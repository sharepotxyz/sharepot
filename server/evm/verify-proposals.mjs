// Independent check of every proposed result on the EVM deployment, run where the contract admin's key lives (Tokyo) —
// NOT on the app host. Mirrors ../verify-proposals.mjs for Solana: the proposer (the app host's hot key) publishes the
// value a market settles on, and the dispute window (one hour here) is the only thing between a wrong or hostile
// proposal and the payout. This job re-derives the value from its own sources and, if the range it lands in is not the
// proposed one, or no source answered before the window is about to close, calls voidMarket (admin only: every stake
// refunded) and says so. Until the 2026-10-20 audit (M2) nobody checked the EVM proposer at all.
//   Stocks ("<SYMBOL>.close:<date>"): Yahoo + Nasdaq official closes (prices.mjs closeMove, the resolver's own rule).
//   Memes  ("<SYMBOL>.day:<date>"): this host samples DexScreener and GeckoTerminal every minute itself
//     (sample-prices.mjs with TOKENS_API, into DATA_DIR/evm/<chain>/ticks) and applies the resolver's closing-hour rule
//     (prices.mjs chainMove) to its own samples. Without own samples for the baseline day (its first day) it falls back
//     to GeckoTerminal minute candles of the token's deepest Robinhood Chain pool.
//   env: EVM_CHAIN, EVM_ADMIN_KEY_FILE, DATA_DIR, API (the site: the testnet mock → mainnet token map), DRY_RUN=1,
//        VOID_UNVERIFIED=1|0 (default 1), NOTIFY_EXEC / NOTIFY_STATE (notify.mjs)
import fs from "node:fs";
import path from "node:path";
import { closeMove, chainMove, chainClose, parseMetric, movePpm, bucketOf, utcMidnight, addDays } from "../prices.mjs";
import { notify } from "../notify.mjs";
import { unverifiedAction, comparisonAction, BOUNDARY_PPM as DEFAULT_BOUNDARY_PPM } from "../verify-policy.mjs";
import { guardProcess } from "../retry.mjs";
import { CHAIN_KEY, chainCfg, walletFor, allMarkets, readConfig, send, Status, explorerTx } from "./chain.mjs";
import { evmDir } from "./index-events.mjs";
guardProcess();

const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "verify-data");
const DIR = evmDir(DATA);
const API = process.env.API ?? "https://robinhood.sharepot.xyz";
const DRY = process.env.DRY_RUN === "1";
const VOID_UNVERIFIED = (process.env.VOID_UNVERIFIED ?? "1") === "1";
const BOUNDARY_PPM = Number(process.env.BOUNDARY_PPM ?? DEFAULT_BOUNDARY_PPM);
const MIN_CANDLES = 30;
const EVM_SOURCES = { primary: "dexscreener", primaryNote: "api.dexscreener.com (the pool recorded at selection)", secondary: "geckoterminal", secondaryNote: "api.geckoterminal.com" };
const keyFile = process.env.EVM_ADMIN_KEY_FILE; if (!keyFile) { console.error("EVM_ADMIN_KEY_FILE required"); process.exit(2); }
const admin = walletFor(keyFile);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 160);
fs.mkdirSync(DIR, { recursive: true });
const STATE = path.join(DIR, "verified.json");
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } })();
const saveState = () => { fs.writeFileSync(STATE + ".tmp", JSON.stringify(state, null, 1)); fs.renameSync(STATE + ".tmp", STATE); };

// ---------- the token a market's quotes are for ----------
// On the live chain the market's own token is the one quoted. On the test network markets sit on mocks; the site's
// listing maps a mock to the mainnet token it stands in for — the one thing taken from the app host, as on Solana devnet.
let listing = null;
async function mainnetTokenOf(token) {
  if (!chainCfg.test) return String(token).toLowerCase();
  if (!listing) listing = (await (await fetch(`${API}/api/stocks`, { signal: AbortSignal.timeout(15_000) })).json()).stocks ?? [];
  const t = listing.flatMap((s) => s.tokens).find((x) => String(x.mint ?? "").toLowerCase() === String(token).toLowerCase());
  return t?.mainnetMint ? String(t.mainnetMint).toLowerCase() : null;
}

// ---------- GeckoTerminal: closing-hour median of the token's deepest pool (the first-day fallback) ----------
const gecko = async (p) => {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://api.geckoterminal.com/api/v2${p}`, { headers: { "user-agent": "Mozilla/5.0 (SharePot verifier)", accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 429 && attempt < 3) { await sleep(20_000); continue; }
    if (!r.ok) throw new Error(`geckoterminal ${r.status} ${p.split("?")[0]}`);
    return r.json();
  }
};
const pools = new Map();
async function poolOf(token) {
  if (!pools.has(token)) {
    const list = (await gecko(`/networks/robinhood/tokens/${token}/pools?page=1`)).data ?? [];
    list.sort((a, b) => Number(b.attributes?.reserve_in_usd ?? 0) - Number(a.attributes?.reserve_in_usd ?? 0));
    if (!list.length) throw new Error(`no pool on GeckoTerminal for ${token}`);
    const top = list[0], base = String(top.relationships?.base_token?.data?.id ?? "").toLowerCase();
    pools.set(token, { pool: top.id.split("_").slice(1).join("_"), side: base.endsWith(token) ? "base" : "quote", name: top.attributes?.name });
    await sleep(2500);
  }
  return pools.get(token);
}
async function closingMedian(token, date) {
  const { pool, side } = await poolOf(token);
  const start = utcMidnight(date) + 23 * 3600, end = utcMidnight(date) + 24 * 3600;
  const list = (await gecko(`/networks/robinhood/pools/${pool}/ohlcv/minute?aggregate=1&limit=60&before_timestamp=${end}&currency=usd&token=${side}`)).data?.attributes?.ohlcv_list ?? [];
  await sleep(2500);
  const closes = list.filter((c) => c[0] >= start && c[0] < end && c[4] > 0).map((c) => c[4]);
  if (closes.length < MIN_CANDLES) throw new Error(`only ${closes.length} closing-hour candles for ${date}`);
  const s = [...closes].sort((a, b) => a - b), n = s.length;
  return { median: n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2, candles: n };
}

// ---------- the check ----------
async function independentValue(m, spec, now, thr) {
  if (spec.kind === "close") {
    const ev = await closeMove(spec.symbol, spec.date, now, thr);
    return ev.ok ? { value: ev.value, detail: `${ev.detail.prevClose} → ${ev.detail.close} (${ev.detail.source}${ev.detail.crossCheck?.agreed ? " + nasdaq" : ""})` } : { error: ev.reason };
  }
  const token = await mainnetTokenOf(m.token); if (!token) return { error: `no mainnet token known for ${spec.symbol} (${m.token})` };
  const own = chainMove(DIR, token, spec.symbol, spec.date, now, thr, EVM_SOURCES);
  if (own.ok) return { value: own.value, detail: `$${own.detail.baseline} → $${own.detail.close} (own samples ${own.detail.prevSamples}/${own.detail.samples}${own.detail.crossCheck?.agreed ? ", geckoterminal agrees" : ""})` };
  if (chainClose(DIR, token, addDays(spec.date, -1)).ok) return { error: own.reason };   // baseline known, today short: wait
  const prev = await closingMedian(token, addDays(spec.date, -1)), cur = await closingMedian(token, spec.date);
  return { value: movePpm(prev.median, cur.median), detail: `$${prev.median} → $${cur.median} (geckoterminal ${pools.get(token).name}, ${prev.candles}/${cur.candles} candles; no own samples for the baseline day)` };
}

const cfg = await readConfig();
if (String(cfg.admin).toLowerCase() !== admin.account.address.toLowerCase()) { console.error(`EVM_ADMIN_KEY_FILE ${admin.account.address} is not the contract admin ${cfg.admin}`); process.exit(2); }
const now = Math.floor(Date.now() / 1000);
const markets = await allMarkets(), proposed = markets.filter((m) => m.status === Status.Proposed);
log(`chain=${CHAIN_KEY} markets=${markets.length} proposed=${proposed.length}${DRY ? " DRY RUN" : ""}`);
let checked = 0, agreed = 0, voided = 0; const late = [];
const voidMarket = async (id) => (await send(admin, "voidMarket", [BigInt(id)])).hash;
for (const m of proposed) {
  const key = String(m.id), id = m.id, metric = m.metric, spec = parseMetric(metric);
  const windowEnd = m.proposedAt + cfg.disputeWindowSecs;
  const done = state[key];
  if (done && done.proposedAt === m.proposedAt && done.verdict !== "pending") continue;   // same proposal, already judged
  if (!spec) { log(`#${id}: unknown metric ${metric}`); continue; }
  const thr = m.thresholds, pv = m.proposedValue, pb = m.proposedOutcome;
  let r; try { r = await independentValue(m, spec, now, thr); } catch (e) { r = { error: short(e) }; }
  checked++;
  if (r.error) {
    log(`#${id} ${metric}: cannot verify yet — ${r.error} (window closes ${new Date(windowEnd * 1000).toISOString()})`);
    const act = unverifiedAction({ now: Math.floor(Date.now() / 1000), proposedAt: m.proposedAt, windowEnd, voidUnverified: VOID_UNVERIFIED });
    if (act === "void") {
      log(`#${id} ${metric}: UNVERIFIED with the window closing — voiding, every stake refunded`);
      if (DRY) { log(`  would void #${id}`); continue; }
      try {
        const tx = await voidMarket(id); voided++;
        log(`  VOIDED #${id} ${explorerTx(tx)}`);
        notify("⛔ 核對不到，已自動作廢退款（Robinhood）", `#${id} ${metric}\n提案 ${pv} ppm → 第 ${pb} 格，但獨立查價到窗快關都沒答案：${r.error}\n沒核對過的結果不放行，已 void，下一輪全額退款。不需處理；若連續發生請看東京的 Robinhood 取樣（sample-cron）與價源。`, `evm-verify-void:${key}`, 60);
        state[key] = { proposedAt: m.proposedAt, verdict: "voided-unverified", proposed: pv, error: r.error, tx, at: new Date().toISOString() }; saveState();
      } catch (e) {
        log(`  void failed: ${short(e)}`);
        notify("⛔ 核對不到且自動作廢失敗（Robinhood）", `#${id} ${metric}\n${short(e)}\n下一輪（10 分內）會自動再試；窗到 ${new Date(windowEnd * 1000).toISOString()}，過了就會照提案結算。`, `evm-verify-fail:${key}`, 60);
      }
      continue;
    }
    if (act === "report") late.push(`#${id} ${metric}: 提案 ${pv} ppm → 第 ${pb} 格；${r.error}（窗到 ${new Date(windowEnd * 1000).toISOString()}）`);
    state[key] = { proposedAt: m.proposedAt, verdict: "pending", error: r.error, at: new Date().toISOString() }; saveState();
    continue;
  }
  const mb = bucketOf(thr, r.value), dist = Math.min(...thr.map((t) => Math.abs(r.value - t)));
  if (mb === pb) {
    agreed++;
    log(`#${id} ${metric}: agrees — proposed ${pv} ppm, independent ${r.value} ppm ${r.detail}, both range ${pb}`);
    state[key] = { proposedAt: m.proposedAt, verdict: "ok", proposed: pv, independent: r.value, at: new Date().toISOString() }; saveState();
    continue;
  }
  const onBoundary = comparisonAction({ proposedBucket: pb, independentBucket: mb, distToBoundaryPpm: dist, boundaryPpm: BOUNDARY_PPM }) === "void-boundary";
  log(`#${id} ${metric}: MISMATCH${onBoundary ? ` (${dist} ppm from a boundary)` : ""} — proposed ${pv} ppm (range ${pb}), independent ${r.value} ppm (range ${mb}) ${r.detail}`);
  if (DRY) { log(`  would void #${id}`); continue; }
  try {
    const tx = await voidMarket(id); voided++;
    log(`  VOIDED #${id} ${explorerTx(tx)}`);
    notify(onBoundary ? "⛔ 兩邊分在不同格（值貼著邊界），已自動作廢退款（Robinhood）" : "⛔ 提案與獨立查價不符，已作廢退款（Robinhood）",
      `#${id} ${metric}\n提案 ${pv} ppm → 第 ${pb} 格； 獨立查價 ${r.value} ppm → 第 ${mb} 格\n${r.detail}\n` + (onBoundary
        ? `離邊界 ${dist} ppm（${(dist / 10000).toFixed(2)}%） ，兩個價源本來就會差一點。兩台不同意就退款，沒有任何一台能單獨決定勝負；已自動處理，不需處理。`
        : `已用 admin 金鑰 void，下一輪全額退款。若 app 主機沒被動過，請查價源；若提案者被入侵，先換 proposer 金鑰（updateConfig）。`),
      `evm-verify-void:${key}`, 60);
    state[key] = { proposedAt: m.proposedAt, verdict: onBoundary ? "voided-boundary" : "voided", proposed: pv, independent: r.value, tx, at: new Date().toISOString() }; saveState();
  } catch (e) {
    log(`  void failed: ${short(e)}`);
    notify("⛔ 提案不符且自動作廢失敗（Robinhood）", `#${id} ${metric}\n提案 ${pv} ppm（第 ${pb} 格） vs 獨立 ${r.value} ppm（第 ${mb} 格）\n${short(e)}\n下一輪（10 分內）會自動再試；窗到 ${new Date(windowEnd * 1000).toISOString()}。連續失敗才需要看 admin 鑰匙的 ETH 與 RPC。`, `evm-verify-fail:${key}`, 60);
  }
}
if (late.length) notify("⚠️ 提案超過半小時還沒核對到（Robinhood）", `${late.length} 個盤獨立查價還沒答案：\n${late.slice(0, 15).join("\n")}\n每 10 分會重試；到窗關前 15 分仍沒答案就自動作廢退款。僅供知悉，不需處理。`, "evm-verify-late", 360);
log(`done: checked ${checked}, agreed ${agreed}, voided ${voided}, unverifiable ${late.length}`);
process.exit(0);
