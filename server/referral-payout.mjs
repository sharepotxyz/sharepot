// Pay out referral earnings (referrals.mjs): everything earned in settlements.jsonl minus what referral-payouts.jsonl
// already records, per wallet and token, sent from the rebate wallet's token accounts in the pool's own token.
// Run weekly from cron. DRY_RUN=1 only prints. Env: CLUSTER, CLUSTER_RPC, DATA_DIR, REBATE_KEYPAIR (the wallet that
// holds the rebate float; on devnet the proposer, which can also mint the mock tokens it lacks).
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { leaderboard, readSettlements } from "./points.mjs";
import * as referrals from "./referrals.mjs";
import { notify } from "./notify.mjs";

const CLUSTER = process.env.CLUSTER ?? "devnet";
const RPC = process.env.CLUSTER_RPC ?? "https://api.devnet.solana.com";
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const REFERRALS_FILE = process.env.REFERRALS_FILE ?? path.join(DATA, "referrals.json");
const LEDGER = path.join(DATA, "referral-payouts.jsonl");
const DRY = process.env.DRY_RUN === "1";
const MIN_USD = Number(process.env.REFERRAL_MIN_USD ?? 0.05);      // below this the token-account rent would exceed the rebate
const keyFile = process.env.REBATE_KEYPAIR; if (!keyFile) { console.error("REBATE_KEYPAIR required"); process.exit(2); }
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const log = (...a) => console.log(new Date().toISOString(), ...a);
process.on("unhandledRejection", (e) => { console.error("unhandled:", String(e?.message ?? e).slice(0, 200)); });

const rows = readSettlements(DATA), db = referrals.load(REFERRALS_FILE);
const pts = new Map(leaderboard(rows, { decimals: () => null, close: () => null }).entries.map((e) => [e.wallet, e.points]));
const due = referrals.pending(referrals.earnings(rows, db, (w) => pts.get(w) ?? 0), referrals.readPayouts(LEDGER));
log(`cluster=${CLUSTER} payer=${payer.publicKey.toBase58()} pending=${due.length}${DRY ? " DRY RUN" : ""}`);

let sent = 0, skipped = 0, failed = 0, usdSent = 0;
for (const d of due) {
  const tag = `${d.wallet.slice(0, 6)}… ${d.token ?? d.mint.slice(0, 6)} ${d.decimals != null ? Number(d.raw) / 10 ** d.decimals : d.raw}${d.usd != null ? ` ($${d.usd.toFixed(2)})` : ""}`;
  if (d.usd != null && d.usd < MIN_USD) { skipped++; continue; }
  if (d.decimals == null) { log("skip (unknown decimals)", tag); skipped++; continue; }
  if (DRY) { log("would pay", tag); continue; }
  try {
    const mint = new PublicKey(d.mint), info = await conn.getParsedAccountInfo(mint), tp = info.value.owner;
    const from = getAssociatedTokenAddressSync(mint, payer.publicKey, false, tp), to = getAssociatedTokenAddressSync(mint, new PublicKey(d.wallet), false, tp);
    const bal = await conn.getTokenAccountBalance(from).then((r) => BigInt(r.value.amount)).catch(() => 0n);
    const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, new PublicKey(d.wallet), mint, tp));
    if (bal >= d.raw) tx.add(createTransferCheckedInstruction(from, mint, to, payer.publicKey, d.raw, d.decimals, [], tp));
    else if (CLUSTER !== "mainnet" && info.value.data.parsed?.info?.mintAuthority === payer.publicKey.toBase58()) tx.add(createMintToInstruction(mint, to, payer.publicKey, d.raw, [], tp));   // devnet mocks: mint what the float lacks
    else { log("FAILED (rebate wallet short)", tag, `have ${bal}`); failed++; continue; }
    let sig; for (let tries = 1; ; tries++) {
      try { sig = await sendAndConfirmTransaction(conn, tx, [payer]); break; }
      catch (e) { if (tries >= 3 || !/Blockhash not found|429/i.test(String(e?.message ?? e))) throw e; await new Promise((r) => setTimeout(r, 2000 * tries)); }
    }
    fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), cluster: CLUSTER, wallet: d.wallet, mint: d.mint, token: d.token, raw: d.raw.toString(), ui: Number(d.raw) / 10 ** d.decimals, usd: d.usd, signature: sig }) + "\n");
    log("paid", tag, sig); sent++; usdSent += d.usd ?? 0;
    await new Promise((r) => setTimeout(r, 1500));               // public RPC rate limit
  } catch (e) { log("FAILED", tag, String(e?.message ?? e).slice(0, 200)); failed++; }
}
log(`done: paid ${sent}, skipped ${skipped} (dust), failed ${failed}`);
if (!DRY && (sent || failed)) await notify(failed ? "⚠️ 推廣回饋有失敗" : "💸 推廣回饋已發", `${CLUSTER}: 發 ${sent} 筆 ≈ $${usdSent.toFixed(2)}${failed ? `,失敗 ${failed} 筆(看 referral-payout.log)` : ""}`, "referral-payout", failed ? 5 : 1);
