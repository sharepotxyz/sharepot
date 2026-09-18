// SOL is what the system burns (market rent that comes back late, transaction fees, Jito tips, the odd token account
// opened for a user), not something the treasury holds. The fee swap therefore sells everything for USDC and buys SOL
// back only up to fixed levels: when a wallet is below its floor it is refilled to its target. The floors are sized to
// last a couple of months at mainnet usage (well under 0.2 SOL a month in total), so a missed run cannot stall the
// proposer. Pure planning here; treasury-swap.mjs does the buying and the transfer.
const LAMPORTS = 1_000_000_000n;
export const sol = (x) => BigInt(Math.round(Number(x) * 1e9));
export const fmtSol = (l) => (Number(l) / 1e9).toFixed(3);

export const DEFAULTS = {
  treasuryFloor: sol(0.3), treasuryTarget: sol(0.5),   // pays swaps' tips and the referral payouts
  proposerFloor: sol(0.5), proposerTarget: sol(1),     // opens, resolves and sweeps every market
  maxPerRun: sol(3),                                   // a wrong balance reading cannot turn the whole USDC into SOL
};

/** What to buy: [{ who: "treasury"|"proposer", lamports }] for every wallet under its floor, each topped to its target;
 *  the total is capped at maxPerRun (the proposer, which cannot work without SOL, is served first). */
export function topUpPlan({ treasury, proposer }, cfg = DEFAULTS) {
  const plan = [];
  if (proposer < cfg.proposerFloor) plan.push({ who: "proposer", lamports: cfg.proposerTarget - proposer });
  if (treasury < cfg.treasuryFloor) plan.push({ who: "treasury", lamports: cfg.treasuryTarget - treasury });
  let left = cfg.maxPerRun;
  for (const p of plan) { p.lamports = p.lamports < left ? p.lamports : left; left -= p.lamports; }
  return plan.filter((p) => p.lamports > 0n);
}

/** USDC units (6 decimals) to offer for `lamports` of SOL when one USDC buys `lamportsPerUsdc`, plus `headroomBps` so
 *  the quoted minimum output still covers the need after slippage. */
export function usdcForLamports(lamports, lamportsPerUsdc, headroomBps = 150) {
  if (!(lamportsPerUsdc > 0n)) throw new Error("no SOL price");
  return (lamports * 1_000_000n * (10_000n + BigInt(headroomBps)) + lamportsPerUsdc * 10_000n - 1n) / (lamportsPerUsdc * 10_000n);
}
