// Pay out referral earnings on the EVM deployment (server/referrals.mjs rules): everything earned in the chain's
// settlements.jsonl minus what its referral-payouts.jsonl records, per wallet and token, sent as ERC-20 transfers from
// the rebate wallet. Run weekly from the host that holds that key (deploy/referral-payout-evm-remote.sh pulls the
// files from the app host and pushes the ledger back). DRY_RUN=1 only prints.
//   env: EVM_CHAIN, DATA_DIR (the pulled files: settlements.jsonl, referrals.json, chain-tokens.json, the ledger),
//        REBATE_KEY_FILE (hex private key file), REFERRAL_MIN_USD (0.05), REBATE_MAX_RUN_USD (2000)
//
// Money is never sent twice: every payment is written to the ledger as "sent" before it leaves this process, with the
// hash it will carry (the transaction is signed first, sent after), and settled as "landed" or "void" afterwards.
// A run that died between the two is finished first thing on the next run, by asking the chain about the hash.
import fs from "node:fs";
import path from "node:path";
import { keccak256, parseAbiItem } from "viem";
import { leaderboard } from "../points.mjs";
import * as referrals from "../referrals.mjs";
import { notify } from "../notify.mjs";
import { CHAIN_KEY, chainCfg, walletFor, publicClient, potAddress, erc20Abi } from "./chain.mjs";
import { provenRows } from "./settlement-proof.mjs";

const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const SETTLEMENTS = path.join(DATA, "settlements.jsonl"), REFERRALS_FILE = process.env.REFERRALS_FILE ?? path.join(DATA, "referrals.json"), LEDGER = path.join(DATA, "referral-payouts.jsonl");
const DRY = process.env.DRY_RUN === "1";
const MIN_USD = Number(process.env.REFERRAL_MIN_USD ?? 0.05);
const MAX_RUN_USD = Number(process.env.REBATE_MAX_RUN_USD ?? 2000);
const keyFile = process.env.REBATE_KEY_FILE; if (!keyFile) { console.error("REBATE_KEY_FILE required"); process.exit(2); }
const payer = walletFor(keyFile);
const log = (...a) => console.log(new Date().toISOString(), ...a);
process.on("unhandledRejection", (e) => { console.error("unhandled:", String(e?.message ?? e).slice(0, 200)); });
const ledger = (row) => fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), chain: CHAIN_KEY, ...row }) + "\n");
const readRows = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
const mintAbi = [parseAbiItem("function mint(address to, uint256 amount)")];

// 1. reconcile: "sent" rows of an earlier run that never got their "landed" / "void"
let payouts = referrals.readPayouts(LEDGER);
const unanswered = [];
for (const p of referrals.unsettledPayouts(payouts)) {
  if (DRY) { log("unsettled from an earlier run (DRY RUN, not touched):", p.signature); continue; }
  let rc = null, err = null;
  try { rc = await publicClient.getTransactionReceipt({ hash: p.signature }); } catch (e) { err = String(e?.shortMessage ?? e?.message ?? e); }
  if (rc?.status === "success") { ledger({ status: "landed", wallet: p.wallet, mint: p.mint, token: p.token, raw: "0", signature: p.signature }); log("reconciled: landed", p.signature); }
  else if (rc && rc.status !== "success") { ledger({ status: "void", wallet: p.wallet, mint: p.mint, token: p.token, raw: (-BigInt(p.raw)).toString(), signature: p.signature, why: "reverted on-chain" }); log("reconciled: void (reverted)", p.signature); }
  else { unanswered.push(p); log("reconciled: no receipt on this RPC yet — held as paid, asked again next run", p.signature, err ?? ""); }
}
for (const p of unanswered) await notify("⚠️ 推廣回饋(Robinhood):一筆付款鏈上查無紀錄", `${CHAIN_KEY} ${p.wallet?.slice(0, 8)}… ${p.token ?? p.mint?.slice(0, 8)} raw ${p.raw}\n${p.signature}\nRPC 目前查不到收據;先當已付,下次再問`, `evm-payout-unknown:${p.signature}`, 1440);
payouts = referrals.readPayouts(LEDGER);

// 2. what is due: only rows the chain confirms earn anything (settlement-proof.mjs)
const db = referrals.load(REFERRALS_FILE);
const referrers = new Set(Object.values(db.bindings).map((b) => b.referrer));
const earns = (r) => { if (referrers.has(r.owner)) return true; const b = db.bindings[r.owner]; if (!b) return false; try { return BigInt(r.fee ?? 0) > 0n; } catch { return false; } };
const proof = await provenRows(publicClient, potAddress(), readRows(SETTLEMENTS).filter((r) => r.kind !== "forfeited"), { cacheFile: path.join(DATA, "settlement-proofs.json"), wanted: earns, log });
const rows = proof.ok;
if (proof.unknown.length) log(`held back: ${proof.unknown.length} settlement rows the chain could not be asked about (next run asks again)`);
if (proof.rejected.length && !DRY) await notify("⛔ 推廣回饋(Robinhood):結算列對不上鏈上", `${CHAIN_KEY}: ${proof.rejected.length} 筆結算列在鏈上找不到對應的派彩事件,已排除不付。\n${proof.rejected.slice(0, 5).map((x) => `${x.row.tx?.slice(0, 12)}… ${x.why}`).join("\n")}`, "evm-payout-rejected", 1440);
const pts = new Map(leaderboard(rows, { decimals: () => null, close: () => null }).entries.map((e) => [e.wallet, e.points]));
const due = referrals.pending(referrals.earnings(rows, db, (w) => pts.get(w) ?? 0), payouts);
// Dollar values for the minimum and the run cap come from this host's own quotes, not the row's `close` (audit
// 2026-10-20 M1): a stock token at the stock's last trade (Yahoo), a meme at DexScreener's highest quote of its mainnet
// token (the site's listing maps a testnet mock to it). On the live chain a token without a quote waits; on the test
// network the row's value stands in.
const API = process.env.API ?? "https://robinhood.sharepot.xyz";
async function repriceWithOwnQuotes(list) {
  let listing = []; try { listing = (await (await fetch(`${API}/api/stocks`, { signal: AbortSignal.timeout(15_000) })).json()).stocks ?? []; } catch (e) { log(`own quotes: site listing unavailable: ${String(e?.message ?? e).slice(0, 80)}`); }
  const byMint = new Map(listing.flatMap((st) => st.tokens.map((t) => [String(t.mint ?? "").toLowerCase(), { ...t, kind: st.kind, symbol: st.symbol }])));
  const memeQuote = new Map();   // mainnet token (lowercase) → highest usd quote across its pairs
  const memes = [...new Set(list.map((d) => byMint.get(String(d.mint).toLowerCase())).filter((t) => t?.kind === "day" && t.mainnetMint).map((t) => String(t.mainnetMint).toLowerCase()))];
  for (let i = 0; i < memes.length; i += 30) {
    try {
      const pairs = await (await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${memes.slice(i, i + 30).join(",")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) })).json();
      for (const pr of pairs) { const a = String(pr?.baseToken?.address ?? "").toLowerCase(), px = Number(pr?.priceUsd); if (memes.includes(a) && px > 0 && !(memeQuote.get(a) >= px)) memeQuote.set(a, px); }
    } catch (e) { log(`own quotes: dexscreener: ${String(e?.message ?? e).slice(0, 80)}`); }
  }
  const stockQuote = new Map();
  for (const d of list) {
    const t = byMint.get(String(d.mint).toLowerCase()); let px = null;
    if (t?.kind === "day") px = memeQuote.get(String(t.mainnetMint).toLowerCase()) ?? null;
    else if (t?.kind === "close") {
      if (!stockQuote.has(t.symbol)) { let v = null; try { const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${t.symbol}?range=1d&interval=1d`, { headers: { "user-agent": "Mozilla/5.0 (SharePot)" }, signal: AbortSignal.timeout(8000) }); const n = Number((await r.json())?.chart?.result?.[0]?.meta?.regularMarketPrice); if (n > 0) v = n; } catch {} stockQuote.set(t.symbol, v); }
      px = stockQuote.get(t.symbol);
    }
    const own = px != null && d.decimals != null ? (Number(d.raw) / 10 ** d.decimals) * (d.multiplier || 1) * px : null;
    if (!chainCfg.test) d.usd = own; else if (own != null) d.usd = own;
  }
}
await repriceWithOwnQuotes(due);
log(`chain=${CHAIN_KEY} payer=${payer.account.address} pending=${due.length}${DRY ? " DRY RUN" : ""}`);

// 3. pay
let sent = 0, skipped = 0, failed = 0, usdSent = 0;
for (const d of due) {
  const tag = `${d.wallet.slice(0, 8)}… ${d.token ?? d.mint.slice(0, 8)} ${d.decimals != null ? Number(d.raw) / 10 ** d.decimals : d.raw}${d.usd != null ? ` ($${d.usd.toFixed(2)})` : ""}`;
  if (d.usd != null && d.usd < MIN_USD) { skipped++; continue; }
  if (d.decimals == null) { log("skip (unknown decimals)", tag); skipped++; continue; }
  if (!chainCfg.test && d.usd == null) { log("waits (no dollar value known for this token: neither the minimum nor the run cap can be applied)", tag); skipped++; continue; }
  if (DRY) { log("would pay", tag); continue; }
  try {
    if (usdSent + (d.usd ?? 0) > MAX_RUN_USD) { log(`STOPPED: this run would pass $${MAX_RUN_USD}`, tag); failed++; await notify("⛔ 推廣回饋(Robinhood)超過單次上限,已停", `${CHAIN_KEY}: 本輪已付 $${usdSent.toFixed(2)},下一筆 ${tag} 會超過 $${MAX_RUN_USD};其餘留到人看過`, "evm-payout-cap", 60); break; }
    const token = d.mint, to = d.wallet;
    const bal = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [payer.account.address] }).catch(() => 0n);
    let req;
    if (bal >= d.raw) req = { address: token, abi: erc20Abi, functionName: "transfer", args: [to, d.raw] };
    else if (chainCfg.test) {
      // a test network's memes are mocks whose mint is public: mint the rebate straight to the wallet
      try { await publicClient.simulateContract({ account: payer.account, address: token, abi: mintAbi, functionName: "mint", args: [to, d.raw] }); req = { address: token, abi: mintAbi, functionName: "mint", args: [to, d.raw] }; }
      catch { log("FAILED (rebate wallet short, token cannot be minted)", tag, `have ${bal}`); failed++; continue; }
    } else { log("FAILED (rebate wallet short)", tag, `have ${bal}`); failed++; continue; }
    const { request } = await publicClient.simulateContract({ account: payer.account, ...req });
    const prepared = await payer.client.prepareTransactionRequest({ ...request, account: payer.account });
    const serialized = await payer.client.signTransaction(prepared), hash = keccak256(serialized);
    const row = { wallet: to, mint: token, token: d.token, ui: Number(d.raw) / 10 ** d.decimals, usd: d.usd };
    ledger({ status: "sent", ...row, raw: d.raw.toString(), signature: hash });   // before it leaves this process
    let rc = null;
    try { await payer.client.sendRawTransaction({ serializedTransaction: serialized }); rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }); }
    catch (e) { log("UNSETTLED (next run asks the chain)", tag, hash, String(e?.shortMessage ?? e?.message ?? e).slice(0, 120)); failed++; continue; }
    if (rc.status === "success") { ledger({ status: "landed", ...row, raw: "0", signature: hash }); log("paid", tag, hash); sent++; usdSent += d.usd ?? 0; }
    else { ledger({ status: "void", ...row, raw: (-d.raw).toString(), signature: hash, why: "reverted on-chain" }); log("reverted (voided, next run retries)", tag, hash); failed++; }
    await new Promise((r) => setTimeout(r, 500));
  } catch (e) { log("FAILED", tag, String(e?.shortMessage ?? e?.message ?? e).slice(0, 200)); failed++; }
}
log(`done: paid ${sent}, skipped ${skipped} (dust), failed ${failed}`);
if (!DRY && (sent || failed)) await notify(failed ? "⚠️ 推廣回饋(Robinhood)有失敗" : "💸 推廣回饋(Robinhood)已發", `${CHAIN_KEY}: 發 ${sent} 筆 ≈ $${usdSent.toFixed(2)}${failed ? `,失敗 ${failed} 筆(看 referral-payout-evm log)` : ""}`, "evm-payout-done", 60);
process.exit(failed ? 1 : 0);
