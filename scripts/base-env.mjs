// Prints the VITE_* settings for a SharePot Perp build (VITE_PERPS: the pools as JSON) from server/evm/chains.json (the reviewed values), one
// `export NAME='value'` per line, after checking every value's shape: a chain id, https URLs, 0x addresses.
// Usage: node scripts/base-env.mjs [chain-key=base-sepolia]   (scripts/build-base.sh evals its output)
import fs from "node:fs";
const key = process.argv[2] ?? "base-sepolia";
const c = JSON.parse(fs.readFileSync(new URL("../server/evm/chains.json", import.meta.url), "utf8"))[key];
const fail = (m) => { console.error(`base-env: ${key}: ${m}`); process.exit(4); };
if (!c) fail("no such entry in chains.json");
const addr = (v, n) => (/^0x[0-9a-fA-F]{40}$/.test(v ?? "") ? v : fail(`${n} is not an address`));
const url = (v, n) => (/^https:\/\/[A-Za-z0-9.\-]+(\/[A-Za-z0-9._~\-\/]*)?$/.test(v ?? "") ? v : fail(`${n} is not an https URL`));
if (!Number.isInteger(c.chainId) || c.chainId <= 0) fail("chainId");
const env = {
  VITE_CHAIN: "evm", VITE_EVM_CHAIN_ID: String(c.chainId), VITE_EVM_NAME: String(c.name).replace(/[^A-Za-z0-9 .\-]/g, ""),
  VITE_EVM_RPC: url(c.rpc, "rpc"), VITE_EVM_EXPLORER: url(c.explorer, "explorer"), VITE_EVM_TEST: c.test === true ? "1" : "0",
  // the pools, one per stock, in the order the site shows them; every field checked, so the JSON needs no escaping
  VITE_PERPS: JSON.stringify((Array.isArray(c.perps) && c.perps.length ? c.perps : fail("no perps")).map((p, i) => ({
    symbol: /^[A-Z]{1,6}$/.test(p.symbol ?? "") ? p.symbol : fail(`perps[${i}].symbol`),
    tokenSymbol: /^[A-Za-z]{1,8}$/.test(p.tokenSymbol ?? "") ? p.tokenSymbol : fail(`perps[${i}].tokenSymbol`),
    pool: addr(p.pool, `perps[${i}].pool`), token: addr(p.token, `perps[${i}].token`),
  }))),
};
if (new Set(JSON.parse(env.VITE_PERPS).map((p) => p.symbol)).size !== c.perps.length) fail("two pools with one symbol");
for (const [k, v] of Object.entries(env)) console.log(`export ${k}='${v}'`);
