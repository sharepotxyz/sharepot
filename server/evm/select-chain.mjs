// Picks the memes that get a pool for the next UTC day on the EVM deployment: the ten Robinhood Chain tokens with the
// most 24-hour traded volume that pass the safety filters, recorded in <data>/evm/<chain>/chain-tokens.json (the same
// registry shape as server/select-chain.mjs keeps for Solana). Runs at 11:00 UTC for the NEXT day, like the Solana one.
//   env: DATA_DIR, EVM_CHAIN, N (10), FOR_DATE (YYYY-MM-DD, default: tomorrow UTC), DRY_RUN=1
//
// Universe: Robinhood Chain has no top-traded list (GeckoTerminal's network listing is empty for it, DexScreener's
// screener is browser-only), but nearly every pool there quotes WETH or USDG, so GeckoTerminal's pool search for
// those two words, a few pages each, lists the traded pools; volume is summed per base token across its pools.
// Filters: not a stock token (Robinhood's own, by name), not a stable / wrapped / bridged asset by symbol, liquidity
// ≥ MIN_LIQUIDITY_USD in its deepest pool that is itself ≥ MIN_AGE_DAYS old, first pool ≥ MIN_AGE_DAYS old, price below
// $9,000 (picodollar range). The pool recorded for the sampler is then looked up on DexScreener, the sampler's own
// source (dexscreenerPool below); a token with no usable pair there is not picked.
// Ranges: down / flat / up, cut at ± the median absolute daily move over the deepest pool's last 60 daily bars
// (GeckoTerminal OHLCV; pools without history — Uniswap v4 ids — fall back to ±8 %), rounded to 0.5 %, [1 %, 25 %].
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, parseAbiItem } from "viem";
import { readRegistry, writeRegistry, niceAmount } from "../chain-tokens.mjs";
import { utcDate, addDays } from "../prices.mjs";
import { CHAIN_KEY, chainCfg, chains } from "./chain.mjs";
import { evmDir } from "./index-events.mjs";

const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DIR = evmDir(DATA);
const N = Number(process.env.N ?? 10), DRY = process.env.DRY_RUN === "1";
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD ?? 100_000), MIN_AGE_DAYS = Number(process.env.MIN_AGE_DAYS ?? 3);
const FAUCET_USD = 25;
const PAGES = Number(process.env.GT_PAGES ?? 5);
// the memes trade on Robinhood Chain mainnet; the testnet deployment reads them there and mints mocks for betting
const NET = "robinhood";
const mainnetRpc = chainCfg.mainnetRpc ?? chains.robinhood?.rpc ?? "https://robinhood.drpc.org";
const mainnet = createPublicClient({ transport: http(mainnetRpc, { batch: true, retryCount: 3 }) });
const STABLE_OR_WRAPPED = /^(w|cb|x|t|h|a|s)?(BTC|ETH|SOL|XRP|ZEC|HYPE|BNB|NEAR|XMR|LINK|TRX|AVAX|DOT|ADA|LTC|BCH|USD[CTGE1]?|USDG|PYUSD|DAI|GHO|EUR[CT]?)$|wrapped|bridged|staked|portal|^st|^we/i;
const STOCKISH = /robinhood token|\bstock\b|tokenized|\betf\b/i;
const now = Math.floor(Date.now() / 1000);
const forDate = process.env.FOR_DATE ?? addDays(utcDate(now), 1);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// GeckoTerminal allows ~30 requests a minute: one call every 2.5 s, and a 429 waits 30 s before one more try.
const getJson = async (url, attempt = 1) => {
  let r;   // a timeout or a dropped connection is retried like a 429: one of them took the whole run down on 2026-10-09 (no memes selected, so no pools the next day)
  try { r = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (SharePot)" }, signal: AbortSignal.timeout(20_000) }); }
  catch (e) { if (attempt >= 3) throw e; console.log(new Date().toISOString(), `retrying ${url.split("?")[0]}: ${String(e?.message ?? e).slice(0, 80)}`); await sleep(15_000); return getJson(url, attempt + 1); }
  if (r.status === 429 && attempt < 3) { await sleep(30_000); return getJson(url, attempt + 1); }
  if (!r.ok) throw new Error(`${r.status} ${url.split("?")[0]}`); return r.json();
};

// The pool the sampler quotes all day (sample-prices.mjs `pool`) is taken from DexScreener, the source that quotes it:
// the token's deepest pair there that is itself ≥ MIN_AGE_DAYS old and ≥ MIN_LIQUIDITY_USD deep. GeckoTerminal still
// finds the tokens and gives the daily bars for the ranges, but the pool it names is its own id (a Uniswap v4 pool is a
// 32-byte id there), which DexScreener may list under another id or not at all: 13 of 45 tokens got no primary quote
// that way and their markets could only be refunded (review 2026-10-21, #5). No such pair on DexScreener: not picked.
async function dexscreenerPool(addr) {
  const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/${NET}/${addr}`);
  let best = null;
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    if (String(pair?.baseToken?.address ?? "").toLowerCase() !== addr || !(Number(pair?.priceUsd) > 0)) continue;
    const liq = Number(pair?.liquidity?.usd ?? 0), ageDays = pair?.pairCreatedAt ? (now - pair.pairCreatedAt / 1000) / 86400 : null;
    if (!(liq >= MIN_LIQUIDITY_USD) || ageDays == null || ageDays < MIN_AGE_DAYS) continue;
    if (!best || liq > best.liq) best = { pool: String(pair.pairAddress).toLowerCase(), liq, ageDays: Math.floor(ageDays), dex: `${pair.dexId ?? "?"}${pair.labels?.length ? " " + pair.labels.join("/") : ""}` };
  }
  return best;
}

// ---------- universe ----------
const byToken = new Map();   // base token address → { name, symbol, vol, liq, pool, created, price }
for (const q of ["WETH", "USDG"]) {
  for (let page = 1; page <= PAGES; page++) {
    const rows = (await getJson(`https://api.geckoterminal.com/api/v2/search/pools?query=${q}&network=${NET}&page=${page}`)).data ?? [];
    await sleep(2500);
    if (!rows.length) break;
    for (const p of rows) {
      const a = p.attributes ?? {}, base = String(p.relationships?.base_token?.data?.id ?? "").replace(/^robinhood_/, "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(base)) continue;
      const [baseName, quoteName] = String(a.name ?? "").split(" / ");
      const vol = Number(a.volume_usd?.h24 ?? 0), liq = Number(a.reserve_in_usd ?? 0), created = a.pool_created_at ? Date.parse(a.pool_created_at) / 1000 : null;
      const t = byToken.get(base) ?? { symbol: String(baseName ?? "").trim(), quote: String(quoteName ?? "").replace(/\s.*$/, ""), vol: 0, liq: 0, pool: null, poolLiq: -1, created: null, price: null };
      t.vol += vol;
      // The pool recorded here is the one the sampler reads all day (sample-prices.mjs): the deepest one that is itself
      // old enough to have a history. A pool stood up yesterday with a mountain of one-sided liquidity must not become
      // the price source (audit 2026-10-20 H1).
      const poolAgeDays = created ? (now - created) / 86400 : null;
      if (liq > t.poolLiq && poolAgeDays != null && poolAgeDays >= MIN_AGE_DAYS) { t.poolLiq = liq; t.liq = liq; t.pool = p.id; t.price = Number(a.base_token_price_usd ?? 0) || t.price; }
      if (created && (t.created == null || created < t.created)) t.created = created;
      byToken.set(base, t);
    }
  }
}
log(`universe: ${byToken.size} base tokens from GeckoTerminal search`);

// ---------- filters ----------
const erc20 = [parseAbiItem("function decimals() view returns (uint8)"), parseAbiItem("function name() view returns (string)"), parseAbiItem("function symbol() view returns (string)")];
const rejected = [], picked = [];
for (const [addr, t] of [...byToken.entries()].sort((a, b) => b[1].vol - a[1].vol)) {
  const ageDays = t.created ? Math.floor((now - t.created) / 86400) : null;
  let why = STABLE_OR_WRAPPED.test(t.symbol) ? "stable/wrapped" : STOCKISH.test(t.symbol) ? "stock token" : !(t.liq >= MIN_LIQUIDITY_USD) ? `liquidity $${Math.round(t.liq)}` : ageDays == null || ageDays < MIN_AGE_DAYS ? `age ${ageDays ?? "?"} d` : !(t.price > 0 && t.price < 9000) ? "price out of range" : Math.abs(t.price - 1) < 0.02 ? "pegged to $1" : null;
  let name = t.symbol, decimals = 18;
  if (!why) {
    try {
      const [d, n, s] = await Promise.all(["decimals", "name", "symbol"].map((fn) => mainnet.readContract({ address: addr, abi: erc20, functionName: fn })));
      decimals = Number(d); name = String(n); t.symbol = String(s) || t.symbol;
      if (STOCKISH.test(name) || STABLE_OR_WRAPPED.test(t.symbol)) why = "stock token / wrapped (by contract name)";
    } catch (e) { why = `not a readable ERC-20 (${String(e?.shortMessage ?? e?.message ?? e).slice(0, 40)})`; }
  }
  let ds = null;
  if (!why) {
    try { ds = await dexscreenerPool(addr); } catch (e) { why = `DexScreener unreachable (${String(e?.message ?? e).slice(0, 40)})`; }
    if (!why && !ds) why = `no DexScreener pair ≥ ${MIN_AGE_DAYS} d old with ≥ $${Math.round(MIN_LIQUIDITY_USD / 1000)}k`;
  }
  if (why) { rejected.push(`${t.symbol} (${why})`); continue; }
  // liquidity is the sampled pool's: the one that sets the close; gtPool keeps GeckoTerminal's id for the daily bars
  picked.push({ address: addr, symbol: t.symbol, name, decimals, usdPrice: t.price, liquidity: ds.liq, volume24h: t.vol, ageDays, pool: ds.pool, poolDex: ds.dex, gtPool: t.pool });
  if (picked.length >= N) break;
}
log(`for ${forDate}: picked ${picked.length}: ${picked.map((p) => `${p.symbol} $${(p.volume24h / 1e6).toFixed(1)}m`).join(", ")}`);
log(`rejected (top of the list): ${rejected.slice(0, 20).join(", ")}`);

// ---------- ranges from history (cached a week per token) ----------
const volFile = path.join(DIR, "vol-cache.json");
let volCache = {}; try { volCache = JSON.parse(fs.readFileSync(volFile, "utf8")); } catch {}
async function thresholdBps(p) {
  const hit = volCache[p.address];
  if (hit && now - hit.at < 7 * 86400) return hit.bps;
  let bps = 800;
  try {
    const poolAddr = String(p.gtPool ?? p.pool).replace(/^robinhood_/, "");
    await sleep(2500);
    const bars = (await getJson(`https://api.geckoterminal.com/api/v2/networks/${NET}/pools/${poolAddr}/ohlcv/day?limit=60&currency=usd`)).data?.attributes?.ohlcv_list ?? [];
    const moves = []; for (let i = 0; i + 1 < bars.length; i++) if (bars[i + 1][4] > 0) moves.push(Math.abs(bars[i][4] / bars[i + 1][4] - 1));
    if (moves.length >= 7) { moves.sort((a, b) => a - b); const med = moves[Math.floor(moves.length / 2)]; bps = Math.min(2500, Math.max(100, Math.round((med * 10000) / 50) * 50)); }
    else log(`  ${p.symbol}: ${moves.length} daily bars, default ±${bps / 100} %`);
  } catch (e) { log(`  ${p.symbol}: no history (${String(e.message ?? e).slice(0, 60)}), default ±${bps / 100} %`); }
  volCache[p.address] = { bps, at: now };
  return bps;
}
const reg = readRegistry(DIR);
for (const t of Object.values(reg.tokens)) t.selectedFor = (t.selectedFor ?? []).filter((d) => d !== forDate);
const taken = new Set(Object.values(reg.tokens).map((t) => t.symbol));
const uniqueSymbol = (addr, raw) => {
  if (reg.tokens[addr]?.symbol) return reg.tokens[addr].symbol;
  let sym = String(raw).replace(/[^A-Za-z0-9$_\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 14) || "TOKEN";
  if (taken.has(sym)) sym = `${sym}-${addr.slice(2, 6)}`;
  taken.add(sym); return sym;
};
for (const p of picked) {
  const bps = await thresholdBps(p);
  const prev = reg.tokens[p.address] ?? { addedAt: new Date().toISOString(), selectedFor: [], mock: null };
  reg.tokens[p.address] = { ...prev, symbol: uniqueSymbol(p.address, p.symbol), name: p.name, decimals: p.decimals, tokenProgram: "erc20", icon: null, category: "memes", issuer: "Robinhood meme",
    thresholdsBps: [-bps, bps], usdPrice: p.usdPrice, liquidity: p.liquidity, volume24h: p.volume24h, ageDays: p.ageDays, pool: p.pool, poolDex: p.poolDex, gtPool: p.gtPool,
    faucetUi: niceAmount(FAUCET_USD, p.usdPrice, p.decimals), seedUi: 0, selectedFor: [...prev.selectedFor, forDate], lastSelected: forDate };
  log(`  ${p.symbol.padEnd(10)} ±${(bps / 100).toFixed(1)} %  $${p.usdPrice.toPrecision(3)}  faucet ${reg.tokens[p.address].faucetUi}  liq $${Math.round(p.liquidity / 1e3)}k (${p.poolDex} ${p.pool.slice(0, 10)}…)  age ${p.ageDays} d  ${p.decimals} dec`);
}
if (DRY) { log("dry run: registry not written"); process.exit(0); }
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(volFile, JSON.stringify(volCache));
writeRegistry(DIR, reg);
log(`registry written (${CHAIN_KEY}): ${Object.keys(reg.tokens).length} tokens known, ${picked.length} selected for ${forDate}`);
