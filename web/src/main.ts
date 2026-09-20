// Home: events (one stock × one session) as compact cards, with stock tabs, status / issuer filters, sorting and search.
// Detail — the four ranges, odds, pools — lives on the event page only.
import { fetchMarkets } from "./chain";
import { STATUS_LABEL, buildEvents, type EventView } from "./events";
import { STOCK_META, STOCK_NAMES, STOCK_ORDER, bucketLabel, bucketName, fmtMove, fmtUsd, issuerOf, loadPrices, loadStocks, question, tokenSymbol } from "./stocks";
import { t, tn } from "./i18n";
import { bucketColor, esc, fmtTs, mountTopbar, renderCatnav, tickerBadge, timeLeft, trackStocks } from "./ui";

const qs = new URLSearchParams(location.search);
const state = { cat: qs.get("cat") ?? "all", stock: qs.get("stock") ?? "all", issuer: qs.get("issuer") ?? "all", status: qs.get("status") ?? "open", sort: qs.get("sort") ?? "closing", q: qs.get("q") ?? "" };
const DEFAULTS: Record<string, string> = { cat: "all", stock: "all", issuer: "all", status: "open", sort: "closing", q: "" };
let events: EventView[] = [];
const grid = document.getElementById("events")!, filters = document.getElementById("filters")!, summary = document.getElementById("summary")!;
// the tabs under the top bar switch category; a stock within it is picked in the filter row
mountTopbar({ active: state.cat, q: state.q, onSearch: (q) => { state.q = q; update(); }, onStock: (c) => { state.cat = c; state.stock = "all"; update(); } });

const label = (ev: EventView, i: number) => bucketName(ev.markets[0], i) || bucketLabel(ev.markets[0], i);
function card(ev: EventView) {
  const m0 = ev.markets[0], backed = ev.dist.some((x) => x > 0);
  const bar = backed ? ev.dist.map((f, i) => `<i style="width:${(f * 100).toFixed(1)}%;background:${bucketColor(m0, i)}"></i>`).join("") : `<i class="empty"></i>`;
  let lead: string;
  if (ev.outcome != null) lead = `${t("home.result", { label: `<b>${esc(label(ev, ev.outcome))}</b>` })}${ev.moveValue != null ? ` · ${fmtMove(ev.moveValue)}` : ""}`;
  else if (ev.proposed != null) lead = `${t("home.proposed", { label: `<b>${esc(label(ev, ev.proposed))}</b>` })}${ev.moveValue != null ? ` · ${fmtMove(ev.moveValue)}` : ""}`;
  else if (backed) { const i = ev.dist.indexOf(Math.max(...ev.dist)); lead = t("home.mostBacked", { label: `<b>${esc(label(ev, i))}</b>`, pct: Math.round(ev.dist[i] * 100) }); }
  else lead = `<span class="note">${t("home.noBets")}</span>`;
  const when = ev.status === "open" ? t("home.left", { t: timeLeft(ev.closeTs) }) : ev.status === "trading" ? t("home.resultAt", { ts: fmtTs(ev.resolveAfterTs) }) : "";
  return `<a class="ev" href="/market.html?e=${encodeURIComponent(ev.key)}">
    <div class="ev-top">${tickerBadge(ev.symbol)}<div><div class="ev-q">${esc(question(m0))}</div><div class="ev-s">${esc(ev.name)} · ${ev.markets.map((m) => esc(tokenSymbol(m))).join(" · ")}</div></div></div>
    <div class="dist" title="${esc(t("home.distTitle"))}">${bar}</div>
    <div class="ev-lead">${lead}</div>
    <div class="ev-foot"><span class="pill ${ev.status}">${ev.status === "open" ? t("status.openShort") : STATUS_LABEL[ev.status]}</span>${ev.potUsd != null ? `<span>${t("home.pot", { usd: fmtUsd(ev.potUsd) })}</span>` : ""}<span>${tn("bettors", ev.bettors)}</span><span class="ev-when">${esc(when)}</span></div>
  </a>`;
}
function renderFilters() {
  const issuers = [...new Set(events.flatMap((e) => e.markets.map((m) => issuerOf(m))).filter(Boolean))].sort();
  const seg = [["open", t("status.open")], ["live", t("filter.live")], ["resolved", t("status.resolved")], ["all", t("filter.all")]];
  // stocks of the current category that have a market (today's memes first: the list is in the API's order)
  const inCat = STOCK_ORDER.filter((sy) => (state.cat === "all" || (STOCK_META[sy]?.category ?? "stocks") === state.cat) && events.some((e) => e.symbol === sy));
  const stockLabel = (sy: string) => (STOCK_NAMES[sy] && STOCK_NAMES[sy] !== sy ? `${sy} · ${STOCK_NAMES[sy]}` : sy);
  filters.innerHTML = `<div class="seg">${seg.map(([k, l]) => `<button data-status="${k}" class="${state.status === k ? "on" : ""}">${l}</button>`).join("")}</div>
    <select id="fstock" aria-label="${esc(t("filter.stockAria"))}"><option value="all">${state.cat === "all" ? t("filter.allStocksTokens") : state.cat === "memes" ? t("filter.allMemes") : state.cat === "preipo" ? t("filter.allPreipo") : t("filter.allStocks")}</option>${inCat.map((sy) => `<option value="${esc(sy)}" ${state.stock === sy ? "selected" : ""}>${esc(stockLabel(sy))}</option>`).join("")}</select>
    <select id="fissuer" aria-label="${esc(t("filter.issuerAria"))}"><option value="all">${t("filter.allIssuers")}</option>${issuers.map((i) => `<option ${state.issuer === i ? "selected" : ""}>${esc(i)}</option>`).join("")}</select>
    <span class="sp"></span>
    <select id="fsort" aria-label="${esc(t("filter.sortAria"))}"><option value="closing" ${state.sort === "closing" ? "selected" : ""}>${t("sort.closing")}</option><option value="pot" ${state.sort === "pot" ? "selected" : ""}>${t("sort.pot")}</option><option value="bettors" ${state.sort === "bettors" ? "selected" : ""}>${t("sort.bettors")}</option></select>`;
  filters.querySelectorAll<HTMLButtonElement>("button[data-status]").forEach((b) => (b.onclick = () => { state.status = b.dataset.status!; update(); }));
  (filters.querySelector("#fstock") as HTMLSelectElement).onchange = (e) => { state.stock = (e.target as HTMLSelectElement).value; update(); };
  (filters.querySelector("#fissuer") as HTMLSelectElement).onchange = (e) => { state.issuer = (e.target as HTMLSelectElement).value; update(); };
  (filters.querySelector("#fsort") as HTMLSelectElement).onchange = (e) => { state.sort = (e.target as HTMLSelectElement).value; update(); };
}
function update() {
  const q = state.q.toLowerCase();
  let list = events.filter((e) =>
    (state.cat === "all" || e.category === state.cat) &&
    (state.stock === "all" || e.symbol === state.stock) &&
    (state.issuer === "all" || e.markets.some((m) => issuerOf(m) === state.issuer)) &&
    (state.status === "all" || (state.status === "open" && e.status === "open") || (state.status === "live" && (e.status === "trading" || e.status === "proposed")) || (state.status === "resolved" && e.status === "resolved")) &&
    (!q || `${e.symbol} ${e.name} ${e.markets.map((m) => tokenSymbol(m) + " " + issuerOf(m)).join(" ")}`.toLowerCase().includes(q)));
  const by = { closing: (a: EventView, b: EventView) => (state.status === "resolved" ? b.closeTs - a.closeTs : a.closeTs - b.closeTs), pot: (a: EventView, b: EventView) => (b.potUsd ?? 0) - (a.potUsd ?? 0), bettors: (a: EventView, b: EventView) => b.bettors - a.bettors }[state.sort as "closing" | "pot" | "bettors"] ?? (() => 0);
  list = list.sort((a, b) => by(a, b) || a.symbol.localeCompare(b.symbol));
  const pools = list.reduce((a, e) => a + e.markets.length, 0), pot = list.reduce((a, e) => a + (e.potUsd ?? 0), 0);
  summary.textContent = list.length ? `${tn("markets", list.length)} · ${tn("pools", pools)}${pot ? ` · ${t("home.inPlay", { usd: fmtUsd(pot) })}` : ""}` : "";
  grid.innerHTML = list.length ? list.map(card).join("") : `<div class="empty-state">${t("home.empty")}</div>`;
  renderFilters(); renderCatnav(state.cat);
  // the pitch is for the front page; a category tab or a stock filter goes straight to those markets
  const hero = document.querySelector<HTMLElement>(".hero"); if (hero) hero.hidden = state.cat !== "all" || state.stock !== "all";
  const p = new URLSearchParams(); for (const [k, v] of Object.entries(state)) if (v && v !== DEFAULTS[k]) p.set(k, v);
  history.replaceState(null, "", p.toString() ? "?" + p : location.pathname);
}
async function load() {
  try {
    const [ms] = await Promise.all([fetchMarkets(), loadPrices(), loadStocks()]);
    events = buildEvents(ms);
    trackStocks(ms);
    update();
  } catch (e: any) { grid.innerHTML = `<div class="msg err">${t("home.loadErr", { err: esc(e.message ?? e) })}</div>`; }
}
// footer: the dispute window is on-chain config (shipped in the page's boot data), not a constant
{ const secs = Number((window as any).__BOOT__?.config?.disputeWindowSecs), el = document.getElementById("dwin");
  if (el && secs > 0) el.textContent = secs % 3600 === 0 ? tn("hours", secs / 3600) : tn("minutes", Math.round(secs / 60)); }
load();
setInterval(load, 30_000); // pools move as people bet; the API caches for 15 s
void STOCK_NAMES;
