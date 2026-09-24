// What every page sees of a chain, whichever chain it is: markets, positions and wallet sessions as plain data with
// string addresses, and the payout arithmetic (the same on both programs). chain-solana.ts / chain-evm.ts produce
// these; wallet-solana.ts / wallet-evm.ts produce sessions.

export type MarketView = {
  /** The market's own address: the program account on Solana, "<contract>#<id>" on an EVM chain. Display and keys only. */
  address: string; id: number;
  /** The stock token the market is staked in (mint / ERC-20 address), its token program (Solana only), decimals and the
   *  issuer's dividend / split multiplier: raw units × multiplier ÷ 10^decimals is what a wallet shows. */
  mint: string; tokenProgram: string; decimals: number; multiplier: number;
  metric: string; thresholds: number[]; nBuckets: number; openTs: number; closeTs: number; resolveAfterTs: number; baseline: number;
  pools: number[]; seed: number;
  /** 0 open · 1 proposed · 2 resolved · 3 voided · 4 swept — the Solana program's numbering, which the EVM adapter maps to. */
  status: number; outcome: number; proposedOutcome: number; proposedValue: number; proposedAt: number;
  positions: number; positionsOpen: number; feeCollected: number; snapshotHash: string;
};
export type ConfigView = { admin: string; proposer: string; treasuryOwner: string; feeBps: number; earlyBirdDiscountBps: number; earlyBirdSecs: number; disputeWindowSecs: number; minBet: number; marketCount: number; paused: boolean };
/** One wallet's open position in one market: stake per range, and the fee rate (bps) locked on each range's stake. */
export type PositionView = { marketId: number; marketAddress: string; amounts: number[]; feeBps: number[] };
export type Balances = { native: number; raw: Record<string, number> };

/** A connected wallet. `placeBet` signs, sends and waits for the stake to land, returning the transaction id; if it was
 *  sent but not seen in time it throws an error with { unconfirmed: true, txid } — callers must not invite a second send. */
export type Session = {
  label: string; address: string;
  placeBet: (m: MarketView, bucket: number, amountRaw: number, onSent?: (txid: string) => void) => Promise<string>;
  signMessage: (msg: Uint8Array) => Promise<Uint8Array>;
  signIn?: (input: SignInInput) => Promise<SignInOutput>;
  disconnect: () => Promise<void>;
};
export type SignInInput = { domain: string; address: string; statement: string; uri?: string; version?: string; chainId?: string; nonce?: string; issuedAt?: string };
export type SignInOutput = { signedMessage: Uint8Array; signature: Uint8Array };
export type WalletChoice = { name: string; icon?: string; handle: unknown };

export const NO_OUTCOME = 255;
export const STATUS = ["Open", "Proposed", "Resolved", "Voided", "Swept"] as const;
/** Same rule as on-chain bucket_of. */
export const bucketOf = (m: MarketView, value: number) => m.thresholds.filter((t) => value >= t).length;
export const totalPool = (m: MarketView) => m.pools.reduce((a, b) => a + b, 0);

/** Off-chain replica of the on-chain payout for a position, given the market's final (or hypothetical) outcome bucket. */
export function payoutIfBucket(m: MarketView, amounts: number[], feeBpsByBucket: number[], w: number) {
  const total = amounts.reduce((a, b) => a + b, 0);
  if (m.status === 3) return { payout: total, kind: "refund" as const };
  const winPool = m.pools[w], losePool = totalPool(m) - winPool, stake = amounts[w] ?? 0;
  if (winPool === 0) return { payout: total, kind: "refund" as const };
  if (stake === 0) return { payout: 0, kind: "lost" as const };
  const gross = (losePool * stake) / winPool, fee = (gross * (feeBpsByBucket[w] ?? 0)) / 10000, seed = (m.seed * stake) / winPool;
  return { payout: stake + gross - fee + seed, kind: "won" as const };
}
/** Fee the user would pay right now on winnings, in bps (mirrors on-chain logic). */
export function currentFeeBps(cfg: ConfigView, m: MarketView, nowSec = Math.floor(Date.now() / 1000)) {
  let fee: number = cfg.feeBps;
  if (nowSec < earlyBirdUntil(cfg, m)) fee = Math.max(0, fee - cfg.earlyBirdDiscountBps);
  return fee;
}
/** End of the early-bird window: first quarter of the betting window, capped by config (mirrors on-chain). */
export function earlyBirdUntil(cfg: ConfigView, m: MarketView) {
  const quarter = Math.floor((m.closeTs - m.openTs) / 4);
  return m.openTs + Math.max(0, Math.min(cfg.earlyBirdSecs, quarter));
}
/** Payout breakdown if `bucket` wins with current pools + this stake. Fee applies to `fromLosers` only (mirrors on-chain). */
export function impliedPayout(m: MarketView, bucket: number, stake: number, feeBps: number) {
  const win = m.pools[bucket] + stake, lose = totalPool(m) - m.pools[bucket];
  const fromLosers = win ? (lose * stake) / win : 0, fromSeed = win ? (m.seed * stake) / win : 0;
  const fee = (fromLosers * feeBps) / 10000;
  return { fromLosers, fromSeed, fee, total: stake + fromLosers - fee + fromSeed };
}
/** The fee rate locked on each range of a position: feeW = Σ amount × bps, so feeW / amount (integer division, as on-chain). */
export const feeBpsOf = (amounts: number[], feeW: (bigint | string | number)[]) => amounts.map((a, i) => (a ? Number(BigInt(String(feeW[i] ?? 0)) / BigInt(Math.round(a))) : 0));

/** The page's boot snapshot (the server embeds markets, config, stocks and prices in the HTML so first paint needs no
 *  round trip); each part is used once, and only while fresh. */
export const boot: any = (globalThis as any).__BOOT__ ?? null;
export const bootFresh = (at?: number) => !!at && Date.now() - at < 60_000;
export const bootUsed = { markets: false, config: false };
export async function fromApi(base: string, p: string) { if (!base) throw new Error("no api"); const r = await fetch(base + p); if (!r.ok) throw new Error("api " + r.status); return r.json(); }
