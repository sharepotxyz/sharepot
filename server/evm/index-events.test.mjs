// node --test server/evm/index-events.test.mjs — the EVM event index (server/evm/index-events.mjs) against a fake RPC
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sync, backfill, repairGaps, marketsShort, openPositions, readEvents, evmDir, eventsFile } from "./index-events.mjs";
import { Status } from "./chain.mjs";

const U1 = "0x00000000000000000000000000000000000000a1", U2 = "0x00000000000000000000000000000000000000a2";
const bet = (block, id, user, i = 0) => ({ eventName: "BetPlaced", blockNumber: BigInt(block), transactionHash: `0x${block.toString(16).padStart(64, "0")}`, logIndex: i,
  args: { id: BigInt(id), user, bucket: 0, amount: 10n ** 18n, feeBps: 300, pools: Array(8).fill(0n) } });

/** An RPC whose eth_getLogs node is `lag` blocks behind the head eth_blockNumber reports, answering only what it has. */
function fakeRpc(logs, head) {
  return {
    head, lag: 0, calls: 0,
    async getBlockNumber() { return BigInt(this.head); },
    async getLogs({ fromBlock, toBlock }) {
      this.calls++;
      const top = Math.min(Number(toBlock), this.head - this.lag);
      return logs.filter((l) => l.blockNumber >= fromBlock && Number(l.blockNumber) <= top);
    },
  };
}
function tmpData(cursor) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sp-index-"));
  fs.mkdirSync(evmDir(d), { recursive: true });
  if (cursor != null) fs.writeFileSync(path.join(evmDir(d), "events.cursor"), String(cursor));
  return d;
}
const rows = (d) => fs.readFileSync(eventsFile(d), "utf8").split("\n").filter(Boolean).length;
const cursor = (d) => Number(fs.readFileSync(path.join(evmDir(d), "events.cursor"), "utf8"));

test("a bet a lagging node left out is picked up by the next sync, and nothing is written twice", async () => {
  // 2026-10-21 #343: the head came from one node, the logs from one 60 blocks behind → the newest bet was skipped for good
  const d = tmpData(1000), rpc = fakeRpc([bet(1100, 343, U1), bet(1150, 343, U2)], 1200);
  rpc.lag = 60;
  assert.equal(await sync(d, rpc), 1);
  rpc.lag = 0; rpc.head = 1210;
  assert.equal(await sync(d, rpc), 1, "the second sync reads the skipped block again");
  assert.equal(await sync(d, rpc), 0);
  assert.equal(rows(d), 2, "re-read blocks are not appended again");
  assert.deepEqual([...openPositions(d).get(343)].sort(), [U1, U2]);
});

test("the cursor stops CONFIRM blocks short of the head", async () => {
  const d = tmpData(1000), rpc = fakeRpc([], 100_000);
  await sync(d, rpc);
  assert.equal(cursor(d), 100_000 - 2_000 + 1);
  rpc.head = 100_500;
  await sync(d, rpc);
  assert.equal(cursor(d), 100_500 - 2_000 + 1);
  const e = tmpData(99_000); await sync(e, fakeRpc([], 100_000));
  assert.equal(cursor(e), 99_000, "never moves backwards from where this sync started");
});

test("a closed market short of bettors is re-read from its creation block, at most hourly", async () => {
  const now = 1_800_000_000, B = 130_000_000;   // block numbers above chains.json deployBlock
  const d = tmpData(B + 9_000), rpc = fakeRpc([bet(B + 2_600, 5, U1), bet(B + 3_000, 5, U2)], B + 10_000);
  fs.writeFileSync(eventsFile(d), JSON.stringify({ event: "BetPlaced", id: 5, user: U1, block: B + 2_600, tx: bet(B + 2_600, 5, U1).transactionHash, logIndex: 0, bucket: 0, amount: "1", feeBps: 300 }) + "\n");
  fs.writeFileSync(path.join(evmDir(d), "markets-opened.jsonl"), [{ id: 4, block: B + 2_400 }, { id: 5, block: B + 2_500 }, { id: 6, block: null }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const m5 = { id: 5, status: Status.Resolved, closeTs: now - 3_600, positions: 2 };
  assert.deepEqual(marketsShort(d, [m5, { ...m5, id: 7, status: Status.Swept }, { ...m5, id: 8, status: Status.Open, closeTs: now + 60 }], now).map((m) => m.id), [5],
    "swept markets and markets still taking bets are left out");
  assert.deepEqual(await repairGaps(d, [m5], now, rpc), { ids: [5], from: B + 2_500, added: 1 });
  assert.deepEqual([...openPositions(d).get(5)].sort(), [U1, U2]);
  assert.equal(await repairGaps(d, [m5], now, rpc), null, "nothing to do once the index matches");
  assert.equal(cursor(d), B + 9_000, "the backfill leaves the cursor alone");

  // a gap the chain does not fill: one re-read an hour; a market with no row starts at the nearest lower id's block
  const m6 = { id: 6, status: Status.Voided, closeTs: now - 3_600, positions: 1 };
  assert.deepEqual(await repairGaps(d, [m6], now, rpc), { ids: [6], from: B + 2_500, added: 0 });
  const calls = rpc.calls;
  assert.equal(await repairGaps(d, [m6], now + 600, rpc), null);
  assert.equal(rpc.calls, calls, "no RPC call inside the hour");
  assert.deepEqual(await repairGaps(d, [m6], now + 3_601, rpc), { ids: [6], from: B + 2_500, added: 0 });
  assert.equal(readEvents(d).length, 2);
});

test("backfill never starts below the deploy block", async () => {
  const d = tmpData(null), seen = [];
  const rpc = { async getBlockNumber() { return 123_609_870n; }, async getLogs(q) { seen.push(Number(q.fromBlock)); return []; } };
  await backfill(d, 0, rpc);
  assert.deepEqual(seen, [123_609_862]);
});
