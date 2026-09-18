// What the independent verifier does with a proposal it cannot check (no price source answered). Settling real money
// on a value nobody re-derived is the one thing the verifier exists to prevent, and nobody should have to be awake to
// stop it: once the dispute window is about to close and there is still no answer, the market is voided and every
// stake refunded. Until then it keeps retrying — most causes (a 429, a late official close) clear by themselves.
//   "wait"   keep retrying, say nothing
//   "report" still retrying, but it has been long enough that the operator should know (nothing to do yet)
//   "void"   the window is closing: refund everyone
export const REPORT_AFTER_SECS = 3600;   // an hour into the window
export const VOID_MARGIN_SECS = 2700;    // 45 min before it closes: the job runs every 10 min and a run can take several
export function unverifiedAction({ now, proposedAt, windowEnd, voidUnverified }) {
  if (voidUnverified && windowEnd - now <= VOID_MARGIN_SECS) return "void";
  return now - proposedAt > REPORT_AFTER_SECS ? "report" : "wait";
}
