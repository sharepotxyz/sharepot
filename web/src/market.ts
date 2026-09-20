// Event page: one stock × one session. Left: the question, a token (issuer) switcher, the ranges of the selected
// token's pool with chance / payout multiple / pool size, then Rules · Resolution · Details tabs. Right: trade panel.
import { bs58 } from "./wallet";
import { NO_OUTCOME, buildPlaceBetTx, confirmBySig, currentFeeBps, earlyBirdUntil, fetchConfig, fetchMarkets, fetchPositionAmounts, impliedPayout, totalPool, type MarketView } from "./chain";
import { STATUS_LABEL, buildEvents, eventKey, payoutMultiple, statusOf, type EventView } from "./events";
import { CATEGORY_NAME, bucketLabel, bucketName, fmtAmt, fmtMove, fmtPx, fmtUsd, issuerOf, loadPrices, loadStocks, minUnitExp, fmtUnit, snapUnit, isUnitMultiple, closeMoment, prevCloseOf, priceOf, question, sessionLabel, toRaw, tokenSymbol, uiAmount, usdOf } from "./stocks";
import { dayEnd, dayStart, fmtDay, fmtHm, fmtHmRange, fmtTsShort } from "./time";
import { balances, bucketColor, esc, fmtTs, getSession, mountTopbar, onBalances, onSession, openWalletMenu, refreshBalances, shareBalance, tickerBadge, timeLeft, trackStocks } from "./ui";
import { API_BASE, IS_TEST, explorerTx } from "./config";
import { bindReferralAfterBet } from "./referral";
import { t, tn } from "./i18n";

const MIN_BET_USD = 1;

const qs = new URLSearchParams(location.search);
const root = document.getElementById("event")!;
let ev: EventView | undefined, m: MarketView, cfg: any, bucket = -1, tab: "rules" | "resolution" | "details" = "rules";
const name = (i: number) => bucketName(m, i) || bucketLabel(m, i);
const full = (i: number) => (bucketName(m, i) ? `${bucketName(m, i)} (${bucketLabel(m, i)})` : bucketLabel(m, i));

async function load(fresh = false) {
  const [ms, c] = await Promise.all([fetchMarkets({ fresh }), fetchConfig({ fresh }), loadPrices(), loadStocks()]);
  cfg = c;
  const byId = qs.get("id") ? ms.find((x) => x.id === Number(qs.get("id"))) : undefined;
  const key = qs.get("e") ?? (byId ? eventKey(byId) : "");
  ev = buildEvents(ms).find((e) => e.key === key);
  if (!ev) { mountTopbar({}); root.innerHTML = `<div class="empty-state" style="margin-top:30px">${t("mkt.missing")}</div>`; return; }
  mountTopbar({ active: ev.category });
  const want = qs.get("t") ?? (byId ? tokenSymbol(byId) : null);
  m = (m && ev.markets.find((x) => x.id === m.id)) || ev.markets.find((x) => tokenSymbol(x) === want) || ev.markets.find((x) => statusOf(x) === "open") || ev.markets[0];
  if (tab === "rules" && (m.status === 1 || m.status >= 2) && !fresh) tab = "resolution";
  trackStocks(ms);
  render();
}
function selectMarket(id: number) {
  m = ev!.markets.find((x) => x.id === id)!;
  const p = new URLSearchParams({ e: ev!.key, t: tokenSymbol(m) }); history.replaceState(null, "", "?" + p);
  render();
}
function render() {
  if (!ev) return;
  const st = statusOf(m), tok = tokenSymbol(m), fee = currentFeeBps(cfg, m), tot = totalPool(m);
  document.title = `${question(m)} · SharePot`;
  const rows = m.pools.map((p, i) => {
    const pct = tot ? `${Math.round((p / tot) * 100)}%` : "—";
    const mult = payoutMultiple(m, i, fee);
    const won = (m.status === 2 || m.status === 4) && m.outcome === i, prop = m.status === 1 && m.proposedOutcome === i;
    const action = st === "open" ? `<button class="pickbtn" data-b="${i}">${bucket === i ? t("mkt.selected") : t("mkt.pick")}</button>` : won ? `<span class="pill open">${t("mkt.won")}</span>` : prop ? `<span class="pill proposed">${t("mkt.proposedPill")}</span>` : "";
    return `<div class="orow${bucket === i && st === "open" ? " sel" : ""}${won ? " win" : ""}" style="--c:${bucketColor(m, i)}"><span class="oname"><i></i><b>${esc(name(i))}</b>${bucketName(m, i) ? `<small>${esc(bucketLabel(m, i))}</small>` : ""}</span><span class="ochance">${pct}</span><span class="opays">${mult ? mult.toFixed(2) + "×" : st === "open" ? t("mkt.wholePot") : "—"}</span><span class="opool">${fmtAmt(m, p, 3)} ${esc(tok)}</span><span>${action}</span></div>`;
  }).join("");
  const res = m.status === 2 || m.status === 4 ? (m.outcome === NO_OUTCOME ? t("mkt.voided") : `${t("mkt.result", { label: `<b>${esc(full(m.outcome))}</b>`, move: fmtMove(m.proposedValue) })} · ${m.pools[m.outcome] === 0 ? t("mkt.resultRefund") : t("mkt.resultPaid")}`)
    : m.status === 3 ? t("mkt.voided") : m.status === 1 ? `${t("mkt.proposedResult", { label: `<b>${esc(full(m.proposedOutcome))}</b>`, move: fmtMove(m.proposedValue), ts: fmtTs(m.proposedAt + cfg.disputeWindowSecs.toNumber()), left: timeLeft(m.proposedAt + cfg.disputeWindowSecs.toNumber()) })}${m.pools[m.proposedOutcome] === 0 ? " " + t("mkt.proposedRefund") : ""}` : "";
  root.innerHTML = `<div class="evpage">
    <div class="evtop">
      <nav class="crumb"><a href="/">${t("mkt.crumb")}</a><span>›</span><a href="/?cat=${encodeURIComponent(ev.category)}">${esc(CATEGORY_NAME[ev.category] ?? ev.category)}</a><span>›</span><a href="/?cat=${encodeURIComponent(ev.category)}&stock=${encodeURIComponent(ev.symbol)}">${esc(ev.name)}</a><span>›</span><span>${esc(fmtDay(closeMoment(m)))}</span></nav>
      <header class="evhdr"><div><div class="evhdr-top">${tickerBadge(ev.symbol, true)}<span class="pill ${st}">${STATUS_LABEL[st]}</span></div><h1>${esc(question(m))}</h1>
        <div class="evmeta">${st === "open" ? `<span>${t("mkt.closeIn", { t: timeLeft(m.closeTs) })}</span>` : ""}${ev.potUsd != null ? `<span>${tn("mkt.potAcross", ev.markets.length, { usd: fmtUsd(ev.potUsd) })}</span>` : ""}<span>${tn("bettors", ev.bettors)}</span>${ev.kind === "day" && priceOf(m) ? `<span title="${esc(t("mkt.nowTitle"))}">${t("mkt.now", { px: fmtPx(priceOf(m)!) })}</span>` : ""}${ev.kind === "day" ? (() => { const pc = prevCloseOf(m); return pc && pc.date === new Date(Date.parse(ev.date + "T00:00:00Z") - 864e5).toISOString().slice(0, 10) ? `<span title="${esc(t("mkt.prevTitle", { ts: fmtTs(dayStart(ev.date)) }))}">${t("mkt.prev", { px: fmtPx(pc.close) })}</span>` : `<span class="note">${t("mkt.prevLater", { ts: esc(fmtTs(dayStart(ev.date))) })}</span>`; })() : ""}</div></div></header>
      ${timeline()}
      <div class="toks" role="tablist" aria-label="${esc(t("mkt.poolAria"))}">${ev.markets.map((x) => `<button role="tab" aria-selected="${x.id === m.id}" class="tok${x.id === m.id ? " on" : ""}" data-id="${x.id}"><b>${esc(tokenSymbol(x))}</b><span>${esc(issuerOf(x))}</span><em>${t("mkt.inPot", { amt: fmtAmt(x, totalPool(x) + x.seed, 3) })} ${usdOf(x, totalPool(x) + x.seed)}</em></button>`).join("")}</div>
      ${ev.markets.length > 1 ? `<p class="note">${t("mkt.multiPools", { n: ev.markets.length })}</p>` : ""}
      <div class="otable"><div class="orow ohead"><span>${t("mkt.colRange")}</span><span>${t("mkt.colChance")}</span><span>${t("mkt.colPays")}</span><span class="opool">${t("mkt.colPool")}</span><span></span></div>${rows}</div>
      ${m.seed ? `<p class="note">${t("mkt.seedNote", { amt: `${fmtAmt(m, m.seed, 3)} ${esc(tok)} ${usdOf(m, m.seed)}`, tok: esc(tok) })}</p>` : ""}
      ${res ? `<div class="result">${res}</div>` : ""}
    </div>
    <aside class="trade" id="trade"></aside>
    <div class="evbottom">
      <div class="tabs" role="tablist">${(["rules", "resolution", "details"] as const).map((k) => `<button role="tab" class="tab${tab === k ? " on" : ""}" data-tab="${k}">${{ rules: t("mkt.tabRules"), resolution: t("mkt.tabResolution"), details: t("mkt.tabDetails") }[k]}</button>`).join("")}</div>
      <div class="tabpanel" id="tabpanel"></div>
    </div>
  </div>`;
  root.querySelectorAll<HTMLButtonElement>(".tok").forEach((b) => (b.onclick = () => selectMarket(Number(b.dataset.id))));
  root.querySelectorAll<HTMLButtonElement>(".pickbtn").forEach((b) => (b.onclick = () => { bucket = Number(b.dataset.b); render(); document.getElementById("amt")?.focus(); }));
  root.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => (b.onclick = () => { tab = b.dataset.tab as typeof tab; render(); }));
  renderTab(); renderTrade();
}

/** The market's whole schedule on the viewer's clock: what has happened, what comes next and when. */
function timeline() {
  const now = Date.now() / 1000, win = cfg.disputeWindowSecs.toNumber(), voided = m.status === 3 || ((m.status === 2 || m.status === 4) && m.outcome === NO_OUTCOME);
  const proposedTs = m.proposedAt || m.resolveAfterTs, finalTs = proposedTs + win, settled = m.status >= 2;
  const steps: { label: string; when: string; ts: number; done: boolean }[] = [
    { label: t("tl.opens"), when: fmtTsShort(m.openTs), ts: m.openTs, done: now >= m.openTs },
    { label: t("tl.closes"), when: fmtTsShort(m.closeTs), ts: m.closeTs, done: now >= m.closeTs },
    ev!.kind === "day" ? { label: t("tl.priceForms"), when: `${fmtHmRange(dayEnd(ev!.date) - 3600, dayEnd(ev!.date))}, ${fmtDay(dayEnd(ev!.date))}`, ts: dayEnd(ev!.date), done: now >= dayEnd(ev!.date) }
      : { label: t("tl.nyClose"), when: fmtTsShort(closeMoment(m)), ts: closeMoment(m), done: now >= closeMoment(m) },
    { label: m.proposedAt ? t("status.proposed") : t("tl.proposedFrom"), when: fmtTsShort(proposedTs), ts: proposedTs, done: !!m.proposedAt || settled },
    { label: voided ? t("tl.voided") : settled || m.proposedAt ? t("tl.final") : t("tl.finalEst"), when: settled && !m.proposedAt ? "" : fmtTsShort(finalTs), ts: finalTs, done: settled },
  ];
  const next = steps.findIndex((x) => !x.done);
  return `<ol class="tline">${steps.map((x, i) => `<li class="${x.done ? "done" : i === next ? "next" : ""}"><b>${x.label}</b><span>${esc(x.when)}</span>${i === next && x.ts > now ? `<em>${t("common.in", { t: timeLeft(x.ts) })}</em>` : ""}</li>`).join("")}</ol>`;
}

// ---------- tabs ----------
const atBell = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }) === "09:30";
function renderTab() {
  const el = document.getElementById("tabpanel")!, tok = esc(tokenSymbol(m)), sym = esc(ev!.symbol);
  if (tab === "rules" && ev!.kind === "day") {
    const top = Math.abs(m.thresholds[m.nBuckets - 2] ?? 0) / 10000, pct = top ? top.toFixed(top % 1 ? 1 : 0) + "%" : "";
    const iss = issuerOf(m), issuerFee = iss === "Tessera" ? "0.2%" : iss === "PreStocks" ? "0.5%" : null;
    const payouts = t("rules.payouts", { tok, early: (cfg.feeBps - cfg.earlyBirdDiscountBps) / 100, until: fmtTs(earlyBirdUntil(cfg, m)), fee: cfg.feeBps / 100 });
    el.innerHTML = `<ul>
      <li>${t("rules.day.q", { sym, ts: esc(fmtTs(dayEnd(ev!.date))), n: m.nBuckets })}</li>
      <li>${t("rules.day.betting", { open: fmtTs(m.openTs), close: fmtTs(m.closeTs) })}</li>
      <li>${t("rules.day.result", { range: esc(fmtHmRange(dayEnd(ev!.date) - 3600, dayEnd(ev!.date))), day: esc(fmtDay(dayEnd(ev!.date))), base: esc(fmtTs(dayStart(ev!.date))), after: fmtTs(m.resolveAfterTs), h: cfg.disputeWindowSecs.toNumber() / 3600 })}</li>
      <li>${payouts}</li>
      ${issuerFee ? `<li>${t("rules.issuerFee", { iss: esc(iss), fee: issuerFee, tok })}</li>` : ""}
      ${ev!.category === "memes" ? `<li>${t("rules.day.why", { time: esc(fmtHm(m.openTs)) })}</li>` : ""}
      <li>${pct ? t("rules.day.ranges", { pct }) : t("rules.day.rangesNoPct")}</li></ul>`;
  } else if (tab === "rules") {
    el.innerHTML = `<ul>
      <li>${t("rules.close.q", { sym, ts: esc(fmtTs(closeMoment(m))) })}</li>
      <li>${t("rules.close.betting", { open: fmtTs(m.openTs), openBell: atBell(m.openTs) ? t("rules.close.openBell") : "", close: fmtTs(m.closeTs), closeBell: atBell(m.closeTs) ? t("rules.close.closeBell") : "" })}</li>
      <li>${t("rules.close.result", { after: fmtTs(m.resolveAfterTs), h: cfg.disputeWindowSecs.toNumber() / 3600 })}</li>
      <li>${t("rules.payouts", { tok, early: (cfg.feeBps - cfg.earlyBirdDiscountBps) / 100, until: fmtTs(earlyBirdUntil(cfg, m)), fee: cfg.feeBps / 100 })}</li>
      <li>${t("rules.close.divs")}</li>
      <li>${t("rules.close.issuer", { iss: esc(issuerOf(m)) || t("rules.theIssuer"), tok })}</li>
      <li>${t("rules.close.ranges", { sym })}</li></ul>`;
  } else if (tab === "resolution") {
    el.innerHTML = m.proposedAt ? `<div class="kv"><b>${t("res.proposed")}</b><span>${fmtTs(m.proposedAt)} · ${t("res.move", { move: `<span class="mono">${fmtMove(m.proposedValue)}</span>` })} → <b>${esc(full(m.proposedOutcome))}</b></span><b>${t("res.evidence")}</b><span id="evidence" class="note">${t("res.loading")}</span>${m.status === 1 ? `<b>${t("res.disagree")}</b><span><button id="dbtn">${t("res.dispute")}</button> <span class="note">${t("res.disputeUntil", { ts: fmtTs(m.proposedAt + cfg.disputeWindowSecs.toNumber()) })}</span><div id="dlist" class="note"></div></span>` : ""}</div>`
      : `<p class="note">${t("res.pending", { ts: fmtTs(m.resolveAfterTs) })}</p>`;
    loadEvidence(); mountDispute();
  } else {
    el.innerHTML = `<div class="kv"><b>${t("det.token")}</b><span class="hash">${tok} · ${esc(issuerOf(m))} · ${m.mint.toBase58()}${m.multiplier !== 1 ? ` · ${t("det.multiplier", { x: m.multiplier })}` : ""}</span><b>${t("det.account")}</b><span class="hash">${m.pubkey.toBase58()} (#${m.id})</span><b>${t("det.openClose")}</b><span>${fmtTs(m.openTs)} → ${fmtTs(m.closeTs)}</span><b>${t("det.resolvesAfter")}</b><span>${fmtTs(m.resolveAfterTs)}</span></div>`;
  }
}

// ---------- trade panel ----------
const balText = () => (getSession() && balances.loaded ? t("trade.balance", { amt: `${fmtAmt(m, shareBalance(m))} ${tokenSymbol(m)}` }) : getSession() ? t("trade.balance", { amt: "…" }) : "");
let typed = { id: -1, v: "" };   // the amount in the box, and the pool it was typed for
function renderTrade() {
  const box = document.getElementById("trade")!;
  const s = getSession(), st = statusOf(m), tok = esc(tokenSymbol(m)), held = shareBalance(m), fee = currentFeeBps(cfg, m), tot = totalPool(m);
  if (st !== "open") {
    const next = `<a href="/?cat=${ev!.category}&stock=${encodeURIComponent(ev!.symbol)}">${t("trade.seeOpen", { sym: esc(ev!.symbol) })}</a>`;
    box.innerHTML = `<div class="tcard"><div class="thead"><b>${STATUS_LABEL[st]}</b></div><p class="note" style="margin:0">${st === "trading" ? t("trade.closedTrading", { close: fmtTs(m.closeTs), after: fmtTs(m.resolveAfterTs), final: fmtTs(m.resolveAfterTs + cfg.disputeWindowSecs.toNumber()) }) : st === "proposed" ? t("trade.closedProposed", { ts: fmtTs(m.proposedAt + cfg.disputeWindowSecs.toNumber()), left: timeLeft(m.proposedAt + cfg.disputeWindowSecs.toNumber()) }) : t("trade.closedSettled")}</p>${next}</div><div id="pos">${posHtml()}</div>`;
    showPosition(); return;
  }
  // The floor is shown as a round number of shares, a power of ten worth at least MIN_BET_USD, so nobody has to work it
  // out from the share price. The program's own floor is in raw units (dust stakes cost more in payout rent than they
  // can win — see forfeit_position); without a price that is all there is.
  const px = priceOf(m), minExp = px ? minUnitExp(px, MIN_BET_USD, m.decimals) : null;
  const minRaw = Math.max(cfg.minBet.toNumber(), minExp != null ? toRaw(m, 10 ** minExp) : 0);
  const unitExp = minExp != null && minRaw === toRaw(m, 10 ** minExp) ? minExp : null;   // null: no price, the program's raw floor only
  const minTxt = unitExp != null ? fmtUnit(unitExp) : fmtAmt(m, minRaw, 8);
  box.innerHTML = `<div class="tcard">
    <div class="thead"><b>${t("trade.stake", { tok })}</b><span class="note">${t("trade.pool", { iss: esc(issuerOf(m)) })}</span></div>
    <div class="topts">${m.pools.map((p, i) => `<button class="${bucket === i ? "on" : ""}" style="--c:${bucketColor(m, i)}" data-b="${i}"><span class="to1"><span>${esc(name(i))}</span><b>${tot ? Math.round((p / tot) * 100) + "%" : "—"}</b></span><em>${esc(bucketLabel(m, i))}</em></button>`).join("")}</div>
    <label class="tlabel" for="amt">${t("trade.amount")}<span class="note" id="bal">${esc(balText())}</span></label>
    <div class="tamt"><input id="amt" type="number" min="0" step="${unitExp != null ? minTxt.replace(/,/g, "") : "any"}" placeholder="${minTxt}" inputmode="decimal"><span class="unit">${tok}</span></div>
    <div class="note" id="minnote">${t(unitExp != null ? "trade.multiples" : "trade.minimum", { amt: `<b>${minTxt} ${tok}</b>` })} ${usdOf(m, minRaw)}</div>
    ${s ? `<div class="tquick"><button data-min>${t("trade.min")}</button><button data-f="0.25">25%</button><button data-f="0.5">50%</button><button data-f="1">${t("trade.max")}</button></div>` : ""}
    <div class="tsum" id="quote"></div>
    ${s ? `<button class="primary big" id="go"${bucket < 0 ? " disabled" : ""}>${bucket < 0 ? t("trade.pickRange") : t("trade.stakeOn", { label: esc(name(bucket)) })}</button>` : `<button class="primary big" id="connect">${t("common.connectWallet")}</button>`}
    <div id="msg"></div>
    <p class="note" style="margin:0">${t(Date.now() / 1000 < earlyBirdUntil(cfg, m) ? "trade.feeEarly" : "trade.fee", { fee: fee / 100 })}</p>
    <p class="note" style="margin:0">${t("trade.noHouse", { tok })}</p>
    ${IS_TEST && s && balances.loaded && !held ? `<p class="note" style="margin:0">${t("trade.noTokens", { tok })}</p>` : ""}
  </div><div id="pos">${posHtml()}</div>`;
  box.querySelectorAll<HTMLButtonElement>(".topts button").forEach((b) => (b.onclick = () => { bucket = Number(b.dataset.b); render(); }));
  const amtEl = box.querySelector<HTMLInputElement>("#amt")!, quote = box.querySelector("#quote")!;
  // The panel is rebuilt on every render (picking a range, a balance arriving, the periodic reload); what was typed
  // has to survive that, for as long as it is the same pool.
  if (typed.id === m.id) amtEl.value = typed.v;
  const upd = () => {
    typed = { id: m.id, v: amtEl.value };
    const a = toRaw(m, Number(amtEl.value));
    if (bucket < 0) { quote.innerHTML = `<span class="note">${t("trade.pickAbove")}</span>`; return; }
    if (!a) { quote.innerHTML = `<div class="r"><span>${t("trade.paysIfRight")}</span><b>${payoutMultiple(m, bucket, fee)?.toFixed(2) ?? t("mkt.wholePot")}${payoutMultiple(m, bucket, fee) ? "×" : ""}</b></div>`; return; }
    if (a < minRaw) { quote.innerHTML = `<span class="note">${t("trade.minIs", { amt: `${minTxt} ${tok}` })}</span>`; return; }
    const q = impliedPayout(m, bucket, a, fee);
    quote.innerHTML = `<div class="r"><span>${t("trade.payoutIf", { label: esc(name(bucket)) })}</span><b class="big">${fmtAmt(m, q.total)} ${tok}</b></div><div class="r note"><span>${usdOf(m, q.total)}</span><span>${(q.total / a).toFixed(2)}× · +${fmtAmt(m, q.total - a)} ${tok}</span></div><div class="note">${t("trade.otherRange", { amt: `${fmtAmt(m, a)} ${tok}` })}</div>`;
  };
  amtEl.oninput = upd; upd();
  // Stakes are whole numbers of the unit: what was typed is rounded down to one on leaving the box (never to zero:
  // an amount under one unit stays as typed and is refused with the minimum spelled out).
  amtEl.onchange = () => { const v = Number(amtEl.value); if (unitExp != null && v >= 10 ** unitExp && !isUnitMultiple(v, unitExp)) { amtEl.value = snapUnit(v, unitExp); upd(); } };
  box.querySelectorAll<HTMLButtonElement>(".tquick button").forEach((b) => (b.onclick = () => {
    const v = uiAmount(m, shareBalance(m)) * Number(b.dataset.f);   // read now: the balance may have arrived after the panel was drawn
    amtEl.value = b.dataset.min != null ? minTxt.replace(/,/g, "") : unitExp != null ? snapUnit(v, unitExp) : String(Math.floor(v * 1e4) / 1e4); upd();
  }));
  const c = box.querySelector<HTMLButtonElement>("#connect"); if (c) c.onclick = (e) => { e.stopPropagation(); openWalletMenu(); };
  const go = box.querySelector<HTMLButtonElement>("#go"), msg = box.querySelector("#msg")!;
  const shortOf = (have: number | null) => `${have != null ? t("trade.shortHave", { tok, amt: `${fmtAmt(m, have)} ${tok}` }) : t("trade.short", { tok })}${IS_TEST ? ` <a href="/faucet.html">${t("trade.getTest")}</a>` : ""}`;
  if (go) go.onclick = async () => {
    const sess = getSession()!; const a = toRaw(m, Number(amtEl.value));
    if (a < minRaw) { msg.innerHTML = `<div class="msg err">${t("trade.minIs", { amt: `${minTxt} ${tok}` })}</div>`; return; }
    if (unitExp != null && !isUnitMultiple(Number(amtEl.value), unitExp)) { msg.innerHTML = `<div class="msg err">${t("trade.multiplesErr", { unit: `${minTxt} ${tok}`, amt: `${Number(snapUnit(Number(amtEl.value), unitExp)).toLocaleString("en-US", { maximumFractionDigits: 8 })} ${tok}` })}</div>`; return; }
    // The balance is read again here, not taken from when the panel was drawn: a balance that never loaded (public RPC
    // rate limit) used to skip this check and hand the bettor the token program's raw "insufficient funds" log.
    go.disabled = true;
    if (!balances.loaded) { msg.innerHTML = `<div class="msg">${t("trade.checking")}</div>`; try { await refreshBalances(); } catch {} }
    const have = shareBalance(m);
    if (balances.loaded && a > have) { msg.innerHTML = `<div class="msg err">${shortOf(have)}</div>`; go.disabled = false; return; }
    msg.innerHTML = `<div class="msg">${t("trade.confirm")}</div>`;
    let sig = "";
    try {
      const tx = await buildPlaceBetTx(sess.publicKey, m, bucket, a);
      sig = await sess.signAndSend(tx);
      msg.innerHTML = `<div class="msg">${t("trade.sent")}</div>`;
      await confirmBySig(sig);
    } catch (e: any) {
      // Sent but not seen yet: it may still land, so the button stays off rather than invite a second stake.
      if (sig && e?.unconfirmed) { msg.innerHTML = `<div class="msg err">${t("trade.unconfirmed", { tx: explorerTx(sig) })}</div>`; return; }
      const raw = String(e?.message ?? e) + " " + (Array.isArray(e?.logs) ? e.logs.join(" ") : "");
      let why = esc(String(e?.message ?? e).split(/ Logs:|\n/)[0].slice(0, 200));   // never the simulation log dump
      if (/insufficient lamports|Attempt to debit|insufficient funds for (fee|rent)/i.test(raw)) why = t("trade.errSol");
      else if (/insufficient funds/i.test(raw)) { try { await refreshBalances(); } catch {} why = shortOf(balances.loaded ? shareBalance(m) : null); }
      else if (/reject|denied|cancel/i.test(raw)) why = t("trade.errCancel");
      else if (/429|rate limit/i.test(raw)) why = t("trade.errBusy");
      msg.innerHTML = `<div class="msg err">${why}</div>`; go.disabled = false; return;
    }
    // The stake is on-chain from here on: nothing below may turn that into an error message.
    const done = `${t("trade.staked", { amt: `${fmtAmt(m, a)} ${tok}`, label: esc(full(bucket)) })} <a href="${explorerTx(sig)}" target="_blank" rel="noopener">${t("trade.viewTx")}</a>`;
    typed = { id: -1, v: "" };
    const show = (note = "") => { const m2 = document.getElementById("msg"); if (m2) m2.innerHTML = `<div class="msg ok">${done}${note ? `<br>${esc(note)}` : ""}</div>`; };
    // Show the stake at once, from what was just confirmed: the position box and the pools are updated here and the
    // chain is re-read behind them (both reads together, not one after the other), instead of a blank wait.
    const k = posKey(), was = k ? posCache.get(k) ?? [] : [];
    if (k) posCache.set(k, Array.from({ length: m.nBuckets }, (_, i) => (was[i] ?? 0) + (i === bucket ? a : 0)));
    m.pools[bucket] += a;
    render(); show();
    await Promise.all([refreshBalances().catch(() => {}), load(true).catch(() => {})]);
    show();
    try { show((await bindReferralAfterBet(sess)) || ""); } catch {}
  };
  showPosition();
}
// The panel is rebuilt on every render, so the position is drawn from what was last read (no blank box while the
// chain is asked again) and only a real answer replaces it: an RPC error leaves it alone, and while bets are open a
// smaller total is a lagging node (stakes only ever add up until the market settles), so that is ignored too.
const posCache = new Map<string, number[]>();
const posKey = () => { const s = getSession(); return s && m ? `${m.pubkey.toBase58()}:${s.publicKey.toBase58()}` : ""; };
function posHtml() {
  const amounts = posCache.get(posKey()); if (!amounts) return "";
  const parts = amounts.slice(0, m.nBuckets).map((x, i) => [x, i]).filter(([x]) => x > 0).map(([x, i]) => `<div class="r"><span>${esc(name(i))}</span><b>${fmtAmt(m, x)} ${esc(tokenSymbol(m))}</b></div>`);
  return parts.length ? `<div class="tcard"><div class="thead"><b>${t("trade.position")}</b><a href="/portfolio.html" class="note">${t("trade.allBets")}</a></div><div class="tsum">${parts.join("")}</div></div>` : "";
}
async function showPosition() {
  const s = getSession(), k = posKey(); if (!s || !k) return;
  let got: number[] | null; try { got = await fetchPositionAmounts(m.pubkey, s.publicKey); } catch { return; }
  if (k !== posKey()) return;   // another pool or wallet was picked while this was in flight
  const sum = (v?: number[] | null) => (v ?? []).reduce((x, y) => x + y, 0);
  if (statusOf(m) === "open" && sum(got) < sum(posCache.get(k))) return;
  if (got) posCache.set(k, got); else posCache.delete(k);
  const el = document.getElementById("pos"); if (el) el.innerHTML = posHtml();
}

async function mountDispute() {
  const btn = document.getElementById("dbtn") as HTMLButtonElement | null; if (!btn) return;
  try { const r = await fetch(`${API_BASE}/disputes?market=${m.pubkey.toBase58()}`); const j = await r.json(); const open = (j.disputes ?? []).filter((d: any) => d.status === "open"); if (open.length) document.getElementById("dlist")!.textContent = tn("res.disputesOpen", open.length); } catch {}
  btn.onclick = async () => {
    const s = getSession(); if (!s) { openWalletMenu(); return; }
    const reason = prompt(t("res.promptWhy")); if (!reason || reason.trim().length < 5) return;
    const claimed = prompt(t("res.promptMove")) ?? "";
    btn.disabled = true;
    try {
      const msg = `sharepot-dispute v1\nmarket=${m.pubkey.toBase58()}\nwallet=${s.publicKey.toBase58()}\nclaimed=${claimed.trim()}\nreason=${reason.trim().slice(0, 2000)}`;
      const sig = await s.signMessage(new TextEncoder().encode(msg));
      const r = await fetch(`${API_BASE}/dispute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ market: m.pubkey.toBase58(), wallet: s.publicKey.toBase58(), reason: reason.trim().slice(0, 2000), claimedValue: claimed.trim() || null, signature: bs58(sig) }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "failed");
      document.getElementById("dlist")!.textContent = t("res.disputeFiled");
    } catch (e: any) { alert(e?.message ?? e); btn.disabled = false; }
  };
}
/** The price data behind the result. The browser hashes the raw response itself and compares it with the hash the
 *  proposer wrote on-chain, so nobody has to trust this page's say-so. */
async function loadEvidence() {
  const el = document.getElementById("evidence"); if (!el || !m.proposedAt) return;
  try {
    const r = await fetch(`${API_BASE}/evidence/${m.id}`); if (!r.ok) { el.textContent = t("res.notPublished"); return; }
    const e = await r.json();
    const raw = await (await fetch(`${API_BASE}/evidence/${m.id}/raw`)).arrayBuffer();
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const match = sha === m.snapshotHash;
    const div = Number(e.dividend) > 0 ? " " + t("ev.dividend", { amt: "$" + esc(e.dividend) }) : "";
    const dayTs = (d: any) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? fmtTs(dayEnd(String(d))) : String(d));
    const fp = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 8 : 4 }) : esc(v); };
    el.innerHTML = e.samples != null
      ? `<div><b>${esc(e.symbol)}</b> ${t("ev.close")} ${esc(dayTs(e.prevDate))} <span class="mono">$${fp(e.baseline)}</span> (${t("ev.median", { n: esc(e.prevSamples) })}) → ${esc(dayTs(e.date))} <span class="mono">$${fp(e.close)}</span> (${t("ev.medianHour", { n: esc(e.samples) })}) = <span class="mono">${fmtMove(e.movePpm)}</span></div>`
      : `<div><b>${esc(e.symbol)}</b> ${t("ev.close")} ${esc(e.prevDate)} <span class="mono">$${esc(e.prevClose)}</span> → ${esc(e.date)} <span class="mono">$${esc(e.close)}</span>${div} = <span class="mono">${fmtMove(e.movePpm)}</span>${e.split ? ` · ${t("ev.split", { x: esc(e.split) })}` : ""}</div>`;
    el.innerHTML +=
      `<div><a href="${API_BASE}/evidence/${m.id}/raw" target="_blank" rel="noopener">${e.samples != null ? t("ev.sampled") : t("ev.raw")}</a> · sha256 <span class="hash">${sha.slice(0, 16)}…</span> · <span class="${match ? "" : "warn"}">${match ? t("ev.match") : t("ev.mismatch")}</span></div>
      ${e.signature ? `<div><a href="${explorerTx(e.signature)}" target="_blank" rel="noopener">${t("ev.proposalTx")}</a></div>` : ""}`;
  } catch { el.textContent = t("res.notPublished"); }
}

onSession(() => { if (ev && m) render(); });   // the top bar mounts (and reconnects the wallet) before the pool is picked
// The balance arrives after the panel is drawn. Only its line is touched: a rebuild here would detach the message box
// and button of a stake in progress (Stake itself re-reads the balance).
onBalances(() => { const el = document.getElementById("bal"); if (el && m) el.textContent = balText(); });
load().catch((e) => (root.innerHTML = `<div class="msg err">${t("mkt.loadErr", { err: esc(e.message ?? e) })}</div>`));
setInterval(() => { if (ev && !document.activeElement?.matches("input")) load(); }, 30_000);
