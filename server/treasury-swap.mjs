// Sell the treasury's collected fees for USDC — mainnet only (test networks have no pools). Run where the treasury key
// lives, after the weekly referral payout, during New York hours when the xStocks pools are deepest.
//
// For every listed token (stock-templates.json + the meme registry) the treasury's balance minus the referral rebates
// still owed in that token is offered to Jupiter. MEV / price impact: a lot that moves the pool more than MAX_IMPACT_PCT
// is halved until it does not (leftovers wait for the next run), slippage is capped at SLIPPAGE_BPS, lots under
// MIN_USD are not worth a swap. Every swap goes to a ledger like the payouts' (sent / landed / void, tx.mjs decides).
//   env: CLUSTER (mainnet), CLUSTER_RPC, DATA_DIR (settlements + referrals + ledger), TREASURY_KEYPAIR, DRY_RUN=1,
//        FAKE_BALANCE_USD=<n> (DRY_RUN only: pretend every token holds this much, to exercise the quoting)
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { leaderboard, readSettlements } from "./points.mjs";
import * as referrals from "./referrals.mjs";
import { readRegistry } from "./chain-tokens.mjs";
import { notify } from "./notify.mjs";
import { sendSigned, signatureStatus } from "./tx.mjs";
import { quoteProblem, simulationProblem } from "./swap-guard.mjs";

const CLUSTER = process.env.CLUSTER ?? "mainnet";
const RPC = process.env.CLUSTER_RPC ?? "https://api.mainnet-beta.solana.com";
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DRY = process.env.DRY_RUN === "1";
const FAKE_USD = DRY ? Number(process.env.FAKE_BALANCE_USD ?? 0) : 0;
const USDC = process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MIN_USD = Number(process.env.SWAP_MIN_USD ?? 20);              // smaller lots stay in the token
const MAX_IMPACT_PCT = Number(process.env.MAX_IMPACT_PCT ?? 0.3);    // per swap; a bigger lot is halved until it fits
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 50);
const MAX_SWAP_LAMPORTS = BigInt(process.env.MAX_SWAP_LAMPORTS ?? 10_000_000);   // fees + priority + (first time) the USDC account's rent
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
log(`cluster=${CLUSTER} treasury=${treasury.publicKey.toBase58()} tokens=${tokens.size}${DRY ? " DRY RUN" : ""}${FAKE_USD ? ` fake balance $${FAKE_USD}` : ""}`);

// Jupiter builds the transaction; the treasury signs only what a simulation shows to be the swap that was asked for
// (swap-guard.mjs). Every token account the treasury owns is watched, not just the two the swap should touch.
const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC), treasury.publicKey, false, TOKEN_PROGRAM_ID).toBase58();
const simulatedProblem = (tx, inputAta, amount, minOut) => simulationProblem(conn, tx, treasury.publicKey, { inputAta, outputAta: usdcAta, amount, minOut, maxLamports: MAX_SWAP_LAMPORTS });

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
    const sw = await jup("/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteResponse: r.q, userPublicKey: treasury.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "medium" } } }) });
    const tx = VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, "base64"));
    const bad = quoteProblem(r.q, { inputMint: mint, outputMint: USDC, amount: r.amount }) ?? await simulatedProblem(tx, ata.toBase58(), r.amount, BigInt(r.q.otherAmountThreshold));
    if (bad) { failed++; log(`REFUSED to sign ${tag}: ${bad}`); await notify("⛔ 換 USDC:交易內容不符,拒簽", `${tag}\n${bad}`, "treasury-swap-guard", 60); continue; }
    const row = { mint, token: t.token, ui, usd: r.outUsd, impactPct: r.impact };
    let sig = null, landed = false;
    try { ({ sig, landed } = await sendSigned(conn, tx, [treasury], { lastValidBlockHeight: sw.lastValidBlockHeight, beforeSend: (s) => ledger({ status: "sent", ...row, raw: r.amount.toString(), signature: s }) })); }
    catch (e) { if (sig === null) throw e; log("UNSETTLED (next run asks the chain)", tag, sig, String(e?.message ?? e).slice(0, 120)); failed++; continue; }
    if (landed) { ledger({ status: "landed", ...row, raw: "0", signature: sig }); log("sold", tag, sig); sold++; usdOut += r.outUsd; }
    else { ledger({ status: "void", ...row, raw: "0", signature: sig, why: "blockhash expired" }); log("did not land (next run retries)", tag, sig); failed++; }
    await sleep(2000);
  } catch (e) { log("FAILED", tag, String(e?.message ?? e).slice(0, 200)); failed++; }
}
log(`done: sold ${sold} lots ≈ $${usdOut.toFixed(2)}, held ${held}, failed ${failed}`);
if (!DRY && (sold || failed)) await notify(failed ? "⚠️ 手續費換 USDC 有失敗" : "💵 手續費已換成 USDC", `${CLUSTER}: 賣出 ${sold} 筆 ≈ $${usdOut.toFixed(2)}${failed ? `,失敗 ${failed} 筆(看 treasury-swap.log)` : ""}`, "treasury-swap", failed ? 5 : 1);
