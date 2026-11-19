// The token list a second sampler (the verifier's, on another host) takes from the site's /api/stocks, with a local
// copy to fall back on when the site cannot be reached.
//   Until 2026-11-19 a site this host could not reach stopped the sampling itself: on 2026-11-18 22:00–24:00Z the
//   Tokyo↔app-host route lost 60–90 % of its packets, the list request timed out most minutes, and the verifier kept
//   only 36 (Solana) / 29 (Robinhood) of the 60 closing-hour samples it needs 40 of, so every coin market of the day
//   was headed for a void. The prices come from Jupiter / DexScreener / GeckoTerminal, never from the site; the site
//   only names the tokens, and that list changes about once a day.
//   The copy is exactly what the site last answered, so it trusts the site no more than before. It is used for at most
//   maxAgeSecs, and the caller says when it is used.
import fs from "node:fs";
import path from "node:path";

export const MAX_AGE_SECS = 48 * 3600;
const msg = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 160);

/** `pick(stocks)` turns the site's `stocks` array into the JSON-serialisable list the sampler uses.
 *  Returns { list, cachedAt (unix secs), fromCache, siteError? }. Throws when the site fails and there is no copy
 *  younger than maxAgeSecs. */
export async function siteTokenList({ url, cacheFile, pick, now = Math.floor(Date.now() / 1000), maxAgeSecs = MAX_AGE_SECS, fetchImpl = fetch, timeoutMs = 15_000 }) {
  let fresh = null, siteErr = null;
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    if (!Array.isArray(body?.stocks)) throw new Error("the answer has no stocks array");
    fresh = pick(body.stocks);
  } catch (e) { siteErr = e; }
  if (fresh) {
    try {   // a copy that cannot be written costs the next outage its fallback, never this minute's samples
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: now, list: fresh })); fs.renameSync(tmp, cacheFile);
    } catch (e) { console.log(new Date().toISOString(), `could not save the token list copy: ${msg(e)}`); }
    return { list: fresh, cachedAt: now, fromCache: false };
  }
  let copy = null;
  try { copy = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { /* missing or unreadable: no copy */ }
  if (!copy || typeof copy.at !== "number" || !Array.isArray(copy.list)) throw new Error(`token list: ${url} failed (${msg(siteErr)}) and there is no local copy`);
  const age = now - copy.at;
  if (age > maxAgeSecs) throw new Error(`token list: ${url} failed (${msg(siteErr)}) and the local copy is ${Math.round(age / 3600)} h old (limit ${Math.round(maxAgeSecs / 3600)} h)`);
  return { list: copy.list, cachedAt: copy.at, fromCache: true, siteError: msg(siteErr) };
}
