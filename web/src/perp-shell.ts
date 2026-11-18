// SharePot Perp: the frame every page shares, in the same look as the other SharePot sites — the top bar (brand, the
// four pages, the chain switch, language, network badge, wallet), the ☰ menu on narrow screens, the footer (contracts,
// source verification, links) and the feedback button. Pages call mountShell(<their name>) and listen with onSession.
import { PERP } from "./config";
import { connectWallet, devWallet, listWallets, type Session } from "./wallet-evm";
import { LANGS, setLang } from "./i18n";
import { P, PL, TESTNET, TOKEN, addrLink, errText, esc, geo, noSend, pc, pt, txLink } from "./perp-core";

const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#5b4bdb"/><g fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"><path d="M24 23c-4-4 4-7 0-11"/><path d="M40 23c-4-4 4-7 0-11"/></g><rect x="6" y="30" width="52" height="8" rx="4" fill="#fff"/><path d="M12 30h40v8a16 16 0 0 1-16 16h-8a16 16 0 0 1-16-16z" fill="#fff"/><path d="M17 36h13v13.5a11 11 0 0 1-13-11z" fill="#ffd166"/><path d="M47 36H34v13.5a11 11 0 0 0 13-11z" fill="#f2545b"/></svg>`;
export type PageName = "pool" | "history" | "me" | "faucet" | "docs";
// the faucet only on a test network: a mainnet build has no link to it
const PAGES: [PageName, string, string][] = ([["pool", "/", "nav.pool"], ["history", "/history", "nav.history"], ["me", "/me", "nav.me"], ["faucet", "/faucet", "nav.faucet"], ["docs", "/docs", "nav.docs"]] as [PageName, string, string][]).filter(([k]) => k !== "faucet" || TESTNET);
// The same product family on the other chains (the four-range daily pools): one-way links, see the docs.
const OTHERS: [string, string, string][] = [["rh", "Robinhood", "https://robinhood.sharepot.xyz"], ["sol", "Solana", "https://devnet.sharepot.xyz"]];

// ---------------------------------------------------------------- site API flags
/** /api/health: whether this site hands out test ETH for fees, and which wallets are ours (demo bots, the treasury). */
export const health: { faucet: boolean; demoWallets: string[]; treasury: string | null } = { faucet: false, demoWallets: [], treasury: null };
const isHex40 = (a: unknown) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
/** "bot" / "treasury" when `addr` is one of ours, else null. */
export const oursKind = (addr: string) => (health.demoWallets.some((a) => a.toLowerCase() === addr.toLowerCase()) ? "bot" : health.treasury && health.treasury.toLowerCase() === addr.toLowerCase() ? "treasury" : null);
const healthListeners: (() => void)[] = [];
export const onHealth = (fn: () => void) => { healthListeners.push(fn); };
// A few tries: until it answers, nothing can be sent (geo.known stays false).
async function loadHealth(tries = 4): Promise<any> {
  for (let i = 0; ; i++) {
    try { const r = await fetch("/api/health", { cache: "no-store" }); if (r.ok) return await r.json(); } catch {}
    if (i + 1 >= tries) return null;
    await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));
  }
}
loadHealth().then((h) => {
  if (!h) return;
  geo.known = true; geo.blocked = h.blocked === true;
  health.faucet = !!h?.faucet;
  health.demoWallets = Array.isArray(h?.demoWallets) ? h.demoWallets.filter(isHex40) : [];
  health.treasury = isHex40(h?.treasury) ? h.treasury : null;
  healthListeners.forEach((f) => f());
}).catch(() => {});
/** Asks the site's faucet for fee ETH for `addr` and waits for it to land; the result line (HTML). */
export async function askGas(addr: string): Promise<string> {
  const r = await fetch("/api/gas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: addr }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  setTimeout(refreshWallet, 500);
  return j.sent ? esc(pt("faucet.gasSent", { eth: j.sent })) + txLink(j.tx) : esc(pt("faucet.gasEnough"));
}

// ---------------------------------------------------------------- wallet session
let session: Session | null = null;
let eth: bigint | null = null;
let walletMenu = false, navMenu = false;
const WALLET_KEY = "sharepot.perp.wallet", TEST_WALLET = "Test wallet (browser)";
const listeners: ((s: Session | null) => void)[] = [];
export const getSession = () => session;
/** Called on every connect / disconnect — and at once if a wallet is already connected (mountShell reconnects the last
 *  wallet before the page has registered its listener). */
export const onSession = (fn: (s: Session | null) => void) => { listeners.push(fn); if (session) fn(session); };
/** The connected wallet's ETH for fees (null = not read yet). */
export const walletEth = () => eth;
function setSession(s: Session | null) {
  session = s; walletMenu = false; eth = null;
  try { s ? localStorage.setItem(WALLET_KEY, s.label) : localStorage.removeItem(WALLET_KEY); } catch {}
  renderWallet(); refreshWallet();
  listeners.forEach((f) => { try { f(s); } catch (e) { console.error(e); } });
}
export async function refreshWallet() {
  if (!session) { renderWallet(); return; }
  try { eth = await pc.getBalance({ address: session.address as `0x${string}` }); } catch {}
  renderWallet();
}
function renderWallet() {
  const el = document.getElementById("pwallet"); if (!el) return;
  if (!session) {
    const ws = listWallets();
    el.innerHTML = `<button class="primary wbtn" id="pwbtn">${esc(pt("wallet.connect"))}</button>${walletMenu ? `<div class="menu" id="pwmenu"><div class="mh">${esc(pt("wallet.pick"))}</div>${ws.map((w, i) => `<button data-i="${i}">${esc(w.name)}</button>`).join("")}${TESTNET ? `<button id="pwdev">${esc(pt("wallet.test"))}</button>` : ""}${ws.length ? "" : `<div class="note" style="padding:6px">${esc(pt("wallet.none"))}</div>`}</div>` : ""}`;
    el.querySelectorAll<HTMLButtonElement>("button[data-i]").forEach((b) => (b.onclick = async () => { try { setSession(await connectWallet(ws[Number(b.dataset.i)])); } catch (e) { alert(errText(e)); } }));
    const d = el.querySelector<HTMLButtonElement>("#pwdev"); if (d) d.onclick = () => setSession(devWallet());
  } else {
    const a = session.address, ethTxt = eth != null ? `<span class="note">${(Number(eth) / 1e18).toFixed(4)} ETH</span>` : "";
    el.innerHTML = `<button class="wbtn" id="pwbtn"><span class="dot"></span><span class="mono">${esc(a.slice(0, 6) + "…" + a.slice(-4))}</span>${ethTxt}</button>${walletMenu ? `<div class="menu" id="pwmenu">
      <div class="mh">${esc(session.label === TEST_WALLET ? pt("wallet.test") : session.label)}${eth != null ? ` · ${(Number(eth) / 1e18).toFixed(4)} ETH` : ""}</div>
      <button id="pwcopy">${esc(pt("wallet.copy"))}</button><a class="mi" href="/me">${esc(pt("nav.me"))}</a><button id="pwdis">${esc(pt("wallet.disconnect"))}</button></div>` : ""}`;
    const cp = el.querySelector<HTMLButtonElement>("#pwcopy"); if (cp) cp.onclick = async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(a); cp.textContent = pt("wallet.copied"); } catch { cp.textContent = a; } };
    const dis = el.querySelector<HTMLButtonElement>("#pwdis"); if (dis) dis.onclick = async () => { await session?.disconnect(); setSession(null); };
  }
  el.querySelector<HTMLButtonElement>("#pwbtn")!.onclick = (e) => { e.stopPropagation(); walletMenu = !walletMenu; navMenu = false; renderNavMenu(); renderWallet(); };
}

// ---------------------------------------------------------------- top bar
const langOptions = () => LANGS.map(([k, n]) => `<option value="${k}"${k === PL ? " selected" : ""}>${esc(n)}</option>`).join("");
const chainSwitch = () => `<span class="chains" title="${esc(pt("nav.chainsTitle"))}"><span class="on base">Base</span>${OTHERS.map(([c, n, u]) => `<a class="${c}" href="${esc(u)}">${esc(n)}</a>`).join("")}</span>`;
let activePage: PageName = "pool";
function renderNavMenu() {
  const box = document.getElementById("pnavbox"); if (!box) return;
  box.querySelector(".menu")?.remove();
  if (navMenu) {
    const m = document.createElement("div"); m.className = "menu navmenu";
    m.innerHTML = PAGES.map(([k, href, key]) => `<a class="mi${k === activePage ? " cta" : ""}" href="${href}">${esc(pt(key))}</a>`).join("")
      + `<hr><div class="langrow" style="display:block;padding:4px 6px"><select class="langsel" aria-label="${esc(pt("lang.label"))}" style="width:100%;max-width:none">${langOptions()}</select></div><div style="padding:4px 6px">${chainSwitch()}</div>`;
    const ls = m.querySelector<HTMLSelectElement>("select")!; ls.onclick = (e) => e.stopPropagation(); ls.onchange = () => setLang(ls.value);
    box.appendChild(m);
  }
  box.querySelector("#pnavbtn")?.setAttribute("aria-expanded", String(navMenu));
}
document.addEventListener("click", (e) => {
  const w = document.getElementById("pwallet"), n = document.getElementById("pnavbox");
  if (walletMenu && w && !w.contains(e.target as Node)) { walletMenu = false; renderWallet(); }
  if (navMenu && n && !n.contains(e.target as Node)) { navMenu = false; renderNavMenu(); }
});

export function mountShell(page: PageName) {
  activePage = page;
  const top = document.getElementById("ptop")!;
  top.className = "topbar";
  top.innerHTML = `<div class="container tb">
    <a class="brand" href="/">${LOGO}<span>SharePot <small class="pbrand">Perp</small></span></a>
    <nav class="tb-right">
      ${PAGES.map(([k, href, key]) => `<a class="navlink${k === page ? " on" : ""}" href="${href}"${k === page ? ' aria-current="page"' : ""}>${esc(pt(key))}</a>`).join("")}
      <div class="navmorebox" id="pnavbox"><button class="navmore" id="pnavbtn" aria-label="${esc(pt("nav.menu"))}" aria-expanded="false">☰</button></div>
      <span class="pchains">${chainSwitch()}</span>
      <select id="plang" class="langsel" aria-label="${esc(pt("lang.label"))}">${langOptions()}</select>
      <span class="netbadge">${esc(TESTNET ? pt("net.test") : pt("net.main"))}</span>
      <div id="pwallet" class="walletbox"></div>
    </nav></div>`;
  (document.getElementById("plang") as HTMLSelectElement).onchange = (e) => setLang((e.target as HTMLSelectElement).value);
  document.getElementById("pnavbtn")!.onclick = (e) => { e.stopPropagation(); navMenu = !navMenu; walletMenu = false; renderWallet(); renderNavMenu(); };
  // footer: what this is, who controls the token, the contracts (their source is verified on Sourcify), the links
  const foot = document.getElementById("pfoot");
  if (foot) foot.innerHTML = `<p>${esc(pt("foot"))}</p>
    <p>${pt("foot.issuer")}</p>
    <p>${esc(pt("foot.contracts"))} ${esc(pt("foot.pool"))} ${addrLink(P)} · ${esc(pt("foot.token", { tok: PERP.tokenSymbol }))} ${addrLink(TOKEN)} · <a href="https://repo.sourcify.dev/84532/${esc(P)}" target="_blank" rel="noopener">${esc(pt("foot.verified"))}</a></p>
    <p class="social"><a href="https://x.com/sharepotxyz" target="_blank" rel="noopener">X @sharepotxyz</a> · <a href="https://github.com/sharepotxyz/sharepot" target="_blank" rel="noopener">GitHub</a> · <a href="mailto:hello@sharepot.xyz">hello@sharepot.xyz</a></p>`;
  mountFeedback();
  renderWallet();
  // reconnect the last wallet
  try {
    const last = localStorage.getItem(WALLET_KEY);
    if (last === TEST_WALLET) { if (TESTNET) setSession(devWallet()); }   // never a browser key wallet on a mainnet build
    else if (last) setTimeout(async () => { const w = listWallets().find((x) => x.name === last); if (w) try { setSession(await connectWallet(w)); } catch {} }, 300);
  } catch {}
  setInterval(() => { if (document.visibilityState === "visible") refreshWallet(); }, 60_000);
}

// ---------------------------------------------------------------- feedback
function mountFeedback() {
  if (document.getElementById("fbbtn")) return;
  const btn = document.createElement("button"); btn.id = "fbbtn"; btn.className = "fbbtn"; btn.setAttribute("aria-label", pt("fb.button"));
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v11H8l-4 4z"/></svg><span>${esc(pt("fb.button"))}</span>`;
  document.body.appendChild(btn);
  btn.onclick = () => {
    if (document.getElementById("fbbox")) return;
    const box = document.createElement("div"); box.id = "fbbox"; box.className = "fbbox";
    box.innerHTML = `<div class="fbhead"><b>${esc(pt("fb.head"))}</b><button class="ghost" id="fbx" aria-label="${esc(pt("fb.close"))}">✕</button></div>
      <textarea id="fbmsg" rows="5" maxlength="4000" placeholder="${esc(pt("fb.msgPh"))}"></textarea>
      <input id="fbcontact" maxlength="200" placeholder="${esc(pt("fb.contactPh"))}">
      <input id="fbweb" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
      <div class="fbrow"><span class="note" id="fbnote">${pt("fb.orEmail")}</span><button class="primary" id="fbsend">${esc(pt("fb.send"))}</button></div>`;
    document.body.appendChild(box);
    const $ = <T extends HTMLElement>(id: string) => box.querySelector<T>("#" + id)!;
    const msg = $<HTMLTextAreaElement>("fbmsg"), send = $<HTMLButtonElement>("fbsend"), note = $("fbnote");
    msg.focus();
    $("fbx").onclick = () => box.remove();
    send.onclick = async () => {
      if (msg.value.trim().length < 5) { note.textContent = pt("fb.tooShort"); return; }
      send.disabled = true; send.textContent = pt("fb.sending");
      try {
        const r = await fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg.value, contact: $<HTMLInputElement>("fbcontact").value, website: $<HTMLInputElement>("fbweb").value, page: location.pathname + location.search, wallet: session ? session.address : null }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? "HTTP " + r.status);
        box.innerHTML = `<div class="fbhead"><b>${esc(pt("fb.thanks"))}</b></div><div class="note">${esc(pt("fb.thanksNote"))}</div>`;
        setTimeout(() => box.remove(), 2500);
      } catch (e) { note.textContent = pt("fb.fail", { err: errText(e) }); send.disabled = false; send.textContent = pt("fb.send"); }
    };
  };
}

/** Pages that send transactions: false for visitors the server flagged (and nothing is sent without a wallet). */
export const canSend = () => !!session && !noSend();
