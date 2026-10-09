import { NO_OUTCOME, fetchConfig, fetchMarkets, fetchPositionsByOwner, payoutIfBucket, type MarketView } from "@chain";
import { bucketLabel, bucketName, fmtAmt, fmtMove, issuerOf, loadPrices, loadStocks, question, tokenSymbol, usdOf } from "./stocks";
import { esc, fmtTs, mountTopbar, onSession, statusPill, timeLeft, trackStocks } from "./ui";
import { API_BASE, explorerTx, isTxId } from "./config";
import { t } from "./i18n";

mountTopbar({});
const openEl = document.getElementById("open")!, settledEl = document.getElementById("settled")!;
const label = (m: MarketView, i: number) => bucketName(m, i) || bucketLabel(m, i);

async function render(owner: string | null) {
  if (!owner) { openEl.innerHTML = `<div class="note">${t("pf.connect")}</div>`; settledEl.innerHTML = `<div class="note">—</div>`; return; }
  openEl.innerHTML = `<div class="note">${t("common.loading")}</div>`;
  const [markets, positions, cfg] = await Promise.all([fetchMarkets(), fetchPositionsByOwner(owner), fetchConfig(), loadPrices(), loadStocks()]);
  const win = cfg.disputeWindowSecs;
  trackStocks(markets);
  const byAddr = new Map(markets.map((m) => [m.address, m])), byId = new Map(markets.map((m) => [m.id, m]));
  const rows = positions.map((p) => ({ p, m: byAddr.get(p.marketAddress) ?? byId.get(p.marketId) })).filter((x) => x.m) as { p: (typeof positions)[number]; m: MarketView }[];
  if (!rows.length) openEl.innerHTML = `<div class="note">${t("pf.none")}</div>`;
  else openEl.innerHTML = `<div class="scroll"><table class="tbl"><thead><tr><th>${t("pf.colMarket")}</th><th>${t("pf.colStakes")}</th><th>${t("pf.colStatus")}</th><th class="r">${t("pf.colWorth")}</th></tr></thead><tbody>${rows.map(({ p, m }) => {
    const tok = esc(tokenSymbol(m));
    // where this market is in its schedule, on the viewer's clock
    const when = (x: MarketView) => { const now = Date.now() / 1000, fin = (x.proposedAt || x.resolveAfterTs) + win;
      return x.status === 1 ? t("pf.whenProposed", { ts: fmtTs(fin), left: timeLeft(fin) }) : x.status >= 2 ? "" : t(now < x.closeTs ? "pf.whenOpen" : "pf.whenClosed", { close: fmtTs(x.closeTs), left: timeLeft(x.closeTs), result: fmtTs(x.resolveAfterTs), final: fmtTs(fin) }); };
    const bets = p.amounts.map((a, i) => (a ? `${esc(label(m, i))}: <span class="mono">${fmtAmt(m, a)}</span>` : "")).filter(Boolean).join("<br>");
    const w = m.status === 2 ? m.outcome : m.status === 1 ? m.proposedOutcome : NO_OUTCOME;
    let value: string;
    if (m.status === 3) value = t("pf.refund", { amt: `${fmtAmt(m, p.amounts.reduce((x, y) => x + y, 0))} ${tok}` });
    else if (w !== NO_OUTCOME) { const r = payoutIfBucket(m, p.amounts, p.feeBps, w); value = r.kind === "lost" ? t("pf.lost") : `${fmtAmt(m, r.payout)} ${tok} ${usdOf(m, r.payout)} (${r.kind === "refund" ? t("pf.refundNobody", { label: esc(label(m, w)) }) : t("pf.kind." + r.kind)})`; }
    else value = p.amounts.map((a, i) => (a ? t("pf.ifLabel", { amt: `${fmtAmt(m, payoutIfBucket(m, p.amounts, p.feeBps, i).payout)} ${tok}`, label: esc(label(m, i)) }) : "")).filter(Boolean).join("<br>");
    const st = m.status === 2 ? t("pf.stResolved") : m.status === 1 ? t("pf.stProposed", { label: esc(label(m, m.proposedOutcome)), move: fmtMove(m.proposedValue) }) : m.status === 3 ? t("pf.stVoided") : Date.now() / 1000 < m.closeTs ? "" : t("pf.stTrading");
    return `<tr><td><a href="/market.html?id=${m.id}">${esc(question(m))}</a><div class="note">${tok} · ${t("trade.pool", { iss: esc(issuerOf(m)) })} · #${m.id}</div><div class="note">${when(m)}</div></td><td>${bets}</td><td>${statusPill(m)}${st ? `<div class="note">${st}</div>` : ""}</td><td class="r mono">${value}</td></tr>`;
  }).join("")}</tbody></table></div><div class="note" style="margin-top:8px">${t("pf.footnote")}</div>`;

  // settled history from the API
  settledEl.innerHTML = `<div class="note">${t("common.loading")}</div>`;
  try {
    const r = await fetch(`${API_BASE}/positions/${owner}`); const j = await r.json();
    if (!j.settled?.length) { settledEl.innerHTML = `<div class="note">${t("pf.noneSettled")}</div>`; return; }
    settledEl.innerHTML = `<div class="scroll"><table class="tbl"><thead><tr><th>${t("pf.colMarket")}</th><th>${t("pf.colStakes")}</th><th>${t("pf.colOutcome")}</th><th class="r">${t("pf.colPaid")}</th><th>Tx</th></tr></thead><tbody>${j.settled.map((s: any) => {
      const m = byId.get(Number(s.id)); const tok = m ? esc(tokenSymbol(m)) : "";
      const amt = (x: number) => (m ? fmtAmt(m, x) : String(x));
      const bets = s.amounts.map((a: string, i: number) => (Number(a) ? `${m ? esc(label(m, i)) : t("pf.range", { i })}: <span class="mono">${amt(Number(a))}</span>` : "")).filter(Boolean).join("<br>");
      const outcome = s.status === 3 ? t("status.chain.Voided") : m ? `${esc(label(m, Number(s.outcome)))} (${fmtMove(Number(s.observed))})` : t("pf.range", { i: esc(s.outcome) });
      const cls = s.kind === "won" ? "ok" : s.kind === "lost" ? "err" : "";
      const txid = isTxId(s.tx ?? s.signature) ? String(s.tx ?? s.signature) : null;
      return `<tr><td>${m ? `<a href="/market.html?id=${m.id}">${esc(question(m))}</a>` : esc(String(s.metric))}<div class="note">${tok} · #${esc(s.id)} · ${fmtTs(Date.parse(s.at) / 1000)}</div></td><td>${bets}</td><td>${outcome}</td><td class="r mono"><span class="msg ${cls}" style="padding:2px 8px">${s.kind === "lost" ? "0" : amt(Number(s.payout))} ${tok}</span></td><td class="hash">${txid ? `<a href="${explorerTx(txid)}" target="_blank" rel="noopener">${txid.slice(0, 8)}…</a>` : "—"}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  } catch { settledEl.innerHTML = `<div class="note">${t("pf.histErr")}</div>`; }
}
onSession((s) => { render(s ? s.address : null); });
