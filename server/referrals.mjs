// Referral links: anyone who has placed a bet gets a code; a wallet that arrives through ?ref=CODE is bound to that
// code by its first bet (signed by the wallet, so nobody can bind someone else's wallet), permanently and on every
// network — the file is keyed by wallet address, which is the same on devnet and mainnet.
//
// Money: fees are charged on winnings (lib.rs settle), in the token of the pool. When a bound wallet's position
// settles with a fee, the referrer earns REFERRER tier % of that fee and the referee gets REFEREE_BPS of it back,
// both in the same token, paid by referral-payout.mjs from the operator's rebate wallet. Earnings are derived from
// data/settlements.jsonl every time (nothing is stored twice); the payout ledger records what was actually sent.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REFEREE_BPS = 1000;                                   // referee gets 10 % of the fee back
export const REFERRER_TIERS = [                                     // by the referrer's own all-time points
  { points: 0, bps: 2000 },                                        // 20 % of every referred fee
  { points: 10_000, bps: 2500 },                                   // 25 %
  { points: 100_000, bps: 3000 },                                  // 30 %
];
export const tierBps = (points) => REFERRER_TIERS.reduce((bps, t) => (points >= t.points ? t.bps : bps), REFERRER_TIERS[0].bps);
export const nextTier = (points) => REFERRER_TIERS.find((t) => points < t.points) ?? null;

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";                 // no 0/O/1/I/L
export const CODE_RE = /^[A-Z0-9]{6,10}$/;
/** Deterministic code for a wallet (same wallet → same code on every host); `len` grows on the rare collision. */
export function codeFor(wallet, len = 6) {
  const h = crypto.createHash("sha256").update("sharepot-ref:" + wallet).digest();
  let s = ""; for (let i = 0; i < len; i++) s += ALPHABET[h[i] % ALPHABET.length];
  return s;
}
export const normalizeCode = (c) => String(c ?? "").trim().toUpperCase().replace(/[O]/g, "0").replace(/[IL]/g, "1");
/** What the wallet signs to bind (plain text, so the wallet shows it). `domain` names the site the signature is for and
 *  `ts` (unix seconds) when it was made: the API takes it only for BIND_MAX_AGE_SECS, so a signature obtained elsewhere
 *  cannot be kept and used later. Wallets that support Sign-In-With-Solana sign a SIWS message instead (siwsBinding). */
export const BIND_MAX_AGE_SECS = 600;
export const bindMessage = (wallet, code, domain, ts) => `sharepot-referral v2\ndomain=${domain}\nwallet=${wallet}\ncode=${code}\nts=${ts}`;
/** Parse a signed Sign-In-With-Solana message text (the wallet checks that `domain` is the page that asked, so a
 *  phishing page cannot get one for this site). Returns { domain, address, code, issuedAt } or null when it is not a
 *  SharePot referral sign-in. */
export function parseSiws(text) {
  const m = String(text).match(/^([^\s]+) wants you to sign in with your Solana account:\n([1-9A-HJ-NP-Za-km-z]{32,44})\n\n(.*?)\n\n/s);
  if (!m) return null;
  const st = m[3].match(/^Apply SharePot referral code ([A-Z0-9]{6,10}) to this wallet's first bet\.$/);
  const issued = String(text).match(/\nIssued At: ([^\n]+)/);
  if (!st || !issued) return null;
  return { domain: m[1], address: m[2], code: st[1], issuedAt: issued[1] };
}
export const siwsStatement = (code) => `Apply SharePot referral code ${code} to this wallet's first bet.`;

const EMPTY = () => ({ version: 1, wallets: {}, codes: {}, bindings: {} });
export function load(file) {
  // Only "no file yet" is an empty book. Any other failure (unreadable, corrupt) must stop the caller: answering with
  // an empty book would let the next save() wipe every binding.
  let text; try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e?.code === "ENOENT") return EMPTY(); throw e; }
  return { ...EMPTY(), ...JSON.parse(text) };
}
/** Atomic write: a crash mid-write must never leave a truncated file behind. */
export function save(file, db) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(db, null, 1)); fs.renameSync(tmp, file);
}

/** The wallet's code, created on first use. Returns { code, created }. */
export function ensureCode(db, wallet, now = Date.now()) {
  const w = db.wallets[wallet]; if (w) return { code: w.code, created: false };
  let code; for (let len = 6; ; len++) { code = codeFor(wallet, len); if (!db.codes[code] || db.codes[code] === wallet) break; }
  db.wallets[wallet] = { code, createdAt: new Date(now).toISOString() }; db.codes[code] = wallet;
  return { code, created: true };
}
export const referrerOf = (db, code) => db.codes[normalizeCode(code)] ?? null;

/**
 * Bind `wallet` to `code`. Pure rule check; the caller verifies the signature and that this really is the wallet's
 * first bet (an open position and no settled history). Returns { ok } or { error }.
 */
export function bind(db, { wallet, code, cluster, now = Date.now() }) {
  code = normalizeCode(code);
  const referrer = db.codes[code];
  if (!referrer) return { error: "unknown referral code" };
  if (referrer === wallet) return { error: "you cannot refer yourself" };
  // no rings: if the code's owner is itself bound (directly or through others) to this wallet's code, the two would be
  // paying each other's rebates out of the treasury
  for (let r = db.bindings[referrer]?.referrer, hops = 0; r && hops < 64; r = db.bindings[r]?.referrer, hops++) if (r === wallet) return { error: "that wallet was referred by you: referrals cannot go in a circle" };
  const prev = db.bindings[wallet];
  if (prev) return prev.code === code ? { ok: true, already: true } : { error: "this wallet is already bound to another code" };
  db.bindings[wallet] = { code, referrer, at: new Date(now).toISOString(), cluster };
  return { ok: true };
}

const shares = (raw, decimals, multiplier) => (Number(raw) / 10 ** decimals) * (multiplier || 1);

/**
 * Earnings from settlement rows. `pointsOf(wallet)` gives the referrer's all-time points for the tier.
 * Returns { byWallet: Map(wallet → { referred: Set, earned: Map(mint → { raw: bigint, usd, token, decimals, multiplier, rows }) }) }
 * where each mint entry carries both roles (`asReferrer`, `asReferee`, in raw units) so the page can show the split.
 */
export function earnings(rows, db, pointsOf = () => 0) {
  const byWallet = new Map();
  const entry = (w) => { let e = byWallet.get(w); if (!e) { e = { referred: new Set(), earned: new Map() }; byWallet.set(w, e); } return e; };
  const add = (w, r, raw, role) => {
    if (raw <= 0n) return;
    const e = entry(w), k = r.mint; let m = e.earned.get(k);
    if (!m) { m = { mint: k, token: r.token ?? null, decimals: r.decimals ?? null, multiplier: r.multiplier ?? 1, raw: 0n, asReferrer: 0n, asReferee: 0n, usd: 0, rows: 0 }; e.earned.set(k, m); }
    m.raw += raw; m[role] += raw; m.rows++;
    if (m.decimals != null && r.close) m.usd += shares(raw, m.decimals, m.multiplier) * r.close;
  };
  // every wallet that ever used a referrer's code counts as referred, fee or not
  for (const [w, b] of Object.entries(db.bindings)) entry(b.referrer).referred.add(w);
  for (const r of rows) {
    const b = db.bindings[r.owner]; if (!b) continue;
    // Only what settled after the binding counts: a binding (the file is shared across networks) never reaches back
    // over fees the wallet paid before it was invited.
    if (b.at && r.at && String(r.at) < String(b.at)) continue;
    let fee; try { fee = BigInt(r.fee ?? 0); } catch { continue; }
    if (fee <= 0n) continue;
    add(b.referrer, r, (fee * BigInt(tierBps(pointsOf(b.referrer)))) / 10000n, "asReferrer");
    add(r.owner, r, (fee * BigInt(REFEREE_BPS)) / 10000n, "asReferee");
  }
  return { byWallet };
}

// The payout ledger (referral-payouts.jsonl) is append-only and written around the send, not after it:
//   { status: "sent",    raw: N,  signature }  written BEFORE the transaction goes out (the signature is known first)
//   { status: "landed",  raw: 0,  signature }  once it is confirmed
//   { status: "void",    raw: -N, signature }  once its blockhash expired without it landing: the "sent" is cancelled
// Rows without a status are from before this scheme and count as paid. Summing `raw` over every row is therefore what
// was really paid, whatever happened to the process in between; a "sent" without "landed"/"void" is settled by the
// next run from the chain (referral-payout.mjs reconcile).
export function readPayouts(file) {
  // Only "no file yet" is an empty ledger. A torn or corrupt line must stop the payout, not read as "nothing was ever
  // paid" — that would pay every rebate in history a second time.
  let text; try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e?.code === "ENOENT") return []; throw e; }
  return text.split("\n").filter(Boolean).map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`${file}: line ${i + 1} is not valid JSON; refusing to treat the payout ledger as empty`); } });
}
/** The payments that stand: sent rows (and legacy rows) whose signature was not voided. */
export function effectivePayouts(payouts) {
  const voided = new Set(payouts.filter((p) => p.status === "void").map((p) => p.signature));
  return payouts.filter((p) => (!p.status || p.status === "sent") && !voided.has(p.signature));
}
/** Sent rows the chain has not yet answered for. */
export const unsettledPayouts = (payouts) => { const done = new Set(payouts.filter((p) => p.status === "landed" || p.status === "void").map((p) => p.signature)); return payouts.filter((p) => p.status === "sent" && !done.has(p.signature)); };
/** earned − paid per (wallet, mint), as bigint raw units; entries ≤ 0 are dropped. */
export function pending(earn, payouts) {
  const paid = new Map();
  for (const p of payouts) { const k = `${p.wallet}|${p.mint}`; paid.set(k, (paid.get(k) ?? 0n) + BigInt(p.raw)); }
  const out = [];
  for (const [wallet, e] of earn.byWallet) for (const m of e.earned.values()) {
    const raw = m.raw - (paid.get(`${wallet}|${m.mint}`) ?? 0n);
    if (raw > 0n) out.push({ wallet, mint: m.mint, token: m.token, decimals: m.decimals, multiplier: m.multiplier, raw, usd: m.usd ? Number(raw) / Number(m.raw) * m.usd : null });
  }
  return out;
}
