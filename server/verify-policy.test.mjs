import test from "node:test";
import assert from "node:assert/strict";
import { unverifiedAction, VOID_MARGIN_SECS, comparisonAction, BOUNDARY_PPM } from "./verify-policy.mjs";

const cmp = (pb, mb, dist) => comparisonAction({ proposedBucket: pb, independentBucket: mb, distToBoundaryPpm: dist });
test("same range: settles", () => assert.equal(cmp(2, 2, 1), "agree"));
test("different ranges, far from any boundary: refund", () => assert.equal(cmp(3, 1, BOUNDARY_PPM * 4), "void-mismatch"));
// the fix: a proposal that crosses a boundary the independent value sits on used to settle on the proposer's word
test("different ranges on a boundary: refund, never settle", () => {
  assert.equal(cmp(2, 1, 0), "void-boundary");
  assert.equal(cmp(2, 1, BOUNDARY_PPM), "void-boundary");
  assert.equal(cmp(2, 1, BOUNDARY_PPM + 1), "void-mismatch");
});
test("agreement wins even on a boundary", () => assert.equal(cmp(1, 1, 0), "agree"));

const P = 1_000_000, W = 21600, end = P + W;
test("fresh proposal: wait quietly", () => assert.equal(unverifiedAction({ now: P + 600, proposedAt: P, windowEnd: end, voidUnverified: true }), "wait"));
test("an hour in, still no answer: report, do not void", () => assert.equal(unverifiedAction({ now: P + 3601, proposedAt: P, windowEnd: end, voidUnverified: true }), "report"));
test("window about to close: void", () => {
  assert.equal(unverifiedAction({ now: end - VOID_MARGIN_SECS - 1, proposedAt: P, windowEnd: end, voidUnverified: true }), "report");
  assert.equal(unverifiedAction({ now: end - VOID_MARGIN_SECS, proposedAt: P, windowEnd: end, voidUnverified: true }), "void");
  assert.equal(unverifiedAction({ now: end + 60, proposedAt: P, windowEnd: end, voidUnverified: true }), "void");
});
test("switched off (devnet): never voids for lack of a source", () => assert.equal(unverifiedAction({ now: end - 60, proposedAt: P, windowEnd: end, voidUnverified: false }), "report"));
test("a window shorter than the margin voids at once rather than never", () => assert.equal(unverifiedAction({ now: P + 1, proposedAt: P, windowEnd: P + 1800, voidUnverified: true }), "void"));
