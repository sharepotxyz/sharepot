// Samples the Jupiter price of every token that settles on its on-chain price, once per run (cron: every minute), into
// data/ticks/<UTC date>.jsonl as {"t":<unix>,"p":{"<mainnet mint>":<usd>,…}}. The close of a UTC day is the median of
// the samples taken in its last hour (prices.mjs chainClose); the file is the evidence the resolver publishes.
// Tracked: pre-IPO tokens from stock-templates.json (kind "day") and registry memes selected for yesterday, today or
// tomorrow, so a token's closing hour is always covered from the evening it is picked.
//   env: DATA_DIR, STOCKS (templates path)
import fs from "node:fs";
import path from "node:path";
import { readRegistry } from "./chain-tokens.mjs";
import { utcDate, addDays } from "./prices.mjs";

//        TOKENS_API=<site>/api/stocks — sample the site's listed on-chain tokens instead of the local templates and
//        registry: for a second sampler on another host (the verifier's), which has no registry of its own.
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const now = Math.floor(Date.now() / 1000), today = utcDate(now);
const mints = new Set();
//        TOKENS_FILE=<path> — the list verify-proposals.mjs writes from the chain's own market accounts (mainnet verifier):
//        the site is never asked, so it cannot leave a token out of the verifier's samples.
if (process.env.TOKENS_FILE) {
  let list = null; try { list = JSON.parse(fs.readFileSync(process.env.TOKENS_FILE, "utf8")).tokens; } catch (e) { if (e?.code !== "ENOENT") throw e; }
  for (const t of list ?? []) if (t.mint) mints.add(t.mint);
} else if (process.env.TOKENS_API) {
  const { stocks } = await (await fetch(process.env.TOKENS_API, { signal: AbortSignal.timeout(15_000) })).json();
  for (const s of stocks) if (s.kind === "day") for (const t of s.tokens) if (t.mainnetMint) mints.add(t.mainnetMint);
} else {
  const tpl = JSON.parse(fs.readFileSync(process.env.STOCKS ?? new URL("./stock-templates.json", import.meta.url), "utf8"));
  const reg = readRegistry(DATA);
  for (const s of tpl.stocks) if (s.kind === "day") for (const t of s.tokens) mints.add(t.mainnetMint);
  for (const [mint, t] of Object.entries(reg.tokens)) if ([addDays(today, -1), today, addDays(today, 1)].some((d) => (t.selectedFor ?? []).includes(d))) mints.add(mint);
}
if (!mints.size) { console.log(new Date().toISOString(), "nothing to sample"); process.exit(0); }

const ids = [...mints];
const prices = {};
for (let i = 0; i < ids.length; i += 50) {
  const chunk = ids.slice(i, i + 50);
  const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${chunk.join(",")}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`jupiter ${r.status}`);
  const j = await r.json();
  for (const m of chunk) if (typeof j[m]?.usdPrice === "number" && j[m].usdPrice > 0) prices[m] = j[m].usdPrice;
}
// Second source, DexScreener (price of the token's deepest pair), kept beside Jupiter's in the same line as `p2`. A close
// is only trusted when both sources put the day's move in the same range (prices.mjs chainMove); a source that is down
// for a minute just leaves its key out of that line.
const prices2 = {};
try {
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`dexscreener ${r.status}`);
    const best = new Map();
    for (const pair of await r.json()) {
      const m = pair?.baseToken?.address, px = Number(pair?.priceUsd), liq = Number(pair?.liquidity?.usd ?? 0);
      if (!chunk.includes(m) || !(px > 0)) continue;
      if (!best.has(m) || liq > best.get(m).liq) best.set(m, { px, liq });
    }
    for (const [m, v] of best) prices2[m] = v.px;
  }
} catch (e) { console.error(new Date().toISOString(), "second source:", String(e?.message ?? e).slice(0, 100)); }
fs.mkdirSync(path.join(DATA, "ticks"), { recursive: true });
const line = JSON.stringify({ t: now, p: prices, p2: prices2 });
fs.appendFileSync(path.join(DATA, "ticks", `${today}.jsonl`), line + "\n");
fs.writeFileSync(path.join(DATA, "ticks", "latest.json.tmp"), line); fs.renameSync(path.join(DATA, "ticks", "latest.json.tmp"), path.join(DATA, "ticks", "latest.json"));
console.log(new Date().toISOString(), `sampled ${Object.keys(prices).length}/${ids.length} (second source ${Object.keys(prices2).length})`);
