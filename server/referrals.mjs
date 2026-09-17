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
export const bindMessage = (wallet, code) => `sharepot-referral v1\nwallet=${wallet}\ncode=${code}`;

const EMPTY = () => ({ version: 1, wallets: {}, codes: {}, bindings: {} });
export function load(file) {
  try { const d = JSON.parse(fs.readFileSync(file, "utf8")); return { ...EMPTY(), ...d }; } catch { return EMPTY(); }
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
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
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
