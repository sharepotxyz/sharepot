// Test-network faucet page. Kept apart from the wallet menu on purpose: on mainnet this page and its nav links go away
// and nothing else changes. On Solana devnet the site's own faucet sends mock tokens; on Robinhood Chain testnet the
// issuer's faucet hands out the test Stock Tokens themselves, so the page points there.
import { fetchMarkets } from "@chain";
import { STOCK_META, STOCK_ORDER, loadPrices, loadStocks, tokensOf } from "./stocks";
import { esc, getSession, mountTopbar, onSession, openWalletMenu, refreshBalances, short, tickerBadge, trackStocks } from "./ui";
import { API_BASE, EVM, HAS_FAUCET_API, IS_EVM, IS_TEST, NETWORK_NAME, explorerTx } from "./config";
import { t } from "./i18n";

mountTopbar({});
const box = document.getElementById("faucet")!, list = document.getElementById("ftokens")!;
let busy = false, result = "";

async function init() {
  const [ms] = await Promise.all([fetchMarkets(), loadStocks(), loadPrices()]);
  trackStocks(ms);
  if (IS_EVM) {
    // the static intro and steps describe the Solana devnet faucet; this chain gets its own words
    // left card = the issuer's stock tokens, which only Robinhood's faucet hands out; right card (#faucet) = the memes,
    // mock tokens this site lets the wallet mint. Two cards so nobody reads "faucet" as "this site sends stocks".
    const left = list.closest(".fcard") as HTMLElement | null;
    const stockToks = STOCK_ORDER.filter((s) => STOCK_META[s]?.active !== false).flatMap((s) => tokensOf(s).filter((tk) => !tk.mock).map((tk) => `<span class="ftok">${tickerBadge(s, false, true)}<b>5 ${esc(tk.token)}</b><span class="note">${esc(tk.issuer)}</span></span>`)).join("") + `<span class="ftok"><b>+ 0.05 ETH</b><span class="note">${t("fc.forFees")}</span></span>`;
    if (left) left.innerHTML = `<div class="thead"><b>${t("fc.evm.stocksHead")}</b></div>
      <p style="margin:0">${t("fc.evm.intro", { net: esc(NETWORK_NAME) })}</p>
      <div><div class="tlabel">${t("fc.evm.stocksLabel")}</div><div class="ftoks">${stockToks}</div></div>
      <ol class="fsteps">${[t("fc.evm.s1", { faucet: esc(EVM.faucet) }), t("fc.evm.s2", { net: esc(NETWORK_NAME) }), t("fc.evm.s3")].map((x) => `<li>${x}</li>`).join("")}</ol>
      <a class="primary big" style="display:block;text-align:center;text-decoration:none" href="${esc(EVM.faucet)}" target="_blank" rel="noopener">${t("fc.evm.open")}</a>
      <p class="note" style="margin:0">${t("fc.evm.more")}</p>`;
  } else {
    list.innerHTML = STOCK_ORDER.filter((s) => STOCK_META[s]?.active !== false).flatMap((s) => tokensOf(s).map((tk) => `<span class="ftok">${tickerBadge(s, false, true)}<b>${(tk.faucetUi ?? 2).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${esc(tk.token)}</b><span class="note">${esc(tk.issuer)}</span></span>`)).join("") + `<span class="ftok"><b>+ 0.01 SOL</b><span class="note">${t("fc.forFees")}</span></span>`;
  }
  render();
}
function render() {
  if (!IS_TEST) { box.innerHTML = `<p style="margin:0">${t("fc.testOnly")}</p>`; return; }
  const s = getSession();
  if (!HAS_FAUCET_API) {
    // testnet memes are mocks whose mint is public: the wallet mints them itself, one transaction per token
    const mocks = STOCK_ORDER.filter((sy) => STOCK_META[sy]?.active !== false).flatMap((sy) => tokensOf(sy).filter((tk) => tk.mock && tk.mint));
    const memeToks = mocks.map((tk) => `<span class="ftok">${tickerBadge(tk.symbol, false, true)}<b>${(tk.faucetUi ?? 1).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${esc(tk.token)}</b><span class="note">${esc(tk.issuer)}</span></span>`).join("");
    box.innerHTML = `<div class="thead"><b>${t("fc.evm.memes")}</b>${s ? `<span class="note mono">${short(s.address)}</span>` : ""}</div>
      <p class="note" style="margin:0">${mocks.length ? t("fc.evm.memesNote", { n: mocks.length }) : t("fc.evm.memesNone")}</p>
      ${mocks.length ? `<div><div class="tlabel">${t("fc.evm.mintLabel")}</div><div class="ftoks">${memeToks}</div></div>
      ${s ? `<button class="primary big" id="mintbtn"${busy ? " disabled" : ""}>${busy ? t("fb.sending") : t("fc.evm.mint")}</button>` : `<button class="primary big" id="fconnect">${t("common.connectWallet")}</button>`}<div id="fmsg">${result}</div>` : ""}`;
    const c = document.getElementById("fconnect"); if (c) c.onclick = (e) => { e.stopPropagation(); openWalletMenu(); };
    const mb = document.getElementById("mintbtn") as HTMLButtonElement | null;
    if (mb) mb.onclick = async () => {
      const sess = getSession(); if (!sess?.mintMock) return;
      busy = true; result = ""; render();
      const done: string[] = [], failed: string[] = [];
      for (const tk of mocks) {
        try { const amt = BigInt(Math.round((tk.faucetUi ?? 1) * 10 ** tk.decimals)); await sess.mintMock(tk.mint!, amt); done.push(tk.token); result = `<div class="msg">${esc(done.join(", "))}…</div>`; render(); }
        catch (e: any) { failed.push(tk.token); if (/reject|denied|cancel/i.test(String(e?.message ?? e))) break; }
      }
      result = done.length ? `<div class="msg ok">${t("fc.evm.minted", { list: esc(done.join(", ")) })}${failed.length ? ` <span class="note">${t("fc.evm.mintFailed", { list: esc(failed.join(", ")) })}</span>` : ""}<br><a href="/?cat=memes">${t("fc.pick")}</a></div>` : `<div class="msg err">${t("fc.evm.mintFailed", { list: esc(failed.join(", ")) })}</div>`;
      busy = false; await refreshBalances(); render();
    };
    return;
  }
  box.innerHTML = s
    ? `<div class="thead"><b>${t("fc.get")}</b><span class="note mono">${short(s.address)}</span></div>
       <p class="note" style="margin:0">${t("fc.sends")}</p>
       <button class="primary big" id="fbtn"${busy ? " disabled" : ""}>${busy ? t("fb.sending") : t("fc.get")}</button><div id="fmsg">${result}</div>`
    : `<div class="thead"><b>${t("fc.get")}</b></div>
       <p class="note" style="margin:0">${t("fc.connectFirst")}</p>
       <button class="primary big" id="fconnect">${t("common.connectWallet")}</button>`;
  const c = document.getElementById("fconnect"); if (c) c.onclick = (e) => { e.stopPropagation(); openWalletMenu(); };
  const b = document.getElementById("fbtn") as HTMLButtonElement | null;
  if (b) b.onclick = async () => {
    busy = true; result = ""; render();
    try {
      const r = await fetch(API_BASE + "/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: getSession()!.address }) });
      const j = await r.json();
      result = r.ok
        ? `<div class="msg ok">${t("fc.sent", { what: esc(j.sent) })} ${(j.signatures ?? []).map((sig: string, i: number) => `<a href="${explorerTx(sig)}" target="_blank" rel="noopener">tx ${i + 1}</a>`).join(" · ")}<br><a href="/">${t("fc.pick")}</a></div>`
        : `<div class="msg err">${esc(j.error ?? t("fc.err"))}</div>`;
    } catch { result = `<div class="msg err">${t("fc.unreachable")}</div>`; }
    busy = false; await refreshBalances(); render();
  };
}
onSession(() => render());
init().catch((e) => (box.innerHTML = `<div class="msg err">${t("fc.loadErr", { err: esc(e.message ?? e) })}</div>`));
