// Test-network faucet page. Kept apart from the wallet menu on purpose: on mainnet this page and its nav links go away
// and nothing else changes.
import { fetchMarkets } from "./chain";
import { STOCK_META, STOCK_ORDER, loadPrices, loadStocks, tokensOf } from "./stocks";
import { esc, getSession, mountTopbar, onSession, openWalletMenu, refreshBalances, short, tickerBadge, trackStocks } from "./ui";
import { API_BASE, IS_TEST, explorerTx } from "./config";

mountTopbar({});
const box = document.getElementById("faucet")!, list = document.getElementById("ftokens")!;
let busy = false, result = "";

async function init() {
  const [ms] = await Promise.all([fetchMarkets(), loadStocks(), loadPrices()]);
  trackStocks(ms);
  list.innerHTML = STOCK_ORDER.filter((s) => STOCK_META[s]?.active !== false).flatMap((s) => tokensOf(s).map((t) => `<span class="ftok">${tickerBadge(s, false, true)}<b>${(t.faucetUi ?? 2).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${esc(t.token)}</b><span class="note">${esc(t.issuer)}</span></span>`)).join("") + `<span class="ftok"><b>+ 0.01 SOL</b><span class="note">for network fees</span></span>`;
  render();
}
function render() {
  if (!IS_TEST) { box.innerHTML = `<p style="margin:0">The faucet only exists on test networks.</p>`; return; }
  const s = getSession();
  box.innerHTML = s
    ? `<div class="thead"><b>Get test tokens</b><span class="note mono">${short(s.publicKey)}</span></div>
       <p class="note" style="margin:0">Sends the tokens on the left to this wallet. One claim per wallet per day.</p>
       <button class="primary big" id="fbtn"${busy ? " disabled" : ""}>${busy ? "Sending…" : "Get test tokens"}</button><div id="fmsg">${result}</div>`
    : `<div class="thead"><b>Get test tokens</b></div>
       <p class="note" style="margin:0">Connect a wallet first — Phantom, Solflare or Backpack set to devnet, or the built-in browser test wallet.</p>
       <button class="primary big" id="fconnect">Connect wallet</button>`;
  const c = document.getElementById("fconnect"); if (c) c.onclick = (e) => { e.stopPropagation(); openWalletMenu(); };
  const b = document.getElementById("fbtn") as HTMLButtonElement | null;
  if (b) b.onclick = async () => {
    busy = true; result = ""; render();
    try {
      const r = await fetch(API_BASE + "/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: getSession()!.publicKey.toBase58() }) });
      const j = await r.json();
      result = r.ok
        ? `<div class="msg ok">Sent ${esc(j.sent)}. ${(j.signatures ?? []).map((sig: string, i: number) => `<a href="${explorerTx(sig)}" target="_blank" rel="noopener">tx ${i + 1}</a>`).join(" · ")}<br><a href="/">Pick a market →</a></div>`
        : `<div class="msg err">${esc(j.error ?? "The faucet could not send right now.")}</div>`;
    } catch { result = `<div class="msg err">Faucet unreachable — try again in a minute.</div>`; }
    busy = false; await refreshBalances(); render();
  };
}
onSession(() => render());
init().catch((e) => (box.innerHTML = `<div class="msg err">Could not load: ${esc(e.message ?? e)}</div>`));
