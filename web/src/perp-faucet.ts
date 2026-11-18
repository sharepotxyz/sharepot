// SharePot Perp — the test-network faucet (/faucet): what a new wallet needs before it can try the pool, a little test
// ETH for fees and test stock tokens (one per pool: NVDAc, TSLAc, METAc …), on its own page so the pool page only shows the pool. Test networks only: on a
// mainnet build the nav has no link here and this page says there is no faucet.
import type { Address } from "viem";
import { PERP } from "./config";
import type { Session } from "./wallet-evm";
import { ONE, POOLS, TESTNET, erc20, symbolList, tokenList, errText, esc, geo, httpsUrl, noSend, pc, pt, tok, txLink } from "./perp-core";
import { askGas, health, mountShell, onHealth, onSession, refreshWallet } from "./perp-shell";

let session: Session | null = null;
/** Each pool's stock token in the wallet (POOLS order; null = not read yet), ETH for fees. */
let bals: (bigint | null)[] = POOLS.map(() => null), eth: bigint | null = null, busy = false, msg = "";

async function refresh() {
  const s = session;
  if (!s) { bals = POOLS.map(() => null); eth = null; render(); return; }
  try {
    const a = s.address as Address;
    const [e, ...bs] = await Promise.all([pc.getBalance({ address: a }), ...POOLS.map((p) => pc.readContract({ address: p.token as Address, abi: erc20, functionName: "balanceOf", args: [a] }) as Promise<bigint>)]);
    if (session === s) { bals = bs; eth = e; }   // a wallet switched meanwhile keeps its own numbers
  } catch {}
  render(); refreshWallet();
}

function render() {
  const root = document.getElementById("perp")!;
  if (!TESTNET) { root.innerHTML = `<section class="phero"><h1>${esc(pt("fc.h1"))}</h1></section><div class="note">${esc(pt("fc.mainnet"))}</div>`; return; }
  const head = `<section class="phero"><h1>${esc(pt("fc.h1"))}</h1><p>${esc(pt("faucet.p", { tok: tokenList() }))}</p>${geo.blocked ? `<div class="note warn">${pt("rules.7", { sym: esc(symbolList()) })}</div>` : ""}</section>`;
  const steps = `<div class="fcard"><ol class="fsteps">
    <li>${pt("fc.s1", { test: esc(pt("wallet.test")) })}</li><li>${esc(pt("fc.s2"))}</li><li>${esc(pt("fc.s3", { tok: tokenList("disjunction") }))}</li><li>${pt("fc.s4")}</li></ol></div>`;
  const off = !session || busy || noSend();
  const have = (v: string | null) => (v == null ? "" : `<span class="note">${esc(pt("fc.bal", { v }))}</span>`);
  const action = !session
    ? `<div class="fcard"><div class="note">${esc(pt("fc.connect"))}</div><button class="primary" id="fconnect">${esc(pt("wallet.connect"))}</button></div>`
    : `<div class="fcard">
      <div><div class="tlabel"><span>${esc(pt("fc.eth"))}</span>${have(eth == null ? null : `${(Number(eth) / 1e18).toFixed(4)} ETH`)}</div>
        <div class="prow" style="margin-top:8px">${health.faucet ? `<button id="pgas" ${off ? "disabled" : ""}>${esc(pt("faucet.gas"))}</button>` : `<a class="btn" href="${esc(httpsUrl(PERP.gasFaucet))}" target="_blank" rel="noopener">${esc(pt("faucet.gas"))}</a>`}</div></div>
      ${POOLS.map((p, i) => `<div><div class="tlabel"><span>${esc(pt("fc.tok", { tok: p.tokenSymbol }))}</span>${have(bals[i] == null ? null : `${tok(bals[i]!)} ${p.tokenSymbol}`)}</div>
        <div class="prow" style="margin-top:8px"><button data-mint="${i}" ${off ? "disabled" : ""}>${esc(pt("faucet.mint", { tok: p.tokenSymbol }))}</button></div></div>`).join("")}
      ${eth === 0n && health.faucet ? `<div class="note">${esc(pt("fc.autoGas"))}</div>` : ""}
      ${msg ? `<div class="note pmsg" style="margin-top:0">${msg}</div>` : ""}
      ${bals.some((b) => b != null && b > 0n) ? `<a class="btn primary" href="/" style="text-align:center">${esc(pt("fc.toPool"))}</a>` : ""}
    </div>`;
  root.innerHTML = head + `<div class="fwrap">${steps}${action}</div>`;
  bind();
}

async function run(fn: () => Promise<string>) {
  if (busy) return;
  busy = true; msg = esc(pt("ord.sending")); render();
  try { msg = await fn(); }
  catch (e: any) { msg = e?.unconfirmed ? esc(pt("ord.notConfirmed")) + txLink(e.txid) : `<span class="warn">${esc(pt("err", { err: errText(e) }))}</span>`; }
  finally { busy = false; await refresh(); }
}

function bind() {
  const c = document.getElementById("fconnect");
  // the wallet menu lives in the top bar; this opens it (stopPropagation: the page-wide click handler closes menus)
  if (c) c.onclick = (e) => { e.stopPropagation(); window.scrollTo({ top: 0 }); document.getElementById("pwbtn")?.click(); };
  document.querySelectorAll<HTMLButtonElement>("button[data-mint]").forEach((b) => (b.onclick = () => run(async () => {
    const p = POOLS[Number(b.dataset.mint)];
    let pre = "";
    if (health.faucet && eth === 0n) { msg = esc(pt("faucet.gasAsking")); render(); pre = (await askGas(session!.address)) + "<br>"; }   // a fresh wallet cannot pay for the mint
    const h = await session!.write!({ address: p.token as Address, abi: erc20, functionName: "mint", args: [session!.address, 100n * ONE] });
    return pre + esc(pt("faucet.minted", { tok: p.tokenSymbol })) + txLink(h);
  })));
  const gasBtn = document.getElementById("pgas");
  if (gasBtn) gasBtn.onclick = () => run(() => askGas(session!.address));
}

// ---------------------------------------------------------------- boot
mountShell("faucet");
document.title = `SharePot Perp · ${pt("fc.h1")}`;
onSession((s) => { session = s; msg = ""; bals = POOLS.map(() => null); eth = null; refresh(); });
onHealth(() => render());
render();
setInterval(() => { if (!busy && document.visibilityState === "visible") refresh(); }, 30_000);
