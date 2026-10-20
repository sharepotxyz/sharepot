// Resolver + crank for the EVM deployment. Runs from cron; every step is idempotent and safe to re-run.
//   1. propose : for each Open market past resolveAfterTs, read the official close of the predicted session and of the
//                session before it (prices.mjs closeMove: the same sources and rules as the Solana resolver), publish
//                the raw price response as evidence and submit proposeResolution with its sha256.
//   2. finalize: for each Proposed market whose dispute window elapsed, finalize.
//   3. settle  : for each Resolved/Voided market, pay out every open position (from the event index) in the market's
//                own stock token, forfeit what cannot be paid once the grace period is over, then sweep.
//   env: EVM_CHAIN, EVM_PROPOSER_KEY_FILE (chain.mjs), DATA_DIR, DRY_RUN=1, STEPS=propose,finalize,settle,
//        ADMIN_FINALIZE=1 + EVM_ADMIN_KEY_FILE (test runs: finalize inside the dispute window)
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { keccak256, stringToBytes } from "viem";
import { closeMove, chainMove, parseMetric, nasdaqMarketInfo, nyToUnix } from "../prices.mjs";
import { readRegistry } from "../chain-tokens.mjs";
import { notify } from "../notify.mjs";
import { guardProcess, isTransient } from "../retry.mjs";
import { CHAIN_KEY, chainCfg, walletFor, pot, allMarkets, readMarket, readConfig, readPosition, send, Status, stockByToken, explorerTx, publicClient, erc20Abi } from "./chain.mjs";
import { sync, openPositions, readEvents, evmDir } from "./index-events.mjs";

const OVERDUE_SECS = Number(process.env.OVERDUE_SECS ?? 7200);
const STALE_VOID_SECS = 86_400;
const FORFEIT_GRACE_SECS = 30 * 86_400;
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DRY = process.env.DRY_RUN === "1";
const ONLY = (process.env.STEPS ?? "propose,finalize,settle").split(",");
const DIR = evmDir(DATA);
fs.mkdirSync(path.join(DIR, "evidence"), { recursive: true });
const SETTLEMENTS = path.join(DIR, "settlements.jsonl"), ARCHIVE = path.join(DIR, "markets-archive.jsonl");
const log = (...a) => console.log(new Date().toISOString(), ...a);
guardProcess(log);   // 2026-10-10: 10 crash dumps in 16 days (torn RPC batches); reads retry in chain.mjs, the rest ends in one line
const FORFEITED_TOPIC = keccak256(stringToBytes("PositionForfeited(uint256,address,uint256)"));
const short = (e) => String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 200);

const wallet = DRY ? null : walletFor();
// memes: registry entries (mainnet address → testnet mock), so a market's token maps back to the address the
// sampler quotes; a token no longer listed still resolves
const EVM_SOURCES = { primary: "dexscreener", primaryNote: "api.dexscreener.com (deepest pair)", secondary: "geckoterminal", secondaryNote: "api.geckoterminal.com" };
const memeByToken = new Map();
for (const [addr, t] of Object.entries(readRegistry(DIR).tokens)) {
  const v = { mainnet: addr, symbol: t.symbol, decimals: t.decimals };
  memeByToken.set(addr.toLowerCase(), v); if (t.mock) memeByToken.set(String(t.mock).toLowerCase(), v);
}
const tokenMeta = (token) => stockByToken(token) ?? memeByToken.get(String(token).toLowerCase()) ?? null;
const admin = process.env.ADMIN_FINALIZE === "1" && process.env.EVM_ADMIN_KEY_FILE ? walletFor(process.env.EVM_ADMIN_KEY_FILE) : null;
const p = pot(wallet ?? undefined);

/** The event that closed (id, owner) — PositionSettled or PositionForfeited — once the index has caught up; null if none. */
async function settledEvent(id, owner) {
  try { await sync(DATA); } catch {}
  const w = String(owner).toLowerCase();
  return readEvents(DATA).filter((r) => (r.event === "PositionSettled" || r.event === "PositionForfeited") && r.id === id && String(r.user).toLowerCase() === w).pop() ?? null;
}

let lastTraded;
async function lastTradedDate() {
  if (lastTraded === undefined) {
    try { const n = await nasdaqMarketInfo(); const started = n.isBusinessDay && n.today && n.open && Date.now() / 1000 >= nyToUnix(n.today, n.open); lastTraded = started ? n.today : n.previous; } catch { lastTraded = null; }
  }
  return lastTraded;
}
/** Off-chain replica of computePayout (same integer math), for the settlement log. */
function payoutFor(m, pos) {
  const amounts = pos.amounts.map(BigInt), feeW = pos.feeW.map(BigInt), total = amounts.reduce((a, b) => a + b, 0n);
  if (m.status === Status.Voided) return { payout: total, fee: 0n, kind: "refund" };
  const w = m.outcome, pools = m.pools.map(BigInt), winPool = pools[w], losePool = pools.reduce((a, b) => a + b, 0n) - winPool, stake = amounts[w];
  if (winPool === 0n) return { payout: total, fee: 0n, kind: "refund" };
  if (stake === 0n) return { payout: 0n, fee: 0n, kind: "lost" };
  const bps = feeW[w] / stake, gross = (losePool * stake) / winPool, fee = (gross * (bps < 1000n ? bps : 1000n)) / 10000n, seed = (BigInt(m.seedAmount) * stake) / winPool;
  return { payout: stake + gross - fee + seed, fee, kind: "won" };
}
function officialClose(id) { try { const c = JSON.parse(fs.readFileSync(path.join(DIR, "evidence", `${id}.json`), "utf8")).close; return Number.isFinite(c) && c > 0 ? c : null; } catch { return null; } }
const multipliers = new Map();
async function multiplierOf(token) {
  if (!multipliers.has(token)) { let m = 1; try { m = Number(await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "uiMultiplier" })) / 1e18; } catch {} multipliers.set(token, m || 1); }
  return multipliers.get(token);
}

async function voidStale(m, why, now) {
  if (now < m.resolveAfterTs + STALE_VOID_SECS) return false;
  if (DRY) { log(`market #${m.id} (${m.metric}): would void as stale — ${why}`); return false; }
  try {
    const { hash } = await send(wallet, "voidStaleMarket", [BigInt(m.id)]);
    log(`market #${m.id} (${m.metric}): VOIDED as stale (${why}) ${explorerTx(hash)}`);
    notify("↩️ 盤已作廢退款(Robinhood)", `#${m.id} ${m.metric}\n${why}\n結算時間過 24h 仍無可用價格,proposer 已 void,下一輪全額退款`, `evm-voided:${m.id}`, 1440);
    return true;
  } catch (e) { log(`market #${m.id}: stale void failed: ${short(e)}`); return false; }
}
async function propose(markets, now) {
  const doomed = [];   // markets that can only end voided, reported together after the loop
  for (const m of markets) {
    try {
      if (m.status !== Status.Open || now < m.resolveAfterTs) continue;
      const spec = parseMetric(m.metric);
      if (!spec) { log(`market #${m.id}: unknown metric ${m.metric}`); continue; }
      const onChain = spec.kind === "day", thr = m.thresholds;
      const ev = onChain ? chainMove(DIR, memeByToken.get(m.token.toLowerCase())?.mainnet ?? m.token, spec.symbol, spec.date, now, thr, EVM_SOURCES) : await closeMove(spec.symbol, spec.date, now, thr);
      if (!ev.ok && onChain) {
        // Not enough closing-hour quotes (sampler outage, or the token's price feed disappeared): hold; a market still
        // unresolved a day after its resolve time is voided by the proposer, everyone refunded.
        const overdue = now >= m.resolveAfterTs + OVERDUE_SECS;
        log(`market #${m.id} (${m.metric}): cannot resolve yet — ${ev.reason}`);
        if (await voidStale(m, ev.reason, now)) continue;
        // that closing hour is over and its quotes cannot come back: void-bound
        if (ev.alert || overdue) doomed.push({ id: m.id, line: `#${m.id} ${m.metric}:${ev.reason}` });
        continue;
      }
      if (!ev.ok) {
        const prevTraded = await lastTradedDate(), overdue = now >= m.resolveAfterTs + OVERDUE_SECS;
        if (ev.disagree) {
          log(`market #${m.id} (${m.metric}): held — ${ev.reason}`);
          if (await voidStale(m, ev.reason, now)) continue;
          notify("⚠️ 兩個價源落在不同區間,先不結算(Robinhood)", `#${m.id} ${m.metric}\n${ev.reason}\n每 10 分鐘重試;結算時間過 24h 仍不一致就自動作廢、全額退款`, `evm-hold:${m.id}`, 720);
        } else if (prevTraded && prevTraded > spec.date) {
          log(`market #${m.id} (${m.metric}): ⚠ no close for ${spec.date} although ${prevTraded} has started — likely DID NOT TRADE`);
          if (await voidStale(m, `no close for ${spec.date}; session ${prevTraded} has since started`, now)) continue;
          doomed.push({ id: m.id, line: `#${m.id} ${m.metric}:${spec.date} 沒有收盤價但後面的交易日已開始(這天可能沒交易)` });
        } else {
          log(`market #${m.id} (${m.metric}): cannot resolve yet — ${ev.reason}`);
          if (ev.alert) notify("⚠️ 結算暫停,收盤價資料缺一個交易日(Robinhood)", `#${m.id} ${m.metric}\n${ev.reason}`, `evm-hold:${m.id}`, 720);
          else if (overdue) notify("⏳ 結算逾時(Robinhood)", `#${m.id} ${m.metric} 收盤後 ${Math.round((now - m.resolveAfterTs) / 3600)} 小時仍未提案\n${ev.reason}`, `evm-overdue:${m.id}`, 360);
        }
        continue;
      }
      const bucket = thr.filter((t) => ev.value >= t).length;
      log(`market #${m.id} (${m.metric}): move ${ev.value} ppm (${onChain ? ev.detail.baseline : ev.detail.prevClose} → ${ev.detail.close}${onChain ? `, median of ${ev.detail.samples} quotes` : ""}); thresholds ${thr.join("/")} → bucket ${bucket} of ${m.nBuckets}`);
      if (DRY) continue;
      const hash = createHash("sha256").update(ev.evidence.response).digest();
      const evidence = { chain: CHAIN_KEY, id: m.id, metric: m.metric, ...ev.detail, movePpm: ev.value, source: ev.evidence.source, response: ev.evidence.response, thresholds: thr, bucket, responseSha256: hash.toString("hex"), at: new Date().toISOString() };
      // evidence first, then the send: a proposal that lands with a lost receipt must already have its evidence
      fs.writeFileSync(path.join(DIR, "evidence", `${m.id}.json`), JSON.stringify(evidence, null, 2));
      const { hash: tx } = await send(wallet, "proposeResolution", [BigInt(m.id), BigInt(ev.value), `0x${hash.toString("hex")}`]);
      fs.writeFileSync(path.join(DIR, "evidence", `${m.id}.json`), JSON.stringify({ ...evidence, tx }, null, 2));
      log(`  proposed ${explorerTx(tx)}`);
    } catch (e) {
      log(`market #${m.id}: propose failed: ${short(e)}`);
      if (now >= m.resolveAfterTs + OVERDUE_SECS) notify("⏳ 結算逾時(提案失敗,Robinhood)", `#${m.id} ${m.metric}\n${short(e)}`, `evm-overdue:${m.id}`, 360);
    }
  }
  // Markets that can only end voided get one message for all of them, sent once per set (the key is their ids) instead
  // of a reminder per market every few hours (2026-10-12, #211: two alerts, then one every 6 h for a day). voidStale
  // voids them STALE_VOID_SECS after their resolve time; the Tokyo dashboard shows them meanwhile, red only if the void
  // itself does not happen.
  if (doomed.length) notify("⏳ 這些盤會自動作廢退款(Robinhood)", `${doomed.map((d) => d.line).join("\n")}\n結算時間過 24 小時由 proposer 作廢、全額退款,不用處理。同一天很多盤一起出現,多半是價源或取樣器整體出問題(股票盤則可能是休市)。`, `evm-doomed:${doomed.map((d) => d.id).join(",")}`, (STALE_VOID_SECS + OVERDUE_SECS) / 60);
}
async function finalize(markets, now, cfg) {
  for (const m of markets) {
    if (m.status !== Status.Proposed) continue;
    const ready = now >= m.proposedAt + cfg.disputeWindowSecs;
    if (!ready && !admin) { log(`market #${m.id}: in dispute window until ${new Date((m.proposedAt + cfg.disputeWindowSecs) * 1000).toISOString()}`); continue; }
    if (DRY) { log(`market #${m.id}: would finalize`); continue; }
    try { const { hash } = await send(ready ? wallet : admin, "finalizeResolution", [BigInt(m.id)]); log(`market #${m.id}: finalized ${explorerTx(hash)}${ready ? "" : " (admin, inside dispute window)"}`); }
    catch (e) { log(`market #${m.id}: finalize failed (next run retries): ${short(e)}`); }
  }
}
async function settle(markets) {
  await sync(DATA);
  const open = openPositions(DATA);
  for (const m0 of markets) {
    if (m0.status !== Status.Resolved && m0.status !== Status.Voided) continue;
    try {
      const stock = tokenMeta(m0.token), close = officialClose(m0.id), multiplier = await multiplierOf(m0.token);
      const owners = [...(open.get(m0.id) ?? [])];
      if (m0.positionsOpen > 0 && owners.length === 0) log(`market #${m0.id}: ${m0.positionsOpen} open position(s) on-chain but none in the event index — re-run after index-events catches up`);
      if (owners.length) log(`market #${m0.id}: settling ${owners.length} position(s)`);
      const now = Math.floor(Date.now() / 1000);
      for (const owner of owners) {
        if (DRY) continue;
        try {
          const m = await readMarket(m0.id, p), pos = await readPosition(m0.id, owner, p);
          if (!pos.open) continue; // settled by someone else since the index ran
          const { payout, fee, kind } = payoutFor(m, pos);
          // the same row shape as the Solana crank writes (points.mjs and the site read both): status in the Solana
          // program's numbering (Resolved 2, Voided 3), the token under `mint`
          const row = { at: new Date().toISOString(), chain: CHAIN_KEY, id: m.id, metric: m.metric, mint: m.token, owner, amounts: pos.amounts.slice(0, m.nBuckets), status: m.status - 1, outcome: m.outcome, observed: String(m.proposedValue), fee: fee.toString(),
            token: stock?.symbol ?? null, decimals: stock?.decimals ?? 18, multiplier, close, pools: m.pools, seed: m.seedAmount };
          let res;
          try { res = await send(wallet, "settlePosition", [BigInt(m.id), owner]); }
          catch (e) {
            // A receipt that never came (timeout, torn RPC answer) is not a refusal: the payout may have landed. The
            // position is read again — gone means paid — and the row, the only record of this payout for points and
            // rebates, is written from the chain's event (audit 2026-10-20 L5). Still open: next run retries; nothing
            // is forfeited over a lost receipt.
            if (isTransient(e)) {
              const again = await readPosition(m.id, owner, p).catch(() => null);
              if (again && !again.open) {
                const ev = await settledEvent(m.id, owner);
                fs.appendFileSync(SETTLEMENTS, JSON.stringify({ ...row, kind, payout: payout.toString(), tx: ev?.tx ?? null, note: "receipt lost; row written from the event index" }) + "\n");
                log(`  settled ${owner} ${kind} payout=${payout} (receipt lost${ev ? `; ${explorerTx(ev.tx)}` : ""})`); continue;
              }
              log(`  deferred ${owner}: ${short(e)} (transient; next run retries)`); continue;
            }
            // the owner cannot receive the token (blocked by the issuer, or a contract that rejects it): forfeit once
            // the program allows it, otherwise wait — a paused token fails here too and just retries next run
            const graceOver = now >= m.resolvedAt + FORFEIT_GRACE_SECS;
            if (!graceOver) { log(`  deferred ${owner}: ${short(e)}; forfeits to the treasury after ${new Date((m.resolvedAt + FORFEIT_GRACE_SECS) * 1000).toISOString().slice(0, 10)} unless payable before`); continue; }
            let f;
            try { f = await send(wallet, "forfeitPosition", [BigInt(m.id), owner]); }
            catch (fe) {
              if (!isTransient(fe)) throw fe;
              const again = await readPosition(m.id, owner, p).catch(() => null);
              if (!(again && !again.open)) { log(`  deferred ${owner}: forfeit ${short(fe)} (transient; next run retries)`); continue; }
              const ev = await settledEvent(m.id, owner), wasForfeit = ev?.event === "PositionForfeited";
              fs.appendFileSync(SETTLEMENTS, JSON.stringify({ ...row, kind: wasForfeit ? "forfeited" : kind, payout: wasForfeit ? "0" : payout.toString(), forfeited: wasForfeit ? payout.toString() : undefined, tx: ev?.tx ?? null, note: "receipt lost; row written from the event index" }) + "\n");
              log(`  ${wasForfeit ? "forfeited" : "settled"} ${owner} (receipt lost${ev ? `; ${explorerTx(ev.tx)}` : ""})`); continue;
            }
            const forfeited = f.receipt.logs.some((l) => l.topics[0] === FORFEITED_TOPIC);
            fs.appendFileSync(SETTLEMENTS, JSON.stringify({ ...row, kind: forfeited ? "forfeited" : kind, payout: forfeited ? "0" : payout.toString(), forfeited: forfeited ? payout.toString() : undefined, tx: f.hash, note: forfeited ? "owner could not receive the token 30 days after resolution; payout forfeited to the treasury" : "paid via forfeitPosition (owner payable again)" }) + "\n");
            log(`  ${forfeited ? "forfeited" : "settled"} ${owner} amount=${payout} ${explorerTx(f.hash)}`);
            continue;
          }
          fs.appendFileSync(SETTLEMENTS, JSON.stringify({ ...row, kind, payout: payout.toString(), tx: res.hash }) + "\n");
          log(`  settled ${owner} ${kind} payout=${payout} ${explorerTx(res.hash)}`);
        } catch (e) { log(`  FAILED ${owner}: ${short(e)}`); }
      }
      const fresh = await readMarket(m0.id, p);
      if (fresh.positionsOpen === 0 && fresh.status !== Status.Swept && !DRY) {
        fs.appendFileSync(ARCHIVE, JSON.stringify({ ...fresh, chain: CHAIN_KEY, symbol: stock?.symbol ?? null, decimals: stock?.decimals ?? 18, multiplier, sweptAt: new Date().toISOString() }) + "\n");
        const { hash } = await send(wallet, "sweepMarket", [BigInt(fresh.id)]);
        log(`market #${fresh.id}: swept ${explorerTx(hash)}`);
      }
    } catch (e) { log(`market #${m0.id}: settle step failed (next run retries): ${short(e)}`); }
  }
}

const LOW_ETH = Number(process.env.PROPOSER_LOW_ETH ?? 0.005);
// the operator funds only the proposer; the site's other wallets (chains.json topups) are refilled from it, never
// taking the proposer below a reserve of 4× its low mark so its own resolving never runs dry
const RESERVE_ETH = LOW_ETH * 4;
async function topUps() {
  for (const t of chainCfg.topups ?? []) {
    try {
      const have = Number(await publicClient.getBalance({ address: t.address })) / 1e18;
      if (have >= t.belowEth) continue;
      const mine = Number(await publicClient.getBalance({ address: wallet.account.address })) / 1e18;
      const amount = Math.min(t.fillToEth - have, mine - RESERVE_ETH);
      if (amount < t.fillToEth / 10) { log(`top-up ${t.label}: skipped, proposer has ${mine.toFixed(5)} ETH (reserve ${RESERVE_ETH})`); continue; }
      const hash = await wallet.client.sendTransaction({ to: t.address, value: BigInt(Math.floor(amount * 1e6)) * 10n ** 12n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`transfer reverted in ${hash}`);
      log(`top-up ${t.label} ${t.address}: ${have.toFixed(5)} → +${amount.toFixed(5)} ETH ${explorerTx(hash)}`);
    } catch (e) { log(`top-up ${t.label}: failed (next run retries): ${short(e)}`); }
  }
}
if (wallet) {
  await topUps();
  try { const b = Number(await publicClient.getBalance({ address: wallet.account.address })) / 1e18; if (b < LOW_ETH) notify("⛽ Robinhood proposer 快沒 ETH", `剩 ${b.toFixed(5)} ETH(${wallet.account.address})\n它也負責補 gas 水龍頭和 deployer,請領水到這個地址\n水龍頭:${chainCfg.faucet ?? "-"}`, "evm-proposer-low", 360); } catch {}
}
const cfg = await readConfig(p);
const markets = await allMarkets(p);
const now = Number(process.env.NOW ?? Math.floor(Date.now() / 1000));   // NOW: test runs against a local chain with its clock moved
log(`chain=${CHAIN_KEY} markets=${markets.length} proposer=${wallet?.account.address ?? "(dry)"} dry=${DRY} steps=${ONLY.join(",")}`);
if (ONLY.includes("propose")) await propose(markets, now);
if (ONLY.includes("finalize")) await finalize(await allMarkets(p), now, cfg);
if (ONLY.includes("settle")) await settle(await allMarkets(p));
log("done");
