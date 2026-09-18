// Send a transaction and learn for certain whether it landed. On a public RPC that answers 429 to some of the status
// polls, "confirm threw" does not mean "did not land": a payout or a proposal can be on-chain while the caller believes
// it failed and records nothing (a lost settlement row, a rebate paid twice). So: the signature is known before the
// send, and the poll keeps asking, through 429s, until the transaction is confirmed or its blockhash has expired —
// only then is "did not land" true.
import bs58 from "bs58";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (e) => /429|Too Many|fetch failed|ECONNRESET|timed? ?out|503|502/i.test(String(e?.message ?? e));

/** Signs, sends and waits. Returns { sig, landed }. Throws on a definite failure (rejected by preflight, or failed on-chain).
 *  `beforeSend(sig)` runs once the signature is known and before anything reaches the network: the place to record it.
 *  `send(raw)` replaces the RPC's sendRawTransaction (e.g. a Jito bundle, jito.mjs); landing is still read from the RPC. */
export async function sendSigned(conn, tx, signers, { beforeSend, lastValidBlockHeight: lvbh, send } = {}) {
  let sig, raw, lastValidBlockHeight = lvbh;
  if (tx.version !== undefined) {
    // a VersionedTransaction (e.g. built by Jupiter) already carries its blockhash; the caller passes its expiry height
    if (lastValidBlockHeight == null) ({ lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed"));
    tx.sign(signers); sig = bs58.encode(tx.signatures[0]); raw = tx.serialize();
  } else {
    const fresh = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = fresh.blockhash; lastValidBlockHeight = fresh.lastValidBlockHeight; tx.feePayer = signers[0].publicKey; tx.sign(...signers);
    sig = bs58.encode(tx.signature); raw = tx.serialize();
  }
  if (beforeSend) await beforeSend(sig);
  for (let tries = 1; ; tries++) {
    try { await (send ? send(raw) : conn.sendRawTransaction(raw, { skipPreflight: false })); break; }
    catch (e) { if (tries >= 4 || !transient(e)) throw e; await sleep(1500 * tries); }
  }
  return { sig, landed: await landed(conn, sig, lastValidBlockHeight) };
}

/** True once `sig` is confirmed; false once its blockhash expired without it. Throws if it landed with an error. */
export async function landed(conn, sig, lastValidBlockHeight) {
  for (;;) {
    try {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return true;
      if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
        // expired: one last look in the ledger, in case it landed while the status cache was unreachable
        const h = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
        if (h?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(h.err)}`);
        return !!h;
      }
    } catch (e) { if (!transient(e)) throw e; }
    await sleep(1500);
  }
}

/** Status of an old signature: "confirmed", "failed" or null (not in the ledger). Retries through rate limits. */
export async function signatureStatus(conn, sig) {
  for (let tries = 1; ; tries++) {
    try {
      const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      return !st ? null : st.err ? "failed" : "confirmed";
    } catch (e) { if (tries >= 5 || !transient(e)) throw e; await sleep(2000 * tries); }
  }
}
