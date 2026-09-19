import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { API_BASE, CLUSTER, IS_TEST } from "./config";
import { STATUS, connection, fetchMarkets, type MarketView } from "./chain";
import { CATEGORIES, STOCK_NAMES, STOCK_ORDER, issuerOf, loadPrices, loadStocks, priceOf, symbolOf, tokenSymbol, uiAmount } from "./stocks";
import { connectWallet, devWallet, listWallets, type Session } from "./wallet";
import { bindIfPending, captureReferral } from "./referral";
import { localizeUtc } from "./time";

/** HTML-escape anything that did not originate in our own source. */
export const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
export const isBase58 = (s: unknown) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(s);
export { fmtTs, timeLeft } from "./time";
export const short = (pk: PublicKey | string) => { const s = pk.toString(); return s.slice(0, 4) + "…" + s.slice(-4); };
export function statusPill(m: MarketView) {
  const now = Date.now() / 1000;
  const label = m.status === 0 ? (now < m.openTs ? "Upcoming" : now < m.closeTs ? "Betting open" : "Awaiting close") : m.status === 1 ? "Result proposed" : STATUS[m.status];
  const cls = m.status === 0 ? (now < m.closeTs ? "open" : "trading") : m.status === 1 ? "proposed" : STATUS[m.status].toLowerCase();
  return `<span class="pill ${cls}">${label}</span>`;
}
// big drop → big gain runs red → green (finance convention)
const COLORS_4 = ["#e5484d", "#f5a524", "#6cc68e", "#12a150"];
const COLORS = ["#e5484d", "#f08c3a", "#f5a524", "#c3c65a", "#6cc68e", "#12a150", "#3b9ede", "#5b4bdb"];
export const bucketColor = (m: MarketView, i: number) => (m.nBuckets === 2 ? (i === 1 ? "var(--gain)" : "var(--drop)") : m.nBuckets === 4 ? COLORS_4[i] : COLORS[Math.round((i * (COLORS.length - 1)) / Math.max(1, m.nBuckets - 1))]);
/** Ticker monogram in a colour derived from the symbol (no third-party logos). */
export function tickerBadge(symbol: string, big = false, small = false) {
  let h = 0; for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="tick${big ? " big" : small ? " sm" : ""}${symbol.length > 5 ? " long" : ""}" style="--h:${h}">${esc(symbol)}</span>`;
}

// ---------- top bar: brand, search, stock tabs, network badge, wallet ----------
type TopbarOpts = { active?: string; q?: string; onSearch?: (q: string) => void; onStock?: (s: string) => void };
let topOpts: TopbarOpts = {};
export function mountTopbar(opts: TopbarOpts = {}) {
  topOpts = opts;
  localizeUtc();
  // test networks only: the faucet page, linked from the nav and the network badge (the badge stays visible on phones)
  const faucetOn = IS_TEST && !!API_BASE, net = CLUSTER === "devnet" ? "Devnet" : CLUSTER;
  const nb = document.getElementById("netbadge");
  if (nb && IS_TEST) nb.innerHTML = faucetOn
    ? `<a class="netbadge" href="/faucet.html" title="Test network: mock stock tokens, no real value. Free test stocks on the faucet page.">${esc(net)}</a>`
    : `<span class="netbadge" title="Test network: mock stock tokens, no real value">${esc(net)}</span>`;
  const fl = document.getElementById("faucetlink"); if (fl) fl.hidden = !faucetOn;
  mountNavMenu();
  captureReferral();
  onSession((s) => { if (s) bindIfPending(s); });
  const q = document.getElementById("q") as HTMLInputElement | null;
  if (q) {
    q.value = opts.q ?? "";
    if (opts.onSearch) q.oninput = () => opts.onSearch!(q.value.trim());
    q.onkeydown = (e) => { if (e.key === "Enter" && !opts.onSearch) location.href = "/?q=" + encodeURIComponent(q.value.trim()); };
  }
  renderCatnav(opts.active ?? "");
  mountWallet();
  mountFeedback();
}
/** Feedback: a small button pinned to the corner of every page. No wallet needed; the note goes to /api/feedback
 *  with the page it was written on, plus the wallet address when one happens to be connected. */
function mountFeedback() {
  if (!API_BASE || document.getElementById("fbbtn")) return;
  const btn = document.createElement("button"); btn.id = "fbbtn"; btn.className = "fbbtn"; btn.textContent = "Feedback";
  document.body.appendChild(btn);
  btn.onclick = () => {
    if (document.getElementById("fbbox")) return;
    const box = document.createElement("div"); box.id = "fbbox"; box.className = "fbbox";
    box.innerHTML = `<div class="fbhead"><b>Tell us what you think</b><button class="ghost" id="fbx" aria-label="Close">\u2715</button></div>
      <textarea id="fbmsg" rows="5" maxlength="4000" placeholder="A bug, something confusing, a market you want\u2026"></textarea>
      <input id="fbcontact" maxlength="200" placeholder="Email, X or Telegram (optional, if you want a reply)">
      <input id="fbweb" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
      <div class="fbrow"><span class="note" id="fbnote">Or email <a href="mailto:hello@sharepot.xyz">hello@sharepot.xyz</a></span><button class="primary" id="fbsend">Send</button></div>`;
    document.body.appendChild(box);
    const $ = <T extends HTMLElement>(id: string) => box.querySelector<T>("#" + id)!;
    const msg = $<HTMLTextAreaElement>("fbmsg"), send = $<HTMLButtonElement>("fbsend"), note = $("fbnote");
    const hint = note.innerHTML; msg.oninput = () => { if (note.innerHTML !== hint) note.innerHTML = hint; };
    msg.focus();
    $("fbx").onclick = () => box.remove();
    send.onclick = async () => {
      if (msg.value.trim().length < 5) { note.textContent = "Please write a few words first."; return; }
      send.disabled = true; send.textContent = "Sending\u2026";
      try {
        const r = await fetch(API_BASE + "/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg.value, contact: $<HTMLInputElement>("fbcontact").value, website: $<HTMLInputElement>("fbweb").value, page: location.pathname + location.search, wallet: session ? String(session.publicKey) : null }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? "HTTP " + r.status);
        box.innerHTML = `<div class="fbhead"><b>Thanks, got it \u2713</b></div><div class="note">Every note is read by a person.</div>`;
        setTimeout(() => box.remove(), 2500);
      } catch (e: any) { note.textContent = "Could not send: " + String(e?.message ?? e); send.disabled = false; send.textContent = "Send"; }
    };
  };
}
/** Phones hide the text links in the top bar (styles.css, ≤640px), which left Docs / Faucet / Leaderboard / My bets
 *  unreachable there. A ☰ button lists the same links in a dropdown; it is invisible on wider screens. */
let navOpen = false;
function mountNavMenu() {
  const right = document.querySelector<HTMLElement>(".tb-right");
  if (!right || document.getElementById("navmore")) return;
  const links = [...right.querySelectorAll<HTMLAnchorElement>("a.navlink")].filter((a) => !a.hidden);
  const box = document.createElement("div"); box.className = "navmorebox";
  box.innerHTML = `<button class="navmore" id="navmore" aria-label="Menu" aria-expanded="false">\u2630</button>`;
  right.insertBefore(box, document.getElementById("netbadge"));
  const btn = box.querySelector<HTMLButtonElement>("#navmore")!;
  const render = () => {
    box.querySelector(".menu")?.remove();
    if (navOpen) { const m = document.createElement("div"); m.className = "menu navmenu"; m.innerHTML = links.map((a) => `<a class="mi" href="${esc(a.getAttribute("href") ?? "/")}">${esc(a.textContent ?? "")}</a>`).join(""); box.appendChild(m); }
    btn.setAttribute("aria-expanded", String(navOpen));
  };
  btn.onclick = (e) => { e.stopPropagation(); navOpen = !navOpen; render(); };
  document.addEventListener("click", () => { if (navOpen) { navOpen = false; render(); } });
}
/** Category tabs under the top bar (Stocks · Pre-IPO · Memes). On the home page they filter in place; elsewhere they
 *  link home with the category set. The stock picker within a category lives in the home page's filter row. */
export function renderCatnav(active: string) {
  const el = document.getElementById("catnav"); if (!el) return;
  const items: [string, string][] = [["all", "All markets"], ...CATEGORIES];
  el.innerHTML = items.map(([k, label]) => topOpts.onStock
    ? `<button data-s="${esc(k)}" class="${active === k ? "on" : ""}">${esc(label)}</button>`
    : `<a href="/${k === "all" ? "" : "?cat=" + encodeURIComponent(k)}" class="${active === k ? "on" : ""}">${esc(label)}</a>`).join("");
  if (topOpts.onStock) el.querySelectorAll<HTMLButtonElement>("button[data-s]").forEach((b) => (b.onclick = () => topOpts.onStock!(b.dataset.s!)));
}

// ---------- wallet + balances ----------
let session: Session | null = null;
type Tracked = { symbol: string; token: string; mint: PublicKey; view: MarketView };
let tracked: Tracked[] = [];
export const balances: { sol: number; loaded: boolean; raw: Record<string, number> } = { sol: 0, loaded: false, raw: {} };
/** Pages hand the wallet the markets they already loaded (one tracked entry per mint). `all` = that was the whole
 *  market list; a page that only knows part of it (one event) or nothing (leaderboard, invite) leaves the rest to
 *  ensureTracked, so the wallet menu lists the same holdings on every page. */
let trackedAll = false, selfTracking = false;
export function trackStocks(ms: MarketView[], all = true) {
  if (all) trackedAll = true;
  const seen = new Map<string, Tracked>(tracked.map((t) => [t.mint.toBase58(), t]));
  for (const m of ms) if (!seen.has(m.mint.toBase58())) seen.set(m.mint.toBase58(), { symbol: symbolOf(m), token: tokenSymbol(m), mint: m.mint, view: m });
  tracked = [...seen.values()].sort((a, b) => STOCK_ORDER.indexOf(a.symbol) - STOCK_ORDER.indexOf(b.symbol) || a.token.localeCompare(b.token));
  refreshBalances();
}
function ensureTracked() {
  setTimeout(async () => {   // give the page a moment to hand over its own list first (saves a request)
    if (trackedAll || selfTracking || !session) return;
    selfTracking = true;
    try { const [ms] = await Promise.all([fetchMarkets(), loadPrices(), loadStocks()]); trackStocks(ms); } catch {} finally { selfTracking = false; }
  }, 1500);
}
/** Raw balance of this market's token in the connected wallet. */
export const shareBalance = (m: MarketView) => balances.raw[m.mint.toBase58()] ?? 0;
/** SOL + every tracked token balance of the connected wallet in two RPC calls (all of the wallet's accounts per token
 *  program at once, not one call per token), so public RPC rate limits are not hit. Concurrent calls share one request;
 *  a call that arrives while one is in flight queues exactly one more run, because the running one may have started
 *  before the page's tokens were known (or before a faucet claim landed) and would otherwise report zeros as final. */
let refreshing: Promise<void> | null = null, again = false;
/** Pages that print a balance outside the wallet menu (the stake panel) redraw it when a read finishes. */
const balanceListeners: (() => void)[] = [];
export const onBalances = (fn: () => void) => { balanceListeners.push(fn); };
export function refreshBalances(): Promise<void> {
  if (!session) { balances.loaded = false; renderWallet(); return Promise.resolve(); }
  if (refreshing) { again = true; return refreshing; }
  refreshing = (async () => {
    do try {
      again = false;
      const owner = session?.publicKey; if (!owner) { balances.loaded = false; break; }
      const programs = [...new Set(tracked.map((t) => t.view.tokenProgram.toBase58()))];
      const [sol, ...lists] = await Promise.all([
        connection.getBalance(owner),
        ...programs.map((p) => connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(p) })),
      ]);
      const raw: Record<string, number> = {};
      for (const list of lists) for (const a of list.value) {
        const info = (a.account.data as any).parsed?.info; if (!info) continue;
        raw[info.mint] = (raw[info.mint] ?? 0) + Number(info.tokenAmount?.amount ?? 0);
      }
      balances.sol = sol / 1e9; balances.raw = Object.fromEntries(tracked.map((t) => [t.mint.toBase58(), raw[t.mint.toBase58()] ?? 0])); balances.loaded = true;
    } catch { balances.loaded = false; } while (again);
    renderWallet();
    balanceListeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
  })().finally(() => { refreshing = null; });
  return refreshing;
}
const listeners: ((s: Session | null) => void)[] = [];
export const onSession = (fn: (s: Session | null) => void) => { listeners.push(fn); fn(session); };
export const getSession = () => session;
function setSession(s: Session | null) { session = s; menuOpen = false; try { s ? localStorage.setItem("sharepot.wallet", s.label) : localStorage.removeItem("sharepot.wallet"); } catch {} balances.loaded = false; listeners.forEach((f) => { try { f(s); } catch (e) { console.error(e); } }); renderWallet(); refreshBalances(); ensureTracked(); }

let menuOpen = false;
export function openWalletMenu() { menuOpen = true; renderWallet(); }
document.addEventListener("click", (e) => { const box = document.getElementById("wallet"); if (menuOpen && box && !box.contains(e.target as Node)) { menuOpen = false; renderWallet(); } });

export function mountWallet() {
  renderWallet();
  // auto-reconnect the last wallet
  try {
    const last = localStorage.getItem("sharepot.wallet");
    if (last === "Test wallet (browser)") setSession(devWallet());
    else if (last) setTimeout(async () => { const w = listWallets().find((x) => x.name === last); if (w) try { setSession(await connectWallet(w)); } catch {} }, 300);
  } catch {}
}
function renderWallet() {
  const el = document.getElementById("wallet"); if (!el) return;
  if (!session) {
    const wallets = listWallets();
    el.innerHTML = `<button class="primary wbtn" id="wbtn">Connect</button>${menuOpen ? `<div class="menu" id="wmenu"><div class="mh">Connect a wallet</div>${wallets.map((w, i) => `<button data-i="${i}">${esc(w.name)}</button>`).join("")}${IS_TEST ? `<button id="wdev" title="A throwaway keypair stored in this browser. Test network only.">Test wallet (browser)</button>` : ""}${!wallets.length && !IS_TEST ? `<div class="note" style="padding:6px">Install Phantom, Solflare or Backpack.</div>` : ""}</div>` : ""}`;
    el.querySelector<HTMLButtonElement>("#wbtn")!.onclick = (e) => { e.stopPropagation(); menuOpen = !menuOpen; renderWallet(); };
    el.querySelectorAll<HTMLButtonElement>("button[data-i]").forEach((b) => (b.onclick = async () => { try { setSession(await connectWallet(wallets[Number(b.dataset.i)])); } catch (e: any) { alert(e.message ?? e); } }));
    const d = el.querySelector<HTMLButtonElement>("#wdev"); if (d) d.onclick = () => setSession(devWallet());
    return;
  }
  // holdings: one row per token (stock badge, token, stock · issuer, amount, dollar value), biggest value first
  const addr = session.publicKey.toBase58();
  const held = tracked.map((t) => ({ t, raw: balances.raw[t.mint.toBase58()] ?? 0 })).filter((h) => h.raw > 0)
    .map((h) => { const amt = uiAmount(h.t.view, h.raw), p = priceOf(h.t.view); return { ...h, amt, usd: p != null ? amt * p : null }; })
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || STOCK_ORDER.indexOf(a.t.symbol) - STOCK_ORDER.indexOf(b.t.symbol));
  const priced = held.filter((h) => h.usd != null), total = priced.reduce((a, h) => a + h.usd!, 0);
  const usd = (v: number) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rows = !balances.loaded ? `<div class="note" style="padding:4px">Loading balances…</div>` : held.length
    ? held.map((h) => `<div class="hold">${tickerBadge(h.t.symbol, false, true)}<span class="hname"><b>${esc(h.t.token)}</b><small>${esc(STOCK_NAMES[h.t.symbol] ?? h.t.symbol)} · ${esc(issuerOf(h.t.view))}</small></span><span class="hamt"><b>${h.amt.toLocaleString("en-US", { maximumFractionDigits: 4 })}</b><small>${h.usd != null ? usd(h.usd) : "no price"}</small></span></div>`).join("")
    : `<div class="note" style="padding:4px">No stock tokens in this wallet yet.</div>`;
  el.innerHTML = `<button class="wbtn" id="wbtn"><span class="dot"></span><span class="mono">${short(session.publicKey)}</span>${balances.loaded ? `<span class="note">${balances.sol.toFixed(3)} SOL</span>` : ""}</button>${menuOpen ? `<div class="menu wmenu" id="wmenu">
    <div class="whead"><div><div class="mh">${esc(session.label)}</div><button class="addr" id="wcopy" title="Copy address">${short(addr)}</button></div><button class="ghost" id="wdis">Disconnect</button></div>
    <div class="wtotal"><span class="note">Stock tokens</span><span class="sol">${balances.loaded ? balances.sol.toFixed(3) + " SOL" : ""}</span><b>${!balances.loaded ? "…" : priced.length ? usd(total) : held.length ? "—" : "$0.00"}</b></div>
    ${balances.loaded && balances.sol < 0.002 ? `<div class="note warn" style="padding:0 4px">Not enough SOL for network fees.</div>` : ""}
    <div class="wlist" id="wholdings">${rows}</div><hr>
    <a class="mi" href="/portfolio.html">My bets</a></div>` : ""}`;
  el.querySelector<HTMLButtonElement>("#wbtn")!.onclick = (e) => { e.stopPropagation(); menuOpen = !menuOpen; renderWallet(); };
  const dis = el.querySelector<HTMLButtonElement>("#wdis"); if (dis) dis.onclick = async () => { await session?.disconnect(); setSession(null); };
  const cp = el.querySelector<HTMLButtonElement>("#wcopy");
  if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText(addr); cp.textContent = "Copied ✓"; } catch { cp.textContent = addr; } setTimeout(() => { if (cp.isConnected) cp.textContent = short(addr); }, 1500); };
}
