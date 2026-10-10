import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// notify.mjs reads its paths once at import time, so the throwaway config and throttle state go in before the import:
// the test must never touch ~/.sharepot-notify.json or a real Telegram config.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sharepot-notify-test-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
fs.writeFileSync(path.join(dir, "telegram.json"), JSON.stringify({ bot_token: "test-token", chat_id: "1" }));
process.env.TELEGRAM_CONFIG = path.join(dir, "telegram.json");
process.env.NOTIFY_STATE = path.join(dir, "state.json");
delete process.env.NOTIFY_EXEC;
const { notify, notifyFlush } = await import("./notify.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("notifyFlush waits for alerts nobody awaited (the resolver fires them and then process.exit()s)", async () => {
  const delivered = [];
  globalThis.fetch = async (url, init) => { await sleep(150); delivered.push(JSON.parse(init.body).text.split("\n")[1]); return { ok: true }; };
  notify("A", "first");                       // not awaited, exactly as resolve.mjs does
  notify("B", "second");
  assert.deepEqual(delivered, []);            // still in flight
  await notifyFlush();
  assert.deepEqual(delivered, ["first", "second"]);
});

test("notifyFlush with nothing in flight returns at once, and a repeat inside the throttle window sends nothing", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true }; };
  const t0 = Date.now(); await notifyFlush(); assert.ok(Date.now() - t0 < 50);
  notify("A", "again");                       // same key as above, well inside 30 min → throttled on disk
  await notifyFlush();
  assert.equal(calls, 0);
});

test("a failing send never throws and is dropped from the in-flight set", async () => {
  globalThis.fetch = async () => { throw new Error("network down"); };
  assert.equal(await notify("C", "third"), false);
  await notifyFlush();
});
