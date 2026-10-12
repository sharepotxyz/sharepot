// node --test server/retry.test.mjs — the cron scripts' transient-failure guard (server/retry.mjs)
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

// guardProcess installs process-wide handlers and may exit, so every case runs in a node process of its own
const guarded = (body) => spawnSync(process.execPath, ["--input-type=module", "-e",
  `import { guardProcess } from ${JSON.stringify(new URL("./retry.mjs", import.meta.url).href)};\nguardProcess((...a) => console.log(...a));\n${body}`],
  { encoding: "utf8", timeout: 20_000 });
const thenRest = `await new Promise((r) => setTimeout(r, 50)); console.log("rest of the run settled");`;

test("guardProcess: a transient stray rejection is logged and the run goes on; anything else still ends it", () => {
  // web3.js confirms with racing requests; the loser's 429 rejects with nobody awaiting it (resolve.log 2026-09-19/20).
  // Exiting on it stopped a resolver mid-settle, past the per-position failure count (audit 2026-10-12).
  const stray = guarded(`Promise.reject(new Error('429 Too Many Requests:  {"jsonrpc":"2.0","error":{"code": 429}}')); ${thenRest}`);
  assert.equal(stray.status, 0, stray.stdout + stray.stderr);
  assert.match(stray.stdout, /unhandled rejection \(ignored\): 429 Too Many Requests/);
  assert.match(stray.stdout, /rest of the run settled/);
  // a stray rejection that is not a network hiccup is a bug: one line, exit 1
  const bug = guarded(`Promise.reject(new Error("Cannot read properties of undefined (reading 'owner')")); ${thenRest}`);
  assert.equal(bug.status, 1, bug.stdout + bug.stderr);
  assert.match(bug.stdout, /FAILED \(uncaught\): Cannot read properties of undefined/);
  assert.doesNotMatch(bug.stdout, /rest of the run settled/);
  // a failed top-level await arrives as uncaughtException in Node 22: one line and exit 1, transient or not
  const top = guarded(`await Promise.reject(new TypeError("fetch failed"));`);
  assert.equal(top.status, 1, top.stdout + top.stderr);
  assert.match(top.stdout, /FAILED \(uncaught\): fetch failed/);
});
