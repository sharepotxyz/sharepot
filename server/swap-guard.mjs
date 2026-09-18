// The treasury signs a swap transaction that an outside API (Jupiter) built. Before it does, the transaction is
// simulated and what it would do to the treasury is compared with what was asked for: sell at most `amount` of ONE
// token, receive at least the quoted minimum in USDC, spend no more SOL than fees, and leave every other treasury
// account exactly as it was. Anything else — a wrong mint, a drained account, a transfer to someone else — is refused
// before a signature exists. The checks are pure functions (tested in swap-guard.test.mjs); simulationProblem does the RPC.
//
// "Exactly as it was" is byte-for-byte: a transaction that leaves every balance intact but plants a delegate, a new
// authority or a program owner on a treasury account (the drain then comes in a later transaction) changes bytes
// outside the balance field, and only the balance field of the two swap accounts may change.
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const SYSTEM = "11111111111111111111111111111111";
/** Token amount of an SPL / Token-2022 account from its raw data (u64 LE at offset 64); 0n for a missing account. */
export const tokenAmount = (data) => (data && data.length >= 72 ? data.readBigUInt64LE(64) : 0n);
const AMOUNT_FIELD = [64, 72];
/** Byte equality of two buffers (both missing counts as equal), optionally ignoring [from, to). */
const sameBytes = (a, b, skip = null) => {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) { if (skip && i >= skip[0] && i < skip[1]) continue; if (a[i] !== b[i]) return false; }
  return true;
};

/** The quote must be for exactly what was asked, and its minimum output must really be outAmount less the slippage
 *  that was requested — a quote whose threshold is a token or two would let the simulation pass at any price. */
export function quoteProblem(q, { inputMint, outputMint, amount, slippageBps = null }) {
  if (q?.inputMint !== inputMint) return `quote sells ${q?.inputMint}, asked ${inputMint}`;
  if (q?.outputMint !== outputMint) return `quote buys ${q?.outputMint}, asked ${outputMint}`;
  if (String(q?.inAmount) !== String(amount)) return `quote sells ${q?.inAmount}, asked ${amount}`;
  let threshold, out; try { threshold = BigInt(q?.otherAmountThreshold ?? 0); out = BigInt(q?.outAmount ?? 0); } catch { return "quote amounts are not numbers"; }
  if (!(threshold > 0n)) return "quote has no minimum output";
  if (slippageBps != null) {
    if (Number(q?.slippageBps) !== slippageBps) return `quote slippage ${q?.slippageBps} bps, asked ${slippageBps}`;
    const floor = (out * BigInt(10_000 - slippageBps - 1)) / 10_000n;   // −1 bp for Jupiter's rounding
    if (threshold < floor) return `quote minimum ${threshold} is below outAmount ${out} less ${slippageBps} bps slippage (${floor})`;
  }
  return null;
}

/**
 * @param before/after  Map address → { lamports: bigint, owner: string|null, data: Buffer|null } for the treasury
 *                      wallet and its token accounts (owner = the program owning the account; null when it does not exist)
 * @param want          { wallet, inputAta, outputAta, amount, minOut, maxLamports, nativeOut }
 *                      nativeOut: the swap buys SOL itself (unwrapped into the wallet) — the wallet must then GAIN at least
 *                      minOut less the fee allowance, and there is no output token account to watch.
 * Returns null when the simulated effects are within what was asked, else the reason.
 */
export function effectsProblem(before, after, want) {
  let walletBytes = null; try { walletBytes = new PublicKey(want.wallet).toBuffer(); } catch { return `wallet ${want.wallet} is not a public key`; }
  for (const [addr, b] of before) {
    const a = after.get(addr); if (!a) return `simulation did not report ${addr}`;
    const ba = tokenAmount(b.data), aa = tokenAmount(a.data);
    if (addr === want.wallet) {
      if (want.nativeOut) { if (a.lamports - b.lamports < want.minOut - want.maxLamports) return `would gain ${a.lamports - b.lamports} lamports, minimum ${want.minOut} less ${want.maxLamports} for fees`; }
      else if (b.lamports - a.lamports > want.maxLamports) return `would spend ${b.lamports - a.lamports} lamports, cap ${want.maxLamports}`;
      if ((a.owner ?? SYSTEM) !== SYSTEM || (a.data?.length ?? 0) !== 0) return "would hand the wallet account itself to a program";
      continue;
    }
    if (addr === want.inputAta || (!want.nativeOut && addr === want.outputAta)) {
      const role = addr === want.inputAta ? "sold-token" : "USDC";
      if (b.data) {
        if (!a.data) return `would close the ${role} account`;
        if (a.owner !== b.owner) return `would change the program owning the ${role} account`;
        if (!sameBytes(b.data, a.data, AMOUNT_FIELD)) return `would change the ${role} account beyond its balance (delegate, authority, owner or an extension)`;
      } else if (a.data) {
        // created by this transaction (a first USDC account): it must be a token account of the wallet
        if (a.data.length < 165 || !sameBytes(a.data.subarray(32, 64), walletBytes)) return `would create the ${role} account for someone else`;
      }
      if (addr === want.inputAta && ba - aa > want.amount) return `would take ${ba - aa} of the sold token, asked ${want.amount}`;
      if (addr === want.outputAta && aa - ba < want.minOut) return `would deliver ${aa - ba} USDC units, minimum ${want.minOut}`;
      continue;
    }
    if (a.owner !== b.owner || a.lamports !== b.lamports || !sameBytes(b.data, a.data)) return `would touch ${addr}, an account this swap has no business with`;
  }
  for (const k of want.nativeOut ? [want.wallet, want.inputAta] : [want.wallet, want.inputAta, want.outputAta]) if (!before.has(k)) return `${k} is not being watched`;
  return null;
}

/** Simulate `tx` (unsigned is fine) and check its effects on `owner` and every token account it holds. */
export async function simulationProblem(conn, tx, owner, { inputAta, outputAta, amount, minOut, maxLamports, nativeOut = false }) {
  const own = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) for (const a of (await conn.getTokenAccountsByOwner(owner, { programId })).value) own.push(a.pubkey.toBase58());
  // A transaction can only change accounts it names, and the RPC reports no more accounts than that: so the watch list
  // is the wallet, the two accounts of the swap, and every other token account of the owner that the transaction names
  // (directly or through its address lookup tables).
  const tables = [];
  for (const l of tx.message.addressTableLookups ?? []) { const t = (await conn.getAddressLookupTable(l.accountKey)).value; if (!t) return `lookup table ${l.accountKey.toBase58()} not found`; tables.push(t); }
  const named = new Set(tx.message.getAccountKeys({ addressLookupTableAccounts: tables }).keySegments().flat().map((k) => k.toBase58()));
  const wallet = owner.toBase58(), addresses = [...new Set([wallet, inputAta, ...(nativeOut ? [] : [outputAta]), ...own.filter((k) => named.has(k))])];
  const ownerStr = (o) => (o == null ? null : typeof o === "string" ? o : o.toBase58());
  const snap = (list, bytes) => new Map(addresses.map((k, i) => [k, list[i] ? { lamports: BigInt(list[i].lamports ?? 0), owner: ownerStr(list[i].owner), data: bytes(list[i]) } : { lamports: 0n, owner: null, data: null }]));
  const before = snap(await conn.getMultipleAccountsInfo(addresses.map((k) => new PublicKey(k)), "confirmed"), (i) => Buffer.from(i.data));
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses } });
  if (sim.value.err) return `simulation failed: ${JSON.stringify(sim.value.err)}`;
  if ((sim.value.accounts ?? []).length !== addresses.length) return "simulation did not report the watched accounts";
  return effectsProblem(before, snap(sim.value.accounts, (i) => Buffer.from(i.data[0], "base64")), { wallet, inputAta, outputAta, amount, minOut, maxLamports, nativeOut });
}
