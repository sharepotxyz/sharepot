// SharePot Perp — one wallet's ledger in one pool, rebuilt from public data only: the pool's settled days (each
// Settled event: the close, the previous close, the long and short exposure, the tokens the price moved, the funding)
// and the wallet's own requests. Pure: no network, no page; perp-me.ts feeds it, scripts/perp-ledger-e2e.sh checks it
// against a real contract.
//
// How a settlement moves a tier (SharePotPerp._process / _shift / _fund): every tier on a side gives or gets in
// proportion to its exposure c x held, so per token a tier holds, a settled day changes it by
//     price:   +/- c x moved / E_side     (+ when that side won the day: longs when the close went up)
//     funding: +/- c x funding / E_side   (- when that side is the crowded one and pays)
// where E_side is that side's exposure before the day (Settled.longExp / shortExp). A wallet's part of a tier moves the
// same way, so its tokens just before a close times those fractions are its share of that day. Entries join after the
// close's moves (priced at it); exits leave after them. Amounts are raw token units as floats (display only: the
// contract's integer rounding differs by a few units, which perp-me.ts folds into the price part).

export type LedgerTier = { i: number; c: number; isLong: boolean };
/** One day as /api/days lists it (amounts are decimal strings; null when that event is not indexed yet). */
export type LedgerDay = {
  day: number; state: number; cutoff: number; value: string; prevValue: string | null; longExp: string | null; shortExp: string | null;
  moved: string | null; funding: string | null; rolledTo: number | null; settledAt: number | null; settleTx: string | null;
};
/** One of the wallet's own events as /api/activity lists it. */
export type LedgerEvent = { ev: string; ts: number; tx: string; day: number; tier: number; amount: string | null; shares: string | null; tokens: string | null };
export type LedgerInput = {
  tiers: LedgerTier[]; feeBps: number;
  /** The treasury pays no fees. */
  exempt: boolean;
  days: LedgerDay[]; events: LedgerEvent[];
  /** What each filled exit pays after its fee, by "requestDay:tier" (a withdrawn one is also in its Claimed event). */
  exitsNet: Map<string, bigint>;
};
/** A settled day for one tier the wallet was in: its share of the price move and of the funding (signed, raw units). */
export type SettleRow = { kind: "settle"; day: number; tier: number; ts: number; tx: string | null; before: number; move: number; price: number; funding: number };
/** An entry or exit filled at a close: tokens in (after the fee) or tokens out (after the fee), and the fee. */
export type FillRow = { kind: "entered" | "exited"; day: number; tier: number; ts: number; tx: string | null; tokens: number; fee: number };
export type LedgerRow = SettleRow | FillRow;
export type TierSum = { tier: number; price: number; funding: number; fees: number; filled: boolean; tokens: number };

const SETTLED = 3, SKIPPED = 4, BPS = 10_000;
const num = (s: string | null | undefined) => (s == null ? NaN : Number(s));

export function buildLedger(inp: LedgerInput): { rows: LedgerRow[]; sums: TierSum[] } {
  const byDay = new Map(inp.days.map((d) => [d.day, d]));
  // a skipped day's requests are filled at the next day it rolled to (following further skips)
  const resolve = (d: number) => { for (let k = 0; k < 64; k++) { const x = byDay.get(d); if (!x || x.state !== SKIPPED || !x.rolledTo) return d; d = x.rolledTo; } return d; };
  const key = (day: number, tier: number) => `${day}:${tier}`;
  // entries (gross, net of take-backs) and exits (by request day) that fill at each day
  const entries = new Map<string, bigint>(), exits = new Map<string, number[]>();
  for (const e of inp.events) {
    const k = key(resolve(e.day), e.tier);
    if (e.ev === "DepositRequested") entries.set(k, (entries.get(k) ?? 0n) + BigInt(e.amount ?? "0"));
    else if (e.ev === "DepositCancelled") entries.set(k, (entries.get(k) ?? 0n) - BigInt(e.amount ?? "0"));
    else if (e.ev === "RedeemRequested") exits.set(k, [...(exits.get(k) ?? []), e.day]);
  }
  const fee = (gross: bigint) => (inp.exempt ? 0n : (gross * BigInt(inp.feeBps)) / BigInt(BPS));
  const rows: LedgerRow[] = [];
  const sums: TierSum[] = inp.tiers.map((t) => ({ tier: t.i, price: 0, funding: 0, fees: 0, filled: false, tokens: 0 }));
  const settled = inp.days.filter((d) => d.state === SETTLED).sort((a, b) => a.day - b.day);
  for (const d of settled) {
    const v = num(d.value), prev = num(d.prevValue), eL = num(d.longExp), eS = num(d.shortExp), moved = num(d.moved), funding = num(d.funding);
    const known = [v, prev, eL, eS, moved, funding].every(Number.isFinite);
    const ts = d.settledAt ?? d.cutoff, tx = d.settleTx;
    for (const t of inp.tiers) {
      const s = sums[t.i];
      // 1. the close moves what the wallet held through it
      if (s.tokens > 0 && known) {
        const side = t.isLong ? eL : eS;
        const won = v > prev ? t.isLong : v < prev ? !t.isLong : null;
        const pays = eL > eS ? t.isLong : eS > eL ? !t.isLong : null;
        const rp = side > 0 && moved > 0 && won != null ? (won ? 1 : -1) * t.c * moved / side : 0;
        const rf = side > 0 && funding > 0 && pays != null ? (pays ? -1 : 1) * t.c * funding / side : 0;
        let price = s.tokens * rp, fund = s.tokens * rf;
        // a tier can lose what it holds and no more (the contract caps each payment at what is left)
        if (s.tokens + price < 0) price = -s.tokens;
        if (s.tokens + price + fund < 0) fund = -(s.tokens + price);
        rows.push({ kind: "settle", day: d.day, tier: t.i, ts, tx, before: s.tokens, move: prev > 0 ? v / prev - 1 : 0, price, funding: fund });
        s.price += price; s.funding += fund; s.tokens += price + fund;
      }
      // 2. exits leave at this close, after its moves; what they paid is known once filled
      for (const reqDay of exits.get(key(d.day, t.i)) ?? []) {
        const net = inp.exitsNet.get(key(reqDay, t.i));
        if (net == null) continue;
        const n = Number(net), gross = inp.exempt ? n : (n * BPS) / (BPS - inp.feeBps);
        rows.push({ kind: "exited", day: d.day, tier: t.i, ts, tx, tokens: n, fee: gross - n });
        s.fees += gross - n; s.tokens = Math.max(0, s.tokens - gross);
      }
      // 3. entries join at this close's price, less the entry fee
      const gross = entries.get(key(d.day, t.i)) ?? 0n;
      if (gross > 0n) {
        const f = fee(gross), net = gross - f;
        rows.push({ kind: "entered", day: d.day, tier: t.i, ts, tx, tokens: Number(net), fee: Number(f) });
        s.fees += Number(f); s.tokens += Number(net); s.filled = true;
      }
    }
  }
  // fees kept from entries taken back before their close
  for (const e of inp.events) {
    const s = sums[e.tier];
    if (s && e.ev === "DepositCancelled" && e.amount && e.tokens) s.fees += Number(BigInt(e.amount) - BigInt(e.tokens));
  }
  return { rows, sums };
}
