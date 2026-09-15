// First-paint HTML for the home and event pages, rendered on the server from the same in-memory caches the API
// serves. The page shows real content as soon as the HTML arrives, before the wallet/chain scripts (≈150 kB) have
// loaded; once they run, the client re-renders the same markup and takes over (filters, wallet, betting).
// Keep the markup in step with web/src/main.ts (card) and web/src/market.ts (render).
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const parseMetric = (tag) => { const m = String(tag).match(/^([A-Z]{1,5})\.close:(\d{4}-\d{2}-\d{2})$/); return m ? { symbol: m[1], date: m[2] } : null; };
const sessionLabel = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const fmtThr = (ppm) => (ppm > 0 ? "+" : ppm < 0 ? "−" : "") + (Math.abs(ppm) / 10000).toFixed(2).replace(/\.?0+$/, "") + "%";
const fmtMove = (ppm) => { const bps = Math.floor(ppm / 100); return (bps > 0 ? "+" : bps < 0 ? "−" : "") + (Math.abs(bps) / 100).toFixed(2) + "%"; };
const fmtUsd = (v) => "$" + (v >= 1e6 ? (v / 1e6).toFixed(1) + "m" : v >= 1e4 ? (v / 1e3).toFixed(1) + "k" : v.toLocaleString("en-US", { maximumFractionDigits: v < 100 ? 2 : 0 }));
const COLORS_4 = ["#e5484d", "#f5a524", "#6cc68e", "#12a150"];
const COLORS = ["#e5484d", "#f08c3a", "#f5a524", "#c3c65a", "#6cc68e", "#12a150", "#3b9ede", "#5b4bdb"];
const bucketColor = (m, i) => (m.nBuckets === 2 ? (i === 1 ? "var(--gain)" : "var(--drop)") : m.nBuckets === 4 ? COLORS_4[i] : COLORS[Math.round((i * (COLORS.length - 1)) / Math.max(1, m.nBuckets - 1))]);
const bucketName = (m, i) => (m.nBuckets === 4 && m.thresholds[1] === 0 ? ["Big drop", "Small drop", "Small gain", "Big gain"][i] : "");
function bucketLabel(m, i) {
  const t = m.thresholds, n = m.nBuckets;
  if (n === 2 && t[0] === 0) return i === 1 ? "Up or flat" : "Down";
  if (i === 0) return `< ${fmtThr(t[0])}`;
  if (i === n - 1) return `≥ ${fmtThr(t[n - 2])}`;
  return `${fmtThr(t[i - 1])} to ${fmtThr(t[i])}`;
}
function tickerBadge(symbol, big = false) { let h = 0; for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) % 360; return `<span class="tick${big ? " big" : ""}" style="--h:${h}">${esc(symbol)}</span>`; }
function timeLeft(ts) {
  const s = ts - Date.now() / 1000; if (s <= 0) return "closed";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
const STATUS_LABEL = { open: "Betting open", trading: "Awaiting close", proposed: "Result proposed", resolved: "Resolved" };
const statusOf = (m) => (m.status === 0 ? (Date.now() / 1000 < m.closeTs ? "open" : "trading") : m.status === 1 ? "proposed" : "resolved");
const RANK = { open: 0, trading: 1, proposed: 2, resolved: 3 };
const total = (m) => m.pools.reduce((a, b) => a + b, 0);

function context({ markets, stocks, prices }) {
  const byMint = new Map(), names = {}, order = [];
  for (const s of stocks) { names[s.symbol] = s.name; order.push(s.symbol); s.tokens.forEach((t, i) => t.mint && byMint.set(t.mint, { ...t, rank: i })); }
  const tok = (m) => byMint.get(m.mint) ?? { token: "shares", issuer: "", rank: 99 };
  const ui = (m, raw) => (raw / 10 ** m.decimals) * (m.multiplier || 1);
  const px = (m) => prices?.[tok(m).token]?.usd ?? null;
  return { markets: markets ?? [], names, order, tok, ui, px };
}
function buildEvents(c) {
  const by = new Map();
  for (const m of c.markets) { const p = parseMetric(m.metric); const k = p ? `${p.symbol}:${p.date}` : `m${m.id}`; if (!by.has(k)) by.set(k, []); by.get(k).push(m); }
  return [...by].map(([key, list]) => {
    const p = parseMetric(list[0].metric); list.sort((a, b) => c.tok(a).rank - c.tok(b).rank || a.id - b.id);
    const n = list[0].nBuckets, usd = new Array(n).fill(0), frac = new Array(n).fill(0);
    let pot = 0, priced = false, fc = 0;
    for (const m of list) {
      const t = total(m), x = c.px(m);
      if (t) { m.pools.forEach((v, i) => (frac[i] += v / t)); fc++; }
      if (x) { priced = true; m.pools.forEach((v, i) => (usd[i] += c.ui(m, v) * x)); pot += c.ui(m, t + m.seed) * x; }
    }
    const ut = usd.reduce((a, b) => a + b, 0);
    return { key, symbol: p?.symbol ?? "?", date: p?.date ?? "", markets: list, closeTs: Math.min(...list.map((m) => m.closeTs)),
      status: list.map(statusOf).sort((a, b) => RANK[a] - RANK[b])[0], potUsd: priced ? pot : null, bettors: list.reduce((a, m) => a + m.positions, 0),
      dist: ut > 0 ? usd.map((v) => v / ut) : fc ? frac.map((v) => v / fc) : new Array(n).fill(0) };
  });
}
const question = (ev) => `Where does ${ev.symbol} close on ${sessionLabel(ev.date)}?`;

/** Home: the default view (betting open, closing soon; all stocks or the ?stock= tab) as event cards + the summary line.
 *  Other filters in the URL are left to the browser. A stock tab hides the hero, as main.ts does. */
export function homeHtml(data, html, url) {
  const stock = url?.searchParams.get("stock") || "all";
  if (stock !== "all") html = html.replace(`<section class="hero">`, `<section class="hero" hidden>`);
  if (["issuer", "status", "sort", "q"].some((k) => url?.searchParams.get(k))) return html;
  const c = context(data); if (!c.markets.length) return html;
  const evs = buildEvents(c).filter((e) => e.status === "open" && (stock === "all" || e.symbol === stock)).sort((a, b) => a.closeTs - b.closeTs || a.symbol.localeCompare(b.symbol));
  if (!evs.length) return html;
  const cards = evs.map((ev) => {
    const m0 = ev.markets[0], backed = ev.dist.some((x) => x > 0), label = (i) => bucketName(m0, i) || bucketLabel(m0, i);
    const bar = backed ? ev.dist.map((f, i) => `<i style="width:${(f * 100).toFixed(1)}%;background:${bucketColor(m0, i)}"></i>`).join("") : `<i class="empty"></i>`;
    const i = ev.dist.indexOf(Math.max(...ev.dist));
    const lead = backed ? `Most backed: <b>${esc(label(i))}</b> ${Math.round(ev.dist[i] * 100)}%` : `<span class="note">No bets yet — the house prize goes to whoever picks right</span>`;
    return `<a class="ev" href="/market.html?e=${encodeURIComponent(ev.key)}">
    <div class="ev-top">${tickerBadge(ev.symbol)}<div><div class="ev-q">${esc(question(ev))}</div><div class="ev-s">${esc(c.names[ev.symbol] ?? ev.symbol)} · ${ev.markets.map((m) => esc(c.tok(m).token)).join(" · ")}</div></div></div>
    <div class="dist" title="How the money is spread across the four ranges">${bar}</div>
    <div class="ev-lead">${lead}</div>
    <div class="ev-foot"><span class="pill open">Open</span>${ev.potUsd != null ? `<span>${fmtUsd(ev.potUsd)} pot</span>` : ""}<span>${ev.bettors} bettor${ev.bettors === 1 ? "" : "s"}</span><span class="ev-when">${esc(timeLeft(ev.closeTs))} left</span></div>
  </a>`;
  }).join("");
  const pools = evs.reduce((a, e) => a + e.markets.length, 0), pot = evs.reduce((a, e) => a + (e.potUsd ?? 0), 0);
  return html
    .replace(`<div id="events" class="evgrid"><div class="note">Loading markets…</div></div>`, `<div id="events" class="evgrid">${cards}</div>`)
    .replace(`<div id="summary" class="note"></div>`, `<div id="summary" class="note">${evs.length} market${evs.length === 1 ? "" : "s"} · ${pools} pools${pot ? ` · ${fmtUsd(pot)} in play` : ""}</div>`);
}

/** Event page: breadcrumb, header, token switcher and the ranges table of the selected pool (trade panel loads with JS). */
export function eventHtml(data, url, html) {
  const c = context(data); if (!c.markets.length) return html;
  const byId = url.searchParams.get("id") ? c.markets.find((m) => m.id === Number(url.searchParams.get("id"))) : null;
  const p0 = byId ? parseMetric(byId.metric) : null;
  const key = url.searchParams.get("e") ?? (p0 ? `${p0.symbol}:${p0.date}` : "");
  const ev = buildEvents(c).find((e) => e.key === key); if (!ev) return html;
  const want = url.searchParams.get("t") ?? (byId ? c.tok(byId).token : null);
  const m = ev.markets.find((x) => c.tok(x).token === want) ?? ev.markets.find((x) => statusOf(x) === "open") ?? ev.markets[0];
  const cfg = data.config ?? { feeBps: 300, earlyBirdDiscountBps: 0, earlyBirdSecs: 0 };
  const now = Date.now() / 1000, eb = m.openTs + Math.max(0, Math.min(cfg.earlyBirdSecs, Math.floor((m.closeTs - m.openTs) / 4)));
  const fee = now < eb ? cfg.feeBps - cfg.earlyBirdDiscountBps : cfg.feeBps;
  const st = statusOf(m), tok = c.tok(m).token, t = total(m);
  const amt = (x, raw, d = 3) => c.ui(x, raw).toLocaleString("en-US", { maximumFractionDigits: d });
  const rows = m.pools.map((p, i) => {
    const win = m.pools[i], lose = t - win, mult = win ? 1 + (lose * (1 - fee / 10000) + m.seed) / win : null;
    return `<div class="orow" style="--c:${bucketColor(m, i)}"><span class="oname"><i></i><b>${esc(bucketName(m, i) || bucketLabel(m, i))}</b>${bucketName(m, i) ? `<small>${esc(bucketLabel(m, i))}</small>` : ""}</span><span class="ochance">${t ? Math.round((p / t) * 100) + "%" : "—"}</span><span class="opays">${mult ? mult.toFixed(2) + "×" : st === "open" ? "whole pot" : "—"}</span><span class="opool">${amt(m, p)} ${esc(tok)}</span><span>${st === "open" ? `<button class="pickbtn" disabled>Pick</button>` : ""}</span></div>`;
  }).join("");
  const body = `<div class="evpage"><div class="evtop">
    <nav class="crumb"><a href="/">Markets</a><span>›</span><a href="/?stock=${encodeURIComponent(ev.symbol)}">${esc(c.names[ev.symbol] ?? ev.symbol)}</a><span>›</span><span>${esc(sessionLabel(ev.date))}</span></nav>
    <header class="evhdr">${tickerBadge(ev.symbol, true)}<div><h1>${esc(question(ev))}</h1><div class="evmeta"><span class="pill ${st}">${STATUS_LABEL[st]}</span>${st === "open" ? `<span>Bets close in ${timeLeft(m.closeTs)}</span>` : ""}${ev.potUsd != null ? `<span>${fmtUsd(ev.potUsd)} pot across ${ev.markets.length} pool${ev.markets.length === 1 ? "" : "s"}</span>` : ""}<span>${ev.bettors} bettor${ev.bettors === 1 ? "" : "s"}</span></div></div></header>
    <div class="toks">${ev.markets.map((x) => `<button class="tok${x.id === m.id ? " on" : ""}" disabled><b>${esc(c.tok(x).token)}</b><span>${esc(c.tok(x).issuer)}</span><em>${amt(x, total(x) + x.seed)} in pot</em></button>`).join("")}</div>
    <div class="otable"><div class="orow ohead"><span>Range (move vs previous close)</span><span>Chance</span><span>Pays</span><span class="opool">Pool</span><span></span></div>${rows}</div>
  </div><aside class="trade" id="trade"><div class="tcard"><div class="note">Loading the trade panel…</div></div></aside><div class="evbottom"></div></div>`;
  return html.replace(`<main class="container" id="event"><div class="note" style="padding:30px 0">Loading…</div></main>`, `<main class="container" id="event">${body}</main>`);
}
