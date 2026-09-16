// Picks the memes that get a pool for the next UTC day: the ten Solana tokens with the most 24-hour traded volume
// (Jupiter's top-traded list) that pass the safety filters, and records them in data/chain-tokens.json (registry).
// Runs at 11:00 UTC for the NEXT day, so open-markets.mjs can open tomorrow's pools at 11:30, before today's lock at
// 12:00 (there is always a pool to bet into), and the sampler covers today's closing hour for the new tokens (the
// baseline of tomorrow's market). Idempotent: a re-run for the same day re-selects and overwrites.
//   env: DATA_DIR, N (10), FOR_DATE (YYYY-MM-DD, default: tomorrow UTC), DRY_RUN=1
//
// Filters — heat is the point, but a pool in a token that rugs mid-day is worthless, so:
//   * no tag from the non-meme families (tokenized stocks / RWA, DeFi, LST, stablecoins, Jupiter's "strict" list of
//     established tokens) and no wrapped / bridged asset by name;
//   * mint authority and freeze authority both given up (Jupiter audit);
//   * liquidity ≥ MIN_LIQUIDITY_USD, first pool ≥ MIN_AGE_DAYS old, price below $9,000 (picodollar range);
//   * a transfer hook would be refused at market creation anyway (the program checks the mint).
// Ranges: three (down / flat / up), cut at ± the token's median absolute daily move over its last 60 daily bars
// (GeckoTerminal), rounded to 0.5 %, clamped to [1 %, 25 %]; 8 % when there is no history.
import fs from "node:fs";
import path from "node:path";
import { readRegistry, writeRegistry, niceAmount } from "./chain-tokens.mjs";
import { utcDate, addDays } from "./prices.mjs";

const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const N = Number(process.env.N ?? 10), DRY = process.env.DRY_RUN === "1";
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD ?? 500_000), MIN_AGE_DAYS = Number(process.env.MIN_AGE_DAYS ?? 3);
const FAUCET_USD = 25, SEED_USD = 3;
const EXCLUDED_TAGS = new Set(["stocks", "rwa", "xstocks", "backpack", "ondo", "prestocks", "equities", "etf", "commodities", "defi", "strict", "lst", "stablecoin", "perps", "bridged", "wormhole", "infra"]);
const WRAPPED = /^(w|cb|x|t)?(BTC|ETH|SOL|XRP|ZEC|HYPE|BNB|NEAR|XMR|LINK|TRX|AVAX|DOT|ADA|LTC|BCH|USD[CT]?)$|wrapped|bridged|staked|portal/i;
const now = Math.floor(Date.now() / 1000);
const forDate = process.env.FOR_DATE ?? addDays(utcDate(now), 1);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// GeckoTerminal allows ~30 requests a minute: one call every 3 s, and a 429 waits 20 s before one more try.
const getJson = async (url, attempt = 1) => {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (SharePot)" }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 429 && attempt < 3) { await sleep(20_000); return getJson(url, attempt + 1); }
  if (!r.ok) throw new Error(`${r.status} ${url.split("?")[0]}`); return r.json();
};

const list = await getJson("https://lite-api.jup.ag/tokens/v2/toptraded/24h?limit=100");
const rejected = [], picked = [];
for (const x of list) {
  const tags = new Set(x.tags ?? []), a = x.audit ?? {}, st = x.stats24h ?? {};
  const vol = (st.buyVolume ?? 0) + (st.sellVolume ?? 0);
  const created = x.firstPool?.createdAt ? Date.parse(x.firstPool.createdAt) / 1000 : null;
  const ageDays = created ? Math.floor((now - created) / 86400) : null;
  const why = [...tags].find((t) => EXCLUDED_TAGS.has(t)) ? "tag" : WRAPPED.test(x.symbol) || WRAPPED.test(x.name ?? "") ? "wrapped/bridged" : !a.mintAuthorityDisabled ? "mint authority" : !a.freezeAuthorityDisabled ? "freeze authority"
    : !((x.liquidity ?? 0) >= MIN_LIQUIDITY_USD) ? `liquidity $${Math.round(x.liquidity ?? 0)}` : ageDays == null || ageDays < MIN_AGE_DAYS ? `age ${ageDays ?? "?"} d` : !(x.usdPrice > 0 && x.usdPrice < 9000) ? "price out of range" : null;
  if (why) { rejected.push(`${x.symbol} (${why})`); continue; }
  picked.push({ mint: x.id, symbol: x.symbol, name: x.name, decimals: x.decimals, tokenProgram: x.tokenProgram, icon: x.icon ?? null, usdPrice: x.usdPrice, liquidity: x.liquidity, volume24h: vol, ageDays, holders: x.holderCount ?? null });
  if (picked.length >= N) break;
}
log(`for ${forDate}: picked ${picked.length}: ${picked.map((p) => `${p.symbol} $${Math.round(p.volume24h / 1e6)}m`).join(", ")}`);
log(`rejected (top of the list): ${rejected.slice(0, 25).join(", ")}`);

// ranges from history (cached a week per mint)
const volFile = path.join(DATA, "vol-cache.json");
let volCache = {}; try { volCache = JSON.parse(fs.readFileSync(volFile, "utf8")); } catch {}
async function thresholdBps(mint) {
  const hit = volCache[mint];
  if (hit && now - hit.at < 7 * 86400) return hit.bps;
  let bps = 800;
  try {
    const pools = (await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`)).data ?? [];
    pools.sort((p, q) => Number(q.attributes?.reserve_in_usd ?? 0) - Number(p.attributes?.reserve_in_usd ?? 0));
    if (pools.length) {
      await sleep(3000);
      const bars = (await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pools[0].id.split("_", 2)[1]}/ohlcv/day?limit=60&currency=usd`)).data?.attributes?.ohlcv_list ?? [];
      const moves = []; for (let i = 0; i + 1 < bars.length; i++) if (bars[i + 1][4] > 0) moves.push(Math.abs(bars[i][4] / bars[i + 1][4] - 1));
      if (moves.length >= 7) { moves.sort((a, b) => a - b); const med = moves[Math.floor(moves.length / 2)]; bps = Math.min(2500, Math.max(100, Math.round((med * 10000) / 50) * 50)); }
    }
  } catch (e) { log(`  ${mint.slice(0, 6)}: no history (${String(e.message ?? e).slice(0, 60)}), default ±${bps / 100} %`); }
  volCache[mint] = { bps, at: now };
  return bps;
}
const reg = readRegistry(DATA);
for (const [mint, t] of Object.entries(reg.tokens)) t.selectedFor = (t.selectedFor ?? []).filter((d) => d !== forDate); // re-select cleanly
// A symbol is the metric tag and the page's key for a token, so it must be unique across everything ever listed and
// fit the tag charset: a second "TRUMP" becomes "TRUMP-6p6x". A token keeps the symbol it was first listed under.
const taken = new Set(Object.values(reg.tokens).map((t) => t.symbol));
const uniqueSymbol = (mint, raw) => {
  if (reg.tokens[mint]?.symbol) return reg.tokens[mint].symbol;
  let sym = String(raw).replace(/[^A-Za-z0-9$_\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 14) || "TOKEN";
  if (taken.has(sym)) sym = `${sym}-${mint.slice(0, 4)}`;
  taken.add(sym); return sym;
};
for (const p of picked) {
  const bps = await thresholdBps(p.mint); await sleep(3000);
  const prev = reg.tokens[p.mint] ?? { addedAt: new Date().toISOString(), selectedFor: [], mock: null };
  reg.tokens[p.mint] = { ...prev, symbol: uniqueSymbol(p.mint, p.symbol), name: p.name, decimals: p.decimals, tokenProgram: p.tokenProgram, icon: p.icon, category: "memes", issuer: "Solana meme",
    thresholdsBps: [-bps, bps], usdPrice: p.usdPrice, liquidity: p.liquidity, volume24h: p.volume24h, ageDays: p.ageDays, holders: p.holders,
    faucetUi: niceAmount(FAUCET_USD, p.usdPrice, p.decimals), seedUi: niceAmount(SEED_USD, p.usdPrice, p.decimals), selectedFor: [...prev.selectedFor, forDate], lastSelected: forDate };
  log(`  ${p.symbol.padEnd(10)} ±${(bps / 100).toFixed(1)} %  $${p.usdPrice.toPrecision(3)}  faucet ${reg.tokens[p.mint].faucetUi}  seed ${reg.tokens[p.mint].seedUi}  liq $${Math.round(p.liquidity / 1e3)}k  age ${p.ageDays} d`);
}
if (DRY) { log("dry run: registry not written"); process.exit(0); }
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(volFile, JSON.stringify(volCache));
writeRegistry(DATA, reg);
log(`registry written: ${Object.keys(reg.tokens).length} tokens known, ${picked.length} selected for ${forDate}`);
