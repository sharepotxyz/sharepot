import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { API_BASE, CLUSTER, IS_TEST } from "./config";
import { STATUS, connection, type MarketView } from "./chain";
import { STOCK_NAMES, STOCK_ORDER, symbolOf, tokenSymbol, uiAmount } from "./stocks";
import { connectWallet, devWallet, listWallets, type Session } from "./wallet";

/** HTML-escape anything that did not originate in our own source. */
export const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
export const isBase58 = (s: unknown) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(s);
export const fmtTs = (ts: number) => new Date(ts * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
export const short = (pk: PublicKey | string) => { const s = pk.toString(); return s.slice(0, 4) + "…" + s.slice(-4); };
export function statusPill(m: MarketView) {
  const now = Date.now() / 1000;
  const label = m.status === 0 ? (now < m.openTs ? "Upcoming" : now < m.closeTs ? "Betting open" : "Awaiting close") : m.status === 1 ? "Result proposed" : STATUS[m.status];
  const cls = m.status === 0 ? (now < m.closeTs ? "open" : "trading") : m.status === 1 ? "proposed" : STATUS[m.status].toLowerCase();
  return `<span class="pill ${cls}">${label}</span>`;
}
/** "2d 4h", "5h 12m", "8m" until ts; "closed" once passed. */
export function timeLeft(ts: number) {
  const s = ts - Date.now() / 1000; if (s <= 0) return "closed";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
// big drop → big gain runs red → green (finance convention)
const COLORS_4 = ["#e5484d", "#f5a524", "#6cc68e", "#12a150"];
const COLORS = ["#e5484d", "#f08c3a", "#f5a524", "#c3c65a", "#6cc68e", "#12a150", "#3b9ede", "#5b4bdb"];
export const bucketColor = (m: MarketView, i: number) => (m.nBuckets === 2 ? (i === 1 ? "var(--gain)" : "var(--drop)") : m.nBuckets === 4 ? COLORS_4[i] : COLORS[Math.round((i * (COLORS.length - 1)) / Math.max(1, m.nBuckets - 1))]);
/** Ticker monogram in a colour derived from the symbol (no third-party logos). */
export function tickerBadge(symbol: string, big = false) {
  let h = 0; for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="tick${big ? " big" : ""}" style="--h:${h}">${esc(symbol)}</span>`;
}

// ---------- top bar: brand, search, stock tabs, network badge, wallet ----------
type TopbarOpts = { active?: string; q?: string; onSearch?: (q: string) => void; onStock?: (s: string) => void };
let topOpts: TopbarOpts = {};
export function mountTopbar(opts: TopbarOpts = {}) {
  topOpts = opts;
  const nb = document.getElementById("netbadge"); if (nb && IS_TEST) nb.innerHTML = `<span class="netbadge" title="Test network: mock stock tokens, no real value">${CLUSTER === "devnet" ? "Devnet" : CLUSTER}</span>`;
  const q = document.getElementById("q") as HTMLInputElement | null;
  if (q) {
    q.value = opts.q ?? "";
    if (opts.onSearch) q.oninput = () => opts.onSearch!(q.value.trim());
    q.onkeydown = (e) => { if (e.key === "Enter" && !opts.onSearch) location.href = "/?q=" + encodeURIComponent(q.value.trim()); };
  }
  renderCatnav(opts.active ?? "");
  mountWallet();
}
/** Stock tabs under the top bar. On the home page they filter in place; elsewhere they link home with the filter set. */
export function renderCatnav(active: string) {
  const el = document.getElementById("catnav"); if (!el) return;
  const items = [["all", "All markets"], ...STOCK_ORDER.map((s) => [s, STOCK_NAMES[s] ?? s])];
  el.innerHTML = items.map(([k, label]) => topOpts.onStock
    ? `<button data-s="${esc(k)}" class="${active === k ? "on" : ""}">${esc(label)}</button>`
    : `<a href="/${k === "all" ? "" : "?stock=" + encodeURIComponent(k)}" class="${active === k ? "on" : ""}">${esc(label)}</a>`).join("");
  if (topOpts.onStock) el.querySelectorAll<HTMLButtonElement>("button[data-s]").forEach((b) => (b.onclick = () => topOpts.onStock!(b.dataset.s!)));
}

// ---------- wallet + balances ----------
let session: Session | null = null;
type Tracked = { symbol: string; token: string; mint: PublicKey; view: MarketView };
let tracked: Tracked[] = [];
export const balances: { sol: number; loaded: boolean; raw: Record<string, number> } = { sol: 0, loaded: false, raw: {} };
/** Pages tell the wallet which stock tokens to track (one entry per mint seen on screen). */
export function trackStocks(ms: MarketView[]) {
  const seen = new Map<string, Tracked>();
  for (const m of ms) if (!seen.has(m.mint.toBase58())) seen.set(m.mint.toBase58(), { symbol: symbolOf(m), token: tokenSymbol(m), mint: m.mint, view: m });
  tracked = [...seen.values()].sort((a, b) => STOCK_ORDER.indexOf(a.symbol) - STOCK_ORDER.indexOf(b.symbol) || a.token.localeCompare(b.token));
  refreshBalances();
}
/** Raw balance of this market's token in the connected wallet. */
export const shareBalance = (m: MarketView) => balances.raw[m.mint.toBase58()] ?? 0;
/** SOL + every tracked token balance of the connected wallet in two RPC calls (all of the wallet's accounts per token
 *  program at once, not one call per token), so public RPC rate limits are not hit. Concurrent calls share one request. */
let refreshing: Promise<void> | null = null;
export function refreshBalances(): Promise<void> {
  if (!session) { balances.loaded = false; renderWallet(); return Promise.resolve(); }
  if (refreshing) return refreshing;
  const owner = session.publicKey;
  refreshing = (async () => {
    try {
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
    } catch { balances.loaded = false; }
    renderWallet();
  })().finally(() => { refreshing = null; });
  return refreshing;
}
const listeners: ((s: Session | null) => void)[] = [];
export const onSession = (fn: (s: Session | null) => void) => { listeners.push(fn); fn(session); };
export const getSession = () => session;
function setSession(s: Session | null) { session = s; menuOpen = false; try { s ? localStorage.setItem("sharepot.wallet", s.label) : localStorage.removeItem("sharepot.wallet"); } catch {} balances.loaded = false; listeners.forEach((f) => f(s)); renderWallet(); refreshBalances(); }

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
  const held = tracked.filter((t) => (balances.raw[t.mint.toBase58()] ?? 0) > 0);
  const holdings = !balances.loaded ? `<div class="note" style="padding:4px 6px">loading…</div>` : held.length
    ? held.map((t) => `<div class="hold"><span>${esc(t.token)}</span><span class="mono">${uiAmount(t.view, balances.raw[t.mint.toBase58()]).toLocaleString("en-US", { maximumFractionDigits: 4 })}</span></div>`).join("")
    : `<div class="note" style="padding:4px 6px">No stock tokens yet.</div>`;
  el.innerHTML = `<button class="wbtn" id="wbtn"><span class="dot"></span><span class="mono">${short(session.publicKey)}</span>${balances.loaded ? `<span class="note">${balances.sol.toFixed(3)} SOL</span>` : ""}</button>${menuOpen ? `<div class="menu" id="wmenu">
    <div class="mh">${esc(session.label)}</div><div id="wholdings">${holdings}</div>${balances.loaded && balances.sol < 0.002 ? `<div class="note warn" style="padding:4px 6px">Not enough SOL for network fees.</div>` : ""}<hr>
    ${IS_TEST && API_BASE ? `<button id="wfaucet" title="2 shares of every mock stock token + a little SOL for fees, once per day">Get test stocks</button>` : ""}
    <a class="mi" href="/portfolio.html">My bets</a><button id="wdis">Disconnect</button></div>` : ""}`;
  el.querySelector<HTMLButtonElement>("#wbtn")!.onclick = (e) => { e.stopPropagation(); menuOpen = !menuOpen; renderWallet(); };
  const dis = el.querySelector<HTMLButtonElement>("#wdis"); if (dis) dis.onclick = async () => { await session?.disconnect(); setSession(null); };
  const f = el.querySelector<HTMLButtonElement>("#wfaucet");
  if (f) f.onclick = async (e) => {
    e.stopPropagation(); f.disabled = true; f.textContent = "Sending…";
    let label = "Failed";
    try { const r = await fetch(API_BASE + "/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: session!.publicKey.toBase58() }) }); const j = await r.json(); label = r.ok ? `Got ${j.sent}` : (j.error ?? "Failed"); }
    catch { label = "Faucet unreachable"; }
    await refreshBalances();
    const f2 = document.querySelector<HTMLButtonElement>("#wfaucet"); if (f2) { f2.disabled = true; f2.textContent = label; setTimeout(() => { const f3 = document.querySelector<HTMLButtonElement>("#wfaucet"); if (f3) { f3.disabled = false; f3.textContent = "Get test stocks"; } }, 6000); }
    listeners.forEach((fn) => fn(session));
  };
}
