// node --test server/site-tokens.test.mjs — the verifier's sampler keeps sampling when the site is unreachable
// (server/site-tokens.mjs; incident 2026-11-18 22:00–24:00Z)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { siteTokenList } from "./site-tokens.mjs";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "site-tokens-")), "sub", "site-tokens.json");
const ok = (stocks) => async () => ({ ok: true, status: 200, json: async () => ({ stocks }) });
const down = async () => { throw new Error("The operation was aborted due to timeout"); };
const http = (status) => async () => ({ ok: false, status, json: async () => { throw new Error("not json"); } });
const pick = (stocks) => stocks.filter((s) => s.kind === "day").flatMap((s) => s.tokens.map((t) => t.mainnetMint));
const STOCKS = [{ kind: "day", tokens: [{ mainnetMint: "MintA" }, { mainnetMint: "MintB" }] }, { kind: "close", tokens: [{ mainnetMint: "Stock" }] }];

test("a site that answers gives its list and leaves a copy", async () => {
  const cacheFile = tmp();
  const r = await siteTokenList({ url: "u", cacheFile, pick, now: 1000, fetchImpl: ok(STOCKS) });
  assert.deepEqual(r, { list: ["MintA", "MintB"], cachedAt: 1000, fromCache: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, "utf8")), { at: 1000, list: ["MintA", "MintB"] });
});

test("timeout, HTTP 522 and a body without stocks all fall back to the copy", async () => {
  const cacheFile = tmp();
  await siteTokenList({ url: "u", cacheFile, pick, now: 1000, fetchImpl: ok(STOCKS) });
  for (const [fetchImpl, why] of [[down, /timeout/], [http(522), /HTTP 522/], [async () => ({ ok: true, json: async () => ({}) }), /no stocks/]]) {
    const r = await siteTokenList({ url: "u", cacheFile, pick, now: 1000 + 3600, fetchImpl });
    assert.equal(r.fromCache, true); assert.deepEqual(r.list, ["MintA", "MintB"]); assert.equal(r.cachedAt, 1000);
    assert.match(r.siteError, why);
  }
  // a failed minute does not overwrite or refresh the copy
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, "utf8")).at, 1000);
});

test("no copy, a corrupt copy, or one older than the limit: the run fails as it did before", async () => {
  const cacheFile = tmp();
  await assert.rejects(siteTokenList({ url: "u", cacheFile, pick, now: 1000, fetchImpl: down }), /no local copy/);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, '{"at":1000,"list":["Min');
  await assert.rejects(siteTokenList({ url: "u", cacheFile, pick, now: 1000, fetchImpl: down }), /no local copy/);
  await siteTokenList({ url: "u", cacheFile, pick, now: 1000, fetchImpl: ok(STOCKS) });
  const r = await siteTokenList({ url: "u", cacheFile, pick, now: 1000 + 48 * 3600, fetchImpl: down });
  assert.equal(r.fromCache, true, "exactly at the limit still counts");
  await assert.rejects(siteTokenList({ url: "u", cacheFile, pick, now: 1000 + 48 * 3600 + 1, fetchImpl: down }), /local copy is 48 h old/);
});

test("an empty list from the site is a real answer, kept and returned as empty", async () => {
  const cacheFile = tmp();
  await siteTokenList({ url: "u", cacheFile, pick, now: 1000, fetchImpl: ok(STOCKS) });
  const r = await siteTokenList({ url: "u", cacheFile, pick, now: 2000, fetchImpl: ok([]) });
  assert.deepEqual(r.list, []); assert.equal(r.fromCache, false);
  assert.deepEqual((await siteTokenList({ url: "u", cacheFile, pick, now: 3000, fetchImpl: down })).list, []);
});
