// Sell the treasury's collected fees for USDC — mainnet only (test networks have no pools). Run where the treasury key
// lives, after the weekly referral payout, during New York hours when the xStocks pools are deepest.
//
// For every listed token (stock-templates.json + the meme registry) the treasury's balance minus the referral rebates
// still owed in that token is offered to Jupiter. MEV / price impact: a lot that moves the pool more than MAX_IMPACT_PCT
// is halved until it does not (leftovers wait for the next run), slippage is capped at SLIPPAGE_BPS, lots under
// MIN_USD are not worth a swap. Every swap goes to a ledger like the payouts' (sent / landed / void, tx.mjs decides).
// Sandwiching: the transaction never takes the public relay path — it is sent as a Jito bundle (jito.mjs, bundleOnly)
// with a tip instead of a priority fee; a bundle that does not land within its blockhash is re-quoted and re-sent with
// twice the tip, up to JITO_ATTEMPTS times, then left for the next run.
//   env: CLUSTER (mainnet), CLUSTER_RPC, DATA_DIR (settlements + referrals + ledger), TREASURY_KEYPAIR, DRY_RUN=1,
//        FAKE_BALANCE_USD=<n> (DRY_RUN only: pretend every token holds this much, to exercise the quoting),
//        JITO_URL, JITO_TIP_MIN / JITO_TIP_MAX (lamports), JITO_ATTEMPTS
// SOL: after the sales, the treasury and the proposer (read from the on-chain config) are refilled from USDC to fixed
// levels when under their floors (sol-topup.mjs) — SOL is an expense here, not a holding.
//        TREASURY_SOL_FLOOR/TARGET, PROPOSER_SOL_FLOOR/TARGET, TOPUP_MAX_SOL (SOL), PROPOSER_PUBKEY (else the config's),
//        FAKE_SOL=<treasury>,<proposer> (DRY_RUN only: pretend these balances)
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { leaderboard, readSettlements } from "./points.mjs";
import * as referrals from "./referrals.mjs";
import { readRegistry } from "./chain-tokens.mjs";
import { notify } from "./notify.mjs";
import { sendSigned, signatureStatus } from "./tx.mjs";
import { quoteProblem, simulationProblem } from "./swap-guard.mjs";
import * as jito from "./jito.mjs";
import { topUpPlan, usdcForLamports, sol, fmtSol, DEFAULTS as TOPUP_DEFAULTS } from "./sol-topup.mjs";
import anchor from "@coral-xyz/anchor";

const CLUSTER = process.env.CLUSTER ?? "mainnet";
const RPC = process.env.CLUSTER_RPC ?? "https://api.mainnet-beta.solana.com";
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DRY = process.env.DRY_RUN === "1";
const FAKE_USD = DRY ? Number(process.env.FAKE_BALANCE_USD ?? 0) : 0;
const USDC = process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MIN_USD = Number(process.env.SWAP_MIN_USD ?? 20);              // smaller lots stay in the token
const MAX_IMPACT_PCT = Number(process.env.MAX_IMPACT_PCT ?? 0.3);    // per swap; a bigger lot is halved until it fits
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 50);
const MAX_SWAP_LAMPORTS = BigInt(process.env.MAX_SWAP_LAMPORTS ?? 10_000_000);   // fee + Jito tip + (first time) the USDC account's rent
const JITO_URL = process.env.JITO_URL ?? jito.DEFAULT_URL;
const JITO_TIP = { min: Number(process.env.JITO_TIP_MIN ?? 100_000), max: Number(process.env.JITO_TIP_MAX ?? 2_000_000) };   // 0.0001–0.002 SOL
const JITO_ATTEMPTS = Number(process.env.JITO_ATTEMPTS ?? 3);
const WSOL = "So11111111111111111111111111111111111111112";
const TOPUP = { ...TOPUP_DEFAULTS, ...Object.fromEntries([["treasuryFloor", "TREASURY_SOL_FLOOR"], ["treasuryTarget", "TREASURY_SOL_TARGET"], ["proposerFloor", "PROPOSER_SOL_FLOOR"], ["proposerTarget", "PROPOSER_SOL_TARGET"], ["maxPerRun", "TOPUP_MAX_SOL"]].filter(([, e]) => process.env[e] != null).map(([k, e]) => [k, sol(process.env[e])])) };
const MIN_LOT_USD = 5;                                               // stop halving below this
const LEDGER = path.join(DATA, "treasury-swaps.jsonl");
if (CLUSTER !== "mainnet" && !DRY) { console.error("treasury-swap: only mainnet has pools (DRY_RUN=1 to exercise the quoting)"); process.exit(2); }
const keyFile = process.env.TREASURY_KEYPAIR; if (!keyFile) { console.error("TREASURY_KEYPAIR required"); process.exit(2); }
const treasury = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("unhandledRejection", (e) => log(`unhandled rejection (ignored): ${String(e?.message ?? e).slice(0, 160)}`));
const ledger = (row) => { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), cluster: CLUSTER, ...row }) + "\n"); };
// Jupiter's free tier rate-limits bursts (a plain-text "Rate limit" answer): back off and retry a few times.
const jup = async (p, init) => {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://lite-api.jup.ag/swap/v1${p}`, { ...init, signal: AbortSignal.timeout(20_000) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    if (r.ok && j && !j.error) return j;
    const transient = r.status === 429 || r.status >= 500 || /rate limit/i.test(text);
    if (transient && attempt < 5) { await sleep(10_000 * attempt); continue; }
    throw new Error(j?.error ?? `jupiter ${r.status}: ${text.slice(0, 80)}`);
  }
};

// 1. an earlier run's "sent" swaps the chain has not answered for
let swaps = referrals.readPayouts(LEDGER);
for (const p of referrals.unsettledPayouts(swaps)) {
  if (DRY) { log("unsettled from an earlier run (DRY RUN, not touched):", p.signature); continue; }
  const st = await signatureStatus(conn, p.signature);
  ledger(st === "confirmed" ? { status: "landed", mint: p.mint, token: p.token, raw: "0", signature: p.signature } : { status: "void", mint: p.mint, token: p.token, raw: "0", signature: p.signature, why: st ?? "never landed" });
  log(`reconciled: ${st === "confirmed" ? "landed" : "void"}`, p.signature);
}

// 2. what each token is worth selling: balance − rebates still owed in it
const tpl = JSON.parse(fs.readFileSync(process.env.STOCKS ?? new URL("./stock-templates.json", import.meta.url), "utf8"));
const tokens = new Map();
for (const s of tpl.stocks) for (const t of s.tokens) tokens.set(t.mainnetMint, { token: t.token, decimals: t.decimals });
for (const [mint, t] of Object.entries(readRegistry(DATA).tokens)) tokens.set(mint, { token: t.symbol, decimals: t.decimals });
const rows = readSettlements(DATA), db = referrals.load(path.join(DATA, "referrals.json"));
const pts = new Map(leaderboard(rows, { decimals: () => null, close: () => null }).entries.map((e) => [e.wallet, e.points]));
const owed = new Map();   // mint → raw still to be paid out as rebates
for (const d of referrals.pending(referrals.earnings(rows, db, (w) => pts.get(w) ?? 0), referrals.readPayouts(path.join(DATA, "referral-payouts.jsonl")))) owed.set(d.mint, (owed.get(d.mint) ?? 0n) + d.raw);
const baseTip = jito.tipLamports(await jito.fetchTipFloor(), JITO_TIP);
log(`cluster=${CLUSTER} treasury=${treasury.publicKey.toBase58()} tokens=${tokens.size} jito=${JITO_URL} tip=${baseTip} lamports${DRY ? " DRY RUN" : ""}${FAKE_USD ? ` fake balance $${FAKE_USD}` : ""}`);

// Jupiter builds the transaction; the treasury signs only what a simulation shows to be the swap that was asked for
// (swap-guard.mjs). Every token account the treasury owns is watched, not just the two the swap should touch.
const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC), treasury.publicKey, false, TOKEN_PROGRAM_ID).toBase58();

// 3. quote, split until the impact is acceptable, swap
const quoteOk = async (mint, amount) => {
  for (;;) {
    const q = await jup(`/quote?inputMint=${mint}&outputMint=${USDC}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`);
    const impact = Number(q.priceImpactPct) * 100, outUsd = Number(q.outAmount) / 1e6;
    if (impact <= MAX_IMPACT_PCT) return { q, amount, outUsd, impact };
    if (outUsd / 2 < MIN_LOT_USD) return { tooThin: true, impact, outUsd };
    amount = amount / 2n; await sleep(500);
  }
};
/** Build (Jupiter, with a Jito tip), check (quote + tip + simulation) and send one swap as a Jito bundle; a bundle that
 *  does not land is re-quoted and re-sent with twice the tip, JITO_ATTEMPTS times. `r` is the first quote ({ q, amount });
 *  `requote(amount)` fetches a fresh one (needed: a new blockhash means a new transaction). Returns "sold", "refused",
 *  "unsettled", "thin" or "expired" (gave up; the next run retries). */
async function executeSwap(tag, r, requote, want, rowBase) {
  let outcome = "expired";
  for (let attempt = 1; attempt <= JITO_ATTEMPTS && outcome === "expired"; attempt++) {
    const tip = Math.min(JITO_TIP.max, baseTip * 2 ** (attempt - 1));
    if (attempt > 1) { r = await requote(r.amount); if (r.tooThin) return "thin"; }
    const sw = await jup("/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteResponse: r.q, userPublicKey: treasury.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { jitoTipLamports: tip } }) });
    const tx = VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, "base64"));
    const bad = quoteProblem(r.q, { inputMint: want.inputMint, outputMint: want.outputMint, amount: r.amount, slippageBps: SLIPPAGE_BPS }) ?? jito.tipProblem(tx, tip)
      ?? await simulationProblem(conn, tx, treasury.publicKey, { inputAta: want.inputAta, outputAta: want.outputAta, nativeOut: !!want.nativeOut, amount: r.amount, minOut: BigInt(r.q.otherAmountThreshold), maxLamports: MAX_SWAP_LAMPORTS });
    if (bad) { log(`REFUSED to sign ${tag}: ${bad}`); await notify("⛔ 換匯:交易內容不符,拒簽", `${tag}\n${bad}`, "treasury-swap-guard", 60); return "refused"; }
    const row = { ...rowBase, tip, attempt };
    let sig = null, landed = false;
    try { ({ sig, landed } = await sendSigned(conn, tx, [treasury], { lastValidBlockHeight: sw.lastValidBlockHeight, send: (raw) => jito.sendBundleOnly(raw, { url: JITO_URL }), beforeSend: (s) => ledger({ status: "sent", ...row, raw: r.amount.toString(), signature: s }) })); }
    catch (e) { if (sig === null) throw e; log("UNSETTLED (next run asks the chain)", tag, sig, String(e?.message ?? e).slice(0, 120)); return "unsettled"; }
    if (landed) { ledger({ status: "landed", ...row, raw: "0", signature: sig }); log(`done ${tag} (attempt ${attempt}, tip ${tip})`, sig); return "sold"; }
    ledger({ status: "void", ...row, raw: "0", signature: sig, why: "blockhash expired" }); log(`bundle did not land (attempt ${attempt}, tip ${tip})`, tag, sig);
    await sleep(2000);
  }
  log(`gave up ${tag} after ${JITO_ATTEMPTS} attempts (next run retries)`);
  return outcome;
}

let sold = 0, usdOut = 0, failed = 0, held = 0;
for (const [mint, t] of tokens) {
  const tag = `${t.token} (${mint.slice(0, 6)}…)`;
  try {
    const info = await conn.getAccountInfo(new PublicKey(mint)); if (!info) { continue; }
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), treasury.publicKey, false, info.owner);
    let bal = await conn.getTokenAccountBalance(ata).then((r) => BigInt(r.value.amount)).catch(() => 0n);
    if (FAKE_USD) { const px = (await jup(`/quote?inputMint=${mint}&outputMint=${USDC}&amount=${10n ** BigInt(t.decimals)}&slippageBps=${SLIPPAGE_BPS}`).catch(() => null)); bal = px ? BigInt(Math.round((FAKE_USD / (Number(px.outAmount) / 1e6)) * 10 ** t.decimals)) : 0n; }
    let lot = bal - (owed.get(mint) ?? 0n);
    if (lot <= 0n) continue;
    let r = await quoteOk(mint, lot);
    if (r.tooThin) { held++; log(`hold ${tag}: pool too thin (impact ${r.impact.toFixed(2)} % even for a $${r.outUsd.toFixed(0)} lot)`); continue; }
    if (r.outUsd < MIN_USD) { held++; log(`hold ${tag}: worth $${r.outUsd.toFixed(2)} < $${MIN_USD}`); continue; }
    const ui = Number(r.amount) / 10 ** t.decimals;
    log(`${DRY ? "would sell" : "selling"} ${tag}: ${ui} of ${Number(lot) / 10 ** t.decimals} → $${r.outUsd.toFixed(2)} USDC, impact ${r.impact.toFixed(3)} %${r.amount < lot ? ` (split: ${Number(lot - r.amount) / 10 ** t.decimals} waits for the next run)` : ""}`);
    if (DRY) { await sleep(1500); continue; }   // pace the quotes (free tier) in dry runs too
    const outcome = await executeSwap(tag, r, (amount) => quoteOk(mint, amount), { inputMint: mint, outputMint: USDC, inputAta: ata.toBase58(), outputAta: usdcAta }, { mint, token: t.token, ui, usd: r.outUsd, impactPct: r.impact });
    if (outcome === "sold") { sold++; usdOut += r.outUsd; } else if (outcome === "thin") held++; else failed++;
    await sleep(2000);
  } catch (e) { log("FAILED", tag, String(e?.message ?? e).slice(0, 200)); failed++; }
}
// 4. SOL for fees: refill the treasury and the proposer from USDC up to their targets (sol-topup.mjs)
let topped = "";
try {
  let proposer = process.env.PROPOSER_PUBKEY ? new PublicKey(process.env.PROPOSER_PUBKEY) : null;
  if (!proposer) {
    const IDL = JSON.parse(fs.readFileSync(new URL("../idl/sharepot.json", import.meta.url), "utf8"));
    const ro = new anchor.Program(IDL, new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
    proposer = (await ro.account.config.fetch(PublicKey.findProgramAddressSync([Buffer.from("config")], ro.programId)[0])).proposer;
  }
  const balances = { treasury: BigInt(await conn.getBalance(treasury.publicKey)), proposer: BigInt(await conn.getBalance(proposer)) };
  if (DRY && process.env.FAKE_SOL) { const [a, b] = process.env.FAKE_SOL.split(","); balances.treasury = sol(a); balances.proposer = sol(b); }
  const plan = topUpPlan(balances, TOPUP);
  log(`SOL: treasury ${fmtSol(balances.treasury)} (floor ${fmtSol(TOPUP.treasuryFloor)}), proposer ${proposer.toBase58().slice(0, 6)}… ${fmtSol(balances.proposer)} (floor ${fmtSol(TOPUP.proposerFloor)})${plan.length ? "" : " — no top-up needed"}`);
  if (plan.length) {
    const need = plan.reduce((a, p) => a + p.lamports, 0n) + 10_000n;   // + the transfer's fee
    const usdcBal = await conn.getTokenAccountBalance(new PublicKey(usdcAta)).then((r) => BigInt(r.value.amount)).catch(() => 0n);
    const probe = await jup(`/quote?inputMint=${USDC}&outputMint=${WSOL}&amount=1000000&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`);
    let usdc = usdcForLamports(need, BigInt(probe.outAmount)), r = null;
    for (let i = 0; i < 3; i++) {   // the quoted minimum (after slippage) must cover the need; widen the USDC offer until it does
      const q = await jup(`/quote?inputMint=${USDC}&outputMint=${WSOL}&amount=${usdc}&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`);
      if (BigInt(q.otherAmountThreshold) >= need) { r = { q, amount: usdc }; break; }
      usdc = usdc * need / BigInt(q.otherAmountThreshold) * 101n / 100n; await sleep(500);
    }
    const desc = plan.map((p) => `${p.who} +${fmtSol(p.lamports)}`).join(", ");
    if (!r) { failed++; log(`top-up: could not get a quote covering ${fmtSol(need)} SOL`); }
    else if (usdc > (DRY && FAKE_USD ? usdc : usdcBal)) { failed++; log(`top-up: needs ${Number(usdc) / 1e6} USDC for ${desc}, treasury has ${Number(usdcBal) / 1e6}`); await notify("⚠️ 補 SOL:USDC 不夠", `${desc} 需 ${(Number(usdc) / 1e6).toFixed(2)} USDC,金庫只有 ${(Number(usdcBal) / 1e6).toFixed(2)}`, "treasury-topup", 60); }
    else {
      log(`${DRY ? "would buy" : "buying"} ${fmtSol(need)} SOL for ${Number(usdc) / 1e6} USDC (${desc})`);
      if (!DRY) {
        const outcome = await executeSwap("SOL top-up", r, async (amount) => ({ q: await jup(`/quote?inputMint=${USDC}&outputMint=${WSOL}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`), amount }),
          { inputMint: USDC, outputMint: WSOL, inputAta: usdcAta, nativeOut: true }, { kind: "topup", mint: USDC, token: "USDC→SOL", usd: Number(usdc) / 1e6, solOut: fmtSol(need), plan: desc });
        if (outcome !== "sold") failed++;
        else {
          topped = `;補 SOL ${desc}`;
          const toProposer = plan.find((p) => p.who === "proposer");
          if (toProposer) {
            const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: proposer, lamports: toProposer.lamports }));
            const row = { kind: "transfer", mint: "SOL", token: "SOL→proposer", to: proposer.toBase58(), solOut: fmtSol(toProposer.lamports) };
            const { sig, landed } = await sendSigned(conn, tx, [treasury], { beforeSend: (s) => ledger({ status: "sent", ...row, raw: toProposer.lamports.toString(), signature: s }) });
            ledger(landed ? { status: "landed", ...row, raw: "0", signature: sig } : { status: "void", ...row, raw: "0", signature: sig, why: "blockhash expired" });
            log(landed ? `sent ${fmtSol(toProposer.lamports)} SOL to the proposer` : "transfer to the proposer did not land (next run retries)", sig);
            if (!landed) failed++;
          }
        }
      }
    }
  }
} catch (e) { log("top-up FAILED", String(e?.message ?? e).slice(0, 200)); failed++; }

log(`done: sold ${sold} lots ≈ $${usdOut.toFixed(2)}, held ${held}, failed ${failed}${topped}`);
if (!DRY && (sold || failed)) await notify(failed ? "⚠️ 手續費換 USDC 有失敗" : "💵 手續費已換成 USDC", `${CLUSTER}: 賣出 ${sold} 筆 ≈ $${usdOut.toFixed(2)}${topped}${failed ? `,失敗 ${failed} 筆(看 treasury-swap.log)` : ""}`, "treasury-swap", failed ? 5 : 1);
