// Samples the price of every registry meme selected for yesterday, today or tomorrow, once per run (cron: every
// minute), into <data>/evm/<chain>/ticks/<UTC date>.jsonl as {"t":<unix>,"p":{"<mainnet address>":<usd>,…},"p2":{…}}
// — the same lines the Solana sampler writes, so prices.mjs chainClose / chainMove read them unchanged. The tokens
// trade on Robinhood Chain mainnet; the primary quote (p) is DexScreener's quote of THE POOL RECORDED AT SELECTION
// (select-chain.mjs `pool`), the second (p2) GeckoTerminal's token price.
//   Until 2026-10-20 p came from whichever pair DexScreener reported deepest at that minute, so a pool stood up with a
//   mountain of one-sided liquidity became the price source and could set a day's close (audit 2026-10-20 H1). A token
//   whose recorded pool is missing from DexScreener's answer gets no p that minute (a market short of quotes holds and,
//   a day later, voids with refunds); only a token recorded before pools were written falls back to the deepest pair.
//   env: DATA_DIR, EVM_CHAIN; or TOKENS_API=<site>/api/stocks for a host without the registry (the verifier's own
//   sampler on Tokyo, see /root/stocklana/sample-cron.sh): the site's listed meme tokens, each with the pool it names.
import fs from "node:fs";
import path from "node:path";
import { readRegistry } from "../chain-tokens.mjs";
import { utcDate, addDays } from "../prices.mjs";
import { withRetry, guardProcess } from "../retry.mjs";
guardProcess();
import { evmDir } from "./index-events.mjs";

const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DIR = evmDir(DATA);
const now = Math.floor(Date.now() / 1000), today = utcDate(now);
// tokens to sample: { <lowercase mainnet address>: <pool address or null> }
const pinned = new Map();
if (process.env.TOKENS_API) {
  const { stocks } = await (await fetch(process.env.TOKENS_API, { signal: AbortSignal.timeout(15_000) })).json();
  for (const s of stocks ?? []) if (s.kind === "day") for (const t of s.tokens) if (t.mainnetMint) pinned.set(String(t.mainnetMint).toLowerCase(), t.pool ? String(t.pool).replace(/^robinhood_/, "").toLowerCase() : null);
} else {
  const reg = readRegistry(DIR);
  for (const [a, t] of Object.entries(reg.tokens)) if ([addDays(today, -1), today, addDays(today, 1)].some((d) => (t.selectedFor ?? []).includes(d))) pinned.set(a.toLowerCase(), t.pool ? String(t.pool).replace(/^robinhood_/, "").toLowerCase() : null);
}
const ids = [...pinned.keys()];
if (!ids.length) { console.log(new Date().toISOString(), "nothing to sample"); process.exit(0); }

const prices = {}; const missing = [];
// Primary source, retried on transient failures; a minute it still cannot reach is logged, not fatal (see server/sample-prices.mjs)
try {
for (let i = 0; i < ids.length; i += 30) {
  const chunk = ids.slice(i, i + 30);
  const pairs = await withRetry(async () => {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${chunk.join(",")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`dexscreener ${r.status}`);
    return r.json();
  }, 3, "dexscreener");
  const best = new Map();
  for (const pair of pairs) {
    const m = String(pair?.baseToken?.address ?? "").toLowerCase(), px = Number(pair?.priceUsd), liq = Number(pair?.liquidity?.usd ?? 0), addr = String(pair?.pairAddress ?? "").toLowerCase();
    if (!chunk.includes(m) || !(px > 0)) continue;
    const want = pinned.get(m);
    if (want) { if (addr === want) best.set(m, { px, liq }); continue; }                  // the recorded pool, nothing else
    if (!best.has(m) || liq > best.get(m).liq) best.set(m, { px, liq });                     // no pool recorded: the deepest pair, as before
  }
  for (const [m, v] of best) prices[m] = v.px;
  for (const m of chunk) if (pinned.get(m) && !best.has(m)) missing.push(m);
}
} catch (e) { console.error(new Date().toISOString(), "primary source:", String(e?.message ?? e).slice(0, 100)); }
if (missing.length) console.log(new Date().toISOString(), `recorded pool not in DexScreener's answer, no primary quote this minute: ${missing.join(",")}`);
const prices2 = {};
try {
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/multi/${chunk.join(",")}`, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (SharePot)" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`geckoterminal ${r.status}`);
    for (const t of (await r.json()).data ?? []) { const m = String(t.attributes?.address ?? "").toLowerCase(), px = Number(t.attributes?.price_usd); if (chunk.includes(m) && px > 0) prices2[m] = px; }
  }
} catch (e) { console.error(new Date().toISOString(), "second source:", String(e?.message ?? e).slice(0, 100)); }
fs.mkdirSync(path.join(DIR, "ticks"), { recursive: true });
const line = JSON.stringify({ t: now, p: prices, p2: prices2 });
fs.appendFileSync(path.join(DIR, "ticks", `${today}.jsonl`), line + "\n");
if (Object.keys(prices).length) { fs.writeFileSync(path.join(DIR, "ticks", "latest.json.tmp"), line); fs.renameSync(path.join(DIR, "ticks", "latest.json.tmp"), path.join(DIR, "ticks", "latest.json")); }
console.log(new Date().toISOString(), `sampled ${Object.keys(prices).length}/${ids.length} (second source ${Object.keys(prices2).length})`);
