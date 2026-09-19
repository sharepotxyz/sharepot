// Event page: one stock × one session. Left: the question, a token (issuer) switcher, the ranges of the selected
// token's pool with chance / payout multiple / pool size, then Rules · Resolution · Details tabs. Right: trade panel.
import { bs58 } from "./wallet";
import { NO_OUTCOME, buildPlaceBetTx, confirmBySig, currentFeeBps, earlyBirdUntil, fetchConfig, fetchMarkets, fetchPosition, impliedPayout, totalPool, type MarketView } from "./chain";
import { STATUS_LABEL, buildEvents, eventKey, payoutMultiple, statusOf, type EventView } from "./events";
import { CATEGORY_NAME, bucketLabel, bucketName, fmtAmt, fmtMove, fmtPx, fmtUsd, issuerOf, loadPrices, loadStocks, markOf, minUnitExp, fmtUnit, closeMoment, prevCloseOf, priceOf, question, sessionLabel, toRaw, tokenSymbol, uiAmount, usdOf } from "./stocks";
import { dayEnd, dayStart, fmtDay, fmtHm, fmtHmRange, fmtTsShort } from "./time";
import { balances, bucketColor, esc, fmtTs, getSession, mountTopbar, onSession, openWalletMenu, refreshBalances, shareBalance, tickerBadge, timeLeft, trackStocks } from "./ui";
import { API_BASE, IS_TEST, explorerTx } from "./config";
import { bindReferralAfterBet } from "./referral";

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
  if (!ev) { root.innerHTML = `<div class="empty-state" style="margin-top:30px">This market does not exist. <a href="/">Back to all markets</a></div>`; return; }
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
    const action = st === "open" ? `<button class="pickbtn" data-b="${i}">${bucket === i ? "Selected" : "Pick"}</button>` : won ? `<span class="pill open">Won</span>` : prop ? `<span class="pill proposed">Proposed</span>` : "";
    return `<div class="orow${bucket === i && st === "open" ? " sel" : ""}${won ? " win" : ""}" style="--c:${bucketColor(m, i)}"><span class="oname"><i></i><b>${esc(name(i))}</b>${bucketName(m, i) ? `<small>${esc(bucketLabel(m, i))}</small>` : ""}</span><span class="ochance">${pct}</span><span class="opays">${mult ? mult.toFixed(2) + "×" : st === "open" ? "whole pot" : "—"}</span><span class="opool">${fmtAmt(m, p, 3)} ${esc(tok)}</span><span>${action}</span></div>`;
  }).join("");
  const res = m.status === 2 || m.status === 4 ? (m.outcome === NO_OUTCOME ? `Voided — every stake refunded.` : `Result: <b>${esc(full(m.outcome))}</b> · move ${fmtMove(m.proposedValue)} · ${m.pools[m.outcome] === 0 ? "nobody picked this range, so every stake was refunded in full, no fee." : "payouts sent automatically."}`)
    : m.status === 3 ? `Voided — every stake refunded.` : m.status === 1 ? `Proposed result: <b>${esc(full(m.proposedOutcome))}</b> · move ${fmtMove(m.proposedValue)} · final ${fmtTs(m.proposedAt + cfg.disputeWindowSecs.toNumber())} (in ${timeLeft(m.proposedAt + cfg.disputeWindowSecs.toNumber())}) unless disputed.${m.pools[m.proposedOutcome] === 0 ? " Nobody picked this range: if it stands, every stake is refunded in full, no fee." : ""}` : "";
  root.innerHTML = `<div class="evpage">
    <div class="evtop">
      <nav class="crumb"><a href="/">Markets</a><span>›</span><a href="/?cat=${encodeURIComponent(ev.category)}">${esc(CATEGORY_NAME[ev.category] ?? ev.category)}</a><span>›</span><a href="/?cat=${encodeURIComponent(ev.category)}&stock=${encodeURIComponent(ev.symbol)}">${esc(ev.name)}</a><span>›</span><span>${esc(fmtDay(closeMoment(m)))}</span></nav>
      <header class="evhdr">${tickerBadge(ev.symbol, true)}<div><h1>${esc(question(m))}</h1>
        <div class="evmeta"><span class="pill ${st}">${STATUS_LABEL[st]}</span>${st === "open" ? `<span>Bets close in ${timeLeft(m.closeTs)}</span>` : ""}${ev.potUsd != null ? `<span>${fmtUsd(ev.potUsd)} pot across ${ev.markets.length} pool${ev.markets.length === 1 ? "" : "s"}</span>` : ""}<span>${ev.bettors} bettor${ev.bettors === 1 ? "" : "s"}</span>${ev.kind === "day" && priceOf(m) ? `<span title="Live Jupiter quote">now ${fmtPx(priceOf(m)!)}</span>` : ""}${ev.kind === "day" ? (() => { const pc = prevCloseOf(m); return pc && pc.date === new Date(Date.parse(ev.date + "T00:00:00Z") - 864e5).toISOString().slice(0, 10) ? `<span title="Median of the quotes in the hour before ${esc(fmtTs(dayStart(ev.date)))}">prev close ${fmtPx(pc.close)}</span>` : `<span class="note">prev close known after ${esc(fmtTs(dayStart(ev.date)))}</span>`; })() : ""}${ev.kind === "day" && markOf(m) ? `<span title="The issuer's official mark price">issuer mark ${fmtPx(markOf(m)!)}</span>` : ""}</div></div></header>
      ${timeline()}
      <div class="toks" role="tablist" aria-label="Pool (token)">${ev.markets.map((x) => `<button role="tab" aria-selected="${x.id === m.id}" class="tok${x.id === m.id ? " on" : ""}" data-id="${x.id}"><b>${esc(tokenSymbol(x))}</b><span>${esc(issuerOf(x))}</span><em>${fmtAmt(x, totalPool(x) + x.seed, 3)} in pot ${usdOf(x, totalPool(x) + x.seed)}</em></button>`).join("")}</div>
      ${ev.markets.length > 1 ? `<p class="note">Each issuer's token has its own pool; all ${ev.markets.length} pools share these ranges and the same result.</p>` : ""}
      <div class="otable"><div class="orow ohead"><span>Range (move vs previous close)</span><span>Chance</span><span>Pays</span><span class="opool">Pool</span><span></span></div>${rows}</div>
      ${m.seed ? `<p class="note">+ ${fmtAmt(m, m.seed, 3)} ${esc(tok)} ${usdOf(m, m.seed)} house prize for the winning range, fee-free. “Chance” is the share of the pool on a range; “Pays” is what each ${esc(tok)} staked returns if it wins and the pools stay as they are.</p>` : ""}
      ${res ? `<div class="result">${res}</div>` : ""}
    </div>
    <aside class="trade" id="trade"></aside>
    <div class="evbottom">
      <div class="tabs" role="tablist">${(["rules", "resolution", "details"] as const).map((t) => `<button role="tab" class="tab${tab === t ? " on" : ""}" data-tab="${t}">${{ rules: "Rules", resolution: "Resolution", details: "Details" }[t]}</button>`).join("")}</div>
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
    { label: "Betting opens", when: fmtTsShort(m.openTs), ts: m.openTs, done: now >= m.openTs },
    { label: "Betting closes", when: fmtTsShort(m.closeTs), ts: m.closeTs, done: now >= m.closeTs },
    ev!.kind === "day" ? { label: "Closing price forms", when: `${fmtHmRange(dayEnd(ev!.date) - 3600, dayEnd(ev!.date))}, ${fmtDay(dayEnd(ev!.date))}`, ts: dayEnd(ev!.date), done: now >= dayEnd(ev!.date) }
      : { label: "New York close", when: fmtTsShort(closeMoment(m)), ts: closeMoment(m), done: now >= closeMoment(m) },
    { label: m.proposedAt ? "Result proposed" : "Result proposed from", when: fmtTsShort(proposedTs), ts: proposedTs, done: !!m.proposedAt || settled },
    { label: voided ? "Voided, stakes refunded" : settled ? "Final, payouts sent" : m.proposedAt ? "Final, payouts sent" : "Final, payouts sent (est.)", when: settled && !m.proposedAt ? "" : fmtTsShort(finalTs), ts: finalTs, done: settled },
  ];
  const next = steps.findIndex((x) => !x.done);
  return `<ol class="tline">${steps.map((x, i) => `<li class="${x.done ? "done" : i === next ? "next" : ""}"><b>${x.label}</b><span>${esc(x.when)}</span>${i === next && x.ts > now ? `<em>in ${timeLeft(x.ts)}</em>` : ""}</li>`).join("")}</ol>`;
}

// ---------- tabs ----------
const atBell = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }) === "09:30";
function renderTab() {
  const el = document.getElementById("tabpanel")!, tok = esc(tokenSymbol(m)), sym = esc(ev!.symbol);
  if (tab === "rules" && ev!.kind === "day") {
    const top = Math.abs(m.thresholds[m.nBuckets - 2] ?? 0) / 10000, pct = top ? top.toFixed(top % 1 ? 1 : 0) + "%" : "";
    const iss = issuerOf(m), issuerFee = iss === "Tessera" ? "0.2%" : iss === "PreStocks" ? "0.5%" : null;
    el.innerHTML = `<ul>
      <li><b>Question.</b> Where does ${sym} close at ${esc(fmtTs(dayEnd(ev!.date)))}, measured against its close 24 hours earlier? ${m.nBuckets} ranges; the one containing the move wins.</li>
      <li><b>Betting</b> opens ${fmtTs(m.openTs)}, while the previous day's pool is still taking bets, and stops ${fmtTs(m.closeTs)} — twelve hours before the close, before most of the answer exists.</li>
      <li><b>Result.</b> There is no exchange close for this token, so the close is the <b>median of one Jupiter quote per minute during the last hour</b>, ${esc(fmtHmRange(dayEnd(ev!.date) - 3600, dayEnd(ev!.date)))} on ${esc(fmtDay(dayEnd(ev!.date)))}; the move is that close ÷ the close 24 hours earlier − 1. The earlier close is not known when betting opens (it forms at ${esc(fmtTs(dayStart(ev!.date)))}) — as a stock pool opens before the previous session has closed. Proposed after ${fmtTs(m.resolveAfterTs)} with every sampled quote of both days published and their hash on-chain; disputable for ${cfg.disputeWindowSecs.toNumber() / 3600} h. Fewer than 40 usable quotes on either day (a delisted token, a dead feed) voids the market with a full refund.</li>
      <li><b>Payouts</b> are in ${tok}: winners get their stake back plus a share of the losing ranges, pushed to wallets automatically. Fee ${(cfg.feeBps - cfg.earlyBirdDiscountBps) / 100}% of winnings until ${fmtTs(earlyBirdUntil(cfg, m))}, then ${cfg.feeBps / 100}% — never on your stake.</li>
      ${issuerFee ? `<li><b>Issuer transfer fee.</b> ${esc(iss)} charges ${issuerFee} on every transfer of ${tok}, including into and out of this pool. Your stake counts as what actually arrives in the pool, and a payout lands net of that fee. That fee goes to ${esc(iss)}, not to SharePot.</li>` : ""}
      ${ev!.category === "memes" ? `<li><b>Why this token.</b> Memes are picked every day at ${esc(fmtHm(m.openTs))} for the following pool: the ten Solana tokens with the most 24-hour traded volume whose mint and freeze authorities are gone, with at least $500k of liquidity and a first pool at least 3 days old. Tomorrow's list can differ from today's; an open market always settles.</li>` : `<li><b>Reference price.</b> The issuer publishes a mark price from private-market data; it moves rarely and is shown for context only. The pool settles on the on-chain price, which trades around it.</li>`}
      <li><b>Ranges</b> are cut at ±${pct || "the token's typical daily move"}, the token's median absolute daily move over its last 60 days, so "flat" and the two tails started out about equally likely.</li></ul>`;
  } else if (tab === "rules") {
    el.innerHTML = `<ul>
      <li><b>Question.</b> Where does ${sym} close at the New York closing bell, ${esc(fmtTs(closeMoment(m)))}, measured against the previous session's close? Four ranges; the one containing the move wins.</li>
      <li><b>Betting</b> opens ${fmtTs(m.openTs)}${atBell(m.openTs) ? " (previous opening bell)" : ""} and stops ${fmtTs(m.closeTs)}${atBell(m.closeTs) ? " — the New York opening bell — before any of the answer exists" : ""}.</li>
      <li><b>Result</b> = total-return move: (official close + any dividend going ex that day) ÷ previous official close − 1, closes on the same share basis across splits. Proposed after ${fmtTs(m.resolveAfterTs)} with the raw price data and its hash on-chain; disputable for ${cfg.disputeWindowSecs.toNumber() / 3600} h.</li>
      <li><b>Payouts</b> are in ${tok}: winners get their stake back plus a share of the losing ranges, pushed to wallets automatically. Fee ${(cfg.feeBps - cfg.earlyBirdDiscountBps) / 100}% of winnings until ${fmtTs(earlyBirdUntil(cfg, m))}, then ${cfg.feeBps / 100}% — never on your stake.</li>
      <li><b>Dividends and splits on the token</b> are applied by the issuer to every balance alike (a multiplier), pools included, so every stake keeps its share. A spin-off, a delisting merger or a full-session halt voids the market with a full refund.</li>
      <li><b>Issuer controls.</b> ${esc(issuerOf(m) || "The issuer")} can pause ${tok} transfers; while paused, bets and payouts for this pool wait. xStocks and Backpack tokens also let the issuer move tokens held in any account, these pools included.</li>
      <li><b>Ranges</b> are set near the quartiles of ${sym}'s recent daily moves, so each started out roughly equally likely.</li></ul>`;
  } else if (tab === "resolution") {
    el.innerHTML = m.proposedAt ? `<div class="kv"><b>Proposed</b><span>${fmtTs(m.proposedAt)} · move <span class="mono">${fmtMove(m.proposedValue)}</span> → <b>${esc(full(m.proposedOutcome))}</b></span><b>Evidence</b><span id="evidence" class="note">loading…</span>${m.status === 1 ? `<b>Disagree?</b><span><button id="dbtn">Dispute this result</button> <span class="note">until ${fmtTs(m.proposedAt + cfg.disputeWindowSecs.toNumber())}. You sign a message with your wallet.</span><div id="dlist" class="note"></div></span>` : ""}</div>`
      : `<p class="note">The result is proposed after ${fmtTs(m.resolveAfterTs)}, with the raw closing-price data published here and its sha256 written on-chain. Your browser re-hashes it to check.</p>`;
    loadEvidence(); mountDispute();
  } else {
    el.innerHTML = `<div class="kv"><b>Pool token</b><span class="hash">${tok} · ${esc(issuerOf(m))} · ${m.mint.toBase58()}${m.multiplier !== 1 ? ` · multiplier ${m.multiplier}` : ""}</span><b>Market account</b><span class="hash">${m.pubkey.toBase58()} (#${m.id})</span><b>Opens / closes</b><span>${fmtTs(m.openTs)} → ${fmtTs(m.closeTs)}</span><b>Resolves after</b><span>${fmtTs(m.resolveAfterTs)}</span></div>`;
  }
}

// ---------- trade panel ----------
let typed = { id: -1, v: "" };   // the amount in the box, and the pool it was typed for
function renderTrade() {
  const box = document.getElementById("trade")!;
  const s = getSession(), st = statusOf(m), tok = esc(tokenSymbol(m)), held = shareBalance(m), fee = currentFeeBps(cfg, m), tot = totalPool(m);
  if (st !== "open") {
    const next = `<a href="/?cat=${ev!.category}&stock=${encodeURIComponent(ev!.symbol)}">See the open ${esc(ev!.symbol)} market →</a>`;
    box.innerHTML = `<div class="tcard"><div class="thead"><b>${STATUS_LABEL[st]}</b></div><p class="note" style="margin:0">${st === "trading" ? `Bets closed ${fmtTs(m.closeTs)}; the result comes after ${fmtTs(m.resolveAfterTs)} and is final about ${fmtTs(m.resolveAfterTs + cfg.disputeWindowSecs.toNumber())}.` : st === "proposed" ? `The result is in its dispute window until ${fmtTs(m.proposedAt + cfg.disputeWindowSecs.toNumber())} (${timeLeft(m.proposedAt + cfg.disputeWindowSecs.toNumber())} left); payouts follow automatically.` : "This market is settled. Payouts have been sent."}</p>${next}</div><div id="pos"></div>`;
    showPosition(); return;
  }
  // The floor is shown as a round number of shares, a power of ten worth at least MIN_BET_USD, so nobody has to work it
  // out from the share price. The program's own floor is in raw units (dust stakes cost more in payout rent than they
  // can win — see forfeit_position); without a price that is all there is.
  const px = priceOf(m), minExp = px ? minUnitExp(px, MIN_BET_USD, m.decimals) : null;
  const minRaw = Math.max(cfg.minBet.toNumber(), minExp != null ? toRaw(m, 10 ** minExp) : 0);
  const minTxt = minExp != null && minRaw === toRaw(m, 10 ** minExp) ? fmtUnit(minExp) : fmtAmt(m, minRaw, 8);
  box.innerHTML = `<div class="tcard">
    <div class="thead"><b>Stake ${tok}</b><span class="note">${esc(issuerOf(m))} pool</span></div>
    <div class="topts">${m.pools.map((p, i) => `<button class="${bucket === i ? "on" : ""}" style="--c:${bucketColor(m, i)}" data-b="${i}"><span class="to1"><span>${esc(name(i))}</span><b>${tot ? Math.round((p / tot) * 100) + "%" : "—"}</b></span><em>${esc(bucketLabel(m, i))}</em></button>`).join("")}</div>
    <label class="tlabel" for="amt">Amount${s && balances.loaded ? `<span class="note">Balance ${fmtAmt(m, held)} ${tok}</span>` : ""}</label>
    <div class="tamt"><input id="amt" type="number" min="0" step="any" placeholder="${minTxt}" inputmode="decimal"><span class="unit">${tok}</span></div>
    <div class="note" id="minnote">Minimum stake <b>${minTxt} ${tok}</b> ${usdOf(m, minRaw)}</div>
    ${s ? `<div class="tquick"><button data-min>Min</button><button data-f="0.25">25%</button><button data-f="0.5">50%</button><button data-f="1">Max</button></div>` : ""}
    <div class="tsum" id="quote"></div>
    ${s ? `<button class="primary big" id="go"${bucket < 0 ? " disabled" : ""}>${bucket < 0 ? "Pick a range" : `Stake on ${esc(name(bucket))}`}</button>` : `<button class="primary big" id="connect">Connect wallet</button>`}
    <div id="msg"></div>
    <p class="note" style="margin:0">Fee ${fee / 100}% of winnings${Date.now() / 1000 < earlyBirdUntil(cfg, m) ? " (early-bird rate)" : ""}, never on your stake; locked in when you bet. Payouts arrive automatically.</p>
    <p class="note" style="margin:0">If nobody takes another range, every ${tok} staked is returned in full — there is no house on the other side of your bet.</p>
    ${IS_TEST && s && balances.loaded && !held ? `<p class="note" style="margin:0">No ${tok} yet? <a href="/faucet.html">Get free test tokens</a>.</p>` : ""}
  </div><div id="pos"></div>`;
  box.querySelectorAll<HTMLButtonElement>(".topts button").forEach((b) => (b.onclick = () => { bucket = Number(b.dataset.b); render(); }));
  const amtEl = box.querySelector<HTMLInputElement>("#amt")!, quote = box.querySelector("#quote")!;
  // The panel is rebuilt on every render (picking a range, a balance arriving, the periodic reload); what was typed
  // has to survive that, for as long as it is the same pool.
  if (typed.id === m.id) amtEl.value = typed.v;
  const upd = () => {
    typed = { id: m.id, v: amtEl.value };
    const a = toRaw(m, Number(amtEl.value));
    if (bucket < 0) { quote.innerHTML = `<span class="note">Pick a range above.</span>`; return; }
    if (!a) { quote.innerHTML = `<div class="r"><span>Pays if right</span><b>${payoutMultiple(m, bucket, fee)?.toFixed(2) ?? "whole pot"}${payoutMultiple(m, bucket, fee) ? "×" : ""}</b></div>`; return; }
    const q = impliedPayout(m, bucket, a, fee);
    quote.innerHTML = `<div class="r"><span>Payout if ${esc(name(bucket))}</span><b class="big">${fmtAmt(m, q.total)} ${tok}</b></div><div class="r note"><span>${usdOf(m, q.total)}</span><span>${(q.total / a).toFixed(2)}× · +${fmtAmt(m, q.total - a)} ${tok}</span></div><div class="note">Any other range: you lose the ${fmtAmt(m, a)} ${tok} staked.</div>`;
  };
  amtEl.oninput = upd; upd();
  box.querySelectorAll<HTMLButtonElement>(".tquick button").forEach((b) => (b.onclick = () => { amtEl.value = b.dataset.min != null ? minTxt.replace(/,/g, "") : String(Math.floor(uiAmount(m, held) * Number(b.dataset.f) * 1e4) / 1e4); upd(); }));
  const c = box.querySelector<HTMLButtonElement>("#connect"); if (c) c.onclick = (e) => { e.stopPropagation(); openWalletMenu(); };
  const go = box.querySelector<HTMLButtonElement>("#go"), msg = box.querySelector("#msg")!;
  if (go) go.onclick = async () => {
    const sess = getSession()!; const a = toRaw(m, Number(amtEl.value));
    if (a < minRaw) { msg.innerHTML = `<div class="msg err">The minimum stake is ${minTxt} ${tok}.</div>`; return; }
    if (balances.loaded && a > held) { msg.innerHTML = `<div class="msg err">You hold ${fmtAmt(m, held)} ${tok}.</div>`; return; }
    go.disabled = true; msg.innerHTML = `<div class="msg">Confirm in your wallet…</div>`;
    let sig = "";
    try {
      const tx = await buildPlaceBetTx(sess.publicKey, m, bucket, a);
      sig = await sess.signAndSend(tx);
      msg.innerHTML = `<div class="msg">Sent. Waiting for confirmation…</div>`;
      await confirmBySig(sig);
    } catch (e: any) {
      // Sent but not seen yet: it may still land, so the button stays off rather than invite a second stake.
      if (sig && e?.unconfirmed) { msg.innerHTML = `<div class="msg err">Sent, but not confirmed yet: it may still go through. Check <a href="/portfolio.html">My bets</a> or the <a href="${explorerTx(sig)}" target="_blank" rel="noopener">transaction</a> before staking again.</div>`; return; }
      msg.innerHTML = `<div class="msg err">${esc(e?.message ?? e)}</div>`; go.disabled = false; return;
    }
    // The stake is on-chain from here on: nothing below may turn that into an error message.
    const done = `Staked ${fmtAmt(m, a)} ${tok} on “${esc(full(bucket))}”. <a href="${explorerTx(sig)}" target="_blank" rel="noopener">view tx</a>`;
    typed = { id: -1, v: "" };
    const show = (note = "") => { const m2 = document.getElementById("msg"); if (m2) m2.innerHTML = `<div class="msg ok">${done}${note ? `<br>${esc(note)}` : ""}</div>`; };
    show();
    try { await refreshBalances(); } catch {}
    try { await load(true); } catch {}
    show();
    try { show((await bindReferralAfterBet(sess)) || ""); } catch {}
  };
  showPosition();
}
async function showPosition() {
  const s = getSession(), el = document.getElementById("pos"); if (!s || !el) return;
  const p = await fetchPosition(m.pubkey, s.publicKey); if (!p) { el.innerHTML = ""; return; }
  const parts = (p.amounts as any[]).slice(0, m.nBuckets).map((x, i) => [x.toNumber(), i]).filter(([x]) => x > 0).map(([x, i]) => `<div class="r"><span>${esc(name(i))}</span><b>${fmtAmt(m, x)} ${esc(tokenSymbol(m))}</b></div>`);
  el.innerHTML = parts.length ? `<div class="tcard"><div class="thead"><b>Your position</b><a href="/portfolio.html" class="note">All my bets →</a></div><div class="tsum">${parts.join("")}</div></div>` : "";
}

async function mountDispute() {
  const btn = document.getElementById("dbtn") as HTMLButtonElement | null; if (!btn) return;
  try { const r = await fetch(`${API_BASE}/disputes?market=${m.pubkey.toBase58()}`); const j = await r.json(); const open = (j.disputes ?? []).filter((d: any) => d.status === "open"); if (open.length) document.getElementById("dlist")!.textContent = `${open.length} open dispute${open.length > 1 ? "s" : ""} already filed.`; } catch {}
  btn.onclick = async () => {
    const s = getSession(); if (!s) { openWalletMenu(); return; }
    const reason = prompt("Why is the proposed result wrong? (what you observed, where)"); if (!reason || reason.trim().length < 5) return;
    const claimed = prompt("What should the move be, in %? (leave empty if unsure)") ?? "";
    btn.disabled = true;
    try {
      const msg = `sharepot-dispute v1\nmarket=${m.pubkey.toBase58()}\nwallet=${s.publicKey.toBase58()}\nclaimed=${claimed.trim()}\nreason=${reason.trim().slice(0, 2000)}`;
      const sig = await s.signMessage(new TextEncoder().encode(msg));
      const r = await fetch(`${API_BASE}/dispute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ market: m.pubkey.toBase58(), wallet: s.publicKey.toBase58(), reason: reason.trim().slice(0, 2000), claimedValue: claimed.trim() || null, signature: bs58(sig) }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "failed");
      document.getElementById("dlist")!.textContent = "Dispute filed. The operator has been notified.";
    } catch (e: any) { alert(e?.message ?? e); btn.disabled = false; }
  };
}
/** The price data behind the result. The browser hashes the raw response itself and compares it with the hash the
 *  proposer wrote on-chain, so nobody has to trust this page's say-so. */
async function loadEvidence() {
  const el = document.getElementById("evidence"); if (!el || !m.proposedAt) return;
  try {
    const r = await fetch(`${API_BASE}/evidence/${m.id}`); if (!r.ok) { el.textContent = "not published yet"; return; }
    const e = await r.json();
    const raw = await (await fetch(`${API_BASE}/evidence/${m.id}/raw`)).arrayBuffer();
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const match = sha === m.snapshotHash;
    const div = Number(e.dividend) > 0 ? ` + $${esc(e.dividend)} dividend going ex` : "";
    const dayTs = (d: any) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? fmtTs(dayEnd(String(d))) : String(d));
    const fp = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 8 : 4 }) : esc(v); };
    el.innerHTML = e.samples != null
      ? `<div><b>${esc(e.symbol)}</b> close ${esc(dayTs(e.prevDate))} <span class="mono">$${fp(e.baseline)}</span> (median of ${esc(e.prevSamples)} quotes) → ${esc(dayTs(e.date))} <span class="mono">$${fp(e.close)}</span> (median of ${esc(e.samples)} quotes in the hour before) = <span class="mono">${fmtMove(e.movePpm)}</span></div>`
      : `<div><b>${esc(e.symbol)}</b> close ${esc(e.prevDate)} <span class="mono">$${esc(e.prevClose)}</span> → ${esc(e.date)} <span class="mono">$${esc(e.close)}</span>${div} = <span class="mono">${fmtMove(e.movePpm)}</span>${e.split ? ` · split ${esc(e.split)} that day` : ""}</div>`;
    el.innerHTML +=
      `<div><a href="${API_BASE}/evidence/${m.id}/raw" target="_blank" rel="noopener">${e.samples != null ? "sampled quotes" : "raw price response"}</a> · sha256 <span class="hash">${sha.slice(0, 16)}…</span> · <span class="${match ? "" : "warn"}">${match ? "✓ matches the hash stored on-chain" : "✗ does not match the on-chain hash"}</span></div>
      ${e.signature ? `<div><a href="${explorerTx(e.signature)}" target="_blank" rel="noopener">proposal transaction</a></div>` : ""}`;
  } catch { el.textContent = "not published yet"; }
}

onSession(() => { if (ev && m) render(); });   // the top bar mounts (and reconnects the wallet) before the pool is picked
load().catch((e) => (root.innerHTML = `<div class="msg err">Could not load this market: ${esc(e.message ?? e)}</div>`));
setInterval(() => { if (ev && !document.activeElement?.matches("input")) load(); }, 30_000);
