// What the independent verifier does with a proposal it cannot check (no price source answered). Settling real money
// on a value nobody re-derived is the one thing the verifier exists to prevent, and nobody should have to be awake to
// stop it: once the dispute window is about to close and there is still no answer, the market is voided and every
// stake refunded. Until then it keeps retrying — most causes (a 429, a late official close) clear by themselves.
//   "wait"   keep retrying, say nothing
//   "report" still retrying, but it has been long enough that the operator should know (nothing to do yet)
//   "void"   the window is closing: refund everyone
// What it does with a proposal it *could* check. Two hosts must agree before real money moves: any disagreement about
// which range the day's move landed in refunds the market, however small the gap. A tolerance band used to settle a
// boundary case on the proposer's value alone, which made the proposer's hot key worth stealing — a failed cheat is
// only refunded, so an attacker could bet everywhere, propose across a boundary wherever the day's move happened to
// sit on one, and the check waved exactly those through. The band now only colours the alert ("the two feeds straddled
// a boundary" reads differently from "the proposal is nowhere near"); it never decides whether a market settles.
//   "agree"         both hosts put the move in the same range: let it settle
//   "void-boundary" different ranges, the independent value sits on a boundary: refund, expected to happen sometimes
//   "void-mismatch" different ranges and not close: refund, and the proposer or its price source needs looking at
export const BOUNDARY_PPM = 5000;
export function comparisonAction({ proposedBucket, independentBucket, distToBoundaryPpm, boundaryPpm = BOUNDARY_PPM }) {
  if (proposedBucket === independentBucket) return "agree";
  return distToBoundaryPpm <= boundaryPpm ? "void-boundary" : "void-mismatch";
}

export const REPORT_AFTER_SECS = 3600;   // an hour into the window
export const VOID_MARGIN_SECS = 2700;    // 45 min before it closes: the job runs every 10 min and a run can take several
export function unverifiedAction({ now, proposedAt, windowEnd, voidUnverified }) {
  if (voidUnverified && windowEnd - now <= VOID_MARGIN_SECS) return "void";
  return now - proposedAt > REPORT_AFTER_SECS ? "report" : "wait";
}
