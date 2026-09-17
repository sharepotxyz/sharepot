// node --test server/swap-guard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { quoteProblem, effectsProblem, tokenAmount } from "./swap-guard.mjs";

const W = "wallet", IN = "inAta", OUT = "usdcAta", OTHER = "otherAta";
const want = { wallet: W, inputAta: IN, outputAta: OUT, amount: 1000n, minOut: 500n, maxLamports: 10_000_000n };
const state = (o = {}) => new Map([[W, { lamports: o.sol ?? 1_000_000_000n, amount: 0n }], [IN, { lamports: 2_039_280n, amount: o.inp ?? 5000n }], [OUT, { lamports: 2_039_280n, amount: o.out ?? 0n }], [OTHER, { lamports: 2_039_280n, amount: o.other ?? 777n }]]);

test("the swap that was asked for passes", () => {
  assert.equal(effectsProblem(state(), state({ sol: 999_990_000n, inp: 4000n, out: 510n }), want), null);
});
test("taking more of the sold token than asked is refused", () => {
  assert.match(effectsProblem(state(), state({ inp: 0n, out: 510n }), want), /asked 1000/);
});
test("delivering less USDC than the quoted minimum is refused", () => {
  assert.match(effectsProblem(state(), state({ inp: 4000n, out: 499n }), want), /minimum 500/);
});
test("touching any other treasury account is refused", () => {
  assert.match(effectsProblem(state(), state({ inp: 4000n, out: 510n, other: 0n }), want), /no business/);
});
test("spending SOL beyond fees is refused", () => {
  assert.match(effectsProblem(state(), state({ sol: 1n, inp: 4000n, out: 510n }), want), /lamports/);
});
test("an account missing from the simulation is refused, never assumed unchanged", () => {
  const after = state({ inp: 4000n, out: 510n }); after.delete(OTHER);
  assert.match(effectsProblem(state(), after, want), /did not report/);
});
test("a quote for another mint or amount is refused", () => {
  const q = { inputMint: "A", outputMint: "USDC", inAmount: "1000", otherAmountThreshold: "500" };
  assert.equal(quoteProblem(q, { inputMint: "A", outputMint: "USDC", amount: 1000n }), null);
  assert.match(quoteProblem({ ...q, outputMint: "X" }, { inputMint: "A", outputMint: "USDC", amount: 1000n }), /buys X/);
  assert.match(quoteProblem({ ...q, inAmount: "9999" }, { inputMint: "A", outputMint: "USDC", amount: 1000n }), /sells 9999/);
  assert.match(quoteProblem({ ...q, otherAmountThreshold: "0" }, { inputMint: "A", outputMint: "USDC", amount: 1000n }), /minimum/);
});
test("token amount is read at offset 64; a missing account holds nothing", () => {
  const d = Buffer.alloc(165); d.writeBigUInt64LE(123456789n, 64);
  assert.equal(tokenAmount(d), 123456789n); assert.equal(tokenAmount(null), 0n);
});
