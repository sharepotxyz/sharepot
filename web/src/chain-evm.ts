// EVM (Robinhood Chain): reads of the SharePot contract through the API's cache first and the public RPC as fallback,
// behind the chain-agnostic types of chain-core.ts. Selected as "@chain" when VITE_CHAIN=evm. Status codes are mapped
// to the Solana program's numbering (the contract counts None=0, Open=1, …) so every page reads them alike.
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import abiJson from "../../evm/abi/SharePot.json";
import { API_BASE, EVM } from "./config";
import { boot, bootFresh, bootUsed, fromApi, type Balances, type ConfigView, type MarketView, type PositionView } from "./chain-core";
export * from "./chain-core";

export const abi = abiJson as any;
export const potAddress = EVM.pot as Address;
export const publicClient = createPublicClient({ transport: http(EVM.rpc, { batch: true, retryCount: 3, retryDelay: 700 }) });
export const erc20Abi = [
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function allowance(address, address) view returns (uint256)"),
  parseAbiItem("function approve(address, uint256) returns (bool)"),
  parseAbiItem("function decimals() view returns (uint8)"),
  parseAbiItem("function uiMultiplier() view returns (uint256)"),
];
export const marketAddress = (id: number) => `${potAddress}#${id}`;
const hexToStr = (h: string) => { const b = h.replace(/^0x/, "").match(/.{2}/g) ?? []; return new TextDecoder().decode(Uint8Array.from(b.map((x) => parseInt(x, 16)))).replace(/\0+$/, ""); };

// decimals and the ERC-8056 multiplier of each token, looked up once per page (RPC fallback only; the API sends them)
const tokenInfos = new Map<string, { decimals: number; multiplier: number }>();
async function tokenInfoOf(token: Address) {
  const k = token.toLowerCase();
  if (!tokenInfos.has(k)) {
    const [d, m] = await Promise.all([publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18), publicClient.readContract({ address: token, abi: erc20Abi, functionName: "uiMultiplier" }).catch(() => null)]);
    tokenInfos.set(k, { decimals: Number(d), multiplier: m == null ? 1 : Number(m) / 1e18 || 1 });
  }
  return tokenInfos.get(k)!;
}
function toView(id: number, m: any, ti: { decimals: number; multiplier: number }): MarketView {
  const n = Number(m.nBuckets);
  return {
    address: marketAddress(id), id, mint: String(m.token).toLowerCase(), tokenProgram: "", decimals: ti.decimals, multiplier: ti.multiplier, metric: hexToStr(m.metric), nBuckets: n, thresholds: m.thresholds.slice(0, n - 1).map(Number),
    openTs: Number(m.openTs), closeTs: Number(m.closeTs), resolveAfterTs: Number(m.resolveAfterTs), baseline: Number(m.baseline), pools: m.pools.slice(0, n).map(Number), seed: Number(m.seedAmount),
    status: Number(m.status) - 1, outcome: Number(m.outcome), proposedOutcome: Number(m.proposedOutcome), proposedValue: Number(m.proposedValue), proposedAt: Number(m.proposedAt),
    positions: Number(m.positions), positionsOpen: Number(m.positionsOpen), feeCollected: Number(m.feeCollected), snapshotHash: String(m.snapshotHash).replace(/^0x/, ""),
  };
}
// The API serves markets already in this shape (status mapped, pools as numbers); a market's address must be this
// contract's, so a forged listing never reaches a transaction.
const viewFromJson = (j: any): MarketView => { if (j.pubkey !== marketAddress(j.id)) throw new Error(`market ${j.id} is not on this contract`); const { pubkey, ...rest } = j; return { ...rest, address: pubkey }; };
const cfgFromJson = (c: any): ConfigView => ({ ...c, earlyBirdSecs: Number(c.earlyBirdSecs), disputeWindowSecs: Number(c.disputeWindowSecs), minBet: Number(c.minBet), marketCount: Number(c.marketCount) });
const readMarket = (id: number) => publicClient.readContract({ address: potAddress, abi, functionName: "getMarket", args: [BigInt(id)] }) as Promise<any>;

export async function fetchConfig(opts: { fresh?: boolean } = {}): Promise<ConfigView> {
  if (!opts.fresh && !bootUsed.config && boot?.config && bootFresh(boot.chainAt)) { bootUsed.config = true; return cfgFromJson(boot.config); }
  if (!opts.fresh) { try { return cfgFromJson((await fromApi(API_BASE, "/config")).config); } catch {} }
  const [c, count] = await Promise.all([publicClient.readContract({ address: potAddress, abi, functionName: "config" }) as Promise<any[]>, publicClient.readContract({ address: potAddress, abi, functionName: "marketCount" }) as Promise<bigint>]);
  return { admin: c[0], proposer: c[1], treasuryOwner: c[2], feeBps: Number(c[3]), earlyBirdDiscountBps: Number(c[4]), earlyBirdSecs: Number(c[5]), disputeWindowSecs: Number(c[6]), minBet: Number(c[7]), marketCount: Number(count), paused: c[8] };
}
export async function fetchMarkets(opts: { fresh?: boolean } = {}): Promise<MarketView[]> {
  if (!opts.fresh && !bootUsed.markets && boot?.markets && bootFresh(boot.chainAt)) { bootUsed.markets = true; return boot.markets.map(viewFromJson); }
  if (!opts.fresh) { try { return (await fromApi(API_BASE, "/markets")).markets.map(viewFromJson); } catch {} }
  const count = Number(await publicClient.readContract({ address: potAddress, abi, functionName: "marketCount" }));
  const raw = await Promise.all(Array.from({ length: count }, (_, id) => readMarket(id)));
  const views = await Promise.all(raw.map(async (m, id) => toView(id, m, await tokenInfoOf(m.token))));
  return views.sort((a, b) => b.id - a.id);
}
export async function fetchMarket(id: number, opts: { fresh?: boolean } = {}): Promise<MarketView> {
  if (!opts.fresh) { try { return viewFromJson((await fromApi(API_BASE, "/markets/" + id)).market); } catch {} }
  const m = await readMarket(id);
  return toView(id, m, await tokenInfoOf(m.token));
}
const readPosition = (id: number, owner: string) => publicClient.readContract({ address: potAddress, abi, functionName: "getPosition", args: [BigInt(id), owner as Address] }) as Promise<any>;
/** Positions live in a mapping, so which markets a wallet is in comes from the API's event index; the stakes themselves
 *  are read from the contract. */
export async function fetchPositionsByOwner(owner: string): Promise<PositionView[]> {
  const j = await fromApi(API_BASE, "/positions/" + owner);
  const ids: number[] = (j.open ?? []).map((x: any) => Number(x.id));
  const got = await Promise.all(ids.map((id) => readPosition(id, owner)));
  return got.map((p, i) => ({ p, id: ids[i] })).filter(({ p }) => p.open).map(({ p, id }) => { const amounts = p.amounts.map(Number) as number[]; return { marketId: id, marketAddress: marketAddress(id), amounts, feeBps: amounts.map((a, k) => (a ? Number(BigInt(p.feeW[k]) / BigInt(Math.round(a))) : 0)) }; });
}
export async function fetchPositionAmounts(m: MarketView, owner: string): Promise<number[] | null> {
  const p = await readPosition(m.id, owner);
  return p.open ? (p.amounts as bigint[]).map(Number) : null;
}
/** ETH + the balance of every listed token, one batched RPC round trip. */
export async function fetchBalances(owner: string, markets: MarketView[]): Promise<Balances> {
  const tokens = [...new Set(markets.map((m) => m.mint))];
  const [eth, ...bals] = await Promise.all([publicClient.getBalance({ address: owner as Address }), ...tokens.map((t) => publicClient.readContract({ address: t as Address, abi: erc20Abi, functionName: "balanceOf", args: [owner as Address] }).catch(() => 0n))]);
  return { native: Number(eth) / 1e18, raw: Object.fromEntries(tokens.map((t, i) => [t, Number(bals[i])])) };
}
