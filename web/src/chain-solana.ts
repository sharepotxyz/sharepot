// Solana: reads of the SharePot program (through the API's cache first, the RPC as fallback) and the place-bet
// transaction, behind the chain-agnostic types of chain-core.ts. Selected as "@chain" when VITE_CHAIN is not "evm".
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "../../idl/sharepot.json";
import { API_BASE, PROGRAM_ID, RPC_URL } from "./config";
import { boot, bootFresh, bootUsed, fromApi, type Balances, type ConfigView, type MarketView, type PositionView } from "./chain-core";
export * from "./chain-core";

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
  throw Object.assign(new Error("Not confirmed after " + timeoutMs / 1000 + "s. Check signature " + sig), { unconfirmed: true, txid: sig });
}
export const programId = new PublicKey(PROGRAM_ID);
const readOnlyProvider = new AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any, { commitment: "confirmed" });
export const program = new Program(idl as Idl, readOnlyProvider);

export const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
export const marketPda = (id: number | BN) => PublicKey.findProgramAddressSync([Buffer.from("market"), new BN(id).toArrayLike(Buffer, "le", 8)], programId)[0];
export const vaultPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], programId)[0];
export const positionPda = (m: PublicKey, u: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), u.toBuffer()], programId)[0];
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
function toView(pubkey: PublicKey, a: any, mi: MintInfo): MarketView {
  return {
    address: pubkey.toBase58(), id: a.id.toNumber(), mint: a.mint.toBase58(), tokenProgram: mi.tokenProgram.toBase58(), decimals: mi.decimals, multiplier: mi.multiplier, metric: tag(a.metric), nBuckets: a.nBuckets, thresholds: a.thresholds.slice(0, a.nBuckets - 1).map((t: any) => t.toNumber()), openTs: a.openTs.toNumber(), closeTs: a.closeTs.toNumber(), resolveAfterTs: a.resolveAfterTs.toNumber(), baseline: a.baseline.toNumber(),
    pools: a.pools.slice(0, a.nBuckets).map((x: any) => x.toNumber()), seed: a.seedAmount.toNumber(), status: a.status, outcome: a.outcome, proposedOutcome: a.proposedOutcome, proposedValue: a.proposedValue.toNumber(), proposedAt: a.proposedAt.toNumber(),
    positions: a.positions, positionsOpen: a.positionsOpen, feeCollected: a.feeCollected.toNumber(), snapshotHash: Buffer.from(a.snapshotHash).toString("hex"),
  };
}
// A market from the API must be the program's own account for that id (its PDA): a wrong or forged address is never
// handed to a transaction.
const viewFromJson = (j: any): MarketView => { if (!marketPda(j.id).equals(new PublicKey(j.pubkey))) throw new Error(`market ${j.id} is not at its program address`); const { pubkey, ...rest } = j; return { ...rest, address: pubkey }; };
const cfgFromJson = (c: any): ConfigView => ({ ...c, earlyBirdSecs: Number(c.earlyBirdSecs), disputeWindowSecs: Number(c.disputeWindowSecs), minBet: Number(c.minBet), marketCount: Number(c.marketCount) });
const cfgFromChain = (c: any): ConfigView => ({ admin: c.admin.toBase58(), proposer: c.proposer.toBase58(), treasuryOwner: c.treasuryOwner.toBase58(), feeBps: c.feeBps, earlyBirdDiscountBps: c.earlyBirdDiscountBps, earlyBirdSecs: c.earlyBirdSecs.toNumber(), disputeWindowSecs: c.disputeWindowSecs.toNumber(), minBet: c.minBet.toNumber(), marketCount: c.marketCount.toNumber(), paused: c.paused });
const pk = (m: MarketView) => new PublicKey(m.address);

export async function fetchConfig(opts: { fresh?: boolean } = {}): Promise<ConfigView> {
  if (!opts.fresh && !bootUsed.config && boot?.config && bootFresh(boot.chainAt)) { bootUsed.config = true; return cfgFromJson(boot.config); }
  if (!opts.fresh) { try { return cfgFromJson((await fromApi(API_BASE, "/config")).config); } catch {} }
  return cfgFromChain(await (program.account as any).config.fetch(configPda));
}
export async function fetchMarkets(opts: { fresh?: boolean } = {}): Promise<MarketView[]> {
  if (!opts.fresh && !bootUsed.markets && boot?.markets && bootFresh(boot.chainAt)) { bootUsed.markets = true; return boot.markets.map(viewFromJson); }
  if (!opts.fresh) { try { return (await fromApi(API_BASE, "/markets")).markets.map(viewFromJson); } catch {} }
  const all = await (program.account as any).market.all([{ dataSize: (program.account as any).market.size }]);
  const views = await Promise.all(all.map(async (x: any) => toView(x.publicKey, x.account, await mintInfoOf(x.account.mint))));
  return views.sort((a: MarketView, b: MarketView) => b.id - a.id);
}
export async function fetchMarket(id: number, opts: { fresh?: boolean } = {}): Promise<MarketView> {
  if (!opts.fresh) { try { return viewFromJson((await fromApi(API_BASE, "/markets/" + id)).market); } catch {} }
  const p = marketPda(id); const a = await (program.account as any).market.fetch(p);
  return toView(p, a, await mintInfoOf(a.mint));
}
/** All open positions of a wallet (owner sits at offset 8 + 32 in Position). */
export async function fetchPositionsByOwner(owner: string): Promise<PositionView[]> {
  const all = await (program.account as any).position.all([{ dataSize: (program.account as any).position.size }, { memcmp: { offset: 40, bytes: owner } }]);
  return all.map((x: any) => { const amounts = (x.account.amounts as any[]).map((a) => a.toNumber()) as number[]; return { marketId: -1, marketAddress: (x.account.market as PublicKey).toBase58(), amounts, feeBps: amounts.map((a, i) => (a ? Number(BigInt(x.account.feeW[i].toString()) / BigInt(a)) : 0)) }; });
}
/** One wallet's stakes per range in a market. "No such position" (null) is told apart from "the RPC did not answer" (throws): a page that
 *  already shows a position must not erase it over a rate limit. */
export async function fetchPositionAmounts(m: MarketView, owner: string): Promise<number[] | null> {
  const p = await (program.account as any).position.fetchNullable(positionPda(pk(m), new PublicKey(owner)));
  return p ? (p.amounts as any[]).map((x) => x.toNumber()) : null;
}
/** SOL + the balance of every listed token in two RPC calls (all of the wallet's accounts per token program at once). */
export async function fetchBalances(owner: string, markets: MarketView[]): Promise<Balances> {
  const o = new PublicKey(owner), programs = [...new Set(markets.map((m) => m.tokenProgram))];
  const [sol, ...lists] = await Promise.all([connection.getBalance(o), ...programs.map((p) => connection.getParsedTokenAccountsByOwner(o, { programId: new PublicKey(p) }))]);
  const raw: Record<string, number> = {};
  for (const list of lists) for (const a of list.value) { const info = (a.account.data as any).parsed?.info; if (info) raw[info.mint] = (raw[info.mint] ?? 0) + Number(info.tokenAmount?.amount ?? 0); }
  return { native: sol / 1e9, raw: Object.fromEntries(markets.map((m) => [m.mint, raw[m.mint] ?? 0])) };
}
/** The wallet's token account for this market's stock. */
export const userTokenAccount = (m: MarketView, user: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(m.mint), user, false, new PublicKey(m.tokenProgram));

export async function buildPlaceBetTx(user: PublicKey, m: MarketView, bucket: number, amountBase: number): Promise<Transaction> {
  const market = pk(m);
  const ix: TransactionInstruction = await program.methods.placeBet(bucket, new BN(amountBase))
    .accounts({ config: configPda, market, position: positionPda(market, user), vault: vaultPda(market), mint: new PublicKey(m.mint), userToken: userTokenAccount(m, user), user, tokenProgram: new PublicKey(m.tokenProgram), systemProgram: SystemProgram.programId })
    .instruction();
  const tx = new Transaction().add(ix);
  tx.feePayer = user;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  return tx;
}
