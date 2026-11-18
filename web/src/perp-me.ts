// SharePot Perp — my activity (/me, or /me?address=0x… for any wallet: it is all public): every pool (one per stock) on
// one page — what a wallet put in and took out of each, what is still in each (positions, entries waiting for their
// close, exits waiting or ready to withdraw), each pool's result in its own stock token from those cash flows, the total
// in dollars at each pool's last close, and every request, booking and withdrawal with its transaction. Actions stay
// on the pool page.
import type { Address } from "viem";
import { POOLS, api, esc, exposures, fillOf, fmtDate, fmtTime, hex, levText, loadMine, loadState, netLev, pt, short, spct, tierCls, tierKey, tok, txLink, usd, type Mine, type Pool, type St } from "./perp-core";
import { getSession, mountShell, onHealth, onSession, oursKind } from "./perp-shell";

type Row = { sym: string; ev: string; ts: number; tx: string; day: number; tier: number; amount: string | null; shares: string | null; tokens: string | null };
type Act = { address: string; indexedAt: number | null; pools: Record<string, { deposited: string; withdrawn: string }>; rows: Row[] };
type DayInfo = { day: number; cutoff: number };
/** One pool's side of this wallet. */
type PoolView = { pool: Pool; st: St; mine: Mine; cutoffs: Map<number, number> };

const fromUrl = new URLSearchParams(location.search).get("address");
const viewing = (): string | null => (hex(fromUrl, 40) ? fromUrl : getSession()?.address ?? null);
let views: PoolView[] | null = null, act: Act | null = null, err = "", loading = false;

async function load() {
  const who = viewing();
  if (!who) { render(); return; }
  loading = true; render();
  try {
    const a = await api<Act>(`/activity/${who}`);
    const vs = await Promise.all(POOLS.map(async (pool) => {
      const [st, d] = await Promise.all([loadState(pool), api<{ days: DayInfo[] }>(`/days?s=${encodeURIComponent(pool.symbol)}`)]);
      const exitDays = a.rows.filter((r) => r.sym === pool.symbol && r.ev === "RedeemRequested").map((r) => r.day);
      return { pool, st, mine: await loadMine(st, who as Address, exitDays), cutoffs: new Map(d.days.map((x) => [x.day, x.cutoff])) };
    }));
    if (who !== viewing()) return;   // another wallet meanwhile
    act = a; views = vs; err = "";
  } catch (e: any) { err = String(e?.message ?? e); }
  loading = false; render();
}

const evName = (ev: string) => pt(`me.ev.${ev}`);
const signed = (raw: bigint) => `${raw >= 0n ? "+" : "−"}${tok(raw >= 0n ? raw : -raw)}`;

/** One pool's cash flows, in its own token. */
function flows(v: PoolView) {
  const f = act!.pools[v.pool.symbol] ?? { deposited: "0", withdrawn: "0" };
  const putIn = BigInt(f.deposited), tookOut = BigInt(f.withdrawn);
  const inPositions = v.mine.pos.reduce((s, p) => s + p.tokens, 0n);
  const pendingIn = v.mine.pos.reduce((s, p) => s + p.pending.reduce((a, q) => a + q.amount, 0n), 0n);
  const exiting = v.mine.exits.reduce((s, x) => s + x.tokens, 0n);
  const stillIn = inPositions + pendingIn + exiting;
  return { putIn, tookOut, inPositions, pendingIn, exiting, stillIn, result: tookOut + stillIn - putIn, px: Number(v.st.lastValue) / 1e8 };
}

function render() {
  const root = document.getElementById("perp")!;
  const who = viewing();
  const kind = who ? oursKind(who) : null;
  const head = `<section class="phero"><h1>${esc(pt("me.title"))}</h1>${who ? `<p>${esc(pt(fromUrl ? "me.viewing" : "me.yours", { addr: short(who) }))}</p>` : ""}${kind ? `<div class="card pwarn">${esc(pt(kind === "bot" ? "me.isBot" : "me.isTreasury"))}</div>` : ""}</section>`;
  if (!who) { root.innerHTML = head + `<div class="card"><p class="note">${esc(pt("me.connect"))}</p></div>`; return; }
  if (!act || !views) { root.innerHTML = head + `<div class="note">${err ? esc(pt("err", { err })) : "…"}</div>`; return; }
  // cash flows per pool (tokens of different stocks are never added), and the total in dollars at each pool's last close
  const used = views.map((v) => ({ v, f: flows(v) })).filter(({ f }) => f.putIn || f.tookOut || f.stillIn);
  const dollars = (raw: bigint, px: number) => (px ? usd((Number(raw) / 1e8) * px) : "—");
  const totalResult = used.reduce((s, { f }) => s + (Number(f.result) / 1e8) * f.px, 0), totalIn = used.reduce((s, { f }) => s + (Number(f.putIn) / 1e8) * f.px, 0);
  const summary = `<section class="card"><h2>${esc(pt("me.summary"))}</h2>${used.length ? `<div class="ptbl"><table class="tbl pmetbl"><thead><tr><th>${esc(pt("me.stock"))}</th><th>${esc(pt("me.putIn"))}</th><th>${esc(pt("me.tookOut"))}</th><th>${esc(pt("me.stillIn"))}</th><th>${esc(pt("me.result"))}</th></tr></thead><tbody>
    ${used.map(({ v, f }) => `<tr><td><b>${esc(v.pool.symbol)}</b></td><td>${tok(f.putIn)}</td><td>${tok(f.tookOut)}</td><td>${tok(f.stillIn)}${f.pendingIn || f.exiting ? `<div class="note">${esc(pt("me.stillInParts", { pos: tok(f.inPositions), pend: tok(f.pendingIn), exit: tok(f.exiting) }))}</div>` : ""}</td>
      <td><b class="${f.result > 0n ? "gain" : f.result < 0n ? "drop" : ""}">${signed(f.result)} ${esc(v.pool.tokenSymbol)}</b>${f.putIn > 0n ? ` <span class="note">(${esc(spct(Number(f.result) / Number(f.putIn)))})</span>` : ""}${f.px ? `<div class="note">≈ ${f.result < 0n ? "−" : ""}${dollars(f.result < 0n ? -f.result : f.result, f.px)}</div>` : ""}</td></tr>`).join("")}
    </tbody></table></div>
    <dl class="pkv"><dt>${esc(pt("me.total"))}</dt><dd><b class="${totalResult > 0.005 ? "gain" : totalResult < -0.005 ? "drop" : ""}">${totalResult < 0 ? "−" : "+"}${usd(Math.abs(totalResult))}</b>${totalIn > 0 ? ` <span class="note">(${esc(spct(totalResult / totalIn))})</span>` : ""}</dd></dl>` : `<div class="note">${esc(pt("me.noRows"))}</div>`}
    <p class="note">${esc(pt("me.resultNote"))}</p></section>`;
  // positions, pool by pool
  const posRows = views.map((v) => {
    const e = exposures(v.st.tiers), px = Number(v.st.lastValue) / 1e8, T = v.pool.tokenSymbol;
    const money = (raw: bigint) => `${tok(raw)} ${esc(T)}${px ? ` <span class="note">≈ ${usd((Number(raw) / 1e8) * px)}</span>` : ""}`;
    return v.st.tiers.map((t) => {
      const p = v.mine.pos[t.i], ex = v.mine.exits.filter((x) => x.tier === t.i);
      if (!p.shares && !p.pending.length && !ex.length) return "";
      const lines = [p.shares ? `${money(p.tokens)} · ${esc(pt("pos.now", { lev: levText(netLev(t, fillOf(t, e))) }))}` : "",
        ...p.pending.map((q) => esc(pt("pos.pendingIn", { time: fmtTime(q.cutoff), n: tok(q.amount), tok: T }))),
        ...ex.map((x) => x.ready ? esc(pt("pos.ready", { n: tok(x.tokens), tok: T })) : esc(pt("pos.pendingOut", { time: fmtTime(x.cutoff) })))].filter(Boolean);
      return `<div class="pposr"><b>${esc(v.pool.symbol)}</b> · <b class="tc-${tierCls(t)}">${esc(pt(tierKey(t)))}</b>${lines.map((l) => `<div>${l}</div>`).join("")}<a class="note" href="/?s=${esc(v.pool.symbol)}">${esc(pt("me.manageOne", { sym: v.pool.symbol }))}</a></div>`;
    }).join("");
  }).join("");
  const positions = `<section class="card"><h2>${esc(pt("me.now"))}</h2>${posRows || `<div class="note">${esc(pt("pos.none"))}</div>`}<p class="note"><a href="/">${esc(pt("me.manage"))}</a></p></section>`;
  const byPool = new Map(views.map((v) => [v.pool.symbol, v]));
  const tierName = (r: Row) => { const t = byPool.get(r.sym)?.st.tiers[r.tier]; return t ? pt(tierKey(t)) : `#${r.tier}`; };
  const rowAmount = (r: Row) => {
    const T = byPool.get(r.sym)?.pool.tokenSymbol ?? r.sym;
    if (r.ev === "DepositRequested" && r.amount) return `${tok(BigInt(r.amount))} ${esc(T)}`;
    if (r.ev === "Claimed" && r.tokens) return `${tok(BigInt(r.tokens))} ${esc(T)}`;
    return `<span class="note">${esc(pt("me.shares"))}</span>`;
  };
  const closeOf = (r: Row) => { const c = byPool.get(r.sym)?.cutoffs.get(r.day); return c ? esc(fmtDate(c)) : "—"; };
  const list = act.rows.length ? `<div class="ptbl"><table class="tbl"><thead><tr><th>${esc(pt("me.when"))}</th><th>${esc(pt("me.stock"))}</th><th>${esc(pt("me.what"))}</th><th>${esc(pt("me.tier"))}</th><th>${esc(pt("me.amount"))}</th><th>${esc(pt("me.close"))}</th><th></th></tr></thead><tbody>
    ${act.rows.map((r) => `<tr><td>${esc(fmtTime(r.ts))}</td><td><b>${esc(r.sym)}</b></td><td>${esc(evName(r.ev))}</td><td>${esc(tierName(r))}</td><td>${rowAmount(r)}</td><td>${closeOf(r)}</td><td>${txLink(r.tx)}</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="note">${esc(pt("me.noRows"))}</div>`;
  root.innerHTML = head + `<div class="pgrid pgrid-me">${summary}${positions}</div><section class="card"><h2>${esc(pt("me.history"))}</h2>${list}${act.indexedAt ? `<p class="note">${esc(pt("me.indexed", { time: fmtTime(act.indexedAt) }))}</p>` : ""}</section>`
    + (loading ? `<p class="note">…</p>` : "");
}

mountShell("me");
document.title = `SharePot Perp · ${pt("me.title")}`;
onSession(() => { if (!fromUrl) load(); });
onHealth(() => render());
render();
load();
setInterval(() => { if (document.visibilityState === "visible" && viewing()) load(); }, 60_000);
