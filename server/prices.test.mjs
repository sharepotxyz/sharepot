// node --test server/prices.test.mjs   (the second half asks Yahoo and Nasdaq for one real session)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { nyseYearByRule, sessions, closeMove, chainMove, utcMidnight, addDays } from "./prices.mjs";

// NYSE's own published lists (nyse.com/markets/hours-calendars and its archives), special closures left out
const PUBLISHED = {
  2022: { holidays: ["2022-01-17", "2022-02-21", "2022-04-15", "2022-05-30", "2022-06-20", "2022-07-04", "2022-09-05", "2022-11-24", "2022-12-26"], early: ["2022-11-25"] },
  2024: { holidays: ["2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27", "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25"], early: ["2024-07-03", "2024-11-29", "2024-12-24"] },
  2025: { holidays: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25"], early: ["2025-07-03", "2025-11-28", "2025-12-24"] },
  2026: { holidays: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"], early: ["2026-11-27", "2026-12-24"] },
  2027: { holidays: ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"], early: ["2027-11-26"] },
};
for (const [year, want] of Object.entries(PUBLISHED)) test(`rule-made calendar equals the published one: ${year}`, () => {
  const got = nyseYearByRule(Number(year));
  assert.deepEqual([...got.holidays].sort(), want.holidays);
  assert.deepEqual(Object.keys(got.earlyCloses).sort(), want.early);
});
test("a year nobody typed in still has sessions", async () => {
  const s = await sessions("2031-01-01", "2031-12-31"); assert.ok(s.length >= 250 && s.length <= 253, String(s.length));
});

// Source disagreement, with Nasdaq's answer bent on the way in. Thresholds as on the live TSLA market. The session is
// a recent one — the latest NYSE session that ended at least two days ago — because Nasdaq's historical table only
// answers for recent windows: a date typed in here (2026-09-16) went blank a month later and turned every run red,
// which the deploy gate reads as "do not deploy" (audit 2026-10-20).
const today = new Date().toISOString().slice(0, 10);
const DAY = (await sessions(addDays(today, -14), addDays(today, -2))).at(-1).date, NOW = utcMidnight(addDays(DAY, 1)) + 12 * 3600;
const US_DAY = `${DAY.slice(5, 7)}/${DAY.slice(8, 10)}/${DAY.slice(0, 4)}`;   // Nasdaq writes its dates MM/DD/YYYY
const THR = [-17500, 0, 20000];
const realFetch = globalThis.fetch;
const bendNasdaq = (delta) => { globalThis.fetch = async (url, init) => { const r = await realFetch(url, init); if (!String(url).includes("api.nasdaq.com/api/quote/TSLA/historical")) return r; const j = await r.json(); for (const row of j?.data?.tradesTable?.rows ?? []) if (row.date === US_DAY) row.close = "$" + (Number(row.close.replace(/[$,]/g, "")) + delta).toFixed(2); return new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } }); }; };
let agreed = null;   // the day's real result; the bends below are sized from it
test("sources agree: settles", async () => { globalThis.fetch = realFetch; const ev = await closeMove("TSLA", DAY, NOW, THR); assert.equal(ev.ok, true); assert.equal(ev.detail.crossCheck.agreed, true); agreed = ev; });
test("closes differ inside one range: settles on the primary and says so", async () => {
  bendNasdaq(0.05); const ev = await closeMove("TSLA", DAY, NOW, THR); globalThis.fetch = realFetch;
  assert.equal(ev.ok, true); assert.equal(ev.detail.crossCheck.sameRange, true); assert.equal(ev.detail.crossCheck.agreed, false);
});
test("closes in different ranges: held as a disagreement, never proposed", async () => {
  // a bend of 5 % of the close, in whichever direction leaves the day's range (the day's own move decides)
  const far = agreed.value > -12_500 ? -agreed.detail.close * 0.05 : agreed.detail.close * 0.05;
  bendNasdaq(far); const ev = await closeMove("TSLA", DAY, NOW, THR); globalThis.fetch = realFetch;
  assert.equal(ev.ok, false); assert.equal(ev.disagree, true); assert.match(ev.reason, /different ranges/);
});

// On-chain tokens: Jupiter alone settles; DexScreener is recorded and never decides. Numbers in the first test are market #95 (OPENAI, 2026-09-20), which the old rule held.
const MINT = "Mint1111", CDAY = "2026-09-20", CPREV = "2026-09-19", CNOW = utcMidnight(CDAY) + 24 * 3600 + 600;
function ticks(jupPrev, dexPrev, jupNow, dexNow) {
  const dir = fs.mkdtempSync(os.tmpdir() + "/sp-ticks-"); fs.mkdirSync(dir + "/ticks");
  for (const [d, p, p2] of [[CPREV, jupPrev, dexPrev], [CDAY, jupNow, dexNow]]) {
    const t0 = utcMidnight(d) + 23 * 3600;
    fs.writeFileSync(`${dir}/ticks/${d}.jsonl`, Array.from({ length: 60 }, (_, i) => JSON.stringify({ t: t0 + i * 60, p: { [MINT]: p }, p2: p2 == null ? {} : { [MINT]: p2 } })).join("\n") + "\n");
  }
  return dir;
}
test("another venue's price lands in another range: Jupiter still settles, the difference is only recorded", () => {
  const ev = chainMove(ticks(1139.48, 1683.92, 1118.66, 1626.065), MINT, "OPENAI", CDAY, CNOW, [-30000, 30000]);
  assert.equal(ev.ok, true); assert.equal(ev.value, -18272); assert.equal(ev.detail.crossCheck.agreed, false);
});
test("the other venue jumps far away on the day: still Jupiter's answer, nothing held", () => {
  const ev = chainMove(ticks(1.00, 1.01, 1.02, 1.50), MINT, "X", CDAY, CNOW, [-30000, 30000]);
  assert.equal(ev.ok, true); assert.equal(ev.value, 20000); assert.equal(ev.detail.crossCheck.agreed, false);
});
test("no second quote at all: Jupiter settles alone", () => {
  const ev = chainMove(ticks(1.00, null, 1.10, null), MINT, "X", CDAY, CNOW, [-30000, 30000]);
  assert.equal(ev.ok, true); assert.equal(ev.detail.crossCheck.agreed, null);
});

// 2026-10-19: the Tokyo host rebooted at 12:59 UTC while the sampler was writing a line; the half line sat ten hours
// before the closing hour, and the reader gave up on the whole file, so 13 markets were voided over 60 good quotes
// (and the next day's baseline could not be read either). A line that does not parse is skipped, never the day.
test("a line cut short by a crash does not cost the day: the good closing-hour samples still count", () => {
  const dir = ticks(1.00, 1.00, 1.10, 1.10);
  const half = JSON.stringify({ t: utcMidnight(CDAY) + 13 * 3600, p: { [MINT]: 1.05 }, p2: { [MINT]: 1.05 } }).slice(0, 40);
  fs.writeFileSync(`${dir}/ticks/${CDAY}.jsonl`, half + "\n" + fs.readFileSync(`${dir}/ticks/${CDAY}.jsonl`, "utf8"));
  fs.appendFileSync(`${dir}/ticks/${CPREV}.jsonl`, "null\n{\"t\":\n");
  const ev = chainMove(dir, MINT, "X", CDAY, CNOW, [-30000, 30000]);
  assert.equal(ev.ok, true); assert.equal(ev.value, 100000); assert.equal(ev.detail.samples, 60); assert.equal(ev.detail.prevSamples, 60);
});

// One quote per minute: 40 lines must be 40 minutes. A replayed cron or a run by hand that writes a second line in a
// minute adds nothing and cannot move the median (review 2026-10-21, #7).
test("40 copies of one minute are one sample: the close is not trusted", () => {
  const dir = ticks(1.00, 1.00, 1.10, 1.10);
  const t0 = utcMidnight(CDAY) + 23 * 3600;
  fs.writeFileSync(`${dir}/ticks/${CDAY}.jsonl`, Array.from({ length: 40 }, () => JSON.stringify({ t: t0, p: { [MINT]: 2 }, p2: { [MINT]: 2 } })).join("\n") + "\n");
  const ev = chainMove(dir, MINT, "X", CDAY, CNOW, [-30000, 30000]);
  assert.equal(ev.ok, false); assert.match(ev.reason, /1 of 40/);
});
test("a second line in the same minute is dropped: the first one written counts, the median does not move", () => {
  const dir = ticks(1.00, 1.00, 1.10, 1.10);
  fs.appendFileSync(`${dir}/ticks/${CDAY}.jsonl`, JSON.stringify({ t: utcMidnight(CDAY) + 23 * 3600 + 30, p: { [MINT]: 99 }, p2: { [MINT]: 99 } }) + "\n");
  const ev = chainMove(dir, MINT, "X", CDAY, CNOW, [-30000, 30000]);
  assert.equal(ev.ok, true); assert.equal(ev.value, 100000); assert.equal(ev.detail.samples, 60); assert.deepEqual(ev.detail.droppedLines[CDAY], { skipped: 0, duplicates: 1 });
});
// The evidence carries every closing-hour line that quotes the token from either source: the minutes where only the
// second source answered are in it too, so its numbers can be recomputed from the evidence (review 2026-10-21, #8).
test("minutes quoted by the second source alone are part of the evidence", () => {
  const dir = ticks(1.00, 1.00, 1.10, 1.10);
  const t0 = utcMidnight(CDAY) + 23 * 3600;
  fs.writeFileSync(`${dir}/ticks/${CDAY}.jsonl`, Array.from({ length: 60 }, (_, i) => JSON.stringify(i < 40 ? { t: t0 + i * 60, p: { [MINT]: 1.10 }, p2: { [MINT]: 1.10 } } : { t: t0 + i * 60, p: {}, p2: { [MINT]: 1.10 } })).join("\n") + "\n");
  const ev = chainMove(dir, MINT, "X", CDAY, CNOW, [-30000, 30000]);
  assert.equal(ev.ok, true); assert.equal(ev.detail.samples, 40); assert.equal(ev.detail.crossCheck.samples, 60);
  assert.equal(ev.evidence.response.split("\n").filter(Boolean).length, 120);
});
