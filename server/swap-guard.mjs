// The treasury signs a swap transaction that an outside API (Jupiter) built. Before it does, the transaction is
// simulated and what it would do to the treasury is compared with what was asked for: sell at most `amount` of ONE
// token, receive at least the quoted minimum in USDC, spend no more SOL than fees, and leave every other treasury
// account exactly as it was. Anything else — a wrong mint, a drained account, a transfer to someone else — is refused
// before a signature exists. The checks are pure functions (tested in swap-guard.test.mjs); simulationProblem does the RPC.
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

/** Token amount of an SPL / Token-2022 account from its raw data (u64 LE at offset 64); 0n for a missing account. */
export const tokenAmount = (data) => (data && data.length >= 72 ? data.readBigUInt64LE(64) : 0n);

/** The quote must be for exactly what was asked. Returns null or the reason. */
export function quoteProblem(q, { inputMint, outputMint, amount }) {
  if (q?.inputMint !== inputMint) return `quote sells ${q?.inputMint}, asked ${inputMint}`;
  if (q?.outputMint !== outputMint) return `quote buys ${q?.outputMint}, asked ${outputMint}`;
  if (String(q?.inAmount) !== String(amount)) return `quote sells ${q?.inAmount}, asked ${amount}`;
  if (!(BigInt(q?.otherAmountThreshold ?? 0) > 0n)) return "quote has no minimum output";
  return null;
}

/**
 * @param before/after  Map address → { lamports: bigint, amount: bigint } for the treasury wallet and its token accounts
 * @param want          { wallet, inputAta, outputAta, amount, minOut, maxLamports }
 * Returns null when the simulated effects are within what was asked, else the reason.
 */
export function effectsProblem(before, after, want) {
  for (const [addr, b] of before) {
    const a = after.get(addr); if (!a) return `simulation did not report ${addr}`;
    if (addr === want.wallet) {
      if (b.lamports - a.lamports > want.maxLamports) return `would spend ${b.lamports - a.lamports} lamports, cap ${want.maxLamports}`;
    } else if (addr === want.inputAta) {
      if (b.amount - a.amount > want.amount) return `would take ${b.amount - a.amount} of the sold token, asked ${want.amount}`;
    } else if (addr === want.outputAta) {
      if (a.amount - b.amount < want.minOut) return `would deliver ${a.amount - b.amount} USDC units, minimum ${want.minOut}`;
    } else if (a.amount < b.amount) return `would take ${b.amount - a.amount} from ${addr}, an account this swap has no business with`;
  }
  for (const k of [want.wallet, want.inputAta, want.outputAta]) if (!before.has(k)) return `${k} is not being watched`;
  return null;
}

/** Simulate `tx` (unsigned is fine) and check its effects on `owner` and every token account it holds. */
export async function simulationProblem(conn, tx, owner, { inputAta, outputAta, amount, minOut, maxLamports }) {
  const own = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) for (const a of (await conn.getTokenAccountsByOwner(owner, { programId })).value) own.push(a.pubkey.toBase58());
  // A transaction can only change accounts it names, and the RPC reports no more accounts than that: so the watch list
  // is the wallet, the two accounts of the swap, and every other token account of the owner that the transaction names
  // (directly or through its address lookup tables).
  const tables = [];
  for (const l of tx.message.addressTableLookups ?? []) { const t = (await conn.getAddressLookupTable(l.accountKey)).value; if (!t) return `lookup table ${l.accountKey.toBase58()} not found`; tables.push(t); }
  const named = new Set(tx.message.getAccountKeys({ addressLookupTableAccounts: tables }).keySegments().flat().map((k) => k.toBase58()));
  const wallet = owner.toBase58(), addresses = [...new Set([wallet, inputAta, outputAta, ...own.filter((k) => named.has(k))])];
  const snap = (list, bytes) => new Map(addresses.map((k, i) => [k, { lamports: BigInt(list[i]?.lamports ?? 0), amount: k === wallet || !list[i] ? 0n : tokenAmount(bytes(list[i])) }]));
  const before = snap(await conn.getMultipleAccountsInfo(addresses.map((k) => new PublicKey(k)), "confirmed"), (i) => i.data);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses } });
  if (sim.value.err) return `simulation failed: ${JSON.stringify(sim.value.err)}`;
  if ((sim.value.accounts ?? []).length !== addresses.length) return "simulation did not report the watched accounts";
  return effectsProblem(before, snap(sim.value.accounts, (i) => Buffer.from(i.data[0], "base64")), { wallet, inputAta, outputAta, amount, minOut, maxLamports });
}
