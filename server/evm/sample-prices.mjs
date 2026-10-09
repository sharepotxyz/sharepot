// Samples the price of every registry meme selected for yesterday, today or tomorrow, once per run (cron: every
// minute), into <data>/evm/<chain>/ticks/<UTC date>.jsonl as {"t":<unix>,"p":{"<mainnet address>":<usd>,…},"p2":{…}}
// — the same lines the Solana sampler writes, so prices.mjs chainClose / chainMove read them unchanged. The tokens
// trade on Robinhood Chain mainnet; the primary quote is DexScreener's deepest pair (p), the second GeckoTerminal (p2).
//   env: DATA_DIR, EVM_CHAIN
import fs from "node:fs";
import path from "node:path";
import { readRegistry } from "../chain-tokens.mjs";
import { utcDate, addDays } from "../prices.mjs";
import { evmDir } from "./index-events.mjs";

const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DIR = evmDir(DATA);
const now = Math.floor(Date.now() / 1000), today = utcDate(now);
const reg = readRegistry(DIR);
const ids = Object.entries(reg.tokens).filter(([, t]) => [addDays(today, -1), today, addDays(today, 1)].some((d) => (t.selectedFor ?? []).includes(d))).map(([a]) => a.toLowerCase());
if (!ids.length) { console.log(new Date().toISOString(), "nothing to sample"); process.exit(0); }

const prices = {};
for (let i = 0; i < ids.length; i += 30) {
  const chunk = ids.slice(i, i + 30);
  const r = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${chunk.join(",")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`dexscreener ${r.status}`);
  const best = new Map();
  for (const pair of await r.json()) {
    const m = String(pair?.baseToken?.address ?? "").toLowerCase(), px = Number(pair?.priceUsd), liq = Number(pair?.liquidity?.usd ?? 0);
    if (!chunk.includes(m) || !(px > 0)) continue;
    if (!best.has(m) || liq > best.get(m).liq) best.set(m, { px, liq });
  }
  for (const [m, v] of best) prices[m] = v.px;
}
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
fs.writeFileSync(path.join(DIR, "ticks", "latest.json.tmp"), line); fs.renameSync(path.join(DIR, "ticks", "latest.json.tmp"), path.join(DIR, "ticks", "latest.json"));
console.log(new Date().toISOString(), `sampled ${Object.keys(prices).length}/${ids.length} (second source ${Object.keys(prices2).length})`);
