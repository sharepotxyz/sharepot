// Price sources. Official daily closes come from Yahoo Finance's chart API by default (no key; its daily closes match
// the consolidated tape — checked against Alpaca SIP for TSLA 2026-09-10/11 to the cent). PRICE_SOURCE=alpaca uses
// Alpaca SIP daily bars instead (needs ALPACA_KEY_ID / ALPACA_SECRET_KEY). Token prices come from Jupiter.
// Pyth Hermes needs a paid key since 2026-08-26, so nothing here depends on it.
//
// Corporate actions: markets settle on the TOTAL-RETURN close-to-close move.
//   * splits / reverse splits: Yahoo reports every close on today's share basis (NVDA's 2024-06-07 close comes back as
//     120.888, not 1,208.88), so a split never shows up as a −90 % day;
//   * dividends: a dividend going ex on the predicted session is added back to that session's close, so the mechanical
//     ex-dividend drop never decides a market (SPY 2026-06-18: price +0.78 %, with the $1.904 dividend +1.04 %).
import fs from "node:fs";

const SOURCE = process.env.PRICE_SOURCE ?? "yahoo";

/** Metric tag "<SYMBOL>.close:<YYYY-MM-DD>" = the New York session whose close is being predicted. */
export function parseMetric(tag) {
  const m = tag.match(/^([A-Z]{1,5})\.close:(\d{4}-\d{2}-\d{2})$/);
  return m ? { symbol: m[1], date: m[2] } : null;
}

/** New York calendar date (YYYY-MM-DD) of a unix timestamp. */
export const nyDate = (ts) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ts * 1000));
export const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

/** Unix seconds of a New York wall-clock time ("HH:MM" on YYYY-MM-DD), DST-correct. */
export function nyToUnix(date, hhmm) {
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const wall = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
  return Math.floor((2 * guess - wall) / 1000);
}

// NYSE calendar, hardcoded per year from the exchange's published holiday list. A date in a year that is not listed
// throws instead of guessing, so the table cannot go stale silently — add the next year before it starts.
const NYSE = {
  2026: {
    holidays: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
    earlyCloses: { "2026-11-27": "13:00", "2026-12-24": "13:00" },
  },
};
/** Trading sessions between two dates (inclusive), oldest first: { date, open, close } with unix-second times. */
export async function sessions(startDate, endDate) {
  const out = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    const y = NYSE[Number(d.slice(0, 4))];
    if (!y) throw new Error(`no NYSE calendar for ${d.slice(0, 4)} in prices.mjs — add that year's holidays`);
    const dow = new Date(d + "T12:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6 || y.holidays.includes(d)) continue;
    out.push({ date: d, open: nyToUnix(d, "09:30"), close: nyToUnix(d, y.earlyCloses[d] ?? "16:00") });
  }
  return out;
}

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  const raw = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${url.split("?")[0]}: ${raw.slice(0, 200)}`);
  return { json: JSON.parse(raw), raw };
}

// ---------- daily closes (bars: { date, close, dividend, split }) ----------
async function yahooDaily(symbol, start, end) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${nyToUnix(start, "00:00")}&period2=${nyToUnix(addDays(end, 1), "00:00")}&interval=1d&events=div%2Csplit`;
  const { json, raw } = await getJson(url, { "user-agent": "Mozilla/5.0 (SharePot resolver)" });
  const r = json.chart?.result?.[0]; if (!r) throw new Error("yahoo: empty chart result");
  const divs = {}, splits = {};
  for (const d of Object.values(r.events?.dividends ?? {})) { const k = nyDate(d.date); divs[k] = (divs[k] ?? 0) + d.amount; }
  for (const s of Object.values(r.events?.splits ?? {})) splits[nyDate(s.date)] = s.splitRatio ?? `${s.numerator}:${s.denominator}`;
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const bars = r.timestamp.map((t, i) => { const date = nyDate(t); return { date, close: closes[i], dividend: divs[date] ?? 0, split: splits[date] ?? null }; })
    .filter((b) => typeof b.close === "number");
  return { bars, raw, url };
}
function alpacaHeaders() {
  let id = process.env.ALPACA_KEY_ID, secret = process.env.ALPACA_SECRET_KEY;
  const envFile = process.env.ALPACA_ENV_FILE;
  if ((!id || !secret) && envFile && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*(ALPACA_KEY_ID|ALPACA_SECRET_KEY)\s*=\s*["']?([^"'\s]+)/);
      if (m && m[1] === "ALPACA_KEY_ID") id ??= m[2];
      if (m && m[1] === "ALPACA_SECRET_KEY") secret ??= m[2];
    }
  }
  if (!id || !secret) throw new Error("PRICE_SOURCE=alpaca needs ALPACA_KEY_ID / ALPACA_SECRET_KEY");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret };
}
// adjustment=all: splits and dividends are folded into the closes, so the ratio is already the total return
async function alpacaDaily(symbol, start, end) {
  const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}&timeframe=1Day&start=${start}&end=${end}&adjustment=all&feed=sip&limit=100`;
  const { json, raw } = await getJson(url, alpacaHeaders());
  return { bars: (json.bars?.[symbol] ?? []).map((b) => ({ date: b.t.slice(0, 10), close: b.c, dividend: 0, split: null })), raw, url };
}

/**
 * Total-return move of `symbol` for session `date` vs the previous session, in ppm (1 ppm = 0.01 bp):
 * (close + dividend going ex that day) / previous close − 1, closes on today's share basis.
 * Integer math on 1/10,000-dollar prices, floored: a fall of any size stays negative and never rounds up onto a
 * threshold. Returns the raw API response so the caller can publish and hash it as evidence.
 */
export async function closeMove(symbol, date) {
  const { bars, raw, url } = await (SOURCE === "alpaca" ? alpacaDaily : yahooDaily)(symbol, addDays(date, -10), date);
  const i = bars.findIndex((b) => b.date === date);
  if (i < 1) return { ok: false, reason: `no ${symbol} daily close for ${date} yet (${SOURCE})` };
  const prev = bars[i - 1], cur = bars[i];
  const p0 = BigInt(Math.round(prev.close * 10_000)), p1 = BigInt(Math.round((cur.close + cur.dividend) * 10_000));
  const num = (p1 - p0) * 1_000_000n;
  const q = num / p0, ppm = num % p0 !== 0n && num < 0n ? q - 1n : q; // floor division
  const r4 = (x) => Math.round(x * 10_000) / 10_000;
  return {
    ok: true, value: Number(ppm),
    detail: { symbol, source: SOURCE, prevDate: prev.date, prevClose: r4(prev.close), date: cur.date, close: r4(cur.close), dividend: r4(cur.dividend), split: cur.split },
    evidence: { source: url, response: raw },
  };
}

// ---------- live check of which day trades next (Nasdaq market-info, no key) ----------
// The hardcoded NYSE table only knows scheduled holidays. Nasdaq's feed also reflects unscheduled closures (a national
// day of mourning, an emergency), so the market opener asks it which session opens next and follows it on a mismatch.
const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const nasdaqDate = (s) => { const m = String(s ?? "").match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/); return m && MONTHS[m[1]] ? `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, "0")}` : null; };
export async function nasdaqMarketInfo() {
  const { json } = await getJson("https://api.nasdaq.com/api/market-info", { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36", accept: "application/json" });
  const d = json?.data; if (!d) throw new Error("nasdaq market-info: no data");
  return { isBusinessDay: !!d.isBusinessDay, today: d.openRaw ? String(d.openRaw).slice(0, 10) : null, open: d.openRaw ? String(d.openRaw).slice(11, 16) : null, close: d.closeRaw ? String(d.closeRaw).slice(11, 16) : null, previous: nasdaqDate(d.previousTradeDate), next: nasdaqDate(d.nextTradeDate), status: d.mrktStatus ?? d.marketIndicator };
}
/** The next New York session to open, per Nasdaq: { date, open, close } (unix seconds; close is today's published close
 *  when the session is today, else the calendar's close or 16:00) plus the last session that traded. */
export async function nextSessionLive(now = Math.floor(Date.now() / 1000)) {
  const n = await nasdaqMarketInfo();
  const todayNy = nyDate(now);
  const date = n.isBusinessDay && n.today === todayNy && n.open && now < nyToUnix(todayNy, n.open) ? todayNy : n.next;
  if (!date) throw new Error("nasdaq market-info: no next trade date");
  const y = NYSE[Number(date.slice(0, 4))];
  const closeHHMM = date === n.today && n.close ? n.close : y?.earlyCloses[date] ?? "16:00";
  return { date, open: nyToUnix(date, "09:30"), close: nyToUnix(date, closeHHMM), previous: n.previous, raw: n };
}

/** Live token prices (Jupiter) incl. the reference stock price and ScaledUiAmount multiplier. */
export async function xstockPrices(mints) {
  const { json } = await getJson(`https://lite-api.jup.ag/price/v3?ids=${mints.join(",")}`);
  return Object.fromEntries(mints.map((m) => [m, json[m] ? { usd: json[m].usdPrice, stock: json[m].stockData?.price ?? null, multiplier: json[m].scaledUiConfig?.multiplier ?? 1 } : null]));
}
