// Pay out referral earnings (referrals.mjs): everything earned in settlements.jsonl minus what referral-payouts.jsonl
// already records, per wallet and token, sent from the rebate wallet's token accounts in the pool's own token.
// Run weekly from cron. DRY_RUN=1 only prints. Env: CLUSTER, CLUSTER_RPC, DATA_DIR, REBATE_KEYPAIR (the wallet that
// holds the rebate float; on devnet the proposer, which can also mint the mock tokens it lacks).
//
// Money is never sent twice: every payment is written to the ledger as "sent" before it leaves this process, with the
// signature it will carry, and settled as "landed" or "void" afterwards (referrals.mjs describes the rows). A run that
// died between the two is finished first thing on the next run, by asking the chain what became of the signature.
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { leaderboard, readSettlements } from "./points.mjs";
import * as referrals from "./referrals.mjs";
import { notify } from "./notify.mjs";
import { sendSigned, signatureStatus } from "./tx.mjs";
import { provenRows } from "./settlement-proof.mjs";

const CLUSTER = process.env.CLUSTER ?? "devnet";
const RPC = process.env.CLUSTER_RPC ?? "https://api.devnet.solana.com";
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const REFERRALS_FILE = process.env.REFERRALS_FILE ?? path.join(DATA, "referrals.json");
const LEDGER = path.join(DATA, "referral-payouts.jsonl");
const DRY = process.env.DRY_RUN === "1";
const MIN_USD = Number(process.env.REFERRAL_MIN_USD ?? 0.05);      // below this the token-account rent would exceed the rebate
// A wallet that does not hold the token yet gets its account opened (the treasury pays the rent) only once the rebate
// owed in that token reaches this much; until then it stays owed and keeps growing. Small enough sums are not worth an
// account the owner could close for its rent, and a referrer rarely holds every token its invitees bet in.
const OPEN_ACCOUNT_USD = Number(process.env.REBATE_OPEN_ACCOUNT_USD ?? 10);
// One run never sends more than this. Rebates are a share of a week's fees; a run that wants more is a mistake or an
// attack, and a human looks first.
const MAX_RUN_USD = Number(process.env.REBATE_MAX_RUN_USD ?? 2000);
const keyFile = process.env.REBATE_KEYPAIR; if (!keyFile) { console.error("REBATE_KEYPAIR required"); process.exit(2); }
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const log = (...a) => console.log(new Date().toISOString(), ...a);
process.on("unhandledRejection", (e) => { console.error("unhandled:", String(e?.message ?? e).slice(0, 200)); });
const ledger = (row) => fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), cluster: CLUSTER, ...row }) + "\n");

// 1. reconcile: "sent" rows of an earlier run that never got their "landed" / "void"
let payouts = referrals.readPayouts(LEDGER);
// Only an answer from the chain settles a row: "confirmed" lands it, "failed" voids it. No record at all is NOT
// "never landed" — a node without full history, or one still catching up, says the same of a transaction that did
// land, and voiding on that would pay the rebate twice. Such a row stays "sent" (counted as paid) until the chain
// answers; the operator is told, once per signature.
const unanswered = [];
for (const p of referrals.unsettledPayouts(payouts)) {
  if (DRY) { log("unsettled from an earlier run (DRY RUN, not touched):", p.signature); continue; }
  const st = await signatureStatus(conn, p.signature);
  if (st === "confirmed") { ledger({ status: "landed", wallet: p.wallet, mint: p.mint, token: p.token, raw: "0", signature: p.signature }); log("reconciled: landed", p.signature); }
  else if (st === "failed") { ledger({ status: "void", wallet: p.wallet, mint: p.mint, token: p.token, raw: (-BigInt(p.raw)).toString(), signature: p.signature, why: "failed on-chain" }); log("reconciled: void (failed on-chain)", p.signature); }
  else { unanswered.push(p); log("reconciled: no record on this RPC yet — held as paid, asked again next run", p.signature); }
}
for (const p of unanswered) await notify("⚠️ 推廣回饋:一筆付款鏈上查無紀錄", `${CLUSTER} ${p.wallet?.slice(0, 6)}… ${p.token ?? p.mint?.slice(0, 6)} raw ${p.raw}\n簽章 ${p.signature}\nRPC 說沒有這筆(可能沒落地,也可能節點沒歷史)。先當作已付、不重付;每週再問。若 explorer 也查無且已過一週,在帳本補一列 status=void 才會重付。`, `payout-unanswered:${p.signature}`, 7 * 24 * 60);
payouts = referrals.readPayouts(LEDGER);

// 2. what is due
// The settlement log comes from the app host: a row earns a rebate only once the chain confirms it
// (settlement-proof.mjs). Forfeited positions paid their owner nothing and earn no rebate.
const db = referrals.load(REFERRALS_FILE);
// Rows that move money (a bound wallet's fee) and rows that set how much (a referrer's own rows decide its tier) are
// both proven against the chain; rows of wallets that are neither pass through, they change nothing.
const referrers = new Set(Object.values(db.bindings).map((b) => b.referrer));
const earns = (r) => { if (referrers.has(r.owner)) return true; const b = db.bindings[r.owner]; if (!b) return false; try { return BigInt(r.fee ?? 0) > 0n; } catch { return false; } };
const proof = await provenRows(conn, readSettlements(DATA).filter((r) => r.kind !== "forfeited"), { cacheFile: path.join(DATA, "settlement-proofs.json"), wanted: earns, log });
const rows = proof.ok;
if (proof.unknown.length) log(`held back: ${proof.unknown.length} settlement rows the chain could not be asked about (next run asks again)`);
if (proof.rejected.length && !DRY) await notify("⛔ 推廣回饋:結算列對不上鏈上", `${CLUSTER}: ${proof.rejected.length} 筆結算列在鏈上找不到對應的派彩事件,已排除不付。\n${proof.rejected.slice(0, 5).map((x) => `${x.row.owner?.slice(0, 6)}… #${x.row.id}: ${x.why}`).join("\n")}\n若不是 RPC 問題,代表網站主機上的 settlements.jsonl 被改過。`, "referral-proof", 60);
const pts = new Map(leaderboard(rows, { decimals: () => null, close: () => null }).entries.map((e) => [e.wallet, e.points]));
const due = referrals.pending(referrals.earnings(rows, db, (w) => pts.get(w) ?? 0), payouts);
log(`cluster=${CLUSTER} payer=${payer.publicKey.toBase58()} pending=${due.length}${DRY ? " DRY RUN" : ""}`);

// 3. pay
let sent = 0, skipped = 0, failed = 0, usdSent = 0;
for (const d of due) {
  const tag = `${d.wallet.slice(0, 6)}… ${d.token ?? d.mint.slice(0, 6)} ${d.decimals != null ? Number(d.raw) / 10 ** d.decimals : d.raw}${d.usd != null ? ` ($${d.usd.toFixed(2)})` : ""}`;
  if (d.usd != null && d.usd < MIN_USD) { skipped++; continue; }
  if (d.decimals == null) { log("skip (unknown decimals)", tag); skipped++; continue; }
  if (CLUSTER === "mainnet" && d.usd == null) { log("waits (no dollar value known for this token: neither the minimum nor the run cap can be applied)", tag); skipped++; continue; }
  if (DRY) { log("would pay", tag); continue; }
  try {
    const mint = new PublicKey(d.mint), info = await conn.getParsedAccountInfo(mint), tp = info.value.owner;
    const from = getAssociatedTokenAddressSync(mint, payer.publicKey, false, tp), to = getAssociatedTokenAddressSync(mint, new PublicKey(d.wallet), false, tp);
        if (!(await conn.getAccountInfo(to)) && !(d.usd != null && d.usd >= OPEN_ACCOUNT_USD)) { log(`waits (no ${d.token ?? "token"} account yet; opened once the rebate reaches $${OPEN_ACCOUNT_USD})`, tag); skipped++; continue; }
    if (usdSent + (d.usd ?? 0) > MAX_RUN_USD) { log(`STOPPED: this run would pass $${MAX_RUN_USD}`, tag); failed++; await notify("⛔ 推廣回饋超過單次上限,已停", `${CLUSTER}: 本輪已付 $${usdSent.toFixed(2)},下一筆 ${tag} 會超過上限 $${MAX_RUN_USD}。確認沒問題再用 REBATE_MAX_RUN_USD 調高重跑。`, "referral-cap", 60); break; }
    const bal = await conn.getTokenAccountBalance(from).then((r) => BigInt(r.value.amount)).catch(() => 0n);
    const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, new PublicKey(d.wallet), mint, tp));
    if (bal >= d.raw) tx.add(createTransferCheckedInstruction(from, mint, to, payer.publicKey, d.raw, d.decimals, [], tp));
    else if (CLUSTER !== "mainnet" && info.value.data.parsed?.info?.mintAuthority === payer.publicKey.toBase58()) tx.add(createMintToInstruction(mint, to, payer.publicKey, d.raw, [], tp));   // devnet mocks: mint what the float lacks
    else { log("FAILED (rebate wallet short)", tag, `have ${bal}`); failed++; continue; }
    const row = { wallet: d.wallet, mint: d.mint, token: d.token, ui: Number(d.raw) / 10 ** d.decimals, usd: d.usd };
    let sig = null, landed = false;
    try {
      ({ sig, landed } = await sendSigned(conn, tx, [payer], { beforeSend: (s) => ledger({ status: "sent", ...row, raw: d.raw.toString(), signature: s }) }));
    } catch (e) {
      // sent (the row exists) but the outcome is unknown: leave it for the next run's reconcile rather than guess
      if (sig === null) throw e;
      log("UNSETTLED (next run asks the chain)", tag, sig, String(e?.message ?? e).slice(0, 120)); failed++; continue;
    }
    if (landed) { ledger({ status: "landed", ...row, raw: "0", signature: sig }); log("paid", tag, sig); sent++; usdSent += d.usd ?? 0; }
    else { ledger({ status: "void", ...row, raw: (-d.raw).toString(), signature: sig, why: "blockhash expired" }); log("did not land (voided, next run retries)", tag, sig); failed++; }
    await new Promise((r) => setTimeout(r, 1500));               // public RPC rate limit
  } catch (e) { log("FAILED", tag, String(e?.message ?? e).slice(0, 200)); failed++; }
}
log(`done: paid ${sent}, skipped ${skipped} (dust), failed ${failed}`);
if (!DRY && (sent || failed)) await notify(failed ? "⚠️ 推廣回饋有失敗" : "💸 推廣回饋已發", `${CLUSTER}: 發 ${sent} 筆 ≈ $${usdSent.toFixed(2)}${failed ? `,失敗 ${failed} 筆(看 referral-payout.log)` : ""}`, "referral-payout", failed ? 5 : 1);
