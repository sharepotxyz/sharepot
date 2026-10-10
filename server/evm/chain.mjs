// Robinhood Chain (and any other EVM deployment of SharePot): clients, the contract, and the reads every script needs.
//   env: EVM_CHAIN=robinhood-testnet|robinhood (default robinhood-testnet), EVM_RPC (overrides chains.json),
//        EVM_CHAINS=path (overrides chains.json), EVM_PROPOSER_KEY_FILE (a file holding the hex private key, for writes)
import fs from "node:fs";
import { withRetry } from "../retry.mjs";
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

/** Every market on the contract, in id order, as plain objects with numbers where they fit. */
export async function allMarkets(p = pot()) {
  const count = Number(await withRetry(() => p.read.marketCount(), 4, "marketCount"));
  if (count === 0) return [];
  // one JSON-RPC batch per 50 markets (the http transport batches concurrent calls); no Multicall3 dependency.
  // A torn batch (the RPC answering fewer items than asked → viem "unknown RPC error") is retried, not fatal.
  const rows = [];
  for (let from = 0; from < count; from += 50) rows.push(...await withRetry(() => Promise.all(Array.from({ length: Math.min(50, count - from) }, (_, i) => p.read.getMarket([BigInt(from + i)]))), 4, `getMarket #${from}…`));
  return rows.map((m, id) => normalizeMarket(id, m));
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
