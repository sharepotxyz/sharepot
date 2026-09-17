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
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount, createHarvestWithheldTokensToMintInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import idlJson from "../idl/sharepot.json" with { type: "json" };
import { closeMove, chainMove, parseMetric, nasdaqMarketInfo, nyToUnix } from "./prices.mjs";
import { readRegistry } from "./chain-tokens.mjs";
import { notify } from "./notify.mjs";
import { sendSigned } from "./tx.mjs";
// A market still unproposed this long after resolve_after_ts is overdue: one Telegram alert per market per 6 h.
const OVERDUE_SECS = Number(process.env.OVERDUE_SECS ?? 7200);
// ...and this long after it, with still no usable price, the proposer voids it on-chain (void_stale_market: the program
// only allows this 24 h past the resolve time), so every stake goes back without waiting for the admin key.
const STALE_VOID_SECS = 86_400;
// A position that cannot be paid — the owner closed their token account for the stock, or the issuer froze it — is
// forfeited to the treasury once the program allows it (forfeit_position: 30 days after the market resolved). Until
// then the crank recreates a closed account only when the payout is worth more than the rent it would pay for it
// (ATA_RENT_USD), so nobody can drain the crank with dust bets from throwaway wallets; a frozen account just waits.
const FORFEIT_GRACE_SECS = 30 * 86_400;
const ATA_RENT_USD = Number(process.env.ATA_RENT_USD ?? 0.5);
const ARCHIVE = (dataDir) => path.join(dataDir, "markets-archive.jsonl");

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
// web3.js confirms transactions with racing promises; when the public RPC answers 429 to one of them the loser rejects
// with nobody awaiting it, and Node 22 would exit on that. The awaited path retries on its own; just log the stray one.
process.on("unhandledRejection", (e) => log(`unhandled rejection (ignored): ${String(e?.message ?? e).slice(0, 160)}`));
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
  // fee rate reduced to whole bps first, exactly as compute_payout does (fee_w / stake, capped at MAX_FEE_BPS)
  const bps = feeW[w] / stake, gross = (losePool * stake) / winPool, fee = (gross * (bps < 1000n ? bps : 1000n)) / 10000n, seed = (BigInt(m.seedAmount.toString()) * stake) / winPool;
  return { payout: stake + gross - fee + seed, fee, kind: "won" };
}
const SETTLEMENTS = path.join(DATA, "settlements.jsonl");

// ---------- what a settled market was worth ----------
// Leaderboard points are shares staked × the official close the market settled on (server/points.mjs), so the close
// is frozen into every settlement row. It is read from the evidence file the proposer published for this market — the
// same number the result was derived from — so NVDAx and NVDAon score identically and nothing depends on a token quote.
// A voided market has no evidence (the session never traded) and records no close: no result, no points.
const tpl = JSON.parse(fs.readFileSync(process.env.STOCKS ?? new URL("./stock-templates.json", import.meta.url), "utf8"));
const mockState = CLUSTER === "mainnet" ? { mints: {} } : JSON.parse(fs.readFileSync(process.env.STATE ?? path.join(SECRETS, "state.json"), "utf8"));
const tokenByMint = new Map(tpl.stocks.flatMap((s) => s.tokens.map((t) => {
  const mint = CLUSTER === "mainnet" ? t.mainnetMint : mockState.mints[t.token];
  return mint ? [mint, { ...t, symbol: s.symbol, kind: s.kind ?? "close" }] : null;
}).filter(Boolean)));
// memes: registry entries (mainnet mint → devnet mock), so a settled market of a token no longer listed still resolves
for (const [mainnetMint, t] of Object.entries(readRegistry(DATA).tokens)) {
  const mint = CLUSTER === "mainnet" ? mainnetMint : t.mock;
  if (mint) tokenByMint.set(mint, { token: t.symbol, issuer: t.issuer, decimals: t.decimals, mainnetMint, symbol: t.symbol, kind: "day" });
}
function officialClose(id) {
  try { const c = JSON.parse(fs.readFileSync(path.join(DATA, "evidence", `${id}.json`), "utf8")).close; return Number.isFinite(c) && c > 0 ? c : null; } catch { return null; }
}
// decimals + ScaledUiAmount multiplier, so raw units can be turned into the share count a wallet shows
const mintMeta = new Map();
async function metaOf(mint) {
  const k = mint.toBase58();
  if (!mintMeta.has(k)) {
    let v = { decimals: tokenByMint.get(k)?.decimals ?? 0, multiplier: 1, transferFee: false };
    try {
      const info = (await conn.getParsedAccountInfo(mint)).value.data.parsed.info;
      const sc = (info.extensions ?? []).find((e) => e.extension === "scaledUiAmountConfig")?.state;
      v = { decimals: info.decimals, multiplier: sc ? Number(Date.now() / 1000 >= Number(sc.newMultiplierEffectiveTimestamp) ? sc.newMultiplier : sc.multiplier) : 1,
        transferFee: (info.extensions ?? []).some((e) => e.extension === "transferFeeConfig") };
    } catch {}
    mintMeta.set(k, v);
  }
  return mintMeta.get(k);
}

// ---------- on-chain steps ----------
/** Void a market whose price will never come (proposer, ≥ 24 h past resolve time); returns true when voided. */
async function voidStale(publicKey, m, metric, why, now) {
  if (now < m.resolveAfterTs.toNumber() + STALE_VOID_SECS) return false;
  if (DRY) { log(`market #${m.id} (${metric}): would void as stale — ${why}`); return false; }
  try {
    const sig = await program.methods.voidStaleMarket().accounts({ config: configPda, market: publicKey, proposer: proposer.publicKey }).rpc();
    log(`market #${m.id} (${metric}): VOIDED as stale (${why}) ${sig}`);
    notify("↩️ 盤已作廢退款", `#${m.id} ${metric}\n${why}\n結算時間過 24h 仍無可用價格,proposer 已 void,下一輪全額退款`, `voided:${m.id}`, 1440);
    return true;
  } catch (e) { log(`market #${m.id}: stale void failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}`); return false; }
}
async function propose(markets, now) {
  for (const { publicKey, account: m } of markets) {
   try {
    if (m.status !== 0 || now < m.resolveAfterTs.toNumber()) continue;
    const metric = tag(m.metric), spec = parseMetric(metric);
    if (!spec) { log(`market #${m.id}: unknown metric ${metric}`); continue; }
    const onChain = spec.kind === "day";
    const n = m.nBuckets, thr = m.thresholds.slice(0, n - 1).map((t) => t.toNumber());
    const ev = onChain
      ? chainMove(DATA, tokenByMint.get(m.mint.toBase58())?.mainnetMint ?? m.mint.toBase58(), spec.symbol, spec.date, now, thr)
      : await closeMove(spec.symbol, spec.date, now);
    if (!ev.ok && onChain) {
      // Not enough closing-hour quotes (sampler outage, or the token's price feed disappeared): hold; a market still
      // unresolved long after its day ended can only be voided (admin key).
      const overdue = now >= m.resolveAfterTs.toNumber() + OVERDUE_SECS;
      log(`market #${m.id} (${metric}): cannot resolve yet — ${ev.reason}`);
      if (await voidStale(publicKey, m, metric, ev.reason, now)) continue;
      if (ev.alert) notify("⚠️ 鏈上盤無法結算", `#${m.id} ${metric}\n${ev.reason}\n結算時間過 24h 後會自動 void 退款`, `hold:${m.id}`, 120);
      else if (overdue) notify("⏳ 鏈上盤結算逾時", `#${m.id} ${metric} 日結束後 ${Math.round((now - m.resolveAfterTs.toNumber()) / 3600)} 小時仍未提案\n${ev.reason}\n過 24h 會自動 void 退款`, `overdue:${m.id}`, 360);
      continue;
    }
    if (!ev.ok) {
      // No usable close for the session: not published / not final / sources disagree, or the session never traded
      // (an unscheduled closure after this market was opened). In the last case the market can only be voided,
      // which needs the admin key.
      const prevTraded = await lastTradedDate();
      const overdue = now >= m.resolveAfterTs.toNumber() + OVERDUE_SECS;
      if (prevTraded && prevTraded > spec.date) {
        log(`market #${m.id} (${metric}): ⚠ no close for ${spec.date} although a later session (${prevTraded}) has started — ${spec.date} likely DID NOT TRADE`);
        if (await voidStale(publicKey, m, metric, `no close for ${spec.date}; session ${prevTraded} has since started`, now)) continue;
        notify("⛔ 這天可能沒交易", `#${m.id} ${metric}:${spec.date} 沒有收盤價但後面的交易日已開始;結算時間過 24h 後 proposer 會自動 void 退款(admin 可提前:node scripts/void-markets.mjs ${m.id})`, `void:${m.id}`, 360);
      } else {
        log(`market #${m.id} (${metric}): cannot resolve yet — ${ev.reason}`);
        if (ev.alert) notify("⚠️ 結算暫停,兩個價源不一致", `#${m.id} ${metric}\n${ev.reason}\n結算器每 10 分鐘會再試;若持續不一致要人工判斷`, `hold:${m.id}`, 120);
        else if (overdue) notify("⏳ 結算逾時", `#${m.id} ${metric} 收盤後 ${Math.round((now - m.resolveAfterTs.toNumber()) / 3600)} 小時仍未提案\n${ev.reason}`, `overdue:${m.id}`, 360);
      }
      continue;
    }
    const bucket = thr.filter((t) => ev.value >= t).length; // same rule as on-chain Market::bucket_of
    log(`market #${m.id} (${metric}): move ${ev.value} ppm (${onChain ? ev.detail.baseline : ev.detail.prevClose} → ${ev.detail.close}${onChain ? `, median of ${ev.detail.samples} quotes` : ""}); thresholds ${thr.join("/")} → bucket ${bucket} of ${n}`);
    if (DRY) continue;
    const evidence = { market: publicKey.toBase58(), id: m.id.toNumber(), metric, ...ev.detail, movePpm: ev.value, source: ev.evidence.source, response: ev.evidence.response };
    const hash = createHash("sha256").update(ev.evidence.response).digest();
    const tx = await program.methods.proposeResolution(new BN(ev.value), Array.from(hash))
      .accounts({ config: configPda, market: publicKey, proposer: proposer.publicKey }).transaction();
    // The evidence file is written with the signature BEFORE the send: if the proposal lands but its confirmation is
    // lost to a rate-limited RPC, the market is Proposed on-chain and the evidence (and the close the leaderboard
    // scores on) must already exist. A send that provably did not land is simply retried next run, overwriting this.
    const write = (sig) => fs.writeFileSync(path.join(DATA, "evidence", `${m.id}.json`), JSON.stringify({ ...evidence, thresholds: thr, bucket, responseSha256: hash.toString("hex"), signature: sig, at: new Date().toISOString() }, null, 2));
    const { sig, landed } = await sendSigned(conn, tx, [proposer], { beforeSend: write });
    if (!landed) { fs.rmSync(path.join(DATA, "evidence", `${m.id}.json`), { force: true }); log(`  proposal did not land before its blockhash expired; next run retries`); continue; }
    log(`  proposed ${sig}`);
   } catch (e) {
    log(`market #${m.id}: propose failed: ${e?.message?.split("\n")[0]}`);
    if (now >= m.resolveAfterTs.toNumber() + OVERDUE_SECS) notify("⏳ 結算逾時(提案失敗)", `#${m.id} ${tag(m.metric)}\n${String(e?.message ?? e).split("\n")[0].slice(0, 300)}`, `overdue:${m.id}`, 360);
   }
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
   try {
    const mint = m.mint, tokenProgram = await tokenProgramOf(mint);
    // Frozen at settlement so the leaderboard can be recomputed from this log alone (see officialClose above).
    const meta = await metaOf(mint), token = tokenByMint.get(mint.toBase58())?.token ?? null;
    const close = officialClose(m.id.toNumber());
    if (m.positionsOpen > 0) {
      // positions of this market: memcmp on the market pubkey (offset 8 = after discriminator)
      const positions = await program.account.position.all([{ memcmp: { offset: 8, bytes: publicKey.toBase58() } }]);
      log(`market #${m.id}: settling ${positions.length} positions`);
      const now = Math.floor(Date.now() / 1000); let deferred = 0;
      for (const { publicKey: ppk, account: p } of positions) {
        if (DRY) continue;
        try {
          const fresh = await program.account.market.fetch(publicKey);
          const { payout, fee, kind } = payoutFor(fresh, p);
          // Where can the payout go? The owner's associated token account: as it is (usable), missing (closed by the
          // owner) or frozen (by the issuer). Only a usable one is paid into.
          const ata = getAssociatedTokenAddressSync(mint, p.owner, false, tokenProgram);
          const acct = await getAccount(conn, ata, "confirmed", tokenProgram).catch((e) => (/TokenAccountNotFound/.test(String(e?.name ?? e)) ? null : { isFrozen: true, invalid: true }));
          const graceOver = now >= fresh.resolvedAt.toNumber() + FORFEIT_GRACE_SECS;
          if (!acct || acct.isFrozen) {
            const worthUsd = close != null ? (Number(payout) / 10 ** meta.decimals) * meta.multiplier * close : null;
            if (graceOver) {
              // forfeit_position: the payout goes to the treasury, the position closes (rent to its payer)
              const treasury = (await getOrCreateAssociatedTokenAccount(conn, proposer, mint, cfg.treasuryOwner, false, "confirmed", undefined, tokenProgram)).address;
              const ftx = await program.methods.forfeitPosition().accounts({ config: configPda, market: publicKey, position: ppk, payer: p.payer, vault: vaultPda(publicKey), mint, ownerAta: ata, treasury, cranker: proposer.publicKey, tokenProgram }).transaction();
              let fsig = null, fok = false, fnote = null;
              try { ({ sig: fsig, landed: fok } = await sendSigned(conn, ftx, [proposer], { beforeSend: (s) => { fsig = s; } })); } catch (e) { fnote = String(e?.message ?? e).split("\n")[0].slice(0, 160); }
              if (!fok) { const still = await program.account.position.fetchNullable(ppk).catch(() => undefined); if (still !== null) throw new Error(fnote ?? "forfeit did not land"); }
              fs.appendFileSync(SETTLEMENTS, JSON.stringify({ at: new Date().toISOString(), market: publicKey.toBase58(), id: m.id.toNumber(), metric: tag(m.metric), mint: mint.toBase58(), owner: p.owner.toBase58(), amounts: p.amounts.slice(0, fresh.nBuckets).map((x) => x.toString()), status: fresh.status, outcome: fresh.outcome, observed: fresh.proposedValue.toString(), kind: "forfeited", payout: "0", forfeited: payout.toString(), fee: fee.toString(), signature: fsig,
                token, decimals: meta.decimals, multiplier: meta.multiplier, close, pools: fresh.pools.slice(0, fresh.nBuckets).map((x) => x.toString()), seed: fresh.seedAmount.toString(), note: `owner's token account ${acct ? "frozen" : "closed"} 30 days after resolution; payout forfeited to the treasury` }) + "\n");
              log(`  forfeited ${p.owner.toBase58()} (${acct ? "frozen" : "closed"} account) amount=${payout} ${fsig}`);
              continue;
            }
            if (acct?.isFrozen || (worthUsd != null && worthUsd < ATA_RENT_USD)) {
              deferred++;
              log(`  deferred ${p.owner.toBase58()}: token account ${acct ? "frozen by the issuer" : `closed, payout ≈ $${worthUsd.toFixed(2)} < rent $${ATA_RENT_USD}`}; forfeits to the treasury after ${new Date((fresh.resolvedAt.toNumber() + FORFEIT_GRACE_SECS) * 1000).toISOString().slice(0, 10)} unless paid before`);
              continue;
            }
          }
          // creates the owner's token account if they closed it (rent paid by the cranker; only when the payout is worth it)
          const ownerToken = (await getOrCreateAssociatedTokenAccount(conn, proposer, mint, p.owner, false, "confirmed", undefined, tokenProgram)).address;
          const tx = await program.methods.settlePosition().accounts({ market: publicKey, position: ppk, payer: p.payer, vault: vaultPda(publicKey), mint, ownerToken, cranker: proposer.publicKey, tokenProgram }).transaction();
          // The row below is the only record of this payout (leaderboard, referral rebates, the wallet's history): a
          // position closes on-chain when it is paid, so a payout whose confirmation was lost would otherwise vanish.
          // sendSigned polls through rate limits until the outcome is certain; if it still cannot tell, the position
          // itself is asked: gone from the chain means paid.
          let sig = null, ok = false, note = null;
          try { ({ sig, landed: ok } = await sendSigned(conn, tx, [proposer], { beforeSend: (s) => { sig = s; } })); }
          catch (e) { note = String(e?.message ?? e).split("\n")[0].slice(0, 160); }
          if (!ok) {
            const still = await program.account.position.fetchNullable(ppk).catch(() => undefined);
            if (still !== null) throw new Error(note ?? "did not land before its blockhash expired");
            ok = true; note = `confirmation lost (${note ?? "expired"}); position gone from the chain, so it was paid`;
          }
          fs.appendFileSync(SETTLEMENTS, JSON.stringify({ at: new Date().toISOString(), market: publicKey.toBase58(), id: m.id.toNumber(), metric: tag(m.metric), mint: mint.toBase58(), owner: p.owner.toBase58(), amounts: p.amounts.slice(0, fresh.nBuckets).map((x) => x.toString()), status: fresh.status, outcome: fresh.outcome, observed: fresh.proposedValue.toString(), kind, payout: payout.toString(), fee: fee.toString(), signature: sig,
            token, decimals: meta.decimals, multiplier: meta.multiplier, close, pools: fresh.pools.slice(0, fresh.nBuckets).map((x) => x.toString()), seed: fresh.seedAmount.toString(), ...(note ? { note } : {}) }) + "\n");
          log(`  settled ${p.owner.toBase58()} ${kind} payout=${payout} ${sig}${note ? ` (${note})` : ""}`);
        } catch (e) {
          log(`  FAILED ${p.owner.toBase58()}: ${e.message?.split("\n")[0]}`);
          notify("⚠️ 有倉位付不出去", `#${m.id} ${tag(m.metric)} owner ${p.owner.toBase58().slice(0, 8)}…\n${String(e.message ?? e).split("\n")[0].slice(0, 200)}\n(每輪重試;30 天後仍付不出會沒收進金庫、該盤才能 sweep)`, `settle:${ppk.toBase58()}`, 360);
        }
      }
      if (deferred) log(`market #${m.id}: ${deferred} position(s) deferred (owner's account closed or frozen); the market sweeps once they are paid or forfeited`);
    }
    const fresh = await program.account.market.fetch(publicKey);
    if (fresh.positionsOpen === 0 && fresh.status !== 4 && !DRY) {
      try {
        // The sweep closes the market account (rent back to the proposer), so its final state is archived first: the
        // site keeps showing settled markets and their results from this file (api.mjs) after they leave the chain.
        let remaining = null; try { remaining = (await conn.getTokenAccountBalance(vaultPda(publicKey))).value.amount; } catch {}
        const num = (x) => (x?.toNumber ? x.toNumber() : Number(x));
        fs.appendFileSync(ARCHIVE(DATA), JSON.stringify({ pubkey: publicKey.toBase58(), id: num(fresh.id), mint: mint.toBase58(), tokenProgram: tokenProgram.toBase58(), decimals: meta.decimals, multiplier: meta.multiplier, metric: tag(fresh.metric), nBuckets: fresh.nBuckets, thresholds: fresh.thresholds.slice(0, fresh.nBuckets - 1).map(num), openTs: num(fresh.openTs), closeTs: num(fresh.closeTs), resolveAfterTs: num(fresh.resolveAfterTs), baseline: num(fresh.baseline), pools: fresh.pools.slice(0, fresh.nBuckets).map(num), seed: num(fresh.seedAmount), status: 4, outcome: fresh.outcome, proposedOutcome: fresh.proposedOutcome, proposedValue: num(fresh.proposedValue), proposedAt: num(fresh.proposedAt), resolvedAt: num(fresh.resolvedAt), positions: fresh.positions, positionsOpen: 0, feeCollected: num(fresh.feeCollected), paidOut: num(fresh.paidOut), swept: remaining == null ? null : Number(remaining), snapshotHash: Buffer.from(fresh.snapshotHash).toString("hex"), sweptAt: new Date().toISOString() }) + "\n");
        // A mint with a transfer fee (Tessera, PreStocks) leaves the issuer's withheld fees sitting in the vault account,
        // and Token-2022 refuses to close an account holding any; harvesting them to the mint is permissionless.
        if (meta.transferFee && tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
          const hsig = await sendAndConfirmTransaction(conn, new Transaction().add(createHarvestWithheldTokensToMintInstruction(mint, [vaultPda(publicKey)], TOKEN_2022_PROGRAM_ID)), [proposer]);
          log(`market #${m.id}: harvested withheld issuer fees to the mint ${hsig}`);
        }
        const treasury = (await getOrCreateAssociatedTokenAccount(conn, proposer, mint, cfg.treasuryOwner, false, "confirmed", undefined, tokenProgram)).address;
        const sig = await program.methods.sweepMarket().accounts({ config: configPda, market: publicKey, vault: vaultPda(publicKey), mint, treasury, rentDest: cfg.proposer, signer: proposer.publicKey, tokenProgram }).rpc();
        log(`market #${m.id}: swept ${sig}`);
      } catch (e) { log(`market #${m.id}: sweep failed: ${e.message?.split("\n")[0]}`); }
    }
   } catch (e) { log(`market #${m.id}: settle step failed (next run retries): ${e?.message?.split("\n")[0]}`); }
  }
}

const PROPOSER_LOW_SOL = Number(process.env.PROPOSER_LOW_SOL ?? 0.3);
try { const b = await conn.getBalance(proposer.publicKey); if (b < PROPOSER_LOW_SOL * 1e9) notify("⛽ proposer 快沒 SOL", `剩 ${(b / 1e9).toFixed(3)} SOL;開盤租金+結算手續費約 0.04/天,見底後不開盤也不結算\n補:solana transfer ${proposer.publicKey.toBase58()} 1 -u devnet`, "proposer-low", 360); } catch {}
const cfg = await program.account.config.fetch(configPda);
const marketFilter = [{ dataSize: program.account.market.size }];
const markets = await program.account.market.all(marketFilter);
const now = Math.floor(Date.now() / 1000);
log(`cluster=${CLUSTER} markets=${markets.length} proposer=${proposer.publicKey.toBase58()} dry=${DRY} steps=${ONLY.join(",")}`);
if (ONLY.includes("propose")) await propose(markets, now);
if (ONLY.includes("finalize")) await finalize(await program.account.market.all(marketFilter), now, cfg);
if (ONLY.includes("settle")) await settle(await program.account.market.all(marketFilter), cfg);
log("done");
