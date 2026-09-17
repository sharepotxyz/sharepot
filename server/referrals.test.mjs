import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REFEREE_BPS, bind, codeFor, earnings, ensureCode, load, normalizeCode, pending, save, tierBps } from "./referrals.mjs";

const A = "DaBB7D5A6kEMrZzhfiaWN4XvykZBGK5J6PEX58zQVPmT", B = "FfZbH33d4ws3LB9Bdx7abSCvXKThBmtS18LWdSizQVYj", C = "op2Ve6ehakzUNvRgwZNQxAEL9SXMPBDrA3uzG9WwSfF";
const MINT = "ESrJMtPaTTm2x5KzasvHQtZGbYwfXsoB89umc1FhCR8q";
const row = (owner, fee, extra = {}) => ({ owner, fee: String(fee), mint: MINT, token: "NVDAx", decimals: 8, multiplier: 1, close: 200, id: 1, ...extra });

test("codes are deterministic, 6 chars, and survive 0/O 1/I/L typos", () => {
  assert.equal(codeFor(A), codeFor(A));
  assert.match(codeFor(A), /^[A-Z0-9]{6}$/);
  assert.notEqual(codeFor(A), codeFor(B));
  assert.equal(normalizeCode(" abc0il "), "ABC011");
});

test("ensureCode is idempotent and resolves a collision by lengthening", () => {
  const db = load("/nonexistent");
  const a = ensureCode(db, A); assert.equal(a.created, true);
  assert.deepEqual(ensureCode(db, A), { code: a.code, created: false });
  db.codes[codeFor(B)] = "someone-else";                          // simulate a clash on B's 6-char code
  assert.equal(ensureCode(db, B).code, codeFor(B, 7));
});

test("bind rules: unknown code, self, second code refused; same code twice is a no-op", () => {
  const db = load("/nonexistent"); const { code } = ensureCode(db, A);
  assert.equal(bind(db, { wallet: B, code: "ZZZZZZ", cluster: "devnet" }).error, "unknown referral code");
  assert.equal(bind(db, { wallet: A, code, cluster: "devnet" }).error, "you cannot refer yourself");
  assert.deepEqual(bind(db, { wallet: B, code: code.toLowerCase(), cluster: "devnet" }), { ok: true });
  assert.equal(bind(db, { wallet: B, code, cluster: "mainnet" }).already, true);
  ensureCode(db, C);
  assert.match(bind(db, { wallet: B, code: codeFor(C), cluster: "devnet" }).error, /already bound/);
  assert.equal(db.bindings[B].referrer, A);
});

test("tiers: 20 % below 10k points, 25 % from 10k, 30 % from 100k", () => {
  assert.equal(tierBps(0), 2000); assert.equal(tierBps(9999), 2000); assert.equal(tierBps(10_000), 2500); assert.equal(tierBps(100_000), 3000);
});

test("earnings: referrer gets tier share of the referee's fee, referee gets 10 % back, in the pool's token", () => {
  const db = load("/nonexistent"); const { code } = ensureCode(db, A); bind(db, { wallet: B, code, cluster: "devnet" });
  // B won: fee 0.09 NVDAx (= 3 shares × 3 %) on a $200 close; C is unbound and earns nobody anything
  const e = earnings([row(B, 9_000_000), row(C, 9_000_000), row(B, 0)], db, () => 0);
  const a = e.byWallet.get(A), b = e.byWallet.get(B);
  assert.equal(a.referred.size, 1);
  assert.equal(a.earned.get(MINT).raw, 1_800_000n);                 // 20 % of 0.09 = 0.018 NVDAx
  assert.equal(a.earned.get(MINT).usd, 0.018 * 200);
  assert.equal(b.earned.get(MINT).raw, 900_000n);                   // 10 % back
  assert.equal(b.earned.get(MINT).asReferee, 900_000n);
  assert.equal(e.byWallet.has(C), false);
  // a referrer with 10k points is on the 25 % tier
  const e2 = earnings([row(B, 9_000_000)], db, (w) => (w === A ? 10_000 : 0));
  assert.equal(e2.byWallet.get(A).earned.get(MINT).raw, 2_250_000n);
});

test("pending = earned − paid, per wallet and mint; fully paid entries disappear", () => {
  const db = load("/nonexistent"); const { code } = ensureCode(db, A); bind(db, { wallet: B, code, cluster: "devnet" });
  const e = earnings([row(B, 10_000)], db);
  assert.deepEqual(pending(e, []).map((p) => [p.wallet, p.raw]), [[A, 2000n], [B, 1000n]]);
  const partial = pending(e, [{ wallet: A, mint: MINT, raw: "1500" }, { wallet: B, mint: MINT, raw: "1000" }]);
  assert.deepEqual(partial.map((p) => [p.wallet, p.raw]), [[A, 500n]]);
  assert.equal(partial[0].usd, 500 / 2000 * (0.00002 * 200));
});

test("save is atomic and load round-trips", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ref-")), f = path.join(dir, "referrals.json");
  const db = load(f); ensureCode(db, A); save(f, db);
  assert.equal(load(f).wallets[A].code, codeFor(A));
  assert.deepEqual(fs.readdirSync(dir), ["referrals.json"]);
  assert.equal(REFEREE_BPS, 1000);
});
