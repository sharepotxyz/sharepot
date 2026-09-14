// Resolver + crank. Runs from cron; every step is idempotent and safe to re-run.
//   1. propose : for each Open market past resolve_after_ts, read the official close of the predicted session and of
//                the session before it (Alpaca SIP daily bars), compute the move in ppm, publish the raw price response
//                as evidence and submit propose_resolution with its sha256.
//   2. finalize: for each Proposed market whose dispute window elapsed, finalize.
//   3. settle  : for each Resolved/Voided market, pay out every outstanding position in the market's own stock token,
//                then sweep fees and dust to the treasury's account for that stock.
// Metric tag = "<SYMBOL>.close:<YYYY-MM-DD>" (the New York session being predicted); thresholds are in ppm.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import idlJson from "../idl/sharepot.json" with { type: "json" };
import { closeMove, parseMetric, nasdaqMarketInfo, nyToUnix } from "./prices.mjs";

// Latest New York session that has started, per Nasdaq: today once the bell has rung, else the previous trading day.
// (If a day was closed without notice, the day after still reports the day before the closure as "previous", so the
// check must look at the latest started session, not at "previous".) Looked up once per run, only when a close is missing.
let lastTraded;
async function lastTradedDate() {
  if (lastTraded === undefined) {
    try {
      const n = await nasdaqMarketInfo();
      const started = n.isBusinessDay && n.today && n.open && Date.now() / 1000 >= nyToUnix(n.today, n.open);
      lastTraded = started ? n.today : n.previous;
    } catch { lastTraded = null; }
  }
  return lastTraded;
}

const { AnchorProvider, Program, BN, Wallet } = anchor;
const CLUSTER = process.env.CLUSTER ?? "devnet";
const RPC = process.env.CLUSTER_RPC ?? "http://127.0.0.1:8899";
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const SECRETS = process.env.SHAREPOT_SECRETS ?? path.join("/root/stocklana/secrets", CLUSTER);
const DRY = process.env.DRY_RUN === "1";
const ONLY = (process.env.STEPS ?? "propose,finalize,settle").split(",");
const loadKp = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
const proposer = loadKp(path.join(SECRETS, "proposer.json"));
// The admin key is only loaded for test runs that explicitly ask for early finalization.
const admin = process.env.ADMIN_FINALIZE === "1" && process.env.ADMIN_KEYPAIR ? loadKp(process.env.ADMIN_KEYPAIR) : null;
const conn = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(conn, new Wallet(proposer), { commitment: "confirmed" });
const program = new Program(idlJson, provider);
const programId = program.programId;
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const vaultPda = (m) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], programId)[0];
const tag = (b) => Buffer.from(b).toString("utf8").replace(/\0+$/, "");
const log = (...a) => console.log(new Date().toISOString(), ...a);
fs.mkdirSync(path.join(DATA, "evidence"), { recursive: true });

// Token program (classic SPL or Token-2022) owning each mint, looked up once.
const tokenPrograms = new Map();
async function tokenProgramOf(mint) {
  const k = mint.toBase58();
  if (!tokenPrograms.has(k)) tokenPrograms.set(k, (await conn.getAccountInfo(mint)).owner);
  return tokenPrograms.get(k);
}

// Off-chain replica of compute_payout (same integer math) so we can record what each settlement paid.
function payoutFor(m, p) {
  const amounts = p.amounts.map((x) => BigInt(x.toString())), feeW = p.feeW.map((x) => BigInt(x.toString()));
  const total = amounts.reduce((a, b) => a + b, 0n);
  if (m.status === 3) return { payout: total, fee: 0n, kind: "refund" };
  const w = m.outcome; const pools = m.pools.map((x) => BigInt(x.toString()));
  const winPool = pools[w], losePool = pools.reduce((a, b) => a + b, 0n) - winPool, stake = amounts[w];
  if (winPool === 0n) return { payout: total, fee: 0n, kind: "refund" };
  if (stake === 0n) return { payout: 0n, fee: 0n, kind: "lost" };
  const gross = (losePool * stake) / winPool, fee = (gross * feeW[w]) / (stake * 10000n), seed = (BigInt(m.seedAmount.toString()) * stake) / winPool;
  return { payout: stake + gross - fee + seed, fee, kind: "won" };
}
const SETTLEMENTS = path.join(DATA, "settlements.jsonl");

// ---------- on-chain steps ----------
async function propose(markets, now) {
  for (const { publicKey, account: m } of markets) {
   try {
    if (m.status !== 0 || now < m.resolveAfterTs.toNumber()) continue;
    const metric = tag(m.metric), spec = parseMetric(metric);
    if (!spec) { log(`market #${m.id}: unknown metric ${metric}`); continue; }
    const ev = await closeMove(spec.symbol, spec.date);
    if (!ev.ok) {
      // No close for the session: either it is not published yet, or the session never traded (an unscheduled closure
      // after this market was opened). In the second case the market can only be voided, which needs the admin key.
      const prevTraded = await lastTradedDate();
      if (prevTraded && prevTraded > spec.date) log(`market #${m.id} (${metric}): ⚠ no close for ${spec.date} although a later session (${prevTraded}) has started — ${spec.date} likely DID NOT TRADE; VOID NEEDED: ANCHOR_WALLET=<admin> node scripts/void-markets.mjs ${m.id}`);
      else log(`market #${m.id} (${metric}): cannot resolve yet — ${ev.reason}`);
      continue;
    }
    const n = m.nBuckets, thr = m.thresholds.slice(0, n - 1).map((t) => t.toNumber());
    const bucket = thr.filter((t) => ev.value >= t).length; // same rule as on-chain Market::bucket_of
    log(`market #${m.id} (${metric}): move ${ev.value} ppm (${ev.detail.prevClose} → ${ev.detail.close}); thresholds ${thr.join("/")} → bucket ${bucket} of ${n}`);
    if (DRY) continue;
    const evidence = { market: publicKey.toBase58(), id: m.id.toNumber(), metric, ...ev.detail, movePpm: ev.value, source: ev.evidence.source, response: ev.evidence.response };
    const hash = createHash("sha256").update(ev.evidence.response).digest();
    const sig = await program.methods.proposeResolution(new BN(ev.value), Array.from(hash))
      .accounts({ config: configPda, market: publicKey, proposer: proposer.publicKey }).rpc();
    fs.writeFileSync(path.join(DATA, "evidence", `${m.id}.json`), JSON.stringify({ ...evidence, thresholds: thr, bucket, responseSha256: hash.toString("hex"), signature: sig, at: new Date().toISOString() }, null, 2));
    log(`  proposed ${sig}`);
   } catch (e) { log(`market #${m.id}: propose failed: ${e?.message?.split("\n")[0]}`); }
  }
}
async function finalize(markets, now, cfg) {
  for (const { publicKey, account: m } of markets) {
    if (m.status !== 1) continue;
    const ready = now >= m.proposedAt.toNumber() + cfg.disputeWindowSecs.toNumber();
    if (!ready && !admin) { log(`market #${m.id}: in dispute window until ${new Date((m.proposedAt.toNumber() + cfg.disputeWindowSecs.toNumber()) * 1000).toISOString()}`); continue; }
    if (DRY) { log(`market #${m.id}: would finalize`); continue; }
    try {
      const signer = ready ? proposer : admin;
      const sig = await program.methods.finalizeResolution().accounts({ config: configPda, market: publicKey, signer: signer.publicKey }).signers([signer]).rpc();
      log(`market #${m.id}: finalized ${sig}${ready ? "" : " (admin, inside dispute window)"}`);
    } catch (e) { log(`market #${m.id}: finalize failed (next run retries): ${e?.message?.split("\n")[0]}`); }
  }
}
async function settle(markets, cfg) {
  for (const { publicKey, account: m } of markets) {
    if (m.status !== 2 && m.status !== 3) continue;
    const mint = m.mint, tokenProgram = await tokenProgramOf(mint);
    if (m.positionsOpen > 0) {
      // positions of this market: memcmp on the market pubkey (offset 8 = after discriminator)
      const positions = await program.account.position.all([{ memcmp: { offset: 8, bytes: publicKey.toBase58() } }]);
      log(`market #${m.id}: settling ${positions.length} positions`);
      for (const { publicKey: ppk, account: p } of positions) {
        if (DRY) continue;
        try {
          // creates the owner's token account if they closed it (rent paid by the cranker)
          const ownerToken = (await getOrCreateAssociatedTokenAccount(conn, proposer, mint, p.owner, false, "confirmed", undefined, tokenProgram)).address;
          const fresh = await program.account.market.fetch(publicKey);
          const { payout, fee, kind } = payoutFor(fresh, p);
          const sig = await program.methods.settlePosition().accounts({ market: publicKey, position: ppk, payer: p.payer, vault: vaultPda(publicKey), mint, ownerToken, cranker: proposer.publicKey, tokenProgram }).rpc();
          fs.appendFileSync(SETTLEMENTS, JSON.stringify({ at: new Date().toISOString(), market: publicKey.toBase58(), id: m.id.toNumber(), metric: tag(m.metric), mint: mint.toBase58(), owner: p.owner.toBase58(), amounts: p.amounts.slice(0, fresh.nBuckets).map((x) => x.toString()), status: fresh.status, outcome: fresh.outcome, observed: fresh.proposedValue.toString(), kind, payout: payout.toString(), fee: fee.toString(), signature: sig }) + "\n");
          log(`  settled ${p.owner.toBase58()} ${kind} payout=${payout} ${sig}`);
        } catch (e) { log(`  FAILED ${p.owner.toBase58()}: ${e.message?.split("\n")[0]}`); }
      }
    }
    const fresh = await program.account.market.fetch(publicKey);
    if (fresh.positionsOpen === 0 && fresh.status !== 4 && !DRY) {
      try {
        const treasury = (await getOrCreateAssociatedTokenAccount(conn, proposer, mint, cfg.treasuryOwner, false, "confirmed", undefined, tokenProgram)).address;
        const sig = await program.methods.sweepMarket().accounts({ config: configPda, market: publicKey, vault: vaultPda(publicKey), mint, treasury, rentDest: cfg.admin, signer: proposer.publicKey, tokenProgram }).rpc();
        log(`market #${m.id}: swept ${sig}`);
      } catch (e) { log(`market #${m.id}: sweep failed: ${e.message?.split("\n")[0]}`); }
    }
  }
}

const cfg = await program.account.config.fetch(configPda);
const marketFilter = [{ dataSize: program.account.market.size }];
const markets = await program.account.market.all(marketFilter);
const now = Math.floor(Date.now() / 1000);
log(`cluster=${CLUSTER} markets=${markets.length} proposer=${proposer.publicKey.toBase58()} dry=${DRY} steps=${ONLY.join(",")}`);
if (ONLY.includes("propose")) await propose(markets, now);
if (ONLY.includes("finalize")) await finalize(await program.account.market.all(marketFilter), now, cfg);
if (ONLY.includes("settle")) await settle(await program.account.market.all(marketFilter), cfg);
log("done");
