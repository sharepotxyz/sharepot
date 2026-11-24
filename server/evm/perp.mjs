// SharePot Perp daily job (Base). One idempotent tick, run from cron every 10 minutes under flock, for every pool of the
// chain (chains.json `perps`: one pool per stock, NVDA, TSLA, META …, and the retired ones — older pools of the same
// stock that the site takes no new entries into, kept running so whoever is in them can exit), one after the other; a
// pool that fails is reported and the next one still runs:
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
// (that is what requiring two agreeing sources before proposing is for). With PERP_GUARDIAN_KEY_FILE (the pools'
// guardian key, which lives only on that host and can do nothing but reject a proposal; the admin key is never loaded) a
// value that differs is rejected on-chain at once — the operator's next tick proposes again from its own reading — and
// reported; without a key it only reports. A value it cannot recompute is reported, never rejected.
// `PERP_SYMBOL=<SYM> node server/evm/perp.mjs skip <day>` skips a day that never traded (an unscheduled closure) in that
// pool: nothing moves and its requests roll into the next day. A held day is never skipped automatically. The contract
// only takes a skip of an unproposed day (reject a proposal first) before the next day's cutoff, and at most 63 in a
// row; past the next cutoff the day has to be proposed (the last settled value moves nothing but funding).
// A close more than the contract's daily cap (maxMoveBps, 50 %) from the last one is beyond the operator key: the job
// holds the day and sends a Telegram instead of reverting every tick, and nothing in that pool settles until
// `PERP_SYMBOL=<SYM> PERP_ADMIN_KEY_FILE=<admin key> perp.mjs admin-propose <day>` (by hand, on the host that holds the
// admin key: /root/stocklana/perp-admin-propose.sh, which also puts the evidence file on the site) recomputes and
// proposes it. A skip would not help: the next day is compared with the same last settled value.
//
//   env: EVM_CHAIN (a chains.json entry with `perps`: [{symbol, pool, token, deployBlock, feed, mainnetToken}]),
//        PERP_SYMBOL (only these pools, comma-separated labels: NVDA = the live NVDA pool, NVDA-old-203e = a retired one), EVM_PROPOSER_KEY_FILE (the operator key), DATA_DIR,
//        PERP_AHEAD_DAYS (14), PERP_PROPOSE_DELAY_SECS (1800), PERP_CHAINLINK_MAX_BPS (100), CHAINLINK_RPC (https://mainnet.base.org)
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
// The feed updates on a 0.5 % move or a heartbeat, so a quiet stock leaves it untouched for a day or more (27.6 h seen
// mid-week; a weekend adds two days): only a last update older than this before the close means a dead feed, and a dead
// feed is no second source (audit 11-22 F003; widened in the second review)
const CHAINLINK_MAX_AGE_SECS = Number(process.env.PERP_CHAINLINK_MAX_AGE_SECS ?? 100 * 3600);
// The second source sees only the day's close; a dividend (Yahoo alone) adds to the move, so a large one waits for a
// human (these stocks pay well under 1 % a quarter)
const MAX_DIVIDEND_YIELD = Number(process.env.PERP_MAX_DIVIDEND_PCT ?? 2) / 100;
// The guardian rejects a proposal it still cannot recompute this close to the end of its dispute window
const REJECT_UNVERIFIED_SECS = Number(process.env.PERP_REJECT_UNVERIFIED_SECS ?? 3600);
// A pool whose tick keeps failing is as stuck as a held day: Telegram after this long failing in a row
const FAIL_ALERT_SECS = Number(process.env.PERP_FAIL_ALERT_SECS ?? 3600);
const HOLD_ALERT_SECS = 2 * 3600; // a day still unproposed this long after its bell is worth a human look
const log = (pool, ...a) => console.log(new Date().toISOString(), `[perp ${CHAIN_KEY}${pool ? " " + pool.label : ""}]`, ...a);

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a ?? "");
/** The chain's pools, in chains.json order (the site shows the live ones in that order). Each: { symbol, tokenSymbol,
 *  address, token, deployBlock, feed, mainnetToken, retired, label }. `label` names the pool in logs, alerts and
 *  PERP_SYMBOL: the symbol for a live pool, "<SYMBOL>-old-<first 4 hex of its address>" for a retired one (two pools of
 *  one stock must never share an alert key). A pool whose address is not a well-formed address is not a pool. */
export const POOLS = (chainCfg.perps ?? []).filter((p) => isAddr(p.pool) && /^[A-Z]{1,6}$/.test(p.symbol ?? "")).map((p) => ({
  symbol: p.symbol, tokenSymbol: p.tokenSymbol ?? `${p.symbol}c`, address: p.pool, token: p.token, deployBlock: Number(p.deployBlock ?? 0),
  feed: isAddr(p.feed) ? p.feed : null, mainnetToken: isAddr(p.mainnetToken) ? p.mainnetToken : null,
  retired: p.retired === true, label: p.retired === true ? `${p.symbol}-old-${p.pool.slice(2, 6).toLowerCase()}` : p.symbol,
}));
/** The pools this run works on: all of them, or only PERP_SYMBOL's labels (comma-separated). */
export function selectedPools() {
  const only = (process.env.PERP_SYMBOL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ps = only.length ? POOLS.filter((p) => only.includes(p.label)) : POOLS;
  if (!ps.length) throw new Error(`chains.json ${CHAIN_KEY}: no perp pool${only.length ? ` for ${only.join(",")}` : ""} (perps: ${POOLS.map((p) => p.label).join(", ") || "none"})`);
  return ps;
}
const contract = (pool) => getContract({ address: pool.address, abi: perpAbi, client: publicClient });

export async function chainNow() {
  const b = await withRetry(() => publicClient.getBlock({ blockTag: "latest" }), 4, "getBlock");
  return Number(b.timestamp);
}

export async function readEpoch(pool, day) {
  const e = await withRetry(() => contract(pool).read.epochs([BigInt(day)]), 4, `${pool.label} epochs(${day})`);
  return { day, cutoff: Number(e[0]), state: Number(e[1]), proposedAt: Number(e[2]), value: e[3], evidence: e[4], rolledTo: Number(e[5]) };
}

export async function readState(pool) {
  const p = contract(pool);
  const [lastScheduled, lastSettled, lastValue, disputeWindowSecs, maxMoveBps] = await withRetry(
    () => Promise.all([p.read.lastScheduled(), p.read.lastSettled(), p.read.lastValue(), p.read.disputeWindowSecs(), p.read.maxMoveBps()]), 4, `${pool.label} state`);
  return { lastScheduled: Number(lastScheduled), lastSettled: Number(lastSettled), lastValue, disputeWindowSecs: Number(disputeWindowSecs), maxMoveBps: Number(maxMoveBps) };
}

/** The signed move from `last` to `value` in bps when it is past `capBps` — the contract's test for a proposal only the
 *  admin may send (`d × BPS > last × maxMoveBps`) — else null. Nothing is past the cap before the first settlement. */
export function overCap(last, value, capBps) {
  if (!last) return null;
  const d = value > last ? value - last : last - value;
  return d * 10_000n > last * BigInt(capBps) ? Number(((value - last) * 10_000n) / last) : null;
}
const pct = (bps) => `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)} %`;

/** The NY session date of the last day that settled with a value (skipped days carry none), or null before the first. */
async function lastSettledDate(pool, st) {
  for (let d = st.lastSettled; d >= 1; d--) {
    const e = await readEpoch(pool, d);
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

/** The pool's feed price as of `ts` (its last update at or before it) and the issuer multiplier now: token value = price.
 *  The feed moves only on a 0.5 % change or a 24 h heartbeat, so it is a sanity check, never the settlement price. */
async function chainlinkAt(pool, ts) {
  if (!pool.feed) return null;
  const latest = await mainnet.readContract({ address: pool.feed, abi: FEED_ABI, functionName: "latestRoundData" });
  const phase = latest[0] >> 64n;
  let agg = latest[0] & ((1n << 64n) - 1n);
  let r = Number(latest[3]) <= ts ? latest : null;
  // walk back 50 rounds per multicall until one was updated at or before ts (NVDA: ~40 updates a trading day)
  for (let batch = 0; !r && batch < 40 && agg > 1n; batch++) {
    const ids = [];
    for (let i = 1n; i <= 50n && agg - i >= 1n; i++) ids.push((phase << 64n) | (agg - i));
    agg -= BigInt(ids.length);
    const res = await mainnet.multicall({ contracts: ids.map((id) => ({ address: pool.feed, abi: FEED_ABI, functionName: "getRoundData", args: [id] })), allowFailure: true });
    r = res.map((x) => (x.status === "success" ? x.result : null)).find((x) => x && Number(x[3]) <= ts) ?? null;
  }
  if (!r) return null; // too far back to look
  let multiplier = null;
  if (pool.mainnetToken) {
    multiplier = await mainnet.readContract({ address: pool.mainnetToken, abi: erc20Abi, functionName: "uiMultiplier" }).catch(() => null);
  }
  return { price: r[1], updatedAt: Number(r[3]), multiplier };
}

// ---------------------------------------------------------------- the value of a day

/** The total-return move of `symbol` from the close of `fromDate` to the close of `toDate` over the daily bars that
 *  exist, with the same guards as closeMove on the target close (final bar, Nasdaq to the cent or its grace period). */
async function gapMove(symbol, fromDate, toDate, now) {
  const [cal] = await sessions(toDate, toDate);
  if (!cal) return { ok: false, alert: true, reason: `${toDate} is not a session` };
  const { bars, raw, url, lastTradeTs } = await yahooDaily(symbol, addDays(fromDate, -7), toDate);
  const i0 = bars.findIndex((b) => b.date === fromDate), i1 = bars.findIndex((b) => b.date === toDate);
  if (i0 < 0) return { ok: false, alert: true, reason: `no ${symbol} bar for the last settled close ${fromDate}` };
  if (i1 <= i0) return { ok: false, reason: `no ${symbol} daily close for ${toDate} yet` };
  if (lastTradeTs != null && lastTradeTs < cal.close) return { ok: false, reason: `the ${toDate} bar is not final yet` };
  const cur = bars[i1];
  let crossCheck;
  try {
    const nd = await nasdaqClose(symbol, toDate);
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
    detail: { symbol, source: "yahoo", date: toDate, close: r4(cur.close), prevDate: fromDate, prevClose: r4(bars[i0].close), dividend: r4(cur.dividend), gapSteps: steps, lastTradeTs, crossCheck },
    evidence: { source: url, response: raw },
  };
}

/**
 * Token value of `pool`'s stock for the session on `date`, chained from the last settled value (or the close itself for
 * the first settlement). { ok: true, value (bigint, 8 decimals), doc } or { ok: false, reason, alert }.
 * `doc` is the evidence: every session's close detail and the raw source responses; its sha256 goes on-chain.
 */
export async function valueFor(pool, date, lastValue, lastDate, now, { knownCloses = null } = {}) {
  const SYMBOL = pool.symbol;
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
      const g = await gapMove(SYMBOL, lastDate, date, now);
      if (!g.ok) return g;
      details.push(g.detail); evidence.push(g.evidence);
      value = g.apply(value);
    }
  }
  const last = details[details.length - 1];
  // Inputs the second source never sees (audit 11-22 F003): the move is (close + dividend) / previous close, and only the
  // close is checked against Nasdaq or Chainlink. The previous close must be the one this host recorded when that day
  // settled — Yahoo rewriting it (a split, a data error) waits for a human — and a dividend over the cap waits too.
  const prev = details[0];
  if (knownCloses && lastDate && knownCloses[lastDate] != null && prev?.prevClose != null && Math.abs(prev.prevClose - knownCloses[lastDate]) > 0.005) {
    // Yahoo restates every earlier close on the new share basis from a split's day on: the split it reports for this
    // session explains the difference exactly (10:1 → the old close is a tenth), and then the day goes ahead
    const m = String(prev.split ?? "").match(/^(\d+(?:\.\d+)?)[:/](\d+(?:\.\d+)?)$/), ratio = m ? Number(m[1]) / Number(m[2]) : NaN;
    const bySplit = Number.isFinite(ratio) && ratio > 0 && Math.abs(prev.prevClose * ratio - knownCloses[lastDate]) <= 0.005 * Math.max(1, ratio);
    if (!bySplit) return { ok: false, alert: true, reason: `Yahoo now gives ${prev.prevClose} for the ${lastDate} close, but ${knownCloses[lastDate]} was recorded when that day settled, and no split on ${date} explains it: holding until Yahoo agrees again (a human who has checked the right close can write it into closes.json in this pool's data folder on both hosts)` };
  }
  for (const d of details) for (const step of d.gapSteps ?? [d]) {
    if (!Number.isFinite(step.dividend) || step.dividend < 0 || !(step.close > 0)) {
      return { ok: false, alert: true, reason: `${step.date}: Yahoo reports a dividend of ${step.dividend} on a close of ${step.close} — not a usable number: holding for a human` };
    }
    if (step.dividend > 0 && step.dividend / step.close > MAX_DIVIDEND_YIELD) {
      return { ok: false, alert: true, reason: `${step.date}: Yahoo reports a dividend of ${step.dividend}, ${((step.dividend / step.close) * 100).toFixed(2)} % of the close — over the ${MAX_DIVIDEND_YIELD * 100} % this job takes without a human (if it is real, raise PERP_MAX_DIVIDEND_PCT on both hosts for that day)` };
    }
  }
  let chainlink = null, chainlinkOk = false;
  try {
    const cal = await sessions(date, date);
    const cl = await chainlinkAt(pool, cal[0].close);
    if (cl && cal[0].close - cl.updatedAt > CHAINLINK_MAX_AGE_SECS) {
      chainlink = { feed: pool.feed, price: cl.price.toString(), updatedAt: cl.updatedAt, stale: true };
      throw new Error(`the feed's last update before the close is ${((cal[0].close - cl.updatedAt) / 3600).toFixed(1)} h old (stuck)`);
    }
    if (cl) {
      const mult = cl.multiplier && cl.multiplier > 0n ? cl.multiplier : 10n ** 18n;   // a 0 multiplier is a bad read, not a price
      const expected = BigInt(Math.round(last.close * 10_000)) * (SCALE / 10_000n) * mult / 10n ** 18n;
      if (expected <= 0n || cl.price <= 0n) throw new Error("no usable Chainlink comparison");
      const diff = cl.price > expected ? cl.price - expected : expected - cl.price;
      const diffBps = Number(diff * 10_000n / expected);
      chainlink = { feed: pool.feed, price: cl.price.toString(), updatedAt: cl.updatedAt, multiplier: mult.toString(), expected: expected.toString(), diffBps };
      if (diffBps > CHAINLINK_MAX_BPS) {
        return { ok: false, alert: true, reason: `Chainlink ${Number(cl.price) / 1e8} vs close×multiplier ${Number(expected) / 1e8} differ by ${diffBps} bps (> ${CHAINLINK_MAX_BPS})` };
      }
      chainlinkOk = true;
    }
  } catch (e) {
    chainlink = { ...(chainlink ?? {}), error: firstLine(e).replace(/https?:\/\/\S+/g, "<url>") };   // this text is hashed on-chain forever: no URLs in it
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

async function send(pool, wallet, fn, args) {
  const { request } = await publicClient.simulateContract({ address: pool.address, abi: perpAbi, functionName: fn, args, account: wallet.account });
  const hash = await wallet.client.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${pool.label} ${fn} reverted in ${hash}`);
  return hash;
}

/** DATA_DIR/perp/<chain>/<pool address>: the pool's evidence files (the site serves them) and this host's notes. */
export const poolDir = (pool, dataDir) => {
  const d = path.join(dataDir, "perp", CHAIN_KEY, pool.address.toLowerCase());
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const writeAtomic = (file, text) => { const tmp = `${file}.tmp${process.pid}`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); };

/** The close of each session this host proposed or verified (NY date → close), from its evidence files and closes.json:
 *  valueFor holds a day whose previous close Yahoo now reports differently (audit 11-22 F003). */
export function knownCloses(pool, dataDir) {
  const dir = poolDir(pool, dataDir), out = {};
  for (const f of fs.readdirSync(dir)) {
    if (!/^evidence-\d+\.json$/.test(f)) continue;
    try { const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); const last = d.sessions?.[d.sessions.length - 1]; if (d.date && last?.close != null) out[d.date] = last.close; } catch {}
  }
  try { Object.assign(out, JSON.parse(fs.readFileSync(path.join(dir, "closes.json"), "utf8"))); } catch {}
  return out;
}
function recordClose(pool, dataDir, date, doc) {
  const last = doc?.sessions?.[doc.sessions.length - 1];
  if (last?.close == null) return;
  const f = path.join(poolDir(pool, dataDir), "closes.json");
  let m = {}; try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  m[date] = last.close;
  writeAtomic(f, JSON.stringify(Object.fromEntries(Object.keys(m).sort().slice(-90).map((k) => [k, m[k]]))));
}
/** A day the operator could legitimately have scheduled: an NYSE session after the last settled one, its cutoff that
 *  session's close. Anything else can never be right, whatever the sources say (audit 11-22 F002). */
async function realSession(date, cutoff, lastDate) {
  const [cal] = await sessions(date, date);
  if (!cal) return `${date} is not an NYSE session`;
  if (cal.close !== cutoff) return `its cutoff ${new Date(cutoff * 1000).toISOString()} is not the ${date} close (${new Date(cal.close * 1000).toISOString()})`;
  if (lastDate && date <= lastDate) return `${date} is not after the last settled session ${lastDate}`;
  return null;
}
/** Consecutive failed ticks of one pool in one mode (RPC or a source down, a bug): after FAIL_ALERT_SECS in a row one
 *  Telegram every 6 h; the streak ends on the first good tick (audit 11-22 F001: a failure used to be a log line only). */
function failStreak(pool, dataDir, mode, err) {
  const f = path.join(poolDir(pool, dataDir), `failing-${mode}.json`);
  if (!err) { try { fs.unlinkSync(f); } catch {} return; }
  let st = null; try { st = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  const now = Math.floor(Date.now() / 1000);
  if (!st?.since) st = { since: now };
  st.last = firstLine(err).replace(/https?:\/\/\S+/g, "<url>");
  writeAtomic(f, JSON.stringify(st));
  if (now - st.since >= FAIL_ALERT_SECS) notify(`${title(pool)}: ${mode} failing for ${Math.round((now - st.since) / 60)} min`, `${st.last}\n(看 log:VPS ~/logs/perp-base-sepolia.log 或東京 /root/stocklana/logs/verify-cron-perp.log)`, `perp-failing-${mode}-${pool.label}`, 360);
}
const title = (pool) => `Perp ${CHAIN_KEY} ${pool.label}`;

// ---------------------------------------------------------------- steps

/** Keeps the next AHEAD_DAYS of sessions scheduled. */
async function scheduleAhead(pool, wallet, st, now) {
  const lastCutoff = st.lastScheduled ? (await readEpoch(pool, st.lastScheduled)).cutoff : 0;
  const cal = await sessions(nyDate(now), addDays(nyDate(now), AHEAD_DAYS));
  const todo = cal.map((s) => s.close).filter((c) => c > lastCutoff && c > now + 60);
  if (!todo.length) return 0;
  const hash = await send(pool, wallet, "schedule", [todo.map(BigInt)]);
  log(pool, `scheduled ${todo.length} day(s) through ${nyDate(todo[todo.length - 1])} (${hash})`);
  return todo.length;
}

/** Proposes or settles the next day in line. Returns what it did. */
async function advance(pool, wallet, st, now, dataDir) {
  const day = st.lastSettled + 1;
  if (day > st.lastScheduled) return "nothing scheduled";
  const e = await readEpoch(pool, day);
  const date = nyDate(e.cutoff);
  if (e.state === State.Scheduled) {
    if (now < e.cutoff + PROPOSE_DELAY) return `day ${day} (${date}) closes at ${new Date(e.cutoff * 1000).toISOString()}`;
    const lastDate = await lastSettledDate(pool, st), fake = await realSession(date, e.cutoff, lastDate);
    if (fake) {   // a calendar change or a bad schedule: proposing would only be rejected by the guardian, every tick
      notify(`${title(pool)}: day ${day} (${date}) is not a real session`, `${fake}. Nothing is proposed for it; skip it: PERP_SYMBOL=${pool.symbol} node server/evm/perp.mjs skip ${day}`, `perp-fake-${pool.label}-${day}`, 360);
      return `day ${day} (${date}) held: not a real session (${fake})`;
    }
    let r;
    try { r = await valueFor(pool, date, st.lastValue, lastDate, now, { knownCloses: knownCloses(pool, dataDir) }); }
    catch (err) { r = { ok: false, reason: `the price sources failed: ${firstLine(err).replace(/https?:\/\/\S+/g, "<url>")}` }; }
    if (!r.ok) {
      const late = now - e.cutoff > HOLD_ALERT_SECS;
      if (r.alert || late) notify(`${title(pool)}: day ${day} (${date}) held`, r.reason, `perp-hold-${pool.label}-${day}`, 360);
      return `day ${day} (${date}) held: ${r.reason}`;
    }
    // Past the operator's daily cap the contract refuses this key: sending would only revert every tick, and a revert is
    // logged, never sent anywhere. The pool stays unsettled (no entry or exit fills) until a human decides — so it goes
    // to Telegram with the one command that proposes it with the admin key. No evidence file is written here: the
    // admin's run writes the one whose hash goes on-chain, and the site must serve exactly those bytes.
    const mv = overCap(st.lastValue, r.value, st.maxMoveBps);
    if (mv !== null) {
      const cap = `${st.maxMoveBps / 100} %`;
      notify(`${title(pool)}: day ${day} (${date}) moved ${pct(mv)}, past the ${cap} cap — needs the admin`,
        `單日 ${pct(mv)} 超過合約上限 ${cap}，營運鑰匙送不出這個收盤價。送出前這個池子不會對帳：所有進場、出場都在排隊，沒人能出場。\n` +
        `先確認這個漲跌是真的（不是拆股或資料錯誤），再在東京跑：\n/root/stocklana/perp-admin-propose.sh ${pool.label} ${day}\n` +
        `它會在東京重算一次（要兩個來源一致）再用管理員鑰匙送出；之後照常 6 小時異議期、東京核對、VPS 對帳。`,
        `perp-overcap-${pool.label}-${day}`, 360);
      return `day ${day} (${date}) held: ${pct(mv)} since the last close is past the operator's ${cap} cap; the admin has to propose it (perp-admin-propose.sh; Telegram sent)`;
    }
    const hash = evidenceHash(r.doc);
    writeAtomic(path.join(poolDir(pool, dataDir), `evidence-${day}.json`), JSON.stringify(r.doc));
    const tx = await send(pool, wallet, "propose", [BigInt(day), r.value, hash]);
    return { did: "proposed", text: `day ${day} (${date}) proposed ${Number(r.value) / 1e8} (${tx})` };
  }
  if (e.state === State.Proposed) {
    if (now < e.proposedAt + st.disputeWindowSecs) return `day ${day} (${date}) in dispute window until ${new Date((e.proposedAt + st.disputeWindowSecs) * 1000).toISOString()}`;
    const tx = await send(pool, wallet, "settle", [BigInt(day)]);
    return { did: "settled", text: `day ${day} (${date}) settled at ${Number(e.value) / 1e8} (${tx})` };
  }
  return `day ${day} in unexpected state ${e.state}`;
}

// The last proposal this host recomputed and matched. A proposal on-chain never changes (a new one has a new
// proposedAt), so once it has matched, the sources failing to give the day later on (Yahoo blanks the newest daily
// close for a while around 8 pm New York) says nothing about it: logged, not sent. A reason flagged for a human (alert)
// and any mismatch still go out as before.
const verifiedFile = (pool, dataDir) => path.join(poolDir(pool, dataDir), "verified.json");
export const sameProposal = (m, e) => !!m && m.day === e.day && m.proposedAt === e.proposedAt && m.value === e.value.toString();
const readVerified = (pool, dataDir) => { try { return JSON.parse(fs.readFileSync(verifiedFile(pool, dataDir), "utf8")); } catch { return null; } };

/** Independent check: recompute the proposed value; alert on any difference. */
async function verify(pool, dataDir) {
  const st = await readState(pool), now = await chainNow();
  const day = st.lastSettled + 1;
  if (day > st.lastScheduled) return "nothing scheduled";
  const e = await readEpoch(pool, day);
  if (e.state !== State.Proposed) return `day ${day} not proposed (state ${e.state})`;
  const date = nyDate(e.cutoff), lastDate = await lastSettledDate(pool, st);
  const deadline = new Date((e.proposedAt + st.disputeWindowSecs) * 1000).toISOString();
  const key = `perp-verify-${pool.label}-${day}`;
  const keyFile = process.env.PERP_GUARDIAN_KEY_FILE;
  const reject = async (why) => {
    let tx;
    try { tx = await send(pool, walletFor(keyFile), "reject", [BigInt(day)]); }
    catch (err) {   // the window may be closing: a human has to know now, not after the failure streak's hour
      notify(`${title(pool)}: day ${day} (${date}) could NOT be rejected`, `${why}; the reject failed: ${firstLine(err).replace(/https?:\/\/\S+/g, "<url>")}. Reject it by hand before ${deadline}.`, `perp-rejectfail-${pool.label}-${day}`, 30);
      throw err;
    }
    notify(`${title(pool)}: day ${day} (${date}) rejected`, `${why}; rejected on-chain (${tx}). The operator proposes again on its next run.`, `perp-reject-${pool.label}-${day}`, 30);
    return `day ${day} ${why} → rejected (${tx})`;
  };
  // a day no honest operator could have scheduled: rejected at once, without asking the sources (audit 11-22 F002)
  const fake = await realSession(date, e.cutoff, lastDate);
  if (fake) {
    if (keyFile) return reject(`proposed ${Number(e.value) / 1e8} for a day that is not a real session: ${fake}`);
    notify(`${title(pool)}: day ${day} (${date}) is not a real session — reject it`, `${fake}; proposed ${Number(e.value) / 1e8}; reject before ${deadline}`, key, 30);
    return `day ${day} NOT A SESSION: ${fake}`;
  }
  let r;
  try { r = await valueFor(pool, date, st.lastValue, lastDate, now, { knownCloses: knownCloses(pool, dataDir) }); }
  catch (err) { r = { ok: false, reason: `the price sources failed: ${firstLine(err).replace(/https?:\/\/\S+/g, "<url>")}` }; }
  if (!r.ok) {
    const seen = readVerified(pool, dataDir);
    if (!r.alert && sameProposal(seen, e)) return `day ${day} (${date}) not recomputable right now (${r.reason}); this proposal already matched at ${seen.at}: not alerting`;
    // never checked, and the window is about to close: a value nobody could confirm does not settle (fail closed)
    if (keyFile && !sameProposal(seen, e) && now >= e.proposedAt + st.disputeWindowSecs - REJECT_UNVERIFIED_SECS) {
      return reject(`proposed ${Number(e.value) / 1e8} but this host could not recompute it before the dispute window's last hour (${r.reason})`);
    }
    const selfReject = keyFile && !sameProposal(seen, e) ? " (this host rejects it itself in the window's last hour if it still cannot)" : "";
    notify(`${title(pool)}: cannot verify day ${day} (${date})`, `${r.reason}\nproposed ${Number(e.value) / 1e8}; reject before ${deadline} if in doubt${selfReject}`, `${key}-${e.proposedAt}`, 360);
    return `day ${day} unverifiable: ${r.reason}`;
  }
  if (r.value !== e.value) {
    if (keyFile) return reject(`MISMATCH: proposed ${e.value}, recomputed ${r.value}`);
    notify(`${title(pool)}: day ${day} (${date}) WRONG — reject it`, `proposed ${e.value} but the sources give ${r.value}; reject before ${deadline}`, key, 30);
    return `day ${day} MISMATCH: proposed ${e.value}, recomputed ${r.value}`;
  }
  recordClose(pool, dataDir, date, r.doc);
  writeAtomic(verifiedFile(pool, dataDir), JSON.stringify({ day, proposedAt: e.proposedAt, value: e.value.toString(), at: new Date().toISOString() }));
  return `day ${day} (${date}) verified ${Number(e.value) / 1e8}`;
}

/** By hand, with the admin key: proposes a day the operator cannot because its move is past the daily cap. The value is
 *  recomputed here from the same sources and under the same two-source rule; a day within the cap is refused (the
 *  operator's job proposes it). The dispute window, the independent verify and the settle then run as on any day. */
async function adminPropose(pool, day, dataDir) {
  const keyFile = process.env.PERP_ADMIN_KEY_FILE;
  if (!keyFile) throw new Error("admin-propose needs PERP_ADMIN_KEY_FILE (the pool's admin key)");
  const wallet = walletFor(keyFile);
  const admin = await withRetry(() => contract(pool).read.admin(), 4, `${pool.label} admin`);
  if (admin.toLowerCase() !== wallet.account.address.toLowerCase()) throw new Error(`${keyFile} is ${wallet.account.address}, not the pool's admin ${admin}`);
  const st = await readState(pool), now = await chainNow();
  if (day !== st.lastSettled + 1) throw new Error(`day ${day} is not next in line (the next is ${st.lastSettled + 1})`);
  const e = await readEpoch(pool, day);
  if (e.state !== State.Scheduled) throw new Error(`day ${day} is not waiting for a proposal (state ${e.state})`);
  const date = nyDate(e.cutoff);
  if (now < e.cutoff + PROPOSE_DELAY) throw new Error(`day ${day} (${date}): too soon after the bell, try after ${new Date((e.cutoff + PROPOSE_DELAY) * 1000).toISOString()}`);
  const r = await valueFor(pool, date, st.lastValue, await lastSettledDate(pool, st), now);
  if (!r.ok) throw new Error(`day ${day} (${date}) has no value on this host: ${r.reason}`);
  const mv = overCap(st.lastValue, r.value, st.maxMoveBps);
  if (mv === null) throw new Error(`day ${day} (${date}) moved within the operator's ${st.maxMoveBps / 100} % cap: the VPS job proposes it, not the admin`);
  const file = path.join(poolDir(pool, dataDir), `evidence-${day}.json`);
  writeAtomic(file, JSON.stringify(r.doc));
  const tx = await send(pool, wallet, "propose", [BigInt(day), r.value, evidenceHash(r.doc)]);
  return `day ${day} (${date}) proposed by the admin at ${Number(r.value) / 1e8}, ${pct(mv)} (${tx}); evidence ${file}`;
}

/** One pool's tick. */
async function runPool(pool, wallet, dataDir) {
  const now = await chainNow();
  let st = await readState(pool);
  await scheduleAhead(pool, wallet, st, now);
  // a tick may settle one day and propose the next (backlog after downtime): a few steps at most
  for (let i = 0; i < 4; i++) {
    st = await readState(pool);
    const r = await advance(pool, wallet, st, await chainNow(), dataDir);
    log(pool, typeof r === "string" ? r : r.text);
    if (typeof r === "string" || r.did !== "settled") break;   // after a settle, the next day may already be due
  }
}

async function main() {
  guardProcess((...a) => log(null, ...a));
  const mode = process.argv[2] ?? "run";
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  const pools = selectedPools();
  if (mode === "skip") {
    const day = Number(process.argv[3]);
    if (!day) throw new Error("usage: PERP_SYMBOL=<SYM> perp.mjs skip <day>");
    if (pools.length !== 1) throw new Error(`skip is for one pool: set PERP_SYMBOL to one of ${POOLS.map((p) => p.label).join(", ")}`);
    log(pools[0], `skip day ${day}: ${await send(pools[0], walletFor(), "skip", [BigInt(day)])}`);
    return;
  }
  if (mode === "admin-propose") {
    const day = Number(process.argv[3]);
    if (!day) throw new Error("usage: PERP_SYMBOL=<SYM> PERP_ADMIN_KEY_FILE=<key> perp.mjs admin-propose <day>");
    if (pools.length !== 1) throw new Error(`admin-propose is for one pool: set PERP_SYMBOL to one of ${POOLS.map((p) => p.label).join(", ")}`);
    log(pools[0], await adminPropose(pools[0], day, dataDir));
    return;
  }
  const wallet = mode === "verify" ? null : walletFor();
  // pools one after the other (one key, one nonce); one pool failing never stops the others
  let failed = 0;
  for (const pool of pools) {
    try {
      if (mode === "verify") log(pool, await verify(pool, dataDir));
      else await runPool(pool, wallet, dataDir);
      failStreak(pool, dataDir, mode, null);
    } catch (e) { failed++; log(pool, `FAILED: ${firstLine(e)}`); try { failStreak(pool, dataDir, mode, e); } catch {} }
  }
  if (failed) throw Object.assign(new Error(`${failed} of ${pools.length} pool(s) failed`), { perPool: true });   // each pool's own streak alerts
}

/** The whole run failing before any pool (a key file, chains.json, the RPC): the same 1 h streak, one file per mode
 *  (audit 11-22 second review R8). A run whose only failures are pools' own is not counted here: their streaks alert. */
function runStreak(err) {
  const dir = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "perp", CHAIN_KEY);
  const f = path.join(dir, `failing-run-${process.argv[2] ?? "run"}.json`);
  if (!err || err.perPool) { try { fs.unlinkSync(f); } catch {} return; }
  fs.mkdirSync(dir, { recursive: true });
  let st = null; try { st = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  const now = Math.floor(Date.now() / 1000);
  if (!st?.since) st = { since: now };
  st.last = firstLine(err).replace(/https?:\/\/\S+/g, "<url>");
  writeAtomic(f, JSON.stringify(st));
  if (now - st.since >= FAIL_ALERT_SECS) notify(`Perp ${CHAIN_KEY}: every ${process.argv[2] ?? "run"} failing for ${Math.round((now - st.since) / 60)} min`, st.last, `perp-failing-run-${process.argv[2] ?? "run"}`, 360);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(async () => { try { runStreak(null); } catch {} await notifyFlush(); process.exit(0); },
    async (e) => { log(null, `FAILED: ${firstLine(e)}`); try { runStreak(e); } catch {} await notifyFlush(); process.exit(1); });
}
