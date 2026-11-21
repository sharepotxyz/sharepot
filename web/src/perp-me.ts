// SharePot Perp — my positions and my history (/me, or /me?address=0x… for any wallet: it is all public), every pool
// (one per stock, the retired ones too) on one page:
//   * My positions: one row per stock and tier the wallet is in — what it holds (and its leverage now), entries and
//     exits waiting for a close, exits ready to withdraw — and the result of that tier: price moves + funding − fees.
//   * History: the wallet's requests, take-backs and withdrawals, and what each close did to it: its share of the
//     price move and of the funding, its entries and exits filled. A search box (any word the row shows, a date as
//     11/18, a tx hash) and chips (stock; my requests / fills / daily closes) narrow it down.
// The per-day parts come from perp-ledger.ts (public settled days + the wallet's own events); the totals are the
// wallet's cash flows (in, out, still in), so they are exact and the parts' rounding lands in the price part.
// Actions stay on the pool page.
import type { Address } from "viem";
import { ALL_POOLS, api, esc, poolLabel, exposures, fillOf, fmtTime, hex, loadMine, loadState, pt, short, spct, tierCls, tierKey, tok, txLink, usd, waitWhy, type Mine, type Pool, type St } from "./perp-core";
import { buildLedger, type LedgerDay, type LedgerEvent, type LedgerRow, type TierSum } from "./perp-ledger";
import { getSession, mountShell, onHealth, onSession, oursKind } from "./perp-shell";
import { effBlock } from "./perp-viz";

type Row = LedgerEvent & { sym: string; pool: string };
type Act = { address: string; indexedAt: number | null; pools: Record<string, { symbol: string; retired: boolean; deposited: string; withdrawn: string }>; rows: Row[] };
/** One pool's side of this wallet. */
type PoolView = { pool: Pool; st: St; mine: Mine; days: LedgerDay[] };

const fromUrl = new URLSearchParams(location.search).get("address");
const viewing = (): string | null => (hex(fromUrl, 40) ? fromUrl : getSession()?.address ?? null);
let views: PoolView[] | null = null, act: Act | null = null, err = "", loading = false, showAll = false;
const SHOWN = 20;   // history rows before "show all"

// ---- the history's search box and chips: what they hold lives across the minute's reloads
/** Which chip a history row falls under: the wallet's own requests, the fills at a close, or a close's moves. */
type Cat = "mine" | "fill" | "close";
const CATS: Cat[] = ["mine", "fill", "close"];
/** One history row; `hay` is its searchable text (what it shows, its date as 11/18 and 2026-11-18, its tx hash). */
type H = { ts: number; order: number; v: PoolView; tier: number; what: string; detail: string; tx: string | null; cat: Cat; hay: string };
let hist: H[] = [], q = "", fPool = "", fCat: Cat | "" = "";
/** Lower case, the minus sign as "-", one space: so "-1.2" finds "−1.2". */
const norm = (s: string) => s.toLowerCase().replace(/−/g, "-").replace(/\s+/g, " ").trim();
/** The text of a bit of this page's markup. */
const plain = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e] as string));
const dateKeys = (ts: number) => { const d = new Date(ts * 1000), m = d.getMonth() + 1, dd = d.getDate(), p = (x: number) => String(x).padStart(2, "0"); return `${m}/${dd} ${p(m)}/${p(dd)} ${d.getFullYear()}-${p(m)}-${p(dd)}`; };
const poolKey = (v: PoolView) => v.pool.address.toLowerCase();
const terms = () => norm(q).split(" ").filter(Boolean);
/** Does the row pass the box and the chips (all but one chip row, to count what that row's chips would show)? */
const passes = (h: H, t: string[], skip?: "pool" | "cat") =>
  (skip === "pool" || !fPool || poolKey(h.v) === fPool) && (skip === "cat" || !fCat || h.cat === fCat) && t.every((w) => h.hay.includes(w));
const label = (v: PoolView, tier: number) => { const t = v.st.tiers[tier]; return `${esc(poolLabel(v.pool))} · <b class="tc-${t ? tierCls(t) : ""}">${esc(t ? pt(tierKey(t)) : `#${tier}`)}</b>`; };

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
  const head = `<section class="phero" id="pmehead"><h1>${esc(pt("me.title"))}</h1>${who ? `<p>${esc(pt(fromUrl ? "me.viewing" : "me.yours", { addr: short(who) }))}</p>` : ""}${kind ? `<div class="card pwarn">${esc(pt(kind === "bot" ? "me.isBot" : "me.isTreasury"))}</div>` : ""}</section>`;
  if (!who) { root.innerHTML = head + `<div class="card"><p class="note">${esc(pt("me.connect"))}</p></div>`; return; }
  if (!act || !views) { root.innerHTML = head + `<div class="note">${err ? esc(pt("err", { err })) : "…"}</div>`; return; }
  const rows = act.rows.filter((r) => r.ev !== "EntryBooked" && !(r.ev === "Claimed" && (!r.tokens || r.tokens === "0")));   // bookings are the contract's bookkeeping
  const books = views.map((v) => ({ v, ...ledgerOf(v, act!.rows) }));
  // a retired pool's link opens that pool by address: there its holders exit and withdraw
  const href = (p: Pool) => (p.retired ? `/?pool=${esc(p.address)}` : `/?s=${esc(p.symbol)}`);

  // ---- my positions: one row per stock and tier; every state it is in, one line each
  const posRows = books.flatMap(({ v, result }) => {
    const e = exposures(v.st.tiers), px = Number(v.st.lastValue) / 1e8, T = esc(v.pool.tokenSymbol);
    const money = (raw: bigint) => `${tok(raw)} ${T}${px ? ` <span class="note">≈ ${usd((Number(raw) / 1e8) * px)}</span>` : ""}`;
    return v.st.tiers.map((t) => {
      const p = v.mine.pos[t.i], ex = v.mine.exits.filter((x) => x.tier === t.i);
      if (!p.shares && !p.pending.length && !ex.length) return "";
      const lines = [
        p.shares ? `<b>${esc(pt("me.hold"))}</b> ${money(p.tokens)}${effBlock(t, fillOf(t, e), p.tokens, px, v.pool.symbol, v.pool.tokenSymbol)}` : "",
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
  const positions = `<section class="card" id="pmepos"><h2>${esc(pt("me.pos"))}</h2>${posRows.length ? `<div class="ptbl"><table class="tbl pmetbl"><thead><tr><th>${esc(pt("me.colPos"))}</th><th>${esc(pt("me.colNow"))}</th><th>${esc(pt("me.colPnl"))}</th></tr></thead><tbody>${posRows.join("")}</tbody></table></div>
    <p class="note">${esc(pt("me.pnlNote"))}</p>` : `<p class="note">${esc(pt("me.none"))}</p>`}</section>`;

  // ---- history: the wallet's own requests and what each close did to it, newest first
  const byPool = new Map(views.map((v) => [v.pool.address.toLowerCase(), v]));
  hist = [];
  const add = (h: Omit<H, "hay">) => hist.push({ ...h, hay: norm([fmtTime(h.ts), dateKeys(h.ts), h.v.pool.tokenSymbol, plain(label(h.v, h.tier)), plain(h.what), plain(h.detail), h.tx ?? ""].join(" ")) });
  for (const r of rows) {
    const v = byPool.get(r.pool); if (!v) continue;
    const T = esc(v.pool.tokenSymbol), n = (x: string | null) => tok(BigInt(x ?? "0"));
    const detail = r.ev === "DepositRequested" ? `${n(r.amount)} ${T}`
      : r.ev === "DepositCancelled" ? pt("me.d.cancel", { n: `${n(r.tokens)} ${T}`, fee: plainTok(BigInt(r.amount ?? "0") - BigInt(r.tokens ?? "0")) })
      : r.ev === "RedeemRequested" ? esc(pt("me.d.exitAsk"))
      : r.ev === "Claimed" ? pt("me.d.claim", { n: `${n(r.tokens)} ${T}` }) : "";
    add({ ts: r.ts, order: 0, v, tier: r.tier, what: esc(pt(`me.ev.${r.ev}`)), detail, tx: r.tx, cat: "mine" });
  }
  for (const { v, rows: lr } of books) for (const x of lr as LedgerRow[]) {
    const T = esc(v.pool.tokenSymbol);
    // at one close: its moves first, then the exits, then the entries (newest first lists them the other way round)
    if (x.kind === "settle") add({ ts: x.ts, order: 1, v, tier: x.tier, what: esc(pt("me.ev.settle")),
      detail: `${pt("me.d.close", { sym: esc(v.pool.symbol), move: `<b class="${x.move > 0 ? "gain" : x.move < 0 ? "drop" : ""}">${esc(spct(x.move))}</b>` })} · ${pt("me.d.parts", { p: signedTok(x.price), f: signedTok(x.funding) })} ${T}`, tx: x.tx, cat: "close" });
    else add({ ts: x.ts, order: x.kind === "exited" ? 2 : 3, v, tier: x.tier, what: esc(pt(`me.ev.${x.kind}`)),
      detail: pt(x.kind === "entered" ? "me.d.entered" : "me.d.exited", { n: `${plainTok(x.tokens)} ${T}`, fee: plainTok(x.fee) }), tx: x.tx, cat: "fill" });
  }
  hist.sort((a, b) => b.ts - a.ts || b.order - a.order);
  if (fPool && !hist.some((h) => poolKey(h.v) === fPool)) fPool = "";   // a stock this wallet has no rows in
  const idx = `<p class="note" id="pmeidx">${act.indexedAt ? esc(pt("me.indexed", { time: fmtTime(act.indexedAt) })) : ""}</p>`;
  const bar = `<div class="pmefbar"><label class="pmeq"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`
    + `<input type="search" id="pmeq" value="${esc(q)}" placeholder="${esc(pt("me.f.q"))}" aria-label="${esc(pt("me.f.q"))}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></label>`
    + `<div id="pmechips">${chipsHtml()}</div></div>`;
  const history = `<section class="card" id="pmehist"><h2>${esc(pt("me.log"))}</h2>${hist.length ? `${bar}<div id="pmehbody">${histBody()}</div>` : `<p class="note">${esc(pt("me.noRows"))}</p>`}${idx}</section>`;
  const busy = `<p class="note" id="pmeload"${loading ? "" : " hidden"}>…</p>`;

  // a reload (every minute) leaves the search box itself in place, so its focus, its caret, a word half typed with
  // an input method and the phone's keyboard survive it: only what is around the box is swapped
  if (hist.length && document.getElementById("pmeq") && document.getElementById("pmehbody")) {
    for (const [id, html] of [["pmehead", head], ["pmepos", positions], ["pmeidx", idx], ["pmeload", busy]]) { const el = document.getElementById(id); if (el) el.outerHTML = html; }
    refreshHist();
    return;
  }
  root.innerHTML = head + `<div class="pme">${positions}${history}</div>` + busy;
  bindHist();
}

/** The chips: one row per stock (when there are two or more), one per kind of row; each says how many rows it would show. */
function chipsHtml() {
  const t = terms();
  const chip = (attr: "fpool" | "fcat", val: string, on: boolean, text: string, n: number, title = "") =>
    `<button type="button" class="pfchip${on ? " on" : ""}${n ? "" : " zero"}" data-${attr}="${esc(val)}" aria-pressed="${on}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)} <span>${n}</span></button>`;
  const pools = ALL_POOLS.filter((p) => hist.some((h) => h.v.pool.address === p.address));
  const forPool = hist.filter((h) => passes(h, t, "pool")), forCat = hist.filter((h) => passes(h, t, "cat"));
  const poolRow = pools.length < 2 ? "" : `<div class="pfrow">${chip("fpool", "", !fPool, pt("me.f.allPools"), forPool.length)}${pools.map((p) => {
    const k = p.address.toLowerCase();
    return chip("fpool", k, fPool === k, poolLabel(p), forPool.filter((h) => poolKey(h.v) === k).length);
  }).join("")}</div>`;
  const catRow = `<div class="pfrow">${chip("fcat", "", !fCat, pt("me.f.allCats"), forCat.length)}${CATS.map((c) =>
    chip("fcat", c, fCat === c, pt(`me.f.${c}`), forCat.filter((h) => h.cat === c).length, pt(`me.f.${c}.d`))).join("")}</div>`;
  return poolRow + catRow;
}

/** The rows that pass the box and the chips, newest first; the first 20 until "show all". */
function histBody() {
  const t = terms(), hits = hist.filter((h) => passes(h, t)), shown = showAll ? hits : hits.slice(0, SHOWN);
  const filtered = hits.length !== hist.length || !!fPool || !!fCat || t.length > 0;
  const clear = `<button type="button" class="ghost pfclear" data-act="clear">${esc(pt("me.f.clear"))}</button>`;
  const count = `<p class="note pfcount">${esc(filtered ? pt("me.f.count", { n: hits.length, all: hist.length }) : pt("me.f.total", { all: hist.length }))}${filtered ? ` ${clear}` : ""}</p>`;
  if (!hits.length) return count + `<p class="note">${esc(pt("me.f.none"))}</p>`;
  return count + `<div class="ptbl"><table class="tbl pmetbl"><thead><tr><th>${esc(pt("me.when"))}</th><th>${esc(pt("me.colPos"))}</th><th>${esc(pt("me.what"))}</th><th>${esc(pt("me.colDetail"))}</th><th></th></tr></thead><tbody>
    ${shown.map((h) => `<tr><td class="nw when">${esc(fmtTime(h.ts))}</td><td class="nw">${label(h.v, h.tier)}</td><td class="nw">${h.what}</td><td>${h.detail}</td><td>${h.tx ? txLink(h.tx) : ""}</td></tr>`).join("")}
    </tbody></table></div>${hits.length > shown.length ? `<p><button type="button" class="ghost" data-act="more">${esc(pt("me.more", { n: hits.length }))}</button></p>` : ""}`;
}

function refreshHist() {
  const chips = document.getElementById("pmechips"), body = document.getElementById("pmehbody");
  if (chips) chips.innerHTML = chipsHtml();
  if (body) body.innerHTML = histBody();
}

/** Wires the box and (by delegation, so a refresh needs no rewiring) the chips, "show all" and "clear". */
function bindHist() {
  const sec = document.getElementById("pmehist"), box = document.getElementById("pmeq") as HTMLInputElement | null;
  if (!sec || !box) return;
  box.oninput = () => { q = box.value; refreshHist(); };
  box.onkeydown = (e) => { if (e.key === "Escape" && box.value) { e.preventDefault(); box.value = q = ""; refreshHist(); } };
  sec.onclick = (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button");
    if (!b || !sec.contains(b)) return;
    if (b.dataset.fpool != null) fPool = b.dataset.fpool;
    else if (b.dataset.fcat != null) fCat = b.dataset.fcat as Cat | "";
    else if (b.dataset.act === "more") showAll = true;
    else if (b.dataset.act === "clear") { q = fPool = fCat = ""; box.value = ""; }
    else return;
    refreshHist();
  };
}

mountShell("me");
document.title = `SharePot Perp · ${pt("me.title")}`;
onSession(() => { if (!fromUrl) load(); });
onHealth(() => render());
render();
load();
setInterval(() => { if (document.visibilityState === "visible" && viewing()) load(); }, 60_000);
