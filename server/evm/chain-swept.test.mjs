// node --test server/evm/chain-swept.test.mjs — allMarkets (server/evm/chain.mjs) with the swept-market cache, against a fake contract
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EVM_READ_GAP_MS = "0"; process.env.EVM_READ_RETRY_MS = "1";
const { allMarkets, sweptFileIn, Status, metricToBytes32 } = await import("./chain.mjs");

const ZERO32 = `0x${"0".repeat(64)}`;
const raw = (id, status) => ({
  token: "0x00000000000000000000000000000000000000aa", metric: metricToBytes32(`T${id}.day:2026-11-08`), questionHash: ZERO32,
  thresholds: [-15000n, 15000n, 0n, 0n, 0n, 0n, 0n], nBuckets: 3, openTs: 1n, closeTs: 2n, resolveAfterTs: 3n, baseline: 0n,
  pools: [BigInt(id), 2n, 3n, 0n, 0n, 0n, 0n, 0n], seedAmount: 0n, status, outcome: 1, proposedOutcome: 1, proposedValue: 10n, proposedAt: 4n,
  snapshotHash: ZERO32, resolvedAt: 5n, feeCollected: 6n, paidOut: 7n, swept: 8n, held: 0n, positions: 2n, positionsOpen: status === Status.Swept ? 0n : 2n,
});
/** A contract of `n` markets; every third one still live, the rest swept. `calls` lists the ids getMarket was asked for. */
function fakePot(n, statusOf = (id) => (id % 3 === 0 ? Status.Open : Status.Swept)) {
  const f = { calls: [], statusOf, n };
  f.read = { marketCount: async () => BigInt(f.n), getMarket: async ([id]) => { f.calls.push(Number(id)); return raw(Number(id), f.statusOf(Number(id))); } };
  return f;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sp-swept-"));
const liveIds = (n) => Array.from({ length: n }, (_, i) => i).filter((i) => i % 3 === 0);

test("a cold read reads every market and keeps only the swept ones on disk", async () => {
  const dir = tmp(), p = fakePot(120);
  const got = await allMarkets(p, { cacheDir: dir });
  assert.equal(got.length, 120);
  assert.equal(p.calls.length, 120);
  const kept = JSON.parse(fs.readFileSync(sweptFileIn(dir), "utf8")).map(([id]) => id);
  assert.deepEqual(kept, Array.from({ length: 120 }, (_, i) => i).filter((i) => i % 3 !== 0));
});

test("with the file, only live markets are read, and the answer equals a full read", async () => {
  const dir = tmp(), warm = fakePot(120);
  await allMarkets(warm, { cacheDir: dir });
  const p = fakePot(120);
  const again = await allMarkets(p, { cacheDir: dir });             // same process, same file
  assert.deepEqual(p.calls, liveIds(120));
  const full = await allMarkets(fakePot(120));                      // no cache at all
  assert.deepEqual(again, full);
  assert.deepEqual(again.map((m) => m.id), Array.from({ length: 120 }, (_, i) => i));
});

test("a new process starts from the file another one wrote (the site's, or an earlier run's)", async () => {
  const a = tmp(); await allMarkets(fakePot(90), { cacheDir: a });
  const b = tmp(); fs.copyFileSync(sweptFileIn(a), sweptFileIn(b)); // a directory this process never loaded
  const p = fakePot(90);
  await allMarkets(p, { cacheDir: b });
  assert.deepEqual(p.calls, liveIds(90));
});

test("an entry that is not a swept market, or sits under another id, is ignored and read from the chain", async () => {
  const dir = tmp(), seed = await allMarkets(fakePot(9));
  const bad = [[1, { ...seed[1], status: Status.Resolved }], [2, { ...seed[4] }], [4, seed[4]], [5, seed[5]]];
  fs.writeFileSync(sweptFileIn(dir), JSON.stringify(bad));
  const p = fakePot(9);
  await allMarkets(p, { cacheDir: dir });
  assert.deepEqual(p.calls, [0, 1, 2, 3, 6, 7, 8]);   // only 4 and 5 trusted
});

test("an unreadable file means a full read, not a crash, and is replaced by a good one", async () => {
  const dir = tmp(); fs.writeFileSync(sweptFileIn(dir), "[[0,{\"id\":0");   // cut off mid-write
  const p = fakePot(12);
  assert.equal((await allMarkets(p, { cacheDir: dir })).length, 12);
  assert.equal(p.calls.length, 12);
  assert.equal(JSON.parse(fs.readFileSync(sweptFileIn(dir), "utf8")).length, 8);
});

test("a market swept since the last read is added; entries the site wrote meanwhile are kept", async () => {
  const dir = tmp(), p = fakePot(12);
  await allMarkets(p, { cacheDir: dir });
  const onDisk = JSON.parse(fs.readFileSync(sweptFileIn(dir), "utf8"));
  // the site adds market 12 (swept) to the file; then market 3 gets swept on chain and the contract grows to 13
  const m12 = (await allMarkets(fakePot(13))).at(-1); m12.status = Status.Swept;
  fs.writeFileSync(sweptFileIn(dir), JSON.stringify([...onDisk, [12, m12]]));
  p.n = 13; p.statusOf = (id) => (id % 3 === 0 && id !== 3 && id !== 12 ? Status.Open : Status.Swept); p.calls = [];
  await allMarkets(p, { cacheDir: dir });
  assert.deepEqual(p.calls, [0, 3, 6, 9, 12]);   // 12 not trusted yet: this process loaded the file before the site wrote it
  const ids = JSON.parse(fs.readFileSync(sweptFileIn(dir), "utf8")).map(([id]) => id);
  assert.ok(ids.includes(3) && ids.includes(12));
  p.calls = [];
  await allMarkets(p, { cacheDir: dir });
  assert.deepEqual(p.calls, [0, 6, 9]);
});

test("a caller editing what it got does not edit the cache", async () => {
  const dir = tmp(); await allMarkets(fakePot(6), { cacheDir: dir });
  const first = await allMarkets(fakePot(6), { cacheDir: dir });
  first[1].status = 99; first[1].pools[0] = "x";
  const second = await allMarkets(fakePot(6), { cacheDir: dir });
  assert.equal(second[1].status, Status.Swept);
  assert.equal(second[1].pools[0], "1");
});

test("a refused batch is retried, then the read goes on", async () => {
  const dir = tmp(), p = fakePot(60); let refusals = 2;
  const real = p.read.getMarket;
  p.read.getMarket = async (a) => { if (Number(a[0]) === 50 && refusals-- > 0) throw new Error("An unknown RPC error occurred. HTTP 429 Too Many Requests"); return real(a); };
  assert.equal((await allMarkets(p, { cacheDir: dir })).length, 60);
});
