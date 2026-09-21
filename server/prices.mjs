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

/** Metric tag. "<SYMBOL>.close:<YYYY-MM-DD>" = the New York session whose official close is being predicted (stocks).
 *  "<SYMBOL>.day:<YYYY-MM-DD>" = a UTC day whose on-chain close is being predicted (pre-IPO tokens, memes): the close
 *  of a day is the median of the Jupiter quotes sampled every minute during its last hour (23:00–24:00 UTC), and the
 *  move is measured against the previous day's close, stored on the market as its baseline (see chainMove). */
export function parseMetric(tag) {
  const m = String(tag).match(/^([A-Za-z0-9$_\-]{1,20})\.(close|day):(\d{4}-\d{2}-\d{2})$/);
  return m ? { symbol: m[1], kind: m[2], date: m[3] } : null;
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

// NYSE calendar: years read off the exchange's published holiday list are kept here as they were published; any other
// year is generated from the exchange's standing rules (nyseYearByRule), so nothing has to be added by hand each year.
const NYSE = {
  2026: {
    holidays: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
    earlyCloses: { "2026-11-27": "13:00", "2026-12-24": "13:00" },
  },
  // nyse.com/markets/hours-calendars, read 2026-09-17. Juneteenth (Sat) is kept on Fri 06-18, Independence Day (Sun)
  // on Mon 07-05, Christmas (Sat) on Fri 12-24; the only early close is the day after Thanksgiving.
  2027: {
    holidays: ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"],
    earlyCloses: { "2027-11-26": "13:00" },
  },
};
/**
 * A year's scheduled NYSE holidays and early closes from the exchange's standing rules (Rule 7.2), for any year the
 * table above does not list, so the calendar never runs out. A holiday on a Saturday is kept on the Friday before and
 * one on a Sunday on the Monday after — except New Year's Day on a Saturday, which is not kept at all (the Friday is a
 * year-end session). Early closes (13:00): the day after Thanksgiving, and July 3 and December 24 when they are
 * weekdays and not themselves a holiday. The generator reproduces the published lists of 2022 and 2024–2027
 * (prices.test.mjs). Unscheduled closures cannot be known in advance by any table: the opener's live Nasdaq check and
 * the resolver's "no close for that day" path handle those.
 */
export function nyseYearByRule(year) {
  const iso = (m, d) => `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dow = (m, d) => new Date(Date.UTC(year, m - 1, d)).getUTCDay();
  const nth = (m, weekday, n) => { let d = 1 + ((weekday - dow(m, 1) + 7) % 7) + (n - 1) * 7; return iso(m, d); };
  const last = (m, weekday) => { const end = new Date(Date.UTC(year, m, 0)).getUTCDate(); return iso(m, end - ((dow(m, end) - weekday + 7) % 7)); };
  const observed = (m, d, skipSaturday = false) => { const w = dow(m, d); return w === 6 ? (skipSaturday ? null : addDays(iso(m, d), -1)) : w === 0 ? addDays(iso(m, d), 1) : iso(m, d); };
  // Good Friday: two days before Easter Sunday (anonymous Gregorian algorithm)
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const em = Math.floor((h + l - 7 * m + 114) / 31), ed = ((h + l - 7 * m + 114) % 31) + 1;
  const thanksgiving = nth(11, 4, 4);
  const holidays = [observed(1, 1, true), nth(1, 1, 3), nth(2, 1, 3), addDays(iso(em, ed), -2), last(5, 1), observed(6, 19), observed(7, 4), nth(9, 1, 1), thanksgiving, observed(12, 25)].filter(Boolean);
  const earlyCloses = { [addDays(thanksgiving, 1)]: "13:00" };
  for (const [mo, da] of [[7, 3], [12, 24]]) { const w = dow(mo, da); if (w >= 1 && w <= 5 && !holidays.includes(iso(mo, da))) earlyCloses[iso(mo, da)] = "13:00"; }
  return { holidays, earlyCloses };
}
const nyseYear = (year) => NYSE[year] ?? (NYSE[year] = nyseYearByRule(year));

/** Trading sessions between two dates (inclusive), oldest first: { date, open, close } with unix-second times. */
export async function sessions(startDate, endDate) {
  const out = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    const y = nyseYear(Number(d.slice(0, 4)));
    const dow = new Date(d + "T12:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6 || y.holidays.includes(d)) continue;
    out.push({ date: d, open: nyToUnix(d, "09:30"), close: nyToUnix(d, y.earlyCloses[d] ?? "16:00") });
  }
  return out;
}

// Network errors, 429 and 5xx are retried in-process (3 attempts, 2 s / 4 s apart); anything else, or a still-failing
// third attempt, throws and the caller's next cron run tries again.
async function getJson(url, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      const raw = await r.text();
      if (!r.ok) { const e = new Error(`${r.status} ${url.split("?")[0]}: ${raw.slice(0, 200)}`); e.retryable = r.status === 429 || r.status >= 500; throw e; }
      return { json: JSON.parse(raw), raw };
    } catch (e) {
      if (attempt >= 3 || e.retryable === false || (e.retryable === undefined && !(e instanceof TypeError || e.name === "TimeoutError" || e.name === "AbortError"))) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
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
  const bars = (r.timestamp ?? []).map((t, i) => { const date = nyDate(t); return { date, close: closes[i], dividend: divs[date] ?? 0, split: splits[date] ?? null }; })
    .filter((b) => typeof b.close === "number");
  // meta.regularMarketTime = time of the last regular-session trade Yahoo has seen; before it reaches the closing bell
  // the newest bar is still a live intraday price, not the official close.
  return { bars, raw, url, lastTradeTs: Number(r.meta?.regularMarketTime ?? 0) || null };
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
  return { bars: (json.bars?.[symbol] ?? []).map((b) => ({ date: b.t.slice(0, 10), close: b.c, dividend: 0, split: null })), raw, url, lastTradeTs: null };
}

// ---------- second source: Nasdaq's official close (no key), used only to confirm the primary ----------
const NASDAQ_HEADERS = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36", accept: "application/json" };
const usDate = (s) => { const m = String(s ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
/** Official close of `symbol` on `date` per Nasdaq: the historical table once it carries the day, else the last sale
 *  of a closed session on that day. null when Nasdaq has nothing for the day yet; throws when Nasdaq is unreachable. */
const nasdaqClass = new Map(); // symbol → asset class Nasdaq knows it under ("stocks" or "etf"; SPY is an etf)
export async function nasdaqClose(symbol, date) {
  const px = (v) => { const n = Number(String(v ?? "").replace(/[$,]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
  let hist = null;
  for (const ac of nasdaqClass.has(symbol) ? [nasdaqClass.get(symbol)] : ["stocks", "etf"]) {
    const { json } = await getJson(`https://api.nasdaq.com/api/quote/${symbol}/historical?assetclass=${ac}&fromdate=${addDays(date, -7)}&todate=${date}&limit=10`, NASDAQ_HEADERS);
    if (json?.data?.tradesTable) { nasdaqClass.set(symbol, ac); hist = json.data.tradesTable.rows ?? []; break; }
  }
  if (hist === null) throw new Error(`nasdaq: ${symbol} unknown under stocks and etf`);
  const row = hist.find((r) => usDate(r.date) === date);
  if (row && px(row.close)) return { close: px(row.close), via: "historical" };
  const info = (await getJson(`https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=${nasdaqClass.get(symbol)}`, NASDAQ_HEADERS)).json?.data;
  const pd = info?.primaryData ?? {}, closed = /closed/i.test(String(info?.marketStatus ?? ""));
  const tsDate = (() => { const m = String(pd.lastTradeTimestamp ?? "").match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/); return m && MONTHS[m[1]] ? `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, "0")}` : null; })();
  if (closed && tsDate === date && px(pd.lastSalePrice)) return { close: px(pd.lastSalePrice), via: "last-sale" };
  return null;
}
/** How long after the bell the resolver keeps waiting for the second source before it settles on the primary alone. */
export const SECOND_SOURCE_GRACE_SECS = Number(process.env.SECOND_SOURCE_GRACE_SECS ?? 7200);

/**
 * Total-return move of `symbol` for session `date` vs the previous session, in ppm (1 ppm = 0.01 bp):
 * (close + dividend going ex that day) / previous close − 1, closes on today's share basis.
 * Integer math on 1/10,000-dollar prices, floored: a fall of any size stays negative and never rounds up onto a
 * threshold. Returns the raw API response so the caller can publish and hash it as evidence.
 */
export async function closeMove(symbol, date, now = Math.floor(Date.now() / 1000), thresholds = null) {
  // Which sessions the calendar expects: the predicted one and the one before it.
  const cal = await sessions(addDays(date, -10), date);
  const session = cal.find((x) => x.date === date), prevSession = cal.filter((x) => x.date < date).pop();
  if (!session || !prevSession) return { ok: false, reason: `${date} is not a trading day on the NYSE calendar` };
  const { bars, raw, url, lastTradeTs } = await (SOURCE === "alpaca" ? alpacaDaily : yahooDaily)(symbol, addDays(date, -10), date);
  const i = bars.findIndex((b) => b.date === date);
  if (i < 1) return { ok: false, reason: `no ${symbol} daily close for ${date} yet (${SOURCE})` };
  const prev = bars[i - 1], cur = bars[i];
  // Guards against a stale or garbled primary response — each one holds the market for the next run instead of
  // proposing a wrong number (an alert:true hold is worth a human look):
  //   1. the bar before the target must be the calendar's previous session (a dropped bar would slide "prev" back a day);
  //   2. the target bar must be final: the source's last trade time has reached that session's closing bell;
  //   3. the close must agree with Nasdaq's official close to the cent, or, if Nasdaq has nothing for the day yet,
  //      the bell must be more than SECOND_SOURCE_GRACE_SECS ago before the primary is trusted alone.
  if (prev.date !== prevSession.date) return { ok: false, alert: true, reason: `${SOURCE} bar before ${date} is ${prev.date}, calendar expects ${prevSession.date} — a session is missing from the response` };
  if (lastTradeTs != null && lastTradeTs < session.close) return { ok: false, reason: `${SOURCE} bar for ${date} is not final yet (last trade ${new Date(lastTradeTs * 1000).toISOString()}, bell ${new Date(session.close * 1000).toISOString()})` };
  const movePpmOf = (close) => { const p0 = BigInt(Math.round(prev.close * 10_000)), p1 = BigInt(Math.round((close + cur.dividend) * 10_000)), num = (p1 - p0) * 1_000_000n, q = num / p0; return Number(num % p0 !== 0n && num < 0n ? q - 1n : q); };
  let crossCheck;
  try {
    const nd = await nasdaqClose(symbol, date);
    // The two closes differ. If both put the day in the same range the difference decides nothing: settle on the
    // primary and say so in the evidence. If they do not, hold — and tell the caller this is a disagreement
    // (`disagree`), so it can refund the market once it has lasted a day instead of guessing a winner.
    const differs = nd && Math.abs(nd.close - cur.close) > 0.005;
    const rangeOf = (v) => thresholds.filter((t) => v >= t).length;
    if (differs && thresholds && rangeOf(movePpmOf(cur.close)) === rangeOf(movePpmOf(nd.close))) crossCheck = { source: "nasdaq", via: nd.via, close: nd.close, agreed: false, sameRange: true, note: `closes differ (${cur.close} vs ${nd.close}) but both fall in the same range; primary used` };
    else if (differs) return { ok: false, alert: true, disagree: true, reason: `${SOURCE} close ${cur.close} (${movePpmOf(cur.close)} ppm) and Nasdaq ${nd.close} (${movePpmOf(nd.close)} ppm, ${nd.via}) put ${symbol} ${date} in different ranges` };
    else if (nd) crossCheck = { source: "nasdaq", via: nd.via, close: nd.close, agreed: true };
    else if (now < session.close + SECOND_SOURCE_GRACE_SECS) return { ok: false, reason: `Nasdaq has no close for ${symbol} ${date} yet — waiting for the second source (until ${new Date((session.close + SECOND_SOURCE_GRACE_SECS) * 1000).toISOString()})` };
    else crossCheck = { source: "nasdaq", agreed: null, note: "no second-source close within the grace period; primary used alone" };
  } catch (e) {
    if (now < session.close + SECOND_SOURCE_GRACE_SECS) return { ok: false, reason: `second source unreachable (${String(e?.message ?? e).slice(0, 80)}) — retrying until ${new Date((session.close + SECOND_SOURCE_GRACE_SECS) * 1000).toISOString()}` };
    crossCheck = { source: "nasdaq", agreed: null, note: `second source unreachable after the grace period (${String(e?.message ?? e).slice(0, 80)}); primary used alone` };
  }
  const p0 = BigInt(Math.round(prev.close * 10_000)), p1 = BigInt(Math.round((cur.close + cur.dividend) * 10_000));
  const num = (p1 - p0) * 1_000_000n;
  const q = num / p0, ppm = num % p0 !== 0n && num < 0n ? q - 1n : q; // floor division
  const r4 = (x) => Math.round(x * 10_000) / 10_000;
  return {
    ok: true, value: Number(ppm),
    detail: { symbol, source: SOURCE, prevDate: prev.date, prevClose: r4(prev.close), date: cur.date, close: r4(cur.close), dividend: r4(cur.dividend), split: cur.split, lastTradeTs, crossCheck },
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

// ---------- on-chain closes (pre-IPO tokens, memes) ----------
// sample-prices.mjs writes one line per minute to data/ticks/<UTC date>.jsonl: {"t":<unix>,"p":{"<mainnet mint>":<usd>}}.
// Prices are handled as integers in picodollars (1e-12 $) so a meme at $0.000004 and a pre-IPO token at $1,000 both
// keep their precision; anything above $9,000 is out of range for the double → integer step and is not listed.
export const PICO = 1_000_000_000_000n;
export const toPico = (usd) => BigInt(Math.round(usd * 1e12));
export const fromPico = (p) => Number(p) / 1e12;
/** Minimum number of one-minute samples in the closing hour before a close is trusted (60 possible). */
export const MIN_CLOSE_SAMPLES = Number(process.env.MIN_CLOSE_SAMPLES ?? 40);
export const utcDate = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
export const utcMidnight = (date) => Math.floor(Date.parse(date + "T00:00:00Z") / 1000);

/** The sampled quotes of `mint` in the closing hour of UTC day `date`, oldest first, plus the exact bytes they came from.
 *  `key` picks the source inside each line: "p" = Jupiter (primary), "p2" = DexScreener (second source). */
export function closingSamples(dataDir, mint, date, key = "p") {
  const f = `${dataDir}/ticks/${date}.jsonl`;
  const start = utcMidnight(date) + 23 * 3600, end = utcMidnight(date) + 24 * 3600;
  const lines = [];
  try { for (const l of fs.readFileSync(f, "utf8").split("\n")) { if (!l) continue; const r = JSON.parse(l); if (r.t >= start && r.t < end && typeof r[key]?.[mint] === "number" && r[key][mint] > 0) lines.push(l); } } catch {}
  return { samples: lines.map((l) => { const r = JSON.parse(l); return { t: r.t, usd: r[key][mint] }; }), raw: lines.join("\n") + (lines.length ? "\n" : ""), file: f };
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
/** Close of `mint` for UTC day `date`: median of its closing-hour samples, in USD; null until enough samples exist. */
export function chainClose(dataDir, mint, date, key = "p") {
  const { samples, raw, file } = closingSamples(dataDir, mint, date, key);
  if (samples.length < MIN_CLOSE_SAMPLES) return { ok: false, reason: `${samples.length} of ${MIN_CLOSE_SAMPLES} closing-hour samples for ${date}`, samples: samples.length };
  return { ok: true, close: median(samples.map((s) => s.usd)), samples: samples.length, first: samples[0].t, last: samples.at(-1).t, raw, file };
}
/** Floored move in ppm between two USD prices. */
export function movePpm(prevUsd, curUsd) {
  const p0 = toPico(prevUsd), p1 = toPico(curUsd);
  const num = (p1 - p0) * 1_000_000n;
  const q = num / p0; return Number(num % p0 !== 0n && num < 0n ? q - 1n : q);
}
/** Same rule as on-chain Market::bucket_of. */
export const bucketOf = (thresholds, value) => thresholds.filter((t) => value >= t).length;
/**
 * Move of `mint` for UTC day `date` vs the previous day's close, in ppm, floored. Both closes come from the sampled
 * quotes (prices.mjs closingSamples), so the evidence is self-contained: the sample lines of both closing hours.
 * Same shape as closeMove(): ok/value/detail/evidence.
 *
 * One settlement source: Jupiter, for both closes — the feed the site shows as "now" and "prev close" and the only one
 * the published rule names. The lines also carry DexScreener's quote of the token's deepest pair; two venues trade at
 * different prices, and a gap between them cannot say which one is off, so that quote is recorded in the evidence for
 * anyone comparing and never decides or holds anything.
 */
export function chainMove(dataDir, mint, symbol, date, now = Math.floor(Date.now() / 1000), thresholds = null) {
  if (now < utcMidnight(date) + 24 * 3600) return { ok: false, reason: `${date} has not ended yet (UTC)` };
  const prevDate = addDays(date, -1);
  const b = chainClose(dataDir, mint, prevDate);
  if (!b.ok) return { ok: false, alert: true, reason: `no previous close: ${b.reason} (${prevDate})` };
  const c = chainClose(dataDir, mint, date);
  if (!c.ok) return { ok: false, reason: `not enough closing-hour quotes: ${c.reason}` };
  const ppm = movePpm(b.close, c.close);
  const b2 = chainClose(dataDir, mint, prevDate, "p2"), c2 = chainClose(dataDir, mint, date, "p2");
  let crossCheck;
  if (b2.ok && c2.ok) {
    const ppm2 = movePpm(b2.close, c2.close);
    const agreed = thresholds ? bucketOf(thresholds, ppm) === bucketOf(thresholds, ppm2) : null;
    crossCheck = { source: "dexscreener", role: "reference only, does not settle", baseline: b2.close, close: c2.close, movePpm: ppm2, prevSamples: b2.samples, samples: c2.samples, agreed };
  } else crossCheck = { source: "dexscreener", agreed: null, note: `second source short of samples (${prevDate}: ${b2.samples ?? 0}, ${date}: ${c2.samples ?? 0} of ${MIN_CLOSE_SAMPLES}); primary used alone` };
  return {
    ok: true, value: ppm,
    detail: { symbol, source: "jupiter-price-v3", mint, prevDate, baseline: b.close, prevSamples: b.samples, date, close: c.close, samples: c.samples, window: "23:00–24:00 UTC of each day, one quote per minute, median", crossCheck },
    evidence: { source: `sampled quotes ${prevDate} and ${date}, 23:00–24:00 UTC (lite-api.jup.ag/price/v3 as p, api.dexscreener.com as p2, one per minute)`, response: b.raw + c.raw },
  };
}
