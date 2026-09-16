// Tokens that settle on their on-chain price (metric "<SYMBOL>.day:<date>", see prices.mjs): the fixed pre-IPO tokens
// listed in stock-templates.json (kind "day") and the memes select-chain.mjs picks each evening by traded volume.
// The memes live in data/chain-tokens.json, a registry keyed by mainnet mint that is only ever added to, so a token
// that fell out of the top ten still has its name and its devnet mock when its old markets are shown or settled:
//   { "tokens": { "<mainnet mint>": { symbol, name, decimals, tokenProgram, icon, category: "memes", thresholdsBps,
//                  faucetUi, seedUi, usdPrice, liquidity, volume24h, ageDays, addedAt, selectedFor: ["YYYY-MM-DD", …],
//                  mock: "<devnet mint>" | null } } }
import fs from "node:fs";
import path from "node:path";

export const REGISTRY_FILE = (dataDir) => path.join(dataDir, "chain-tokens.json");
export function readRegistry(dataDir) {
  try { const r = JSON.parse(fs.readFileSync(REGISTRY_FILE(dataDir), "utf8")); r.tokens ??= {}; return r; } catch { return { tokens: {} }; }
}
export function writeRegistry(dataDir, reg) {
  fs.mkdirSync(dataDir, { recursive: true });
  const f = REGISTRY_FILE(dataDir), tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ ...reg, updatedAt: new Date().toISOString() }, null, 1));
  fs.renameSync(tmp, f);
}
/** Registry tokens selected for `date` (a UTC day), in the order they were listed. */
export const selectedFor = (reg, date) => Object.entries(reg.tokens).filter(([, t]) => (t.selectedFor ?? []).includes(date)).map(([mint, t]) => ({ mainnetMint: mint, ...t }));

/** The "stocks" view of a registry token, shaped like a stock-templates.json entry so every consumer treats it alike:
 *  one token, its own symbol, three ranges (down / flat / up around ±thresholdBps). */
export function asStock(mainnetMint, t, cluster) {
  return {
    symbol: t.symbol, name: t.name, category: "memes", kind: "day", thresholdsBps: t.thresholdsBps, icon: t.icon ?? null,
    tokens: [{ token: t.symbol, issuer: t.issuer ?? "Solana meme", decimals: t.decimals, mainnetMint, mint: cluster === "mainnet" ? mainnetMint : t.mock ?? null, seed: t.seedUi ?? 0, faucetUi: t.faucetUi ?? 0, tokenProgram: t.tokenProgram ?? null }],
  };
}

/** Round a dollar budget into a "nice" token amount (2 significant digits), never below one raw unit. */
export function niceAmount(usd, price, decimals) {
  if (!(price > 0)) return 0;
  const raw = usd / price;
  const mag = 10 ** Math.floor(Math.log10(raw)) / 10;
  const nice = Math.round(raw / mag) * mag;
  return Math.max(nice, 10 ** -decimals);
}
