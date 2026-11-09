// Robinhood Chain (and any other EVM deployment of SharePot): clients, the contract, and the reads every script needs.
//   env: EVM_CHAIN=robinhood-testnet|robinhood (default robinhood-testnet), EVM_RPC (overrides chains.json),
//        EVM_CHAINS=path (overrides chains.json), EVM_PROPOSER_KEY_FILE (a file holding the hex private key, for writes)
import fs from "node:fs";
import path from "node:path";
import { withRetry, sleep } from "../retry.mjs";
import { createPublicClient, createWalletClient, http, getContract, parseAbiItem, keccak256, stringToBytes, defineChain, hexToString, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const CHAIN_KEY = process.env.EVM_CHAIN ?? "robinhood-testnet";
const chainsFile = process.env.EVM_CHAINS ?? new URL("./chains.json", import.meta.url);
export const chains = JSON.parse(fs.readFileSync(chainsFile, "utf8"));
export const chainCfg = chains[CHAIN_KEY];
if (!chainCfg) throw new Error(`unknown EVM_CHAIN ${CHAIN_KEY} (chains.json has ${Object.keys(chains).filter((k) => k !== "_doc").join(", ")})`);
export const RPC = process.env.EVM_RPC ?? chainCfg.rpc;
export const abi = JSON.parse(fs.readFileSync(new URL("../../evm/abi/SharePot.json", import.meta.url), "utf8"));
export const erc20Abi = [
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function allowance(address, address) view returns (uint256)"),
  parseAbiItem("function approve(address, uint256) returns (bool)"),
  parseAbiItem("function decimals() view returns (uint8)"),
  parseAbiItem("function symbol() view returns (string)"),
  parseAbiItem("function paused() view returns (bool)"),
  parseAbiItem("function uiMultiplier() view returns (uint256)"),
  parseAbiItem("function balanceOfUI(address) view returns (uint256)"),
];

export const chain = defineChain({
  id: chainCfg.chainId, name: chainCfg.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } }, blockExplorers: { default: { name: "explorer", url: chainCfg.explorer } },
});
export const publicClient = createPublicClient({ chain, transport: http(RPC, { batch: true, retryCount: 4, retryDelay: 800 }) });

/** Wallet client for the proposer (or whichever key file EVM_PROPOSER_KEY_FILE points at). */
export function walletFor(keyFile = process.env.EVM_PROPOSER_KEY_FILE) {
  if (!keyFile) throw new Error("EVM_PROPOSER_KEY_FILE not set");
  const raw = fs.readFileSync(keyFile, "utf8").trim();
  const hex = raw.startsWith("0x") ? raw : (raw.match(/(?:DEPLOYER_KEY|PROPOSER_KEY|PRIVATE_KEY)\s*=\s*(0x[0-9a-fA-F]{64})/)?.[1] ?? `0x${raw}`);
  const account = privateKeyToAccount(hex);
  return { account, client: createWalletClient({ account, chain, transport: http(RPC, { retryCount: 4, retryDelay: 800 }) }) };
}

export const potAddress = () => { if (!chainCfg.pot) throw new Error(`chains.json: no SharePot deployed on ${CHAIN_KEY} yet`); return chainCfg.pot; };
export const pot = (wallet) => getContract({ address: potAddress(), abi, client: wallet ? { public: publicClient, wallet: wallet.client } : publicClient });

/** Metric tags are bytes32: the UTF-8 string, NUL-padded, exactly as the Solana program stores them. */
export const metricToBytes32 = (s) => stringToHex(s, { size: 32 });
export const bytes32ToMetric = (h) => hexToString(h, { size: 32 }).replace(/\0+$/, "");
export const sha256Hex = (buf) => `0x${Buffer.from(buf).toString("hex")}`;
export const questionHash = (q) => keccak256(stringToBytes(q));

export const Status = { None: 0, Open: 1, Proposed: 2, Resolved: 3, Voided: 4, Swept: 5 };
export const NO_OUTCOME = 255;

// A swept market never changes again (every write in SharePot.sol requires Open, Proposed, Resolved or Voided), so it
// is read once and kept on disk in the file the site's api.mjs keeps too (one per pot address). Reading every market
// three times per resolver run had outgrown the public RPC's burst limit: about 500 calls in a few seconds and it
// answers a whole batch with HTTP 429 (one error object, not an array, which viem reports as "unknown RPC error"), and
// keeps refusing while the retries arrive. From 2026-11-04 (≈500 markets) about half the resolver runs died on it; on
// 2026-11-09 a read with this file was 25 calls instead of 568.
export const sweptFileIn = (dir) => path.join(dir, `swept-markets.${String(chainCfg.pot).toLowerCase()}.json`);
const sweptCaches = new Map();   // file → Map(id → normalized swept market), loaded once per process
function readSweptFile(file) {
  const out = new Map();
  try {
    for (const [id, m] of JSON.parse(fs.readFileSync(file, "utf8"))) if (Number.isInteger(id) && m && m.id === id && m.status === Status.Swept) out.set(id, m);
  } catch (e) { if (e?.code !== "ENOENT") console.log(new Date().toISOString(), `swept-market cache ${path.basename(file)} unreadable (${String(e?.message ?? e).slice(0, 80)}): reading every market`); }
  return out;
}
function saveSweptFile(file, swept) {
  try {
    for (const [id, m] of readSweptFile(file)) if (!swept.has(id)) swept.set(id, m);   // keep what the site added meanwhile
    const tmp = `${file}.${process.pid}.tmp`;   // the site writes the same file: its own temp name, then an atomic rename
    fs.writeFileSync(tmp, JSON.stringify([...swept].sort((a, b) => a[0] - b[0]))); fs.renameSync(tmp, file);
  } catch (e) { console.log(new Date().toISOString(), `swept-market cache write failed (next run reads those markets again): ${String(e?.message ?? e).slice(0, 100)}`); }
}
const READ_BATCH = 50, READ_GAP_MS = Number(process.env.EVM_READ_GAP_MS ?? 2000), READ_RETRY_MS = Number(process.env.EVM_READ_RETRY_MS ?? 5000);

/** Every market on the contract, in id order, as plain objects with numbers where they fit. With `cacheDir` (the
 *  chain's data directory) the swept ones come from the swept-market file and only the live ones are read. */
export async function allMarkets(p = pot(), { cacheDir } = {}) {
  const count = Number(await withRetry(() => p.read.marketCount(), 4, "marketCount"));
  if (count === 0) return [];
  const file = cacheDir ? sweptFileIn(cacheDir) : null;
  if (file && !sweptCaches.has(file)) sweptCaches.set(file, readSweptFile(file));
  const swept = file ? sweptCaches.get(file) : new Map();
  const ids = []; for (let id = 0; id < count; id++) if (!swept.has(id)) ids.push(id);
  // one JSON-RPC batch per 50 markets (the http transport batches concurrent calls); no Multicall3 dependency. A cold
  // read (no cache yet) pauses between batches to stay under the burst limit; a refused batch waits 5, 10, 20 s.
  const fresh = new Map(); let newlySwept = 0;
  for (let i = 0; i < ids.length; i += READ_BATCH) {
    if (i) await sleep(READ_GAP_MS);
    const slice = ids.slice(i, i + READ_BATCH);
    const got = await withRetry(() => Promise.all(slice.map((id) => p.read.getMarket([BigInt(id)]))), 4, `getMarket #${slice[0]}…`, READ_RETRY_MS);
    slice.forEach((id, j) => { const m = normalizeMarket(id, got[j]); fresh.set(id, m); if (file && m.status === Status.Swept) { swept.set(id, m); newlySwept++; } });
  }
  if (newlySwept) saveSweptFile(file, swept);
  return Array.from({ length: count }, (_, id) => fresh.get(id) ?? structuredClone(swept.get(id)));   // a copy: callers never edit the cache
}
export async function readMarket(id, p = pot()) { return normalizeMarket(id, await withRetry(() => p.read.getMarket([BigInt(id)]), 4, `getMarket #${id}`)); }
export function normalizeMarket(id, m) {
  const n = Number(m.nBuckets);
  return {
    id, token: m.token, metric: bytes32ToMetric(m.metric), questionHash: m.questionHash,
    thresholds: m.thresholds.slice(0, n - 1).map(Number), nBuckets: n,
    openTs: Number(m.openTs), closeTs: Number(m.closeTs), resolveAfterTs: Number(m.resolveAfterTs), baseline: Number(m.baseline),
    pools: m.pools.slice(0, n).map((x) => x.toString()), seedAmount: m.seedAmount.toString(),
    status: Number(m.status), outcome: Number(m.outcome), proposedOutcome: Number(m.proposedOutcome), proposedValue: Number(m.proposedValue), proposedAt: Number(m.proposedAt),
    snapshotHash: m.snapshotHash, resolvedAt: Number(m.resolvedAt),
    feeCollected: m.feeCollected.toString(), paidOut: m.paidOut.toString(), swept: m.swept.toString(), held: m.held.toString(),
    positions: Number(m.positions), positionsOpen: Number(m.positionsOpen),
  };
}
export async function readConfig(p = pot()) {
  const c = await withRetry(() => p.read.config(), 4, "config");
  return { admin: c[0], proposer: c[1], treasury: c[2], feeBps: Number(c[3]), earlyBirdDiscountBps: Number(c[4]), earlyBirdSecs: Number(c[5]), disputeWindowSecs: Number(c[6]), minBet: c[7].toString(), paused: c[8] };
}
export async function readPosition(id, owner, p = pot()) {
  const q = await withRetry(() => p.read.getPosition([BigInt(id), owner]), 4, `getPosition #${id}`);
  return { amounts: q.amounts.map((x) => x.toString()), feeW: q.feeW.map((x) => x.toString()), open: q.open };
}

/** Sends a write and waits for the receipt; throws with the revert reason when it fails. */
export async function send(wallet, fn, args, opts = {}) {
  const p = pot(wallet);
  const { request } = await publicClient.simulateContract({ address: p.address, abi, functionName: fn, args, account: wallet.account, ...opts });
  const hash = await wallet.client.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${fn} reverted in ${hash}`);
  return { hash, receipt };
}

/** ERC-20 approve `spender` for `amount` from the wallet unless the allowance already covers it. */
export async function ensureAllowance(wallet, token, spender, amount) {
  const have = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [wallet.account.address, spender] });
  if (have >= amount) return null;
  const hash = await wallet.client.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, 2n ** 256n - 1n] });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return hash;
}

export const stockByToken = (addr) => chainCfg.stocks.find((s) => s.token.toLowerCase() === String(addr).toLowerCase()) ?? null;
export const explorerTx = (hash) => `${chainCfg.explorer}/tx/${hash}`;
