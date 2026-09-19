import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "../../idl/sharepot.json";
import { API_BASE, PROGRAM_ID, RPC_URL } from "./config";

export const connection = new Connection(RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: false });

/** Confirm by polling signature status (no websocket: works behind tunnels, on mobile data, and on flaky public RPCs). */
export async function confirmBySig(sig: string, timeoutMs = 60000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let st;
    // a status poll that fails (rate limit, a network blip: browsers word these differently) says nothing about the
    // transaction: wait and ask again. Only an error reported for the transaction itself is a failure.
    try { st = (await connection.getSignatureStatuses([sig])).value[0]; } catch { st = undefined; }
    if (st?.err) throw new Error("Transaction failed: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Not seen yet is not the same as failed: the transaction may still land. Callers must not invite a second send.
  throw Object.assign(new Error("Not confirmed after " + timeoutMs / 1000 + "s. Check signature " + sig), { unconfirmed: true });
}
export const programId = new PublicKey(PROGRAM_ID);
const readOnlyProvider = new AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any, { commitment: "confirmed" });
export const program = new Program(idl as Idl, readOnlyProvider);

export const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
export const marketPda = (id: number | BN) => PublicKey.findProgramAddressSync([Buffer.from("market"), new BN(id).toArrayLike(Buffer, "le", 8)], programId)[0];
export const vaultPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], programId)[0];
export const positionPda = (m: PublicKey, u: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), u.toBuffer()], programId)[0];

export type MarketView = {
  pubkey: PublicKey; id: number; mint: PublicKey; tokenProgram: PublicKey; decimals: number; multiplier: number; metric: string; thresholds: number[]; nBuckets: number; openTs: number; closeTs: number; resolveAfterTs: number;
  baseline: number; pools: number[]; seed: number; status: number; outcome: number; proposedOutcome: number; proposedValue: number; proposedAt: number; positions: number; positionsOpen: number; feeCollected: number; snapshotHash: string;
};
export const NO_OUTCOME = 255;
/** Same rule as on-chain Market::bucket_of. */
export const bucketOf = (m: MarketView, value: number) => m.thresholds.filter((t) => value >= t).length;
export const totalPool = (m: MarketView) => m.pools.reduce((a, b) => a + b, 0);
export const STATUS = ["Open", "Proposed", "Resolved", "Voided", "Swept"] as const;
const tag = (b: number[]) => Buffer.from(b).toString("utf8").replace(/\0+$/, "");

// Token program, decimals and current ScaledUiAmount multiplier of each mint, looked up once per page (RPC fallback only;
// the API sends the same fields with every market).
type MintInfo = { tokenProgram: PublicKey; decimals: number; multiplier: number };
const mintInfos = new Map<string, MintInfo>();
async function mintInfoOf(mint: PublicKey): Promise<MintInfo> {
  const k = mint.toBase58();
  if (!mintInfos.has(k)) {
    const a: any = await connection.getParsedAccountInfo(mint), info = a.value.data.parsed.info;
    const sc = (info.extensions ?? []).find((e: any) => e.extension === "scaledUiAmountConfig")?.state;
    const multiplier = sc ? Number(Date.now() / 1000 >= Number(sc.newMultiplierEffectiveTimestamp) ? sc.newMultiplier : sc.multiplier) : 1;
    mintInfos.set(k, { tokenProgram: a.value.owner, decimals: info.decimals, multiplier });
  }
  return mintInfos.get(k)!;
}
export function toView(pubkey: PublicKey, a: any, mi: MintInfo): MarketView {
  return {
    pubkey, id: a.id.toNumber(), mint: a.mint, tokenProgram: mi.tokenProgram, decimals: mi.decimals, multiplier: mi.multiplier, metric: tag(a.metric), nBuckets: a.nBuckets, thresholds: a.thresholds.slice(0, a.nBuckets - 1).map((t: any) => t.toNumber()), openTs: a.openTs.toNumber(), closeTs: a.closeTs.toNumber(), resolveAfterTs: a.resolveAfterTs.toNumber(), baseline: a.baseline.toNumber(),
    pools: a.pools.slice(0, a.nBuckets).map((x: any) => x.toNumber()), seed: a.seedAmount.toNumber(), status: a.status, outcome: a.outcome, proposedOutcome: a.proposedOutcome, proposedValue: a.proposedValue.toNumber(), proposedAt: a.proposedAt.toNumber(),
    positions: a.positions, positionsOpen: a.positionsOpen, feeCollected: a.feeCollected.toNumber(), snapshotHash: Buffer.from(a.snapshotHash).toString("hex"),
  };
}
// Reads go through the API's 15 s cache first (one small JSON instead of a getProgramAccounts round-trip on every page
// view) and fall back to the RPC. `fresh: true` forces the RPC, used right after the user's own transaction.
const fromApi = async (p: string) => { if (!API_BASE) throw new Error("no api"); const r = await fetch(API_BASE + p); if (!r.ok) throw new Error("api " + r.status); return r.json(); };
// A market from the API must be the program's own account for that id (its PDA): a wrong or forged address is never
// handed to a transaction.
const viewFromJson = (j: any): MarketView => { const pubkey = new PublicKey(j.pubkey); if (!marketPda(j.id).equals(pubkey)) throw new Error(`market ${j.id} is not at its program address`); return { ...j, pubkey, mint: new PublicKey(j.mint), tokenProgram: new PublicKey(j.tokenProgram) }; };
const cfgFromJson = (c: any) => ({ ...c, admin: new PublicKey(c.admin), proposer: new PublicKey(c.proposer), treasuryOwner: new PublicKey(c.treasuryOwner), earlyBirdSecs: new BN(c.earlyBirdSecs), disputeWindowSecs: new BN(c.disputeWindowSecs), minBet: new BN(c.minBet), marketCount: new BN(c.marketCount) });
// The server embeds a snapshot of markets + config in the page (window.__BOOT__); the first read of each uses it, so
// first paint needs no API round trip. Later reads (auto-refresh, after a bet) go to the API or the RPC as before.
const boot: any = (globalThis as any).__BOOT__ ?? null;
const bootFresh = (at?: number) => !!at && Date.now() - at < 60_000;
const bootUsed = { markets: false, config: false };
export async function fetchConfig(opts: { fresh?: boolean } = {}) {
  if (!opts.fresh && !bootUsed.config && boot?.config && bootFresh(boot.chainAt)) { bootUsed.config = true; return cfgFromJson(boot.config); }
  if (!opts.fresh) { try { return cfgFromJson((await fromApi("/config")).config); } catch {} }
  return (program.account as any).config.fetch(configPda);
}
export async function fetchMarkets(opts: { fresh?: boolean } = {}): Promise<MarketView[]> {
  if (!opts.fresh && !bootUsed.markets && boot?.markets && bootFresh(boot.chainAt)) { bootUsed.markets = true; return boot.markets.map(viewFromJson); }
  if (!opts.fresh) { try { return (await fromApi("/markets")).markets.map(viewFromJson); } catch {} }
  const all = await (program.account as any).market.all([{ dataSize: (program.account as any).market.size }]);
  const views = await Promise.all(all.map(async (x: any) => toView(x.publicKey, x.account, await mintInfoOf(x.account.mint))));
  return views.sort((a: MarketView, b: MarketView) => b.id - a.id);
}
export async function fetchMarket(id: number, opts: { fresh?: boolean } = {}): Promise<MarketView> {
  if (!opts.fresh) { try { return viewFromJson((await fromApi("/markets/" + id)).market); } catch {} }
  const pk = marketPda(id); const a = await (program.account as any).market.fetch(pk);
  return toView(pk, a, await mintInfoOf(a.mint));
}
/** All open positions of a wallet (owner sits at offset 8 + 32 in Position). */
export async function fetchPositionsByOwner(u: PublicKey) {
  const all = await (program.account as any).position.all([{ dataSize: (program.account as any).position.size }, { memcmp: { offset: 40, bytes: u.toBase58() } }]);
  return all.map((x: any) => ({ pubkey: x.publicKey as PublicKey, market: x.account.market as PublicKey, amounts: (x.account.amounts as any[]).map((a) => a.toNumber()) as number[], feeW: x.account.feeW as any[] }));
}
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
/** One wallet's stakes per range in a market. "No such position" (null) is told apart from "the RPC did not answer" (throws): a page that
 *  already shows a position must not erase it over a rate limit. */
export async function fetchPositionAmounts(m: PublicKey, u: PublicKey): Promise<number[] | null> {
  const p = await (program.account as any).position.fetchNullable(positionPda(m, u));
  return p ? (p.amounts as any[]).map((x) => x.toNumber()) : null;
}

/** Fee the user would pay right now on winnings, in bps (mirrors on-chain logic). */
export function currentFeeBps(cfg: any, m: MarketView, nowSec = Math.floor(Date.now() / 1000)) {
  let fee: number = cfg.feeBps;
  if (nowSec < earlyBirdUntil(cfg, m)) fee = Math.max(0, fee - cfg.earlyBirdDiscountBps);
  return fee;
}
/** End of the early-bird window: first quarter of the betting window, capped by config (mirrors on-chain). */
export function earlyBirdUntil(cfg: any, m: MarketView) {
  const quarter = Math.floor((m.closeTs - m.openTs) / 4);
  return m.openTs + Math.max(0, Math.min(cfg.earlyBirdSecs.toNumber(), quarter));
}
/** Payout breakdown if `bucket` wins with current pools + this stake. Fee applies to `fromLosers` only (mirrors on-chain). */
export function impliedPayout(m: MarketView, bucket: number, stake: number, feeBps: number) {
  const win = m.pools[bucket] + stake, lose = totalPool(m) - m.pools[bucket];
  const fromLosers = win ? (lose * stake) / win : 0, fromSeed = win ? (m.seed * stake) / win : 0;
  const fee = (fromLosers * feeBps) / 10000;
  return { fromLosers, fromSeed, fee, total: stake + fromLosers - fee + fromSeed };
}
/** The wallet's token account for this market's stock. */
export const userTokenAccount = (m: MarketView, user: PublicKey) => getAssociatedTokenAddressSync(m.mint, user, false, m.tokenProgram);

export async function buildPlaceBetTx(user: PublicKey, m: MarketView, bucket: number, amountBase: number): Promise<Transaction> {
  const ix: TransactionInstruction = await program.methods.placeBet(bucket, new BN(amountBase))
    .accounts({ config: configPda, market: m.pubkey, position: positionPda(m.pubkey, user), vault: vaultPda(m.pubkey), mint: m.mint, userToken: userTokenAccount(m, user), user, tokenProgram: m.tokenProgram, systemProgram: SystemProgram.programId })
    .instruction();
  const tx = new Transaction().add(ix);
  tx.feePayer = user;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  return tx;
}
