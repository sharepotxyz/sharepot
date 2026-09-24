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
    const intro = document.querySelector<HTMLElement>("[data-t='fc.intro']"), steps = document.querySelector<HTMLElement>("[data-t='fc.s1']")?.closest("ol");
    if (intro) intro.innerHTML = t("fc.evm.intro", { net: esc(NETWORK_NAME) });
    if (steps) steps.innerHTML = [t("fc.evm.s1", { faucet: esc(EVM.faucet) }), t("fc.evm.s2", { net: esc(NETWORK_NAME) }), t("fc.evm.s3")].map((s) => `<li>${s}</li>`).join("");
    list.innerHTML = STOCK_ORDER.filter((s) => STOCK_META[s]?.active !== false).flatMap((s) => tokensOf(s).map((tk) => `<span class="ftok">${tickerBadge(s, false, true)}<b>5 ${esc(tk.token)}</b><span class="note">${esc(tk.issuer)}</span></span>`)).join("") + `<span class="ftok"><b>+ 0.05 ETH</b><span class="note">${t("fc.forFees")}</span></span>`;
  } else {
    list.innerHTML = STOCK_ORDER.filter((s) => STOCK_META[s]?.active !== false).flatMap((s) => tokensOf(s).map((tk) => `<span class="ftok">${tickerBadge(s, false, true)}<b>${(tk.faucetUi ?? 2).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${esc(tk.token)}</b><span class="note">${esc(tk.issuer)}</span></span>`)).join("") + `<span class="ftok"><b>+ 0.01 SOL</b><span class="note">${t("fc.forFees")}</span></span>`;
  }
  render();
}
function render() {
  if (!IS_TEST) { box.innerHTML = `<p style="margin:0">${t("fc.testOnly")}</p>`; return; }
  const s = getSession();
  if (!HAS_FAUCET_API) {
    box.innerHTML = `<div class="thead"><b>${t("fc.get")}</b>${s ? `<span class="note mono">${short(s.address)}</span>` : ""}</div>
      <p class="note" style="margin:0">${t("fc.evm.s1", { faucet: esc(EVM.faucet) })}</p>
      <a class="primary big" style="display:block;text-align:center;text-decoration:none" href="${esc(EVM.faucet)}" target="_blank" rel="noopener">${t("fc.evm.open")}</a>
      <p class="note" style="margin:0">${t("fc.evm.more")}</p>`;
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
