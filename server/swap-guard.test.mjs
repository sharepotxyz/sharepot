// node --test server/swap-guard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { quoteProblem, effectsProblem, tokenAmount } from "./swap-guard.mjs";

const SYSTEM = "11111111111111111111111111111111", TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const walletKp = Keypair.generate(), W = walletKp.publicKey.toBase58();
const IN = Keypair.generate().publicKey.toBase58(), OUT = Keypair.generate().publicKey.toBase58(), OTHER = Keypair.generate().publicKey.toBase58();
const want = { wallet: W, inputAta: IN, outputAta: OUT, amount: 1000n, minOut: 500n, maxLamports: 10_000_000n };
/** A plain 165-byte token account: mint zeros, owner = the wallet, amount, then whatever `patch` sets. */
const tokenData = (amount, patch = (d) => d) => { const d = Buffer.alloc(165); walletKp.publicKey.toBuffer().copy(d, 32); d.writeBigUInt64LE(amount, 64); return patch(d); };
const acct = (amount, patch) => ({ lamports: 2_039_280n, owner: TOKEN, data: tokenData(amount, patch) });
const state = (o = {}) => new Map([
  [W, { lamports: o.sol ?? 1_000_000_000n, owner: SYSTEM, data: Buffer.alloc(0) }],
  [IN, acct(o.inp ?? 5000n, o.inPatch)], [OUT, o.outMissing ? { lamports: 0n, owner: null, data: null } : acct(o.out ?? 0n, o.outPatch)],
  [OTHER, o.otherMissing ? { lamports: 0n, owner: null, data: null } : acct(o.other ?? 777n, o.otherPatch)],
]);
const setDelegate = (d) => { d.writeUInt32LE(1, 72); Keypair.generate().publicKey.toBuffer().copy(d, 76); d.writeBigUInt64LE(10n ** 12n, 121); return d; };
const setCloseAuthority = (d) => { d.writeUInt32LE(1, 129); Keypair.generate().publicKey.toBuffer().copy(d, 133); return d; };
const setOwner = (d) => { Keypair.generate().publicKey.toBuffer().copy(d, 32); return d; };

test("the swap that was asked for passes", () => {
  assert.equal(effectsProblem(state(), state({ sol: 999_990_000n, inp: 4000n, out: 510n }), want), null);
});
test("taking more of the sold token than asked is refused", () => {
  assert.match(effectsProblem(state(), state({ inp: 0n, out: 510n }), want), /asked 1000/);
});
test("delivering less USDC than the quoted minimum is refused", () => {
  assert.match(effectsProblem(state(), state({ inp: 4000n, out: 499n }), want), /minimum 500/);
});
test("touching any other treasury account is refused: balance, bytes, lamports or owner", () => {
  assert.match(effectsProblem(state(), state({ inp: 4000n, out: 510n, other: 0n }), want), /no business/);
  assert.match(effectsProblem(state(), state({ inp: 4000n, out: 510n, other: 778n }), want), /no business/);
  assert.match(effectsProblem(state(), state({ inp: 4000n, out: 510n, otherPatch: setDelegate }), want), /no business/);
  assert.match(effectsProblem(state(), state({ inp: 4000n, out: 510n, otherMissing: true }), want), /no business/);
});
test("balances intact but a delegate, close authority or owner planted on a swap account is refused", () => {
  assert.match(effectsProblem(state(), state({ sol: 999_990_000n, inp: 4000n, out: 510n, inPatch: setDelegate }), want), /sold-token account beyond its balance/);
  assert.match(effectsProblem(state(), state({ sol: 999_990_000n, inp: 4000n, out: 510n, outPatch: setCloseAuthority }), want), /USDC account beyond its balance/);
  assert.match(effectsProblem(state(), state({ sol: 999_990_000n, inp: 4000n, out: 510n, outPatch: setOwner }), want), /USDC account beyond its balance/);
  const after = state({ sol: 999_990_000n, inp: 4000n, out: 510n }); after.get(IN).owner = "Some111111111111111111111111111111111111111";
  assert.match(effectsProblem(state(), after, want), /program owning the sold-token account/);
  const closed = state({ sol: 999_990_000n, inp: 4000n, out: 510n }); closed.set(IN, { lamports: 0n, owner: null, data: null });
  assert.match(effectsProblem(state(), closed, want), /would close the sold-token account/);
});
test("the wallet account itself must stay a plain system account", () => {
  const after = state({ sol: 999_990_000n, inp: 4000n, out: 510n }); after.get(W).owner = TOKEN;
  assert.match(effectsProblem(state(), after, want), /wallet account itself/);
});
test("a USDC account created by the swap must belong to the wallet", () => {
  assert.equal(effectsProblem(state({ outMissing: true }), state({ sol: 997_000_000n, inp: 4000n, out: 510n }), want), null);
  assert.match(effectsProblem(state({ outMissing: true }), state({ sol: 997_000_000n, inp: 4000n, out: 510n, outPatch: setOwner }), want), /for someone else/);
});
test("spending SOL beyond fees is refused", () => {
  assert.match(effectsProblem(state(), state({ sol: 1n, inp: 4000n, out: 510n }), want), /lamports/);
});
test("an account missing from the simulation is refused, never assumed unchanged", () => {
  const after = state({ inp: 4000n, out: 510n }); after.delete(OTHER);
  assert.match(effectsProblem(state(), after, want), /did not report/);
});
test("a quote for another mint, amount, slippage or a too-low minimum is refused", () => {
  const q = { inputMint: "A", outputMint: "USDC", inAmount: "1000", outAmount: "520", otherAmountThreshold: "517", slippageBps: 50 };
  const ask = { inputMint: "A", outputMint: "USDC", amount: 1000n };
  assert.equal(quoteProblem(q, ask), null);
  assert.equal(quoteProblem(q, { ...ask, slippageBps: 50 }), null);
  assert.match(quoteProblem({ ...q, outputMint: "X" }, ask), /buys X/);
  assert.match(quoteProblem({ ...q, inAmount: "9999" }, ask), /sells 9999/);
  assert.match(quoteProblem({ ...q, otherAmountThreshold: "0" }, ask), /minimum/);
  assert.match(quoteProblem({ ...q, otherAmountThreshold: "1" }, { ...ask, slippageBps: 50 }), /below outAmount 520/);
  assert.match(quoteProblem({ ...q, slippageBps: 500 }, { ...ask, slippageBps: 50 }), /slippage 500 bps/);
  assert.match(quoteProblem({ ...q, outAmount: "x" }, ask), /not numbers/);
});
test("token amount is read at offset 64; a missing account holds nothing", () => {
  const d = Buffer.alloc(165); d.writeBigUInt64LE(123456789n, 64);
  assert.equal(tokenAmount(d), 123456789n); assert.equal(tokenAmount(null), 0n);
});

const wantSol = { wallet: W, inputAta: OUT, amount: 1000n, minOut: 500_000_000n, maxLamports: 10_000_000n, nativeOut: true };   // sell 1000 USDC units for ≥ 0.5 SOL
test("buying SOL: the wallet must gain at least the quoted minimum less fees, USDC leaves as asked, nothing else moves", () => {
  assert.equal(effectsProblem(state({ out: 5000n }), state({ sol: 1_495_000_000n, out: 4000n }), wantSol), null);   // +0.495 SOL after fees+tip
  assert.match(effectsProblem(state({ out: 5000n }), state({ sol: 1_400_000_000n, out: 4000n }), wantSol), /would gain 400000000 lamports/);
  assert.match(effectsProblem(state({ out: 5000n }), state({ sol: 900_000_000n, out: 4000n }), wantSol), /would gain -100000000 lamports/);
  assert.match(effectsProblem(state({ out: 5000n }), state({ sol: 1_495_000_000n, out: 0n }), wantSol), /asked 1000/);
  assert.match(effectsProblem(state({ out: 5000n }), state({ sol: 1_495_000_000n, out: 4000n, other: 0n }), wantSol), /no business/);
  assert.match(effectsProblem(state({ out: 5000n }), state({ sol: 1_495_000_000n, out: 4000n, outPatch: setDelegate }), wantSol), /sold-token account beyond its balance/);
});
