// Leaderboard points, computed from data/settlements.jsonl (the crank's record of every position it paid out).
//
// Points for one position in one market:
//
//     points = shares staked × the official close the market settled on
//
// i.e. what the stake was worth, in dollars, at settlement. Every range you bet counts, won or lost: one share on each
// of the four ranges of a $212 close is 848 points, and only one of them can pay. The close is the one in the evidence
// file the result was derived from, so NVDAx and NVDAon score alike and no token quote is involved. The crank freezes
// it into the settlement row; rows written before it did are read back from that same evidence file. A market with no
// official close (voided: the session never traded) has no result and scores nothing.
import fs from "node:fs";
import path from "node:path";

const shares = (raw, decimals, multiplier) => (Number(raw) / 10 ** decimals) * (multiplier || 1);

/** One settlement row → its dollar figures, or null when the market has no official close. */
function score(row, fallback) {
  const decimals = row.decimals ?? fallback.decimals(row.mint);
  const close = row.close ?? fallback.close(row.id);
  if (decimals == null || !close) return null;
  const mult = row.multiplier ?? 1;
  const stakeRaw = row.amounts.reduce((a, b) => a + Number(b), 0);
  return {
    stakeUsd: shares(stakeRaw, decimals, mult) * close,
    payoutUsd: shares(Number(row.payout ?? 0), decimals, mult) * close,
    feeUsd: shares(Number(row.fee ?? 0), decimals, mult) * close,
  };
}

/**
 * @param rows      parsed settlement rows, oldest first
 * @param fallback  { decimals(mint), close(marketId) } for rows written before those fields were recorded
 * @param since     unix seconds; only rows settled at or after this count
 */
export function leaderboard(rows, fallback, since = 0) {
  const by = new Map(), markets = new Set();
  let volumeUsd = 0, feesUsd = 0, scoredRows = 0;
  for (const r of rows) {
    if (since && Date.parse(r.at) / 1000 < since) continue;
    const s = score(r, fallback);
    if (!s) continue;
    scoredRows++; markets.add(String(r.id)); volumeUsd += s.stakeUsd; feesUsd += s.feeUsd;
    const e = by.get(r.owner) ?? { wallet: r.owner, points: 0, bets: 0, markets: new Set(), pnlUsd: 0, feesPaidUsd: 0, won: 0, lastAt: r.at };
    e.points += s.stakeUsd;
    e.bets += 1;
    e.markets.add(String(r.id));
    e.pnlUsd += s.payoutUsd - s.stakeUsd;
    e.feesPaidUsd += s.feeUsd;
    if (r.kind === "won") e.won += 1;
    if (r.at > e.lastAt) e.lastAt = r.at;
    by.set(r.owner, e);
  }
  const entries = [...by.values()].map((e) => ({ ...e, markets: e.markets.size })).sort((a, b) => b.points - a.points).map((e, i) => ({ rank: i + 1, ...e }));
  return {
    entries,
    totals: { players: entries.length, markets: markets.size, volumeUsd, feesUsd, points: volumeUsd, rows: scoredRows },
  };
}

/** Settlement rows from disk, oldest first. */
export function readSettlements(dataDir) {
  const f = path.join(dataDir, "settlements.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
