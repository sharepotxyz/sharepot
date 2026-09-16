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

const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const tpl = JSON.parse(fs.readFileSync(process.env.STOCKS ?? new URL("./stock-templates.json", import.meta.url), "utf8"));
const now = Math.floor(Date.now() / 1000), today = utcDate(now);
const reg = readRegistry(DATA);
const mints = new Set(tpl.stocks.filter((s) => s.kind === "day").flatMap((s) => s.tokens.map((t) => t.mainnetMint)));
for (const [mint, t] of Object.entries(reg.tokens)) if ([addDays(today, -1), today, addDays(today, 1)].some((d) => (t.selectedFor ?? []).includes(d))) mints.add(mint);
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
fs.mkdirSync(path.join(DATA, "ticks"), { recursive: true });
const line = JSON.stringify({ t: now, p: prices });
fs.appendFileSync(path.join(DATA, "ticks", `${today}.jsonl`), line + "\n");
fs.writeFileSync(path.join(DATA, "ticks", "latest.json.tmp"), line); fs.renameSync(path.join(DATA, "ticks", "latest.json.tmp"), path.join(DATA, "ticks", "latest.json"));
console.log(new Date().toISOString(), `sampled ${Object.keys(prices).length}/${ids.length}`);
