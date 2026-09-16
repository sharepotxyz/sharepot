// Leaderboard points, computed from data/settlements.jsonl (the crank's record of every position it paid out).
//
// Points for one position in one market:
//
//     points = (your stake in dollars) × (the market's player pot in dollars)
//
// Both sides are in dollars, not shares: SPYx is worth about four times NVDAx, so scoring raw share counts would make
// the cheapest token's pool the best place to farm. The pot excludes any house seed, so bootstrap money never inflates
// a score (on mainnet there is no seed at all). Stake counts whether the bet won or lost — points reward showing up
// and making the pool deep, which is exactly what a parimutuel needs; profit is already its own reward.
//
// Every input is frozen in the settlement row at settlement time (usdPerShare, decimals, multiplier, pools), so a score
// never moves afterwards. Rows written before those fields existed are scored with a fallback price and flagged
// `approx` — the leaderboard shows how many rows that covers.
//
// Wash trading: one person betting both sides of a thin market from two wallets gets their money back minus the fee on
// the winning side, and farms points quadratically. That is not defended against here — the formula stays generous on
// purpose. It is caught after the fact by scripts/points-audit.mjs, whose verdicts land in data/points-bans.json and
// are subtracted here.
import fs from "node:fs";
import path from "node:path";

const RAW = (raw, decimals, multiplier) => (Number(raw) / 10 ** decimals) * (multiplier || 1);

/** One settlement row → its dollar figures, or null when the row cannot be priced at all. */
function score(row, fallback) {
  const decimals = row.decimals ?? fallback.decimals(row.mint);
  if (decimals == null) return null;
  const usd = row.usdPerShare ?? fallback.usd(row.mint);
  if (!usd) return null;
  const mult = row.multiplier ?? 1;
  const stakeRaw = row.amounts.reduce((a, b) => a + Number(b), 0);
  return {
    approx: row.usdPerShare == null,
    stakeUsd: RAW(stakeRaw, decimals, mult) * usd,
    payoutUsd: RAW(Number(row.payout ?? 0), decimals, mult) * usd,
    feeUsd: RAW(Number(row.fee ?? 0), decimals, mult) * usd,
    potFromRow: row.pools ? RAW(row.pools.reduce((a, b) => a + Number(b), 0), decimals, mult) * usd : null,
  };
}

/**
 * @param rows      parsed settlement rows, oldest first
 * @param fallback  { decimals(mint), usd(mint) } for rows written before those fields were recorded
 * @param bans      { [wallet]: reason } — excluded from the ranking, still counted in `banned`
 * @param since     unix seconds; only rows settled at or after this count
 */
export function leaderboard(rows, fallback, bans = {}, since = 0) {
  const scored = [];
  for (const r of rows) {
    if (since && Date.parse(r.at) / 1000 < since) continue;
    const s = score(r, fallback);
    if (s) scored.push({ r, s });
  }
  // Player pot per market: the recorded pools when available, otherwise the sum of every settled stake in that market,
  // which is the same number — the crank logs one row per position and every position is settled before the sweep.
  const pot = new Map();
  for (const { r, s } of scored) {
    const k = String(r.id);
    const cur = pot.get(k) ?? { fromRow: null, summed: 0 };
    if (s.potFromRow != null) cur.fromRow = s.potFromRow;
    cur.summed += s.stakeUsd;
    pot.set(k, cur);
  }
  const potUsd = (id) => { const c = pot.get(String(id)); return c ? (c.fromRow ?? c.summed) : 0; };

  const by = new Map();
  for (const { r, s } of scored) {
    const w = r.owner;
    const e = by.get(w) ?? { wallet: w, points: 0, bets: 0, markets: new Set(), volumeUsd: 0, pnlUsd: 0, feesPaidUsd: 0, won: 0, approxRows: 0, lastAt: r.at };
    e.points += s.stakeUsd * potUsd(r.id);
    e.bets += 1;
    e.markets.add(String(r.id));
    e.volumeUsd += s.stakeUsd;
    e.pnlUsd += s.payoutUsd - s.stakeUsd;
    e.feesPaidUsd += s.feeUsd;
    if (r.kind === "won") e.won += 1;
    if (s.approx) e.approxRows += 1;
    if (r.at > e.lastAt) e.lastAt = r.at;
    by.set(w, e);
  }
  const all = [...by.values()].map((e) => ({ ...e, markets: e.markets.size, banned: bans[e.wallet] ?? null }));
  const ranked = all.filter((e) => !e.banned).sort((a, b) => b.points - a.points).map((e, i) => ({ rank: i + 1, ...e }));
  return {
    entries: ranked,
    banned: all.filter((e) => e.banned).sort((a, b) => b.points - a.points),
    totals: {
      players: ranked.length,
      markets: pot.size,
      volumeUsd: scored.reduce((a, x) => a + x.s.stakeUsd, 0),
      feesUsd: scored.reduce((a, x) => a + x.s.feeUsd, 0),
      points: ranked.reduce((a, e) => a + e.points, 0),
      approxRows: scored.filter((x) => x.s.approx).length,
      rows: scored.length,
    },
  };
}

/** Settlement rows from disk, oldest first. */
export function readSettlements(dataDir) {
  const f = path.join(dataDir, "settlements.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** Wallets excluded by the wash-trading audit: { wallet: reason }. */
export function readBans(dataDir) {
  const f = path.join(dataDir, "points-bans.json");
  if (!fs.existsSync(f)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return Object.fromEntries(Object.entries(j.wallets ?? j).map(([k, v]) => [k, typeof v === "string" ? v : (v?.reason ?? "flagged")]));
  } catch { return {}; }
}
