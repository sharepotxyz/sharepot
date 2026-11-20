// SharePot Perp — my positions and my history (/me, or /me?address=0x… for any wallet: it is all public), every pool
// (one per stock, the retired ones too) on one page:
//   * My positions: one row per stock and tier the wallet is in — what it holds (and its leverage now), entries and
//     exits waiting for a close, exits ready to withdraw — and the result of that tier: price moves + funding − fees.
//   * History: the wallet's requests, take-backs and withdrawals, and what each close did to it: its share of the
//     price move and of the funding, its entries and exits filled.
// The per-day parts come from perp-ledger.ts (public settled days + the wallet's own events); the totals are the
// wallet's cash flows (in, out, still in), so they are exact and the parts' rounding lands in the price part.
// Actions stay on the pool page.
import type { Address } from "viem";
import { ALL_POOLS, api, esc, poolLabel, exposures, fillOf, fmtTime, hex, loadMine, loadState, nowLines, pt, short, spct, tierCls, tierKey, tok, txLink, usd, waitWhy, type Mine, type Pool, type St } from "./perp-core";
import { buildLedger, type LedgerDay, type LedgerEvent, type LedgerRow, type TierSum } from "./perp-ledger";
import { getSession, mountShell, onHealth, onSession, oursKind } from "./perp-shell";

type Row = LedgerEvent & { sym: string; pool: string };
type Act = { address: string; indexedAt: number | null; pools: Record<string, { symbol: string; retired: boolean; deposited: string; withdrawn: string }>; rows: Row[] };
/** One pool's side of this wallet. */
type PoolView = { pool: Pool; st: St; mine: Mine; days: LedgerDay[] };

const fromUrl = new URLSearchParams(location.search).get("address");
const viewing = (): string | null => (hex(fromUrl, 40) ? fromUrl : getSession()?.address ?? null);
let views: PoolView[] | null = null, act: Act | null = null, err = "", loading = false, showAll = false;
const SHOWN = 20;   // history rows before "show all"

async function load() {
  const who = viewing();
  if (!who) { render(); return; }
  loading = true; render();
  try {
    const a = await api<Act>(`/activity/${who}`);
    // every pool, the retired ones too: whoever is still in one sees it here, with the way out
    const vs = await Promise.all(ALL_POOLS.map(async (pool) => {
      const key = pool.address.toLowerCase();
      const [st, d] = await Promise.all([loadState(pool), api<{ days: LedgerDay[] }>(`/days?pool=${key}`)]);
      const exitDays = a.rows.filter((r) => r.pool === key && r.ev === "RedeemRequested").map((r) => r.day);
      return { pool, st, mine: await loadMine(st, who as Address, exitDays), days: d.days };
    }));
    if (who !== viewing()) return;   // another wallet meanwhile
    act = a; views = vs; err = "";
  } catch (e: any) { err = String(e?.message ?? e); }
  loading = false; render();
}

/** +1.23 / −1.23 (raw units as a float), coloured. */
const signedTok = (x: number) => { const r = BigInt(Math.round(Math.abs(x))); return `<b class="${r === 0n ? "" : x > 0 ? "gain" : "drop"}">${r === 0n ? "0" : `${x > 0 ? "+" : "−"}${tok(r)}`}</b>`; };
const plainTok = (x: number | bigint) => tok(typeof x === "bigint" ? x : BigInt(Math.round(x)));
/** The reason a request is still waiting, on its own line under it. */
const why = (s: string) => (s ? `<div class="note pwhy">${esc(s)}</div>` : "");

/** One pool's ledger and, per tier, the exact result from the wallet's cash flows. */
function ledgerOf(v: PoolView, rows: Row[]) {
  const key = v.pool.address.toLowerCase(), mine = rows.filter((r) => r.pool === key);
  // what each filled exit paid or will pay after its fee: its withdrawal once withdrawn, else what claim() pays now
  const exitsNet = new Map<string, bigint>();
  for (const r of mine) if (r.ev === "Claimed" && r.tokens && r.tokens !== "0") exitsNet.set(`${r.day}:${r.tier}`, BigInt(r.tokens));
  for (const x of v.mine.exits) if (x.ready) exitsNet.set(`${x.day}:${x.tier}`, x.tokens);
  const L = buildLedger({ tiers: v.st.tiers, feeBps: v.st.feeBps, exempt: oursKind(viewing() ?? "") === "treasury", days: v.days, events: mine, exitsNet });
  const result = v.st.tiers.map((t) => {
    const of = mine.filter((r) => r.tier === t.i), sum = (ev: string, f: "amount" | "tokens") => of.filter((r) => r.ev === ev).reduce((s, r) => s + Number(r[f] ?? 0), 0);
    const p = v.mine.pos[t.i], stillIn = Number(p.tokens) + p.pending.reduce((s, q) => s + Number(q.amount), 0) + v.mine.exits.filter((x) => x.tier === t.i).reduce((s, x) => s + Number(x.tokens), 0);
    const total = stillIn + sum("Claimed", "tokens") + sum("DepositCancelled", "tokens") - sum("DepositRequested", "amount");
    const s: TierSum = L.sums[t.i];
    return { total, funding: s.funding, fees: s.fees, price: total - s.funding + s.fees, filled: s.filled };
  });
  return { rows: L.rows, result };
}

function render() {
  const root = document.getElementById("perp")!;
  const who = viewing();
  const kind = who ? oursKind(who) : null;
  const head = `<section class="phero"><h1>${esc(pt("me.title"))}</h1>${who ? `<p>${esc(pt(fromUrl ? "me.viewing" : "me.yours", { addr: short(who) }))}</p>` : ""}${kind ? `<div class="card pwarn">${esc(pt(kind === "bot" ? "me.isBot" : "me.isTreasury"))}</div>` : ""}</section>`;
  if (!who) { root.innerHTML = head + `<div class="card"><p class="note">${esc(pt("me.connect"))}</p></div>`; return; }
  if (!act || !views) { root.innerHTML = head + `<div class="note">${err ? esc(pt("err", { err })) : "…"}</div>`; return; }
  const rows = act.rows.filter((r) => r.ev !== "EntryBooked" && !(r.ev === "Claimed" && (!r.tokens || r.tokens === "0")));   // bookings are the contract's bookkeeping
  const books = views.map((v) => ({ v, ...ledgerOf(v, act!.rows) }));
  const label = (v: PoolView, tier: number) => { const t = v.st.tiers[tier]; return `${esc(poolLabel(v.pool))} · <b class="tc-${t ? tierCls(t) : ""}">${esc(t ? pt(tierKey(t)) : `#${tier}`)}</b>`; };
  // a retired pool's link opens that pool by address: there its holders exit and withdraw
  const href = (p: Pool) => (p.retired ? `/?pool=${esc(p.address)}` : `/?s=${esc(p.symbol)}`);

  // ---- my positions: one row per stock and tier; every state it is in, one line each
  const posRows = books.flatMap(({ v, result }) => {
    const e = exposures(v.st.tiers), px = Number(v.st.lastValue) / 1e8, T = esc(v.pool.tokenSymbol);
    const money = (raw: bigint) => `${tok(raw)} ${T}${px ? ` <span class="note">≈ ${usd((Number(raw) / 1e8) * px)}</span>` : ""}`;
    return v.st.tiers.map((t) => {
      const p = v.mine.pos[t.i], ex = v.mine.exits.filter((x) => x.tier === t.i);
      if (!p.shares && !p.pending.length && !ex.length) return "";
      const now = p.shares ? nowLines(t, fillOf(t, e), v.pool.symbol, v.pool.tokenSymbol, p.tokens, px) : [];   // partly matched: effective part, rest, together
      const lines = [
        p.shares ? `<b>${esc(pt("me.hold"))}</b> ${money(p.tokens)}${now.length === 1 ? ` <span class="note">· ${esc(now[0])}</span>` : ""}` : "",
        ...(now.length > 1 ? now.map((l) => `<span class="note">${esc(l)}</span>`) : []),
        ...p.pending.map((q) => `<b>${esc(pt("me.waitIn"))}</b> ${tok(q.amount)} ${T} <span class="note">· ${esc(fmtTime(q.cutoff))}</span>${why(waitWhy(q.ep, "in", v.st.now, v.st.dispute))}`),
        ...ex.map((x) => x.ready ? `<b>${esc(pt("me.ready"))}</b> ${tok(x.tokens)} ${T} <a href="${href(v.pool)}">${esc(pt("me.withdraw"))}</a>`
          : `<b>${esc(pt("me.waitOut"))}</b> ${esc(pt("me.about"))} ${tok(x.tokens)} ${T} <span class="note">· ${esc(fmtTime(x.cutoff))}</span>${why(waitWhy(x.ep, "out", v.st.now, v.st.dispute))}`)].filter(Boolean);
      const r = result[t.i];
      const pnl = !r.filled ? `<span class="note">${esc(pt("me.notYet"))}</span>`
        : `${signedTok(r.total)} ${T}${px ? ` <span class="note">≈ ${r.total < 0 ? "−" : ""}${usd((Math.abs(r.total) / 1e8) * px)}</span>` : ""}
          <div class="note pmeparts">${pt("me.parts", { p: signedTok(r.price), f: signedTok(r.funding), fee: signedTok(-r.fees) })}</div>`;
      return `<tr><td class="nw"><a class="pmepos" href="${href(v.pool)}">${label(v, t.i)}</a></td><td>${lines.map((l) => `<div>${l}</div>`).join("")}</td><td${r.filled ? ` data-l="${esc(pt("me.colPnl"))}"` : ' class="nopnl"'}>${pnl}</td></tr>`;
    }).filter(Boolean);
  });
  const positions = `<section class="card"><h2>${esc(pt("me.pos"))}</h2>${posRows.length ? `<div class="ptbl"><table class="tbl pmetbl"><thead><tr><th>${esc(pt("me.colPos"))}</th><th>${esc(pt("me.colNow"))}</th><th>${esc(pt("me.colPnl"))}</th></tr></thead><tbody>${posRows.join("")}</tbody></table></div>
    <p class="note">${esc(pt("me.pnlNote"))}</p>` : `<p class="note">${esc(pt("me.none"))}</p>`}</section>`;

  // ---- history: the wallet's own requests and what each close did to it, newest first
  type H = { ts: number; order: number; v: PoolView; tier: number; what: string; detail: string; tx: string | null };
  const byPool = new Map(views.map((v) => [v.pool.address.toLowerCase(), v]));
  const hist: H[] = [];
  for (const r of rows) {
    const v = byPool.get(r.pool); if (!v) continue;
    const T = esc(v.pool.tokenSymbol), n = (x: string | null) => tok(BigInt(x ?? "0"));
    const detail = r.ev === "DepositRequested" ? `${n(r.amount)} ${T}`
      : r.ev === "DepositCancelled" ? pt("me.d.cancel", { n: `${n(r.tokens)} ${T}`, fee: plainTok(BigInt(r.amount ?? "0") - BigInt(r.tokens ?? "0")) })
      : r.ev === "RedeemRequested" ? esc(pt("me.d.exitAsk"))
      : r.ev === "Claimed" ? pt("me.d.claim", { n: `${n(r.tokens)} ${T}` }) : "";
    hist.push({ ts: r.ts, order: 0, v, tier: r.tier, what: esc(pt(`me.ev.${r.ev}`)), detail, tx: r.tx });
  }
  for (const { v, rows: lr } of books) for (const x of lr as LedgerRow[]) {
    const T = esc(v.pool.tokenSymbol);
    // at one close: its moves first, then the exits, then the entries (newest first lists them the other way round)
    if (x.kind === "settle") hist.push({ ts: x.ts, order: 1, v, tier: x.tier, what: esc(pt("me.ev.settle")),
      detail: `${pt("me.d.close", { sym: esc(v.pool.symbol), move: `<b class="${x.move > 0 ? "gain" : x.move < 0 ? "drop" : ""}">${esc(spct(x.move))}</b>` })} · ${pt("me.d.parts", { p: signedTok(x.price), f: signedTok(x.funding) })} ${T}`, tx: x.tx });
    else hist.push({ ts: x.ts, order: x.kind === "exited" ? 2 : 3, v, tier: x.tier, what: esc(pt(`me.ev.${x.kind}`)),
      detail: pt(x.kind === "entered" ? "me.d.entered" : "me.d.exited", { n: `${plainTok(x.tokens)} ${T}`, fee: plainTok(x.fee) }), tx: x.tx });
  }
  hist.sort((a, b) => b.ts - a.ts || b.order - a.order);
  const shown = showAll ? hist : hist.slice(0, SHOWN);
  const history = `<section class="card"><h2>${esc(pt("me.log"))}</h2>${hist.length ? `<div class="ptbl"><table class="tbl pmetbl"><thead><tr><th>${esc(pt("me.when"))}</th><th>${esc(pt("me.colPos"))}</th><th>${esc(pt("me.what"))}</th><th>${esc(pt("me.colDetail"))}</th><th></th></tr></thead><tbody>
    ${shown.map((h) => `<tr><td class="nw when">${esc(fmtTime(h.ts))}</td><td class="nw">${label(h.v, h.tier)}</td><td class="nw">${h.what}</td><td>${h.detail}</td><td>${h.tx ? txLink(h.tx) : ""}</td></tr>`).join("")}
    </tbody></table></div>${hist.length > shown.length ? `<p><button class="ghost" id="pmemore">${esc(pt("me.more", { n: hist.length }))}</button></p>` : ""}` : `<p class="note">${esc(pt("me.noRows"))}</p>`}
    ${act.indexedAt ? `<p class="note">${esc(pt("me.indexed", { time: fmtTime(act.indexedAt) }))}</p>` : ""}</section>`;

  root.innerHTML = head + `<div class="pme">${positions}${history}</div>` + (loading ? `<p class="note">…</p>` : "");
  const more = document.getElementById("pmemore"); if (more) more.onclick = () => { showAll = true; render(); };
}

mountShell("me");
document.title = `SharePot Perp · ${pt("me.title")}`;
onSession(() => { if (!fromUrl) load(); });
onHealth(() => render());
render();
load();
setInterval(() => { if (document.visibilityState === "visible" && viewing()) load(); }, 60_000);
