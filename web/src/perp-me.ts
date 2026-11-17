// SharePot Perp — my activity (/me, or /me?address=0x… for any wallet: it is all public): what a wallet put in, what it
// took out, what is still in the pool (positions, entries waiting for their close, exits waiting or ready to withdraw),
// the result in tokens and dollars from those cash flows, and every request, booking and withdrawal with its
// transaction. Actions stay on the pool page.
import type { Address } from "viem";
import { PERP } from "./config";
import { api, esc, exposures, fillOf, fmtDate, fmtTime, hex, levText, loadMine, loadState, netLev, pt, short, spct, tierCls, tierKey, tok, txLink, usd, type Mine, type St } from "./perp-core";
import { getSession, mountShell, onHealth, onSession, oursKind } from "./perp-shell";

type Row = { ev: string; ts: number; tx: string; day: number; tier: number; amount: string | null; shares: string | null; tokens: string | null };
type Act = { address: string; indexedAt: number | null; deposited: string; withdrawn: string; rows: Row[] };
type DayInfo = { day: number; cutoff: number };

const fromUrl = new URLSearchParams(location.search).get("address");
const viewing = (): string | null => (hex(fromUrl, 40) ? fromUrl : getSession()?.address ?? null);
let st: St | null = null, mine: Mine | null = null, act: Act | null = null, cutoffs = new Map<number, number>(), err = "", loading = false;

async function load() {
  const who = viewing();
  if (!who) { render(); return; }
  loading = true; render();
  try {
    const [a, s, d] = await Promise.all([api<Act>(`/activity/${who}`), loadState(), api<{ days: DayInfo[] }>("/days")]);
    act = a; st = s; cutoffs = new Map(d.days.map((x) => [x.day, x.cutoff]));
    const exitDays = a.rows.filter((r) => r.ev === "RedeemRequested").map((r) => r.day);
    mine = await loadMine(s, who as Address, exitDays);
    err = "";
  } catch (e: any) { err = String(e?.message ?? e); }
  loading = false; render();
}

const evName = (ev: string) => pt(`me.ev.${ev}`);
function rowAmount(r: Row) {
  if (r.ev === "DepositRequested" && r.amount) return `${tok(BigInt(r.amount))} ${esc(PERP.tokenSymbol)}`;
  if (r.ev === "Claimed" && r.tokens) return `${tok(BigInt(r.tokens))} ${esc(PERP.tokenSymbol)}`;
  return `<span class="note">${esc(pt("me.shares"))}</span>`;
}

function render() {
  const root = document.getElementById("perp")!;
  const who = viewing();
  const kind = who ? oursKind(who) : null;
  const head = `<section class="phero"><h1>${esc(pt("me.title"))}</h1>${who ? `<p>${esc(pt(fromUrl ? "me.viewing" : "me.yours", { addr: short(who) }))}</p>` : ""}${kind ? `<div class="card pwarn">${esc(pt(kind === "bot" ? "me.isBot" : "me.isTreasury"))}</div>` : ""}</section>`;
  if (!who) { root.innerHTML = head + `<div class="card"><p class="note">${esc(pt("me.connect"))}</p></div>`; return; }
  if (!act || !st || !mine) { root.innerHTML = head + `<div class="note">${err ? esc(pt("err", { err })) : "…"}</div>`; return; }
  const px = Number(st.lastValue) / 1e8;
  // cash flows: what went in, what came out, and what is still in the pool in any form
  const putIn = BigInt(act.deposited), tookOut = BigInt(act.withdrawn);
  const inPositions = mine.pos.reduce((s, p) => s + p.tokens, 0n);
  const pendingIn = mine.pos.reduce((s, p) => s + p.pending.reduce((a, q) => a + q.amount, 0n), 0n);
  const exiting = mine.exits.reduce((s, x) => s + x.tokens, 0n);
  const stillIn = inPositions + pendingIn + exiting;
  const result = tookOut + stillIn - putIn;
  const money = (raw: bigint) => `${tok(raw)} ${esc(PERP.tokenSymbol)}${px ? ` <span class="note">≈ ${usd((Number(raw) / 1e8) * px)}</span>` : ""}`;
  const summary = `<section class="card"><h2>${esc(pt("me.summary"))}</h2><dl class="pkv">
    <dt>${esc(pt("me.putIn"))}</dt><dd>${money(putIn)}</dd>
    <dt>${esc(pt("me.tookOut"))}</dt><dd>${money(tookOut)}</dd>
    <dt>${esc(pt("me.stillIn"))}</dt><dd>${money(stillIn)}${pendingIn || exiting ? ` <span class="note">${esc(pt("me.stillInParts", { pos: tok(inPositions), pend: tok(pendingIn), exit: tok(exiting) }))}</span>` : ""}</dd>
    <dt>${esc(pt("me.result"))}</dt><dd><b class="${result > 0n ? "gain" : result < 0n ? "drop" : ""}">${result >= 0n ? "+" : "−"}${tok(result >= 0n ? result : -result)} ${esc(PERP.tokenSymbol)}</b>${putIn > 0n ? ` <span class="note">(${esc(spct(Number(result) / Number(putIn)))})</span>` : ""}</dd>
  </dl><p class="note">${esc(pt("me.resultNote"))}</p></section>`;
  const e = exposures(st.tiers);
  const posRows = st.tiers.map((t) => {
    const p = mine!.pos[t.i], ex = mine!.exits.filter((x) => x.tier === t.i);
    if (!p.shares && !p.pending.length && !ex.length) return "";
    const lines = [p.shares ? `${money(p.tokens)} · ${esc(pt("pos.now", { lev: levText(netLev(t, fillOf(t, e))) }))}` : "",
      ...p.pending.map((q) => esc(pt("pos.pendingIn", { time: fmtTime(q.cutoff), n: tok(q.amount), tok: PERP.tokenSymbol }))),
      ...ex.map((x) => x.ready ? esc(pt("pos.ready", { n: tok(x.tokens), tok: PERP.tokenSymbol })) : esc(pt("pos.pendingOut", { time: fmtTime(x.cutoff) })))].filter(Boolean);
    return `<div class="pposr"><b class="tc-${tierCls(t)}">${esc(pt(tierKey(t)))}</b>${lines.map((l) => `<div>${l}</div>`).join("")}</div>`;
  }).join("");
  const positions = `<section class="card"><h2>${esc(pt("me.now"))}</h2>${posRows || `<div class="note">${esc(pt("pos.none"))}</div>`}<p class="note"><a href="/">${esc(pt("me.manage"))}</a></p></section>`;
  const tierName = (i: number) => (st!.tiers[i] ? pt(tierKey(st!.tiers[i])) : `#${i}`);
  const list = act.rows.length ? `<div class="ptbl"><table class="tbl"><thead><tr><th>${esc(pt("me.when"))}</th><th>${esc(pt("me.what"))}</th><th>${esc(pt("me.tier"))}</th><th>${esc(pt("me.amount"))}</th><th>${esc(pt("me.close"))}</th><th></th></tr></thead><tbody>
    ${act.rows.map((r) => `<tr><td>${esc(fmtTime(r.ts))}</td><td>${esc(evName(r.ev))}</td><td>${esc(tierName(r.tier))}</td><td>${rowAmount(r)}</td><td>${cutoffs.has(r.day) ? esc(fmtDate(cutoffs.get(r.day)!)) : "—"}</td><td>${txLink(r.tx)}</td></tr>`).join("")}
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
