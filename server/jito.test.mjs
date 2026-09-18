import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TIP_ACCOUNTS, tipLamports, tipProblem, systemTransfers, sendBundleOnly } from "./jito.mjs";

const payer = Keypair.generate(), tipAcct = new PublicKey([...TIP_ACCOUNTS][0]), stranger = Keypair.generate().publicKey;
const tx = (...ixs) => new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message());
const transfer = (to, lamports) => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports });

test("tip follows the landed-tip floor, clamped to [min, max]", () => {
  assert.equal(tipLamports(null), 100_000);                       // floor unknown → min
  assert.equal(tipLamports(0.0000119), 100_000);                  // floor below min → min
  assert.equal(tipLamports(0.0005), 500_000);                     // floor in range → floor
  assert.equal(tipLamports(0.01), 2_000_000);                     // floor above max → max
  assert.equal(tipLamports(0.0005, { min: 1_000, max: 10_000 }), 10_000);
});

test("a single tip to a Jito tip account, at most the agreed amount, passes", () => {
  assert.equal(tipProblem(tx(transfer(tipAcct, 100_000)), 100_000), null);
  assert.equal(tipProblem(tx(transfer(tipAcct, 90_000)), 100_000), null);
  assert.equal(tipProblem(tx(transfer(tipAcct, 100_000), SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: stranger, lamports: 2_039_280, space: 165, programId: stranger })), 100_000), null);   // an ATA's rent is not a transfer
});

test("no tip, two tips, a bigger tip, or SOL to anyone else is refused", () => {
  assert.match(tipProblem(tx(), 100_000), /no Jito tip/);
  assert.match(tipProblem(tx(transfer(tipAcct, 50_000), transfer(tipAcct, 50_000)), 100_000), /2 tip transfers/);
  assert.match(tipProblem(tx(transfer(tipAcct, 100_001)), 100_000), /tips 100001 lamports, agreed 100000/);
  assert.match(tipProblem(tx(transfer(tipAcct, 100_000), transfer(stranger, 1)), 100_000), /not a tip/);
  assert.match(tipProblem(tx(transfer(stranger, 100_000)), 100_000), /not a tip/);
});

test("systemTransfers reads the Transfer instruction only", () => {
  const t = systemTransfers(tx(transfer(stranger, 7), SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: tipAcct, lamports: 5, space: 0, programId: stranger })));
  assert.deepEqual(t, [{ to: stranger.toBase58(), lamports: 7n }]);
});

test("sendBundleOnly posts base64 with bundleOnly=true and returns the echoed signature; errors carry the status", async () => {
  const calls = [];
  const fake = (status, body, headers = {}) => async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: (k) => headers[k] ?? null } }; };
  const r = await sendBundleOnly(Uint8Array.from([1, 2, 3]), { url: "https://x", fetchImpl: fake(200, { jsonrpc: "2.0", result: "SIG" }, { "x-bundle-id": "B1" }) });
  assert.deepEqual(r, { signature: "SIG", bundleId: "B1" });
  assert.equal(calls[0].url, "https://x/api/v1/transactions?bundleOnly=true");
  assert.deepEqual(calls[0].body.params, ["AQID", { encoding: "base64" }]);
  await assert.rejects(sendBundleOnly(Uint8Array.from([1]), { fetchImpl: fake(429, { error: { message: "rate limited" } }) }), /jito 429: rate limited/);
  await assert.rejects(sendBundleOnly(Uint8Array.from([1]), { fetchImpl: fake(200, { error: { code: -32602, message: "bad tx" } }) }), /jito 200: bad tx/);
  await assert.rejects(sendBundleOnly(Uint8Array.from([1]), { fetchImpl: fake(200, { result: 5 }) }), /jito 200/);
});
