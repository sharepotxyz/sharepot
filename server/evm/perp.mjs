// SharePot Perp daily job (Base). One idempotent tick, run from cron every 10 minutes under flock:
//   1. schedule — keeps the next PERP_AHEAD_DAYS of NYSE sessions scheduled on-chain (cutoff = that day's closing bell,
//      early closes included). The contract has no calendar of its own: a day that is not scheduled takes no requests.
//   2. propose — once a session's close is final and confirmed, proposes the day's token value: the last settled value
//      times each session's total-return move since (closeMove in prices.mjs: Yahoo's close, matched to the cent by
//      Nasdaq's official close, the dividend going ex that day added back so an ex-dividend drop is no gift to the
//      shorts). The first settlement proposes the close itself. Chainlink's on-chain price on Base mainnet must agree
//      within PERP_CHAINLINK_MAX_BPS, or the day is held for a human.
//   3. settle — after the dispute window (anyone may; the operator key pays the gas).
// Nothing is ever paid out on a user's behalf: a filled entry is already the user's position, and a filled exit waits
// for its owner to withdraw it on the site (claim). Gains, losses and funding stay in the position and compound.
//
// `node server/evm/perp.mjs verify` is the independent check (run it on another host): it recomputes a proposed value
// from the same public sources — so it catches a wrong, buggy or tampered proposal, not a source that is itself wrong
// (that is what requiring two agreeing sources before proposing is for). With PERP_GUARDIAN_KEY_FILE (the pool's guardian
// key, which lives only on that host and can do nothing but reject a proposal; the admin key is never loaded) a value
// that differs is rejected on-chain at once — the operator's next tick proposes again from its own reading — and
// reported; without a key it only reports. A value it cannot recompute is reported, never rejected.
// `node server/evm/perp.mjs skip <day>` skips a day that never traded (an unscheduled closure): nothing moves and its
// requests roll into the next day. A held day is never skipped automatically. The contract only takes a skip of an
// unproposed day (reject a proposal first) before the next day's cutoff, and at most 63 in a row; past the next cutoff
// the day has to be proposed (the last settled value moves nothing but funding).
//
//   env: EVM_CHAIN (a chains.json entry with perp, perpToken, perpSymbol, perpDeployBlock, perpFeed, perpMainnetToken),
//        EVM_PROPOSER_KEY_FILE (the operator key), DATA_DIR, PERP_AHEAD_DAYS (14), PERP_PROPOSE_DELAY_SECS (1800),
//        PERP_CHAINLINK_MAX_BPS (100), CHAINLINK_RPC (https://mainnet.base.org)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createPublicClient, http, parseAbiItem, getContract } from "viem";
import { base } from "viem/chains";
import { publicClient, walletFor, chainCfg, CHAIN_KEY, erc20Abi } from "./chain.mjs";
import { sessions, closeMove, nyDate, addDays, yahooDaily, nasdaqClose, SECOND_SOURCE_GRACE_SECS } from "../prices.mjs";
import { withRetry, guardProcess, firstLine } from "../retry.mjs";
import { notify, notifyFlush } from "../notify.mjs";

export const perpAbi = JSON.parse(fs.readFileSync(new URL("../../evm/abi/SharePotPerp.json", import.meta.url), "utf8"));
export const State = { None: 0, Scheduled: 1, Proposed: 2, Settled: 3, Skipped: 4 };
export const SCALE = 100_000_000n; // token values carry 8 decimals, like the Chainlink feed
const PPM = 1_000_000n;

const AHEAD_DAYS = Number(process.env.PERP_AHEAD_DAYS ?? 14);
const PROPOSE_DELAY = Number(process.env.PERP_PROPOSE_DELAY_SECS ?? 1800);
const CHAINLINK_MAX_BPS = Number(process.env.PERP_CHAINLINK_MAX_BPS ?? 100);
const HOLD_ALERT_SECS = 2 * 3600; // a day still unproposed this long after its bell is worth a human look
const log = (...a) => console.log(new Date().toISOString(), `[perp ${CHAIN_KEY}]`, ...a);

export const perpAddress = () => {
  const a = process.env.PERP_ADDRESS ?? chainCfg.perp;
  if (!a) throw new Error(`chains.json: no perp deployed on ${CHAIN_KEY} yet`);
  return a;
};
export const SYMBOL = process.env.PERP_SYMBOL ?? chainCfg.perpSymbol ?? "NVDA";
const perp = () => getContract({ address: perpAddress(), abi: perpAbi, client: publicClient });

export async function chainNow() {
  const b = await withRetry(() => publicClient.getBlock({ blockTag: "latest" }), 4, "getBlock");
  return Number(b.timestamp);
}

export async function readEpoch(day) {
  const e = await withRetry(() => perp().read.epochs([BigInt(day)]), 4, `epochs(${day})`);
  return { day, cutoff: Number(e[0]), state: Number(e[1]), proposedAt: Number(e[2]), value: e[3], evidence: e[4], rolledTo: Number(e[5]) };
}

export async function readState() {
  const p = perp();
  const [lastScheduled, lastSettled, lastValue, disputeWindowSecs] = await withRetry(
    () => Promise.all([p.read.lastScheduled(), p.read.lastSettled(), p.read.lastValue(), p.read.disputeWindowSecs()]), 4, "perp state");
  return { lastScheduled: Number(lastScheduled), lastSettled: Number(lastSettled), lastValue, disputeWindowSecs: Number(disputeWindowSecs) };
}

/** The NY session date of the last day that settled with a value (skipped days carry none), or null before the first. */
async function lastSettledDate(st) {
  for (let d = st.lastSettled; d >= 1; d--) {
    const e = await readEpoch(d);
    if (e.state === State.Settled) return nyDate(e.cutoff);
  }
  return null;
}

// ---------------------------------------------------------------- Chainlink (Base mainnet, free to read)
const FEED_ABI = [
  parseAbiItem("function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"),
  parseAbiItem("function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)"),
];
const mainnet = createPublicClient({ chain: base, transport: http(process.env.CHAINLINK_RPC ?? "https://mainnet.base.org", { batch: true, retryCount: 3, retryDelay: 800 }) });

/** The feed's price as of `ts` (its last update at or before it) and the issuer multiplier now: token value = price.
 *  The feed moves only on a 0.5 % change or a 24 h heartbeat, so it is a sanity check, never the settlement price. */
async function chainlinkAt(ts) {
  if (!chainCfg.perpFeed) return null;
  const latest = await mainnet.readContract({ address: chainCfg.perpFeed, abi: FEED_ABI, functionName: "latestRoundData" });
  const phase = latest[0] >> 64n;
  let agg = latest[0] & ((1n << 64n) - 1n);
  let r = Number(latest[3]) <= ts ? latest : null;
  // walk back 50 rounds per multicall until one was updated at or before ts (NVDA: ~40 updates a trading day)
  for (let batch = 0; !r && batch < 40 && agg > 1n; batch++) {
    const ids = [];
    for (let i = 1n; i <= 50n && agg - i >= 1n; i++) ids.push((phase << 64n) | (agg - i));
    agg -= BigInt(ids.length);
    const res = await mainnet.multicall({ contracts: ids.map((id) => ({ address: chainCfg.perpFeed, abi: FEED_ABI, functionName: "getRoundData", args: [id] })), allowFailure: true });
    r = res.map((x) => (x.status === "success" ? x.result : null)).find((x) => x && Number(x[3]) <= ts) ?? null;
  }
  if (!r) return null; // too far back to look
  let multiplier = null;
  if (chainCfg.perpMainnetToken) {
    multiplier = await mainnet.readContract({ address: chainCfg.perpMainnetToken, abi: erc20Abi, functionName: "uiMultiplier" }).catch(() => null);
  }
  return { price: r[1], updatedAt: Number(r[3]), multiplier };
}

// ---------------------------------------------------------------- the value of a day

/** The total-return move from the close of `fromDate` to the close of `toDate` over the daily bars that exist, with the
 *  same guards as closeMove on the target close (final bar, Nasdaq to the cent or its grace period). */
async function gapMove(fromDate, toDate, now) {
  const [cal] = await sessions(toDate, toDate);
  if (!cal) return { ok: false, alert: true, reason: `${toDate} is not a session` };
  const { bars, raw, url, lastTradeTs } = await yahooDaily(SYMBOL, addDays(fromDate, -7), toDate);
  const i0 = bars.findIndex((b) => b.date === fromDate), i1 = bars.findIndex((b) => b.date === toDate);
  if (i0 < 0) return { ok: false, alert: true, reason: `no ${SYMBOL} bar for the last settled close ${fromDate}` };
  if (i1 <= i0) return { ok: false, reason: `no ${SYMBOL} daily close for ${toDate} yet` };
  if (lastTradeTs != null && lastTradeTs < cal.close) return { ok: false, reason: `the ${toDate} bar is not final yet` };
  const cur = bars[i1];
  let crossCheck;
  try {
    const nd = await nasdaqClose(SYMBOL, toDate);
    if (nd && Math.abs(nd.close - cur.close) > 0.005) return { ok: false, alert: true, reason: `Yahoo ${cur.close} and Nasdaq ${nd.close} disagree on ${toDate}` };
    if (nd) crossCheck = { source: "nasdaq", via: nd.via, close: nd.close, agreed: true };
    else if (now < cal.close + SECOND_SOURCE_GRACE_SECS) return { ok: false, reason: `waiting for Nasdaq's ${toDate} close` };
    else crossCheck = { source: "nasdaq", agreed: null, note: "no second-source close within the grace period; primary used alone" };
  } catch (e) {
    if (now < cal.close + SECOND_SOURCE_GRACE_SECS) return { ok: false, reason: `second source unreachable; retrying` };
    crossCheck = { source: "nasdaq", agreed: null, note: "second source unreachable after the grace period" };
  }
  const r4 = (x) => Math.round(x * 10_000) / 10_000, c4 = (x) => BigInt(Math.round(x * 10_000));
  const steps = bars.slice(i0 + 1, i1 + 1).map((b, k) => ({ date: b.date, prevClose: r4(bars[i0 + k].close), close: r4(b.close), dividend: r4(b.dividend) }));
  return {
    ok: true,
    apply: (v) => steps.reduce((acc, st) => (acc * c4(st.close + st.dividend)) / c4(st.prevClose), v),   // floor per step
    detail: { symbol: SYMBOL, source: "yahoo", date: toDate, close: r4(cur.close), prevDate: fromDate, prevClose: r4(bars[i0].close), dividend: r4(cur.dividend), gapSteps: steps, lastTradeTs, crossCheck },
    evidence: { source: url, response: raw },
  };
}

/**
 * Token value for the session on `date`, chained from the last settled value (or the close itself for the first
 * settlement). { ok: true, value (bigint, 8 decimals), doc } or { ok: false, reason, alert }.
 * `doc` is the evidence: every session's close detail and the raw source responses; its sha256 goes on-chain.
 */
export async function valueFor(date, lastValue, lastDate, now) {
  const evidence = [], details = [];
  let value;
  if (lastValue === 0n || lastDate === null) {
    const m = await closeMove(SYMBOL, date, now);
    if (!m.ok) return { ok: false, reason: m.reason, alert: !!m.alert };
    details.push(m.detail); evidence.push(m.evidence);
    value = BigInt(Math.round(m.detail.close * 10_000)) * (SCALE / 10_000n);
  } else {
    const between = await sessions(addDays(lastDate, 1), date);
    if (!between.length || between[between.length - 1].date !== date) return { ok: false, alert: true, reason: `${date} is not a session after ${lastDate}` };
    value = lastValue;
    if (between.length === 1) {
      const m = await closeMove(SYMBOL, date, now);
      if (!m.ok) return { ok: false, reason: `${date}: ${m.reason}`, alert: !!m.alert };
      details.push({ ...m.detail, movePpm: m.value }); evidence.push(m.evidence);
      value = value * (PPM + BigInt(m.value)) / PPM; // floor; a move is always > −100 %
    } else {
      // Skipped days in between — a data problem, or a closure the rule-based calendar cannot know about: take the
      // move from the last settled close straight to this one over the daily bars that actually exist, so a day that
      // never traded is simply not there (closeMove would wait forever for its bar).
      const g = await gapMove(lastDate, date, now);
      if (!g.ok) return g;
      details.push(g.detail); evidence.push(g.evidence);
      value = g.apply(value);
    }
  }
  const last = details[details.length - 1];
  let chainlink = null, chainlinkOk = false;
  try {
    const cal = await sessions(date, date);
    const cl = await chainlinkAt(cal[0].close);
    if (cl) {
      const mult = cl.multiplier && cl.multiplier > 0n ? cl.multiplier : 10n ** 18n;   // a 0 multiplier is a bad read, not a price
      const expected = BigInt(Math.round(last.close * 10_000)) * (SCALE / 10_000n) * mult / 10n ** 18n;
      if (expected <= 0n || cl.price <= 0n) throw new Error("no usable Chainlink comparison");
      const diff = cl.price > expected ? cl.price - expected : expected - cl.price;
      const diffBps = Number(diff * 10_000n / expected);
      chainlink = { feed: chainCfg.perpFeed, price: cl.price.toString(), updatedAt: cl.updatedAt, multiplier: mult.toString(), expected: expected.toString(), diffBps };
      if (diffBps > CHAINLINK_MAX_BPS) {
        return { ok: false, alert: true, reason: `Chainlink ${Number(cl.price) / 1e8} vs close×multiplier ${Number(expected) / 1e8} differ by ${diffBps} bps (> ${CHAINLINK_MAX_BPS})` };
      }
      chainlinkOk = true;
    }
  } catch (e) {
    chainlink = { error: firstLine(e).replace(/https?:\/\/\S+/g, "<url>") };   // this text is hashed on-chain forever: no URLs in it
  }
  // Two sources must agree before a value goes on-chain: Yahoo's close plus Nasdaq's official close to the cent, or plus
  // Chainlink within the limit. Yahoo alone (Nasdaq silent past its grace period and Chainlink unavailable) holds the day.
  const nasdaqOk = last?.crossCheck?.agreed === true;
  if (!nasdaqOk && !chainlinkOk) {
    return { ok: false, alert: true, reason: `only one source for ${date}: Nasdaq ${last?.crossCheck?.note ?? "has not confirmed"}; Chainlink ${chainlink?.error ?? "unavailable"} — holding until a second source agrees` };
  }
  const doc = { symbol: SYMBOL, date, from: lastDate, lastValue: lastValue.toString(), value: value.toString(), sessions: details, chainlink, evidence };
  return { ok: true, value, doc };
}

export const evidenceHash = (doc) => `0x${crypto.createHash("sha256").update(JSON.stringify(doc)).digest("hex")}`;

// ---------------------------------------------------------------- writes

async function send(wallet, fn, args) {
  const { request } = await publicClient.simulateContract({ address: perpAddress(), abi: perpAbi, functionName: fn, args, account: wallet.account });
  const hash = await wallet.client.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${fn} reverted in ${hash}`);
  return hash;
}

const dirOf = (dataDir) => {
  const d = path.join(dataDir, "perp", CHAIN_KEY, perpAddress().toLowerCase());
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const writeAtomic = (file, text) => { const tmp = `${file}.tmp${process.pid}`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); };

// ---------------------------------------------------------------- steps

/** Keeps the next AHEAD_DAYS of sessions scheduled. */
async function scheduleAhead(wallet, st, now) {
  const lastCutoff = st.lastScheduled ? (await readEpoch(st.lastScheduled)).cutoff : 0;
  const cal = await sessions(nyDate(now), addDays(nyDate(now), AHEAD_DAYS));
  const todo = cal.map((s) => s.close).filter((c) => c > lastCutoff && c > now + 60);
  if (!todo.length) return 0;
  const hash = await send(wallet, "schedule", [todo.map(BigInt)]);
  log(`scheduled ${todo.length} day(s) through ${nyDate(todo[todo.length - 1])} (${hash})`);
  return todo.length;
}

/** Proposes or settles the next day in line. Returns what it did. */
async function advance(wallet, st, now, dataDir) {
  const day = st.lastSettled + 1;
  if (day > st.lastScheduled) return "nothing scheduled";
  const e = await readEpoch(day);
  const date = nyDate(e.cutoff);
  if (e.state === State.Scheduled) {
    if (now < e.cutoff + PROPOSE_DELAY) return `day ${day} (${date}) closes at ${new Date(e.cutoff * 1000).toISOString()}`;
    const r = await valueFor(date, st.lastValue, await lastSettledDate(st), now);
    if (!r.ok) {
      const late = now - e.cutoff > HOLD_ALERT_SECS;
      if (r.alert || late) notify(`Perp ${CHAIN_KEY}: day ${day} (${date}) held`, r.reason, `perp-hold-${day}`, 360);
      return `day ${day} (${date}) held: ${r.reason}`;
    }
    const hash = evidenceHash(r.doc);
    writeAtomic(path.join(dirOf(dataDir), `evidence-${day}.json`), JSON.stringify(r.doc));
    const tx = await send(wallet, "propose", [BigInt(day), r.value, hash]);
    return { did: "proposed", text: `day ${day} (${date}) proposed ${Number(r.value) / 1e8} (${tx})` };
  }
  if (e.state === State.Proposed) {
    if (now < e.proposedAt + st.disputeWindowSecs) return `day ${day} (${date}) in dispute window until ${new Date((e.proposedAt + st.disputeWindowSecs) * 1000).toISOString()}`;
    const tx = await send(wallet, "settle", [BigInt(day)]);
    return { did: "settled", text: `day ${day} (${date}) settled at ${Number(e.value) / 1e8} (${tx})` };
  }
  return `day ${day} in unexpected state ${e.state}`;
}

/** Independent check: recompute the proposed value; alert on any difference. */
async function verify() {
  const st = await readState(), now = await chainNow();
  const day = st.lastSettled + 1;
  if (day > st.lastScheduled) return "nothing scheduled";
  const e = await readEpoch(day);
  if (e.state !== State.Proposed) return `day ${day} not proposed (state ${e.state})`;
  const date = nyDate(e.cutoff);
  const r = await valueFor(date, st.lastValue, await lastSettledDate(st), now);
  const deadline = new Date((e.proposedAt + st.disputeWindowSecs) * 1000).toISOString();
  if (!r.ok) {
    notify(`Perp ${CHAIN_KEY}: cannot verify day ${day} (${date})`, `${r.reason}\nproposed ${Number(e.value) / 1e8}; reject before ${deadline} if in doubt`, `perp-verify-${day}`, 60);
    return `day ${day} unverifiable: ${r.reason}`;
  }
  if (r.value !== e.value) {
    const keyFile = process.env.PERP_GUARDIAN_KEY_FILE;
    if (keyFile) {
      const tx = await send(walletFor(keyFile), "reject", [BigInt(day)]);
      notify(`Perp ${CHAIN_KEY}: day ${day} (${date}) rejected`, `proposed ${e.value} but the sources give ${r.value}; rejected on-chain (${tx}). The operator proposes again on its next run.`, `perp-verify-${day}`, 30);
      return `day ${day} MISMATCH: proposed ${e.value}, recomputed ${r.value} → rejected (${tx})`;
    }
    notify(`Perp ${CHAIN_KEY}: day ${day} (${date}) WRONG — reject it`, `proposed ${e.value} but the sources give ${r.value}; reject before ${deadline}`, `perp-verify-${day}`, 30);
    return `day ${day} MISMATCH: proposed ${e.value}, recomputed ${r.value}`;
  }
  return `day ${day} (${date}) verified ${Number(e.value) / 1e8}`;
}

async function main() {
  guardProcess(log);
  const mode = process.argv[2] ?? "run";
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  if (mode === "verify") { log(await verify()); return; }
  const wallet = walletFor();
  if (mode === "skip") {
    const day = Number(process.argv[3]);
    if (!day) throw new Error("usage: perp.mjs skip <day>");
    log(`skip day ${day}: ${await send(wallet, "skip", [BigInt(day)])}`);
    return;
  }
  const now = await chainNow();
  let st = await readState();
  await scheduleAhead(wallet, st, now);
  // a tick may settle one day and propose the next (backlog after downtime): a few steps at most
  for (let i = 0; i < 4; i++) {
    st = await readState();
    const r = await advance(wallet, st, await chainNow(), dataDir);
    log(typeof r === "string" ? r : r.text);
    if (typeof r === "string" || r.did !== "settled") break;   // after a settle, the next day may already be due
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(async () => { await notifyFlush(); process.exit(0); }, async (e) => { log(`FAILED: ${firstLine(e)}`); await notifyFlush(); process.exit(1); });
}
