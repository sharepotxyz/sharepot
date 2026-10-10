// node --test server/retry.test.mjs — the cron scripts' transient-failure guard (server/retry.mjs)
import test from "node:test";
import assert from "node:assert/strict";
import { withRetry, isTransient } from "./retry.mjs";

test("transient errors are retried with backoff, others throw at once", async () => {
  let n = 0;
  assert.equal(await withRetry(async () => { n++; if (n < 3) throw new Error("fetch failed"); return "ok"; }, 4, "t", 1), "ok");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new Error("execution reverted: NotProposed"); }, 4, "t", 1), /NotProposed/);
  assert.equal(n, 1, "a contract revert is not retried");
  n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new Error("read ECONNRESET"); }, 3, "t", 1), /ECONNRESET/);
  assert.equal(n, 3, "gives up after `tries` attempts");
});

test("the real-world crashes of 2026-10 count as transient", () => {
  // viem: torn JSON-RPC batch from the Robinhood RPC (shortMessage + details, no useful message)
  const viem = Object.assign(new Error("An unknown RPC error occurred.\nDetails: Cannot read properties of undefined (reading 'error')"), { shortMessage: "An unknown RPC error occurred.", details: "Cannot read properties of undefined (reading 'error')" });
  assert.ok(isTransient(viem));
  // undici: fetch failed with the reason only in `cause`
  assert.ok(isTransient(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) })));
  assert.ok(isTransient(Object.assign(new TypeError("fetch failed"), { cause: new Error("Connect Timeout Error (attempted address: api.dexscreener.com:443, timeout: 10000ms)") })));
  assert.ok(isTransient(new Error("jupiter 429")));
  assert.ok(isTransient(new Error("dexscreener 503")));
  assert.ok(!isTransient(new Error("execution reverted: NoPosition")));
  assert.ok(!isTransient(new Error("jupiter 404")));
});
