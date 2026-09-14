// What a market is about: the stock, read from its on-chain metric tag "<SYMBOL>.close:<YYYY-MM-DD>" (the New York
// session whose official close is compared with the previous close), and the token it is staked in, looked up by mint
// in /api/stocks (one stock can trade as several tokens from different issuers; each token has its own pool).
// Amounts on-chain are raw token units; wallets show them times the token's ScaledUiAmount multiplier (dividends and
// splits), and so does this page. Thresholds are the move in ppm (1 ppm = 0.01 bp).
import type { MarketView } from "./chain";
import { API_BASE } from "./config";

type TokenInfo = { token: string; issuer: string; decimals: number; symbol: string; name: string };
export const STOCK_NAMES: Record<string, string> = { SPCX: "SpaceX", TSLA: "Tesla", NVDA: "NVIDIA", SPY: "S&P 500 ETF" };
export let STOCK_ORDER = Object.keys(STOCK_NAMES);
const byMint = new Map<string, TokenInfo>();
const tokensByStock = new Map<string, TokenInfo[]>();
/** Listed stocks and their tokens on this network (falls back to names only when the API is unreachable). */
const boot: any = (globalThis as any).__BOOT__ ?? null;   // data embedded in the page by the server (see chain.ts)
let stocksLoaded = false;
export async function loadStocks() {
  if (stocksLoaded) return;
  try {
    const j = boot?.stocks ?? await (async () => { const r = await fetch(API_BASE + "/stocks"); if (!r.ok) throw new Error("stocks " + r.status); return r.json(); })();
    stocksLoaded = true;
    STOCK_ORDER = j.stocks.map((s: any) => s.symbol);
    for (const s of j.stocks) {
      STOCK_NAMES[s.symbol] = s.name;
      const list = s.tokens.filter((t: any) => t.mint).map((t: any) => ({ ...t, symbol: s.symbol, name: s.name }));
      tokensByStock.set(s.symbol, list);
      for (const t of list) byMint.set(t.mint, t);
    }
  } catch {}
}
export const tokensOf = (symbol: string) => tokensByStock.get(symbol) ?? [];
export const tokenInfo = (m: MarketView) => byMint.get(m.mint.toBase58());
export function parseMetric(tag: string) {
  const m = tag.match(/^([A-Z]{1,5})\.close:(\d{4}-\d{2}-\d{2})$/);
  return m ? { symbol: m[1], date: m[2] } : null;
}
export const symbolOf = (m: MarketView) => parseMetric(m.metric)?.symbol ?? "?";
export const stockName = (m: MarketView) => STOCK_NAMES[symbolOf(m)] ?? symbolOf(m);
export const tokenSymbol = (m: MarketView) => tokenInfo(m)?.token ?? "shares";
export const issuerOf = (m: MarketView) => tokenInfo(m)?.issuer ?? "";
export const sessionLabel = (date: string) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
export function question(m: MarketView) {
  const p = parseMetric(m.metric); if (!p) return m.metric;
  return `Where does ${p.symbol} close on ${sessionLabel(p.date)}?`;
}

/** A move in ppm as a signed percentage, floored to whole basis points. Thresholds are whole basis points, so the
 *  floored figure always sits in the same range as the exact value (−1.7501 % shows as −1.76 %, never −1.75 %). */
export function fmtMove(ppm: number) {
  const bps = Math.floor(ppm / 100);
  return (bps > 0 ? "+" : bps < 0 ? "−" : "") + (Math.abs(bps) / 100).toFixed(2) + "%";
}
const fmtThr = (ppm: number) => (ppm > 0 ? "+" : ppm < 0 ? "−" : "") + (Math.abs(ppm) / 10000).toFixed(2).replace(/\.?0+$/, "") + "%";
/** Short label of bucket i, e.g. "< −1.75%", "−1.75% to 0%", "0% to +2%", "≥ +2%". */
export function bucketLabel(m: MarketView, i: number) {
  const t = m.thresholds, n = m.nBuckets;
  if (n === 2 && t[0] === 0) return i === 1 ? "Up or flat" : "Down";
  if (i === 0) return `< ${fmtThr(t[0])}`;
  if (i === n - 1) return `≥ ${fmtThr(t[n - 2])}`;
  return `${fmtThr(t[i - 1])} to ${fmtThr(t[i])}`;
}
/** Plain-words name for the common 4-range layout (middle cut at 0). */
export function bucketName(m: MarketView, i: number) {
  if (m.nBuckets === 4 && m.thresholds[1] === 0) return ["Big drop", "Small drop", "Small gain", "Big gain"][i];
  return "";
}

/** Raw on-chain units → what the holder's wallet shows (decimals and the dividend/split multiplier applied). */
export const uiAmount = (m: MarketView, raw: number) => (raw / 10 ** m.decimals) * (m.multiplier || 1);
/** Shares as typed by the user → raw units, rounded down so a stake never exceeds what was typed. */
export const toRaw = (m: MarketView, ui: number) => Math.floor(((ui || 0) / (m.multiplier || 1)) * 10 ** m.decimals);
export const fmtAmt = (m: MarketView, raw: number, digits = 4) => uiAmount(m, raw).toLocaleString("en-US", { maximumFractionDigits: digits });

// Live token prices from the API (Jupiter), keyed by token symbol; used only for a dollar estimate next to share counts.
let prices: Record<string, { usd: number; stock: number | null } | null> = {};
let pricesFromBoot = !!boot?.prices;
if (pricesFromBoot) prices = boot.prices;
export async function loadPrices() {
  if (pricesFromBoot) { pricesFromBoot = false; return prices; }   // first paint uses the embedded prices
  try { const r = await fetch(API_BASE + "/prices"); if (r.ok) prices = (await r.json()).prices ?? {}; } catch {}
  return prices;
}
export function usdOf(m: MarketView, raw: number) {
  const p = prices[tokenSymbol(m)]?.usd; if (!p) return "";
  const v = uiAmount(m, raw) * p;
  return "≈ $" + v.toLocaleString("en-US", { maximumFractionDigits: v < 100 ? 2 : 0 });
}
/** Dollar price of one share of this market's token (Jupiter, mainnet token), or null when unknown. */
export const priceOf = (m: MarketView) => prices[tokenSymbol(m)]?.usd ?? null;
export const fmtUsd = (v: number) => "$" + (v >= 1e6 ? (v / 1e6).toFixed(1) + "m" : v >= 1e4 ? (v / 1e3).toFixed(1) + "k" : v.toLocaleString("en-US", { maximumFractionDigits: v < 100 ? 2 : 0 }));
