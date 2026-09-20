import test from "node:test"; import assert from "node:assert/strict";
import { heartbeatProblems } from "./heartbeat-check.mjs";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const keys = (hb) => heartbeatProblems(hb, NOW).map((p) => p.key);

test("fresh heartbeat: nothing to say", () => assert.deepEqual(keys({ at: ago(3), verifyDone: ago(8), sampled: ago(1) }), []));
test("no file at all: host alert only", () => assert.deepEqual(keys(null), ["heartbeat-host"]));
test("stale heartbeat: host alert only, the inner times are not reported twice", () => assert.deepEqual(keys({ at: ago(45), verifyDone: ago(300), sampled: ago(300) }), ["heartbeat-host"]));
test("host alive, verifier stuck", () => assert.deepEqual(keys({ at: ago(3), verifyDone: ago(55), sampled: ago(1) }), ["heartbeat-verify"]));
test("host alive, sampler stopped; a missing field counts as never", () => assert.deepEqual(keys({ at: ago(3), verifyDone: ago(8) }), ["heartbeat-sample"]));
test("both inner jobs down are both listed", () => assert.deepEqual(keys({ at: ago(3), verifyDone: null, sampled: "garbage" }), ["heartbeat-verify", "heartbeat-sample"]));
test("just inside the limits stays quiet", () => assert.deepEqual(keys({ at: ago(29), verifyDone: ago(39), sampled: ago(14) }), []));
