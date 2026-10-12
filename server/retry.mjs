// Transient-failure guard for the cron scripts (both chains). 2026-10-10: in 16 days the resolvers, openers and
// samplers died 48 times on things that pass a minute later — viem's "unknown RPC error" when the Robinhood RPC returns
// a torn batch, web3.js "fetch failed / ECONNRESET", DexScreener and Jupiter connect timeouts — each time dumping a
// 1,000-line stack into the log and doing nothing for that tick. Reads are idempotent, so retry them with backoff; and
// whatever still escapes ends the run with one log line instead of a crash dump (the next tick retries anyway).
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const TRANSIENT = /429|Too Many|fetch failed|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR|\b50[0-4]\b|Blockhash not found|unknown RPC error|nonce too low|replacement/i;
const text = (e) => [e?.shortMessage, e?.message, e?.details, e?.cause?.message, e?.cause?.code, typeof e === "string" ? e : ""].filter(Boolean).join(" | ");
export const isTransient = (e) => TRANSIENT.test(text(e));
export const firstLine = (e) => String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 200);

/** Retry `fn` on transient errors only: 1 s, 2 s, 4 s … between tries (baseMs scales it; tests pass 1). Anything else throws at once. */
export async function withRetry(fn, tries = 4, label = "rpc", baseMs = 1000) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !isTransient(e)) throw e;
      const wait = baseMs * 2 ** (i - 1);
      console.log(new Date().toISOString(), `${label}: ${firstLine(e).slice(0, 120)} — retry ${i}/${tries - 1} in ${wait} ms`);
      await sleep(wait);
    }
  }
}

/** Last line of defence for a script run from cron: an exception nobody caught (a failed top-level await included —
 *  Node 22 reports it as uncaughtException) is logged as one line plus the first stack frames, and the process exits 1
 *  — no stack dump, no silent half-run.
 *  A rejected promise nobody awaits is another matter: web3.js confirms transactions with racing requests, and when the
 *  RPC answers 429/5xx to the one that lost, it rejects with nobody waiting; the awaited path has its own answer. Such
 *  a transient stray is logged and the run goes on (exiting on it stopped a resolver mid-settle, where the per-position
 *  failure count never sees it: audit 2026-10-12). Any other stray rejection is a bug and still ends the run. */
export function guardProcess(log = (...a) => console.log(new Date().toISOString(), ...a)) {
  const die = (e) => {
    log(`FAILED (uncaught): ${firstLine(e)} — this run stops here; the next tick retries`);
    const frames = String(e?.stack ?? "").split("\n").slice(1, 4).map((s) => s.trim()).filter(Boolean).join(" | ");
    if (frames) log(`  ${frames}`);
    process.exit(1);
  };
  process.on("unhandledRejection", (e) => (isTransient(e) ? log(`unhandled rejection (ignored): ${firstLine(e).slice(0, 160)}`) : die(e)));
  process.on("uncaughtException", die);
}
