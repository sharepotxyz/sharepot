// Send the treasury's swaps through Jito instead of the public RPC path. A transaction sent the usual way is relayed
// between nodes for a second or two before it lands, and a sandwiching validator (or a bot fed by one) can read it in
// transit, sell ahead of it and buy back behind it. A Jito bundle goes straight to the block engine and the current
// Jito leader, sealed until execution; `bundleOnly=true` keeps it off the regular relay path entirely (a bundle that
// fails is simply dropped, nothing lands partially). The bundle pays a tip to one of Jito's tip accounts — Jupiter's
// /swap adds that transfer when asked for `jitoTipLamports`, and tipProblem() checks it went where it should.
import { SystemProgram } from "@solana/web3.js";

export const TIP_ACCOUNTS = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);
export const DEFAULT_URL = "https://tokyo.mainnet.block-engine.jito.wtf";   // this host is in Tokyo; the engine routes globally anyway
const SYSTEM = SystemProgram.programId.toBase58();
const LAMPORTS = 1e9;

/** Tip to offer: the 95th percentile of recently landed tips (so ~19 in 20 bundles land on the first try), within
 *  [min, max]. `floor95Sol` is what bundles.jito.wtf reports, in SOL; null when it could not be fetched. */
export function tipLamports(floor95Sol, { min = 100_000, max = 2_000_000 } = {}) {
  const wanted = floor95Sol == null || !(floor95Sol > 0) ? min : Math.ceil(floor95Sol * LAMPORTS);
  return Math.min(max, Math.max(min, wanted));
}

/** The 95th-percentile landed tip in SOL, or null (never throws: a tip floor is a hint, not a requirement). */
export async function fetchTipFloor(fetchImpl = fetch) {
  try {
    const r = await fetchImpl("https://bundles.jito.wtf/api/v1/bundles/tip_floor", { signal: AbortSignal.timeout(8_000) });
    const j = await r.json(); const v = Number(j?.[0]?.landed_tips_95th_percentile);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

/** Every System transfer in a (versioned) transaction: { to, lamports }. Only static keys are looked at: a transfer's
 *  accounts are always static (the System program does not go through lookup tables in Jupiter's transactions), and an
 *  instruction whose keys we cannot see is reported as `to: null` so it is refused rather than ignored. */
export function systemTransfers(tx) {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58()), out = [];
  for (const ix of tx.message.compiledInstructions) {
    if (keys[ix.programIdIndex] !== SYSTEM) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 12 || data.readUInt32LE(0) !== 2) continue;   // 2 = Transfer; other System instructions (create account for the wrapped-SOL/USDC ATA) are not tips
    out.push({ to: keys[ix.accountKeyIndexes[1]] ?? null, lamports: data.readBigUInt64LE(4) });
  }
  return out;
}

/** The transaction must tip exactly one Jito tip account, no more than `tip` lamports, and transfer SOL nowhere else.
 *  Returns null or the reason. */
export function tipProblem(tx, tip) {
  const transfers = systemTransfers(tx);
  const tips = transfers.filter((t) => t.to && TIP_ACCOUNTS.has(t.to)), other = transfers.filter((t) => !t.to || !TIP_ACCOUNTS.has(t.to));
  if (other.length) return `transfers ${other.map((t) => `${t.lamports} lamports to ${t.to ?? "an address we cannot see"}`).join(", ")}: not a tip`;
  if (tips.length !== 1) return tips.length ? `${tips.length} tip transfers, expected one` : "no Jito tip in the transaction";
  if (tips[0].lamports > BigInt(tip)) return `tips ${tips[0].lamports} lamports, agreed ${tip}`;
  return null;
}

/** Submit one signed transaction as a single-transaction bundle. Resolves to the signature Jito echoes back. Errors carry
 *  the HTTP status so the caller can tell a rate limit (retry) from a rejection (do not). */
export async function sendBundleOnly(raw, { url = DEFAULT_URL, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${url}/api/v1/transactions?bundleOnly=true`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [Buffer.from(raw).toString("base64"), { encoding: "base64" }] }),
  });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok || !j || j.error || typeof j.result !== "string") throw new Error(`jito ${r.status}: ${j?.error?.message ?? text.slice(0, 120)}`);
  return { signature: j.result, bundleId: r.headers.get("x-bundle-id") };
}
