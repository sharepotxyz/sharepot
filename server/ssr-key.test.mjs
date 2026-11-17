// node --test server/ssr-key.test.mjs — the pre-render cache key (server/ssr.mjs ssrCacheKey), used by both API servers.
// Two promises: (1) a value the data does not know adds no cache entry — `?stock=<random>` used to be one full render
// per request, and the 100th cleared the cache (weekly audit 2026-11-17, rest of 2026-10-20 M3); (2) a key never
// stands for two different pages: every pair of URLs that share a key renders byte for byte the same first paint.
import test from "node:test";
import assert from "node:assert/strict";
import { homeHtml, eventHtml, ssrCacheKey } from "./ssr.mjs";
import { translator } from "./i18n.mjs";
import fs from "node:fs";

const NOW = 1794900000;   // 2026-11-17T12:00Z: SPY/TSLA of 11-17 open, TSLA of 11-14 closed
const mk = (id, metric, mint, extra = {}) => ({ id, mint, decimals: 8, multiplier: 1, metric, nBuckets: 4, thresholds: [-5000, 0, 5000], openTs: NOW - 86400,
  closeTs: NOW + 3600, resolveAfterTs: NOW + 7200, pools: [id * 10, 0, 5, 7], seed: 0, status: 0, outcome: 255, proposedOutcome: 255, positions: 3, positionsOpen: 3, ...extra });
const stocks = [
  { symbol: "SPY", name: "S&P 500", category: "stocks", tokens: [{ token: "SPYx", mint: "mSPYx" }, { token: "SPYon", mint: "mSPYon" }] },
  { symbol: "TSLA", name: "Tesla", category: "stocks", tokens: [{ token: "TSLAx", mint: "mTSLAx" }] },
  { symbol: "WIF", name: "dogwifhat", category: "memes", tokens: [{ token: "WIF", mint: "mWIF" }] },
];
const markets = [
  mk(0, "SPY.close:2026-11-17", "mSPYx"), mk(1, "SPY.close:2026-11-17", "mSPYon"), mk(2, "TSLA.close:2026-11-17", "mTSLAx"),
  mk(3, "TSLA.close:2026-11-14", "mTSLAx", { closeTs: NOW - 86400 * 3, status: 2, outcome: 1 }), mk(4, "WIF.day:2026-11-17", "mWIF", { nBuckets: 3, thresholds: [-2000, 2000] }),
  mk(5, "not a metric", "mWIF"),   // an unparseable market: buildEvents names its symbol "?"
];
const data = { markets, config: { feeBps: 300, earlyBirdDiscountBps: 100, earlyBirdSecs: 3600 }, stocks, prices: { SPYx: { usd: 600 }, TSLAx: { usd: 400 } } };
// the real page files, so the renderers find the placeholders they fill (a made-up page silently rendered nothing)
const BASE = Object.fromEntries(["/index.html", "/market.html"].map((rel) => [rel, fs.readFileSync(new URL("../web" + rel, import.meta.url), "utf8")]));
const rnd = (i) => `x${i}${Math.random().toString(36).slice(2, 8)}`;

function render(rel, url) {
  const real = Date.now; Date.now = () => NOW * 1000;
  try { const tr = translator("en"); return rel === "/index.html" ? homeHtml(data, BASE[rel], url, tr) : eventHtml(data, url, BASE[rel], tr); } finally { Date.now = real; }
}
const key = (rel, qs) => ssrCacheKey(data, rel, new URL("https://x.test/" + qs));

test("unknown values share one key; known values keep their own", () => {
  const homes = new Set(), events = new Set(), toks = new Set();
  for (let i = 0; i < 500; i++) {
    homes.add(key("/index.html", `?stock=${rnd(i)}`)); homes.add(key("/index.html", `?stock=${rnd(i)}&cat=${rnd(i)}`));
    events.add(key("/market.html", `?e=${encodeURIComponent(rnd(i))}`)); toks.add(key("/market.html", `?e=SPY:2026-11-17&t=${rnd(i)}`));
  }
  assert.equal(homes.size, 2, "random ?stock= (and ?cat=) values: one entry each shape, not one per value");
  assert.equal(events.size, 1);
  assert.equal(toks.size, 1);
  assert.notEqual(key("/index.html", "?stock=SPY"), key("/index.html", "?stock=TSLA"));
  assert.equal(key("/index.html", "?stock=all"), key("/index.html", ""));
  assert.equal(key("/market.html", "?id=7"), key("/market.html", ""), "an id no market has is the same page as none");
  assert.equal(key("/market.html", "?id=02"), key("/market.html", "?id=2"), "id is read as a number, as the renderer reads it");
});

test("a key never stands for two different pages", () => {
  const cases = {
    "/index.html": ["", "?stock=all", "?stock=", "?stock=SPY", "?stock=TSLA", "?stock=WIF", "?stock=%3F", "?stock=NOPE", "?stock=zz", "?cat=memes", "?cat=stocks",
      "?cat=bogus", "?cat=all&stock=SPY", "?stock=NOPE&cat=memes", "?status=resolved", "?status=resolved&stock=SPY", "?q=tes", "?sort=pot&cat=memes", "?x=1"],
    "/market.html": ["", "?id=0", "?id=1", "?id=01", "?id=1.0", "?id=3", "?id=99", "?id=", "?id=abc", "?e=SPY:2026-11-17", "?e=SPY:2026-11-17&t=SPYon",
      "?e=SPY:2026-11-17&t=SPYx", "?e=SPY:2026-11-17&t=nope", "?e=SPY:2026-11-17&t=", "?e=TSLA:2026-11-14", "?e=m5", "?e=", "?e=nope", "?e=nope&t=SPYon",
      "?id=1&t=SPYx", "?id=1&t=nope", "?id=4", "?id=5", "?e=WIF:2026-11-17&t=WIF"],
  };
  for (const [rel, list] of Object.entries(cases)) {
    const seen = new Map();
    for (const qs of [...list, ...Array.from({ length: 20 }, (_, i) => (rel === "/index.html" ? `?stock=${rnd(i)}` : `?e=${rnd(i)}&id=${i}`))]) {
      const k = key(rel, qs), html = render(rel, new URL("https://x.test/" + qs));
      if (seen.has(k)) assert.equal(html, seen.get(k).html, `${rel}: "${qs}" and "${seen.get(k).qs}" share key ${JSON.stringify(k)} but render differently`);
      else seen.set(k, { html, qs });
    }
  }
  // the fixture really renders: a known event page and a stock tab differ from the bare page
  assert.notEqual(render("/market.html", new URL("https://x.test/?e=SPY:2026-11-17")), BASE["/market.html"]);
  assert.notEqual(render("/market.html", new URL("https://x.test/?e=SPY:2026-11-17&t=SPYon")), render("/market.html", new URL("https://x.test/?e=SPY:2026-11-17")));
  assert.notEqual(render("/index.html", new URL("https://x.test/")), BASE["/index.html"]);
  assert.notEqual(render("/index.html", new URL("https://x.test/?stock=SPY")), render("/index.html", new URL("https://x.test/")));
});
