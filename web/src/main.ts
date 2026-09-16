// Home: events (one stock × one session) as compact cards, with stock tabs, status / issuer filters, sorting and search.
// Detail — the four ranges, odds, pools — lives on the event page only.
import { fetchMarkets } from "./chain";
import { STATUS_LABEL, buildEvents, type EventView } from "./events";
import { STOCK_META, STOCK_NAMES, STOCK_ORDER, bucketLabel, bucketName, fmtMove, fmtUsd, issuerOf, loadPrices, loadStocks, question, tokenSymbol } from "./stocks";
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
  if (ev.outcome != null) lead = `Result: <b>${esc(label(ev, ev.outcome))}</b>${ev.moveValue != null ? ` · ${fmtMove(ev.moveValue)}` : ""}`;
  else if (ev.proposed != null) lead = `Proposed: <b>${esc(label(ev, ev.proposed))}</b>${ev.moveValue != null ? ` · ${fmtMove(ev.moveValue)}` : ""}`;
  else if (backed) { const i = ev.dist.indexOf(Math.max(...ev.dist)); lead = `Most backed: <b>${esc(label(ev, i))}</b> ${Math.round(ev.dist[i] * 100)}%`; }
  else lead = `<span class="note">No bets yet — the house prize goes to whoever picks right</span>`;
  const when = ev.status === "open" ? `${timeLeft(ev.closeTs)} left` : ev.status === "trading" ? `result ~${fmtTs(ev.resolveAfterTs)}` : "";
  return `<a class="ev" href="/market.html?e=${encodeURIComponent(ev.key)}">
    <div class="ev-top">${tickerBadge(ev.symbol)}<div><div class="ev-q">${esc(question(m0))}</div><div class="ev-s">${esc(ev.name)} · ${ev.markets.map((m) => esc(tokenSymbol(m))).join(" · ")}</div></div></div>
    <div class="dist" title="How the money is spread across the ranges">${bar}</div>
    <div class="ev-lead">${lead}</div>
    <div class="ev-foot"><span class="pill ${ev.status}">${ev.status === "open" ? "Open" : STATUS_LABEL[ev.status]}</span>${ev.potUsd != null ? `<span>${fmtUsd(ev.potUsd)} pot</span>` : ""}<span>${ev.bettors} bettor${ev.bettors === 1 ? "" : "s"}</span><span class="ev-when">${esc(when)}</span></div>
  </a>`;
}
function renderFilters() {
  const issuers = [...new Set(events.flatMap((e) => e.markets.map((m) => issuerOf(m))).filter(Boolean))].sort();
  const seg = [["open", "Betting open"], ["live", "Awaiting result"], ["resolved", "Resolved"], ["all", "All"]];
  // stocks of the current category that have a market (today's memes first: the list is in the API's order)
  const inCat = STOCK_ORDER.filter((sy) => (state.cat === "all" || (STOCK_META[sy]?.category ?? "stocks") === state.cat) && events.some((e) => e.symbol === sy));
  const stockLabel = (sy: string) => (STOCK_NAMES[sy] && STOCK_NAMES[sy] !== sy ? `${sy} · ${STOCK_NAMES[sy]}` : sy);
  filters.innerHTML = `<div class="seg">${seg.map(([k, l]) => `<button data-status="${k}" class="${state.status === k ? "on" : ""}">${l}</button>`).join("")}</div>
    <select id="fstock" aria-label="Stock or token"><option value="all">${state.cat === "all" ? "All stocks & tokens" : state.cat === "memes" ? "All memes" : state.cat === "preipo" ? "All pre-IPO" : "All stocks"}</option>${inCat.map((sy) => `<option value="${esc(sy)}" ${state.stock === sy ? "selected" : ""}>${esc(stockLabel(sy))}</option>`).join("")}</select>
    <select id="fissuer" aria-label="Issuer"><option value="all">All issuers</option>${issuers.map((i) => `<option ${state.issuer === i ? "selected" : ""}>${esc(i)}</option>`).join("")}</select>
    <span class="sp"></span>
    <select id="fsort" aria-label="Sort"><option value="closing" ${state.sort === "closing" ? "selected" : ""}>Closing soon</option><option value="pot" ${state.sort === "pot" ? "selected" : ""}>Biggest pot</option><option value="bettors" ${state.sort === "bettors" ? "selected" : ""}>Most bettors</option></select>`;
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
  summary.textContent = list.length ? `${list.length} market${list.length === 1 ? "" : "s"} · ${pools} pools${pot ? ` · ${fmtUsd(pot)} in play` : ""}` : "";
  grid.innerHTML = list.length ? list.map(card).join("") : `<div class="empty-state">Nothing matches these filters. <a href="/">Show all open markets</a></div>`;
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
  } catch (e: any) { grid.innerHTML = `<div class="msg err">Could not load markets: ${esc(e.message ?? e)}</div>`; }
}
// footer: the dispute window is on-chain config (shipped in the page's boot data), not a constant
{ const secs = Number((window as any).__BOOT__?.config?.disputeWindowSecs), el = document.getElementById("dwin");
  if (el && secs > 0) el.textContent = secs % 3600 === 0 ? `${secs / 3600} hour${secs === 3600 ? "" : "s"}` : `${Math.round(secs / 60)} minutes`; }
load();
setInterval(load, 30_000); // pools move as people bet; the API caches for 15 s
void STOCK_NAMES;
