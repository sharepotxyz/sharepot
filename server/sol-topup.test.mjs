import { test } from "node:test";
import assert from "node:assert/strict";
import { topUpPlan, usdcForLamports, sol, DEFAULTS } from "./sol-topup.mjs";

test("wallets at or above their floor are left alone", () => {
  assert.deepEqual(topUpPlan({ treasury: sol(0.3), proposer: sol(0.5) }), []);
  assert.deepEqual(topUpPlan({ treasury: sol(5), proposer: sol(9) }), []);
});
test("a wallet under its floor is refilled to its target, not just to the floor", () => {
  assert.deepEqual(topUpPlan({ treasury: sol(0.29), proposer: sol(2) }), [{ who: "treasury", lamports: sol(0.21) }]);
  assert.deepEqual(topUpPlan({ treasury: sol(1), proposer: sol(0.1) }), [{ who: "proposer", lamports: sol(0.9) }]);
  assert.deepEqual(topUpPlan({ treasury: 0n, proposer: 0n }), [{ who: "proposer", lamports: sol(1) }, { who: "treasury", lamports: sol(0.5) }]);
});
test("the per-run cap serves the proposer first and never exceeds the cap", () => {
  const cfg = { ...DEFAULTS, proposerTarget: sol(4), maxPerRun: sol(3) };
  assert.deepEqual(topUpPlan({ treasury: 0n, proposer: 0n }, cfg), [{ who: "proposer", lamports: sol(3) }]);
  const cfg2 = { ...DEFAULTS, maxPerRun: sol(1.2) };
  assert.deepEqual(topUpPlan({ treasury: 0n, proposer: 0n }, cfg2), [{ who: "proposer", lamports: sol(1) }, { who: "treasury", lamports: sol(0.2) }]);
});
test("USDC to offer covers the SOL needed plus headroom, rounded up", () => {
  assert.equal(usdcForLamports(sol(1), 10_000_000n, 0), 100_000_000n);        // $100/SOL → 100 USDC
  assert.equal(usdcForLamports(sol(1), 10_000_000n, 150), 101_500_000n);      // +1.5 %
  assert.equal(usdcForLamports(1n, 10_000_000n, 0), 1n);                       // rounds up, never 0 for a positive need
  assert.throws(() => usdcForLamports(sol(1), 0n), /no SOL price/);
});
