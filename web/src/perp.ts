// SharePot Perp — the pool page (/): one pool per stock (NVDA, TSLA, META …; the tabs pick one, ?s=<SYMBOL> in the
// address), what an entry would really be (fill, net leverage, funding, zero line) before anyone signs, the user's
// positions, and the three things a user does: enter, exit, withdraw an exit. Nothing is done on a user's behalf. Test tokens are on their own page (perp-faucet.ts). Shared parts: perp-core.ts (strings,
// formatting, chain reads), perp-shell.ts (frame).
import type { Address } from "viem";
import type { Session } from "./wallet-evm";
import {
  geo, noSend, MAXU, POOLS, PROPOSED, TESTNET, abi, bindPoolTabs, pickedPool, poolTabs, rawToStr, read, erc20, errText, esc, exposures, fillOf, fmtDate, fmtTime, fundingDaily, left, levText,
  loadMine, loadState, netLev, parseAmount, pct, price, pt, rememberExit, symbolList, tierCls, tokenList, tierKey, tok, txLink, usd, type Mine, type Pool, type St,
} from "./perp-core";
import { health, mountShell, onHealth, onSession, refreshWallet } from "./perp-shell";

let session: Session | null = null;

// ---------------------------------------------------------------- page
let pool: Pool | null = pickedPool();
let st: St | null = null, mine: Mine | null = null, loadErr = "";
/** Each pool's last settled close, for the tabs (null = none yet; missing = not read yet). */
const closes: Record<string, number | null> = {};
let pick = 0, amountStr = "", busy = false;
const msgs: Record<string, string> = {};   // per action: the last result line (ok / error), HTML
const exitStr: Record<number, string> = {};

async function refresh() {
  const p = pool; if (!p) return;
  // the other pools' last closes ride along in the same batched request (the tabs show them)
  POOLS.forEach((q) => { if (q !== p) read(q, "lastValue").then((v: bigint) => { closes[q.symbol] = v > 0n ? Number(v) / 1e8 : null; render(); }).catch(() => {}); });
  try {
    const s = await loadState(p);
    if (p !== pool) return;   // another stock was picked meanwhile: its own refresh is on the way
    st = s; loadErr = ""; closes[p.symbol] = s.lastValue > 0n ? price(s) : null;
    render();   // the pool first; the wallet's side follows
    const m = session ? await loadMine(s, session.address as Address) : null;
    if (p !== pool) return;
    mine = m;
  } catch (e) { if (p === pool) loadErr = errText(e); }
  render(); refreshWallet();
}

/** Shows another stock's pool: what was typed for the last one does not carry over. */
function switchPool(p: Pool) {
  if (p === pool || busy) return;
  pool = p; st = null; mine = null; loadErr = ""; amountStr = "";
  for (const k of Object.keys(msgs)) delete msgs[k];
  for (const k of Object.keys(exitStr)) delete exitStr[Number(k)];
  document.title = `SharePot Perp · ${p.symbol}`;
  render(); refresh();
}

function marketCard(s: St) {
  const e = exposures(s.tiers), px = price(s), f = fundingDaily(s.fundingBps, e);
  const fillL = e.L ? e.M / e.L : 0, fillS = e.S ? e.M / e.S : 0, maxE = Math.max(e.L, e.S, 1);
  const who = e.L + e.S === 0 || e.M === 0 ? pt("mk.noFundingEmpty") : f > 0 ? pt("mk.longsPay") : f < 0 ? pt("mk.shortsPay") : pt("mk.noFunding");
  const bar = (cls: string, x: number, fill: number) => `<div class="pbar ${cls}"><i style="width:${((x / maxE) * 100).toFixed(1)}%"></i><b style="width:${(((x * fill) / maxE) * 100).toFixed(1)}%"></b></div>`;
  const dollars = (x: number) => usd((x / 1e8) * px);
  let status = "";
  if (s.next && s.next.state === PROPOSED) status = pt("mk.proposed", { date: esc(fmtDate(s.next.cutoff)), price: usd(Number(s.next.value) / 1e8), time: esc(fmtTime(s.next.proposedAt + s.dispute)) });
  else if (s.next && s.next.cutoff <= s.now) status = pt("mk.waiting", { date: esc(fmtDate(s.next.cutoff)) });
  return `<section class="card pmk">
    <div class="pmkh"><h2>${esc(pt("mk.title", { sym: s.pool.symbol }))}</h2>${s.paused ? `<span class="pill warnp">${esc(pt("mk.paused"))}</span>` : ""}</div>
    <dl class="pkv">
      <dt>${esc(pt("mk.nextClose"))}</dt><dd>${!s.open ? esc(pt("mk.noneScheduled")) : s.open.cutoff > Date.now() / 1000 ? esc(pt("mk.nextCloseVal", { time: fmtTime(s.open.cutoff), left: left(s.open.cutoff, Date.now() / 1000) })) : esc(fmtTime(s.open.cutoff))}</dd>
      <dt>${esc(pt("mk.lastClose"))}</dt><dd>${s.settled ? esc(pt("mk.lastCloseVal", { price: usd(px), date: fmtDate(s.settled.cutoff) })) : esc(pt("mk.noCloseYet"))}</dd>
      <dt>${esc(pt("mk.funding"))}</dt><dd><b>${esc(pt("mk.fundingVal", { daily: pct(Math.abs(f), 3), yearly: pct(Math.abs(f) * 252, 1) }))}</b> · ${esc(who)}</dd>
    </dl>
    ${status ? `<div class="note pstatus">${status}</div>` : ""}
    ${e.L + e.S === 0 ? `<div class="note">${esc(pt("mk.empty"))}</div>` : `<div class="psides">
      <div class="pside"><div class="psh"><span class="gain">${esc(pt("mk.long"))}</span><span>${esc(pt("mk.exposure", { usd: dollars(e.L) }))} · <b>${esc(pt("mk.filled", { pct: pct(fillL, 0) }))}</b></span></div>${bar("long", e.L, fillL)}</div>
      <div class="pside"><div class="psh"><span class="drop">${esc(pt("mk.short"))}</span><span>${esc(pt("mk.exposure", { usd: dollars(e.S) }))} · <b>${esc(pt("mk.filled", { pct: pct(fillS, 0) }))}</b></span></div>${bar("short", e.S, fillS)}
        ${s.treasuryTok > 0n ? `<div class="note">${esc(pt("mk.treasury", { usd: dollars(Number(s.treasuryTok)) }))}</div>` : ""}</div>
    </div>${health.demoWallets.length ? `<p class="note">${pt("mk.demo", { n: health.demoWallets.length })}</p>` : ""}`}
  </section>`;
}

function orderCard(s: St) {
  const t = s.tiers[pick] ?? s.tiers[0];
  const amt = parseAmount(amountStr);
  const fee = amt ? (amt * BigInt(s.feeBps)) / 10_000n : 0n, net = amt ? amt - fee : 0n;
  const e = exposures(s.tiers, net > 0n ? { tier: t.i, amount: net } : undefined);
  const f = fillOf(t, e), k = netLev(t, f), fd = fundingDaily(s.fundingBps, e);
  const crowdedLong = fd > 0, mineCrowded = t.isLong === crowdedLong, fPos = Math.abs(fd) * t.c * f;
  const funding = fd === 0 || f === 0 ? pt("ord.fundNone") : mineCrowded ? pt("ord.fundPay", { pct: pct(fPos, 3) }) : pt("ord.fundRecv", { pct: pct(fPos, 3) });
  const kFull = netLev(t, 1);   // what the tier is when fully matched: what the user picked
  const zero = kFull > 1.0001 ? pt("ord.zeroDrop", { sym: s.pool.symbol, pct: pct(1 / kFull, 0) }) : kFull < -0.0001 ? pt("ord.zeroRise", { sym: s.pool.symbol, pct: pct(1 / -kFull, 0) }) : pt("ord.zeroNever");
  const why = f >= 0.9995 ? "" : f <= 0.0005 ? pt("ord.unmatched", { sym: s.pool.symbol }) : pt("ord.partial", { pct: pct(f, 0), sym: s.pool.symbol });
  const levCls = (x: number) => (x > 0.005 ? "gain" : x < -0.005 ? "drop" : "");
  const can = !!session && !!s.open && !s.paused && !noSend() && !s.problem;
  const over = !!(amt && mine && amt > mine.bal);
  const needApprove = !!(amt && mine && mine.allowance < amt);
  // test tokens are on their own page (/faucet); pointed to only when this wallet is short of them
  const toFaucet = TESTNET && !!mine && (mine.bal === 0n || mine.eth === 0n || over);
  const btn = !session ? pt("ord.connect") : !s.open ? pt("ord.noOpen") : needApprove ? pt("ord.approve", { tok: s.pool.tokenSymbol }) : pt("ord.submit");
  return `<section class="card pord">
    <h2>${esc(pt("ord.title"))}</h2>
    <div class="ptiers" role="radiogroup">${s.tiers.map((x) => `<button role="radio" aria-checked="${x.i === t.i}" class="ptier ${tierCls(x)}${x.i === t.i ? " on" : ""}" data-tier="${x.i}"><b>${esc(pt(tierKey(x)))}</b><small>${esc(pt(tierKey(x) + ".d"))}</small></button>`).join("")}</div>
    <label class="pamt"><span>${esc(pt("ord.amount"))} <small class="note">${mine ? esc(pt("ord.balance", { n: tok(mine.bal), tok: s.pool.tokenSymbol })) : ""}</small></span>
      <span class="pin"><input id="pamount" inputmode="decimal" autocomplete="off" placeholder="0.0" value="${esc(amountStr)}"><span class="unit">${esc(s.pool.tokenSymbol)}</span>${mine ? `<button class="ghost" id="pmax">${esc(pt("ord.max"))}</button>` : ""}</span></label>
    <dl class="pkv pprev">
      <dt>${esc(pt("ord.target"))}</dt><dd><b class="${levCls(kFull)}">${esc(levText(kFull))}</b></dd>
      <dt>${esc(pt("ord.fill"))}</dt><dd>${pct(f, 0)}</dd>
      <dt>${esc(pt("ord.lev"))}</dt><dd><b class="${levCls(k)}">${esc(levText(k))}</b></dd>
      <dt>${esc(pt("ord.funding"))}</dt><dd>${esc(funding)}</dd>
      <dt>${esc(pt("ord.zero"))}</dt><dd>${esc(zero)}</dd>
      <dt>${esc(pt("ord.price"))}</dt><dd>${s.open ? esc(pt("ord.priceAt", { time: fmtTime(s.open.cutoff) })) : "—"}</dd>
      <dt>${esc(pt("ord.fee"))}</dt><dd>${esc(pt("ord.feeVal", { pct: pct(s.feeBps / 1e4, 1), n: tok(fee, 8), tok: s.pool.tokenSymbol }))}</dd>
    </dl>
    ${why ? `<div class="note pwarn">${esc(why)}</div>` : ""}
    ${Math.abs(k) > 1.05 ? `<div class="note">${esc(pt("ord.decay"))}</div>` : ""}
    ${over ? `<div class="note warn">${esc(pt("ord.tooBig"))}</div>` : ""}
    ${toFaucet ? `<div class="note">${pt("ord.toFaucet", { tok: esc(s.pool.tokenSymbol) })}</div>` : ""}
    <button class="primary big" id="penter" ${can && !busy && !over ? "" : "disabled"}>${esc(btn)}</button>
    ${msgs.enter ? `<div class="note pmsg">${msgs.enter}</div>` : ""}
  </section>`;
}

function positionsCard(s: St) {
  if (!session) return `<section class="card ppos"><h2>${esc(pt("pos.title"))}</h2><div class="note">${esc(pt("pos.connect"))}</div></section>`;
  if (!mine) return `<section class="card ppos"><h2>${esc(pt("pos.title"))}</h2><div class="note">…</div></section>`;
  const e = exposures(s.tiers), px = price(s);
  const rows = s.tiers.map((t) => {
    const p = mine!.pos[t.i], ex = mine!.exits.filter((x) => x.tier === t.i);
    if (!p.shares && !p.pending.length && !ex.length) return "";
    const k = netLev(t, fillOf(t, e));
    const pend = p.pending.map((q) => `<div class="note">${esc(pt("pos.pendingIn", { time: fmtTime(q.cutoff), n: tok(q.amount), tok: s.pool.tokenSymbol }))}</div>`).join("");
    const exits = ex.map((x) => x.ready
      ? `<div class="pready">${esc(pt("pos.ready", { n: tok(x.tokens), tok: s.pool.tokenSymbol }))} <button class="primary" data-claim="${x.day}:${x.tier}" ${busy || noSend() || !!s.problem ? "disabled" : ""}>${esc(pt("pos.withdraw"))}</button></div>`
      : `<div class="note">${esc(pt("pos.pendingOut", { time: fmtTime(x.cutoff) }))}</div>`).join("");
    const held = p.shares > 0n ? `<div class="pposv"><b>${esc(pt("pos.value", { n: tok(p.tokens), tok: s.pool.tokenSymbol, usd: usd((Number(p.tokens) / 1e8) * px) }))}</b><span class="note">${esc(pt("pos.now", { lev: levText(k) }))}</span></div>
      <div class="pexit"><input data-exitamt="${t.i}" inputmode="decimal" placeholder="${esc(pt("pos.exitAmt", { tok: s.pool.tokenSymbol }))}" value="${esc(exitStr[t.i] ?? "")}"><button data-exit="${t.i}" ${busy || !s.open || s.paused || noSend() || !!s.problem ? "disabled" : ""}>${esc(pt("pos.exit"))}</button><button class="ghost" data-exitall="${t.i}" ${busy || !s.open || s.paused || noSend() || !!s.problem ? "disabled" : ""}>${esc(pt("pos.exitAll"))}</button></div>` : "";
    return `<div class="pposr"><div class="pposh"><b class="tc-${tierCls(t)}">${esc(pt(tierKey(t)))}</b></div>${held}${pend}${exits}</div>`;
  }).join("");
  return `<section class="card ppos"><h2>${esc(pt("pos.title"))}</h2>${rows || `<div class="note">${esc(pt("pos.none"))}</div>`}${msgs.pos ? `<div class="note pmsg">${msgs.pos}</div>` : ""}</section>`;
}

const rules = (s: St) => `<details class="card prules"><summary>${esc(pt("rules.title"))}</summary><ol>${[1, 2, 3, 4, 5, 6, 7].map((i) => `<li>${pt("rules." + i, { sym: esc(s.pool.symbol) })}</li>`).join("")}</ol></details>`;

function render() {
  const root = document.getElementById("perp")!;
  const keepFocus = document.activeElement instanceof HTMLInputElement ? { id: document.activeElement.id, ex: document.activeElement.dataset.exitamt, pos: document.activeElement.selectionStart } : null;
  // the hero names every stock (the site is not one stock's); the tabs under it pick the pool shown below
  const hero = `<section class="phero"><h1>${pt("hero.h1", { sym: esc(symbolList("disjunction")) })}</h1><p>${esc(pt("hero.p", { tok: tokenList() }))}</p>${geo.blocked ? `<div class="note warn">${pt("rules.7", { sym: esc(symbolList()) })}</div>` : ""}</section>`;
  if (!pool) { root.innerHTML = hero + `<div class="note">Not deployed on this network yet.</div>`; return; }
  const tabs = poolTabs(pool, (p) => `<span class="pstockpx">${closes[p.symbol] ? usd(closes[p.symbol]!) : closes[p.symbol] === null ? esc(pt("tab.noClose")) : "…"}</span>`);
  if (!st) { root.innerHTML = hero + tabs + `<div class="note">${loadErr ? esc(pt("err", { err: loadErr })) : "…"}</div>`; bindPoolTabs(switchPool); return; }
  // one flat list in reading order (phones); on wide screens the order panel takes the right column (perp.css)
  const problem = st.problem ? `<div class="card pwarn">${esc(pt("ord.problem", { why: st.problem }))}</div>` : "";
  root.innerHTML = hero + tabs + problem + `<div class="pgrid">${marketCard(st)}${orderCard(st)}${positionsCard(st)}${rules(st)}</div>`
    + (loadErr ? `<div class="note warn">${esc(pt("err", { err: loadErr }))}</div>` : "");
  bind();
  if (keepFocus) {
    const el = keepFocus.id ? document.getElementById(keepFocus.id) : keepFocus.ex != null ? document.querySelector<HTMLInputElement>(`input[data-exitamt="${keepFocus.ex}"]`) : null;
    if (el instanceof HTMLInputElement) { el.focus(); if (keepFocus.pos != null) el.setSelectionRange(keepFocus.pos, keepFocus.pos); }
  }
}

async function run(key: string, fn: () => Promise<string>) {
  if (busy) return;
  busy = true; msgs[key] = esc(pt("ord.sending")); render();
  try { msgs[key] = await fn(); }
  catch (e: any) { msgs[key] = e?.unconfirmed ? esc(pt("ord.notConfirmed")) + txLink(e.txid) : `<span class="warn">${esc(pt("err", { err: errText(e) }))}</span>`; }
  finally { busy = false; await refresh(); }
}

function bind() {
  bindPoolTabs(switchPool);
  document.querySelectorAll<HTMLButtonElement>("button[data-tier]").forEach((b) => (b.onclick = () => { pick = Number(b.dataset.tier); render(); }));
  const amt = document.getElementById("pamount") as HTMLInputElement | null;
  if (amt) amt.oninput = () => { amountStr = amt.value; render(); };
  const mx = document.getElementById("pmax"); if (mx) mx.onclick = () => { if (mine) { amountStr = rawToStr(mine.bal); render(); } };
  const ent = document.getElementById("penter");
  if (ent) ent.onclick = () => run("enter", async () => {
    // every send goes to the pool whose numbers were on screen (s.pool), never to whatever is picked by the time it signs
    const s = st!, t = s.tiers[pick], a = parseAmount(amountStr), P = s.pool.address as Address, TOKEN = s.pool.token as Address;
    if (!session?.write) throw new Error(pt("ord.connect"));
    if (!a) throw new Error(pt("ord.zeroAmt"));
    let h = "";
    if ((mine?.allowance ?? 0n) < a) {
      // the token to approve is the one the pool contract records, checked right now, never only the one this build names
      const onChain = String(await read(s.pool, "token")).toLowerCase();
      if (onChain !== TOKEN.toLowerCase()) throw new Error(pt("ord.tokenMismatch"));
      msgs.enter = esc(pt("ord.approving", { tok: s.pool.tokenSymbol })); render();
      await session.write({ address: TOKEN, abi: erc20, functionName: "approve", args: [P, MAXU] });
    }
    msgs.enter = esc(pt("ord.sending")); render();
    h = await session.write({ address: P, abi, functionName: "requestDeposit", args: [t.i, a] });
    amountStr = "";
    return esc(pt("ord.sent", { time: fmtTime(s.open!.cutoff) })) + txLink(h);
  });
  document.querySelectorAll<HTMLInputElement>("input[data-exitamt]").forEach((i) => (i.oninput = () => { exitStr[Number(i.dataset.exitamt)] = i.value; }));
  const exit = (tier: number, all: boolean) => run("pos", async () => {
    const s = st!, p = mine!.pos[tier], P = s.pool.address as Address;
    let shares = p.shares;
    if (!all) {
      const a = parseAmount(exitStr[tier] ?? ""); if (!a) throw new Error(pt("ord.zeroAmt"));
      if (a > p.tokens) throw new Error(pt("pos.exitTooBig"));
      const now = await read(s.pool, "tierInfo", [tier]);   // a close may have settled since the page last refreshed
      shares = now.held > 0n ? (a * now.shares) / now.held : 0n;
      if (shares > p.shares) shares = p.shares;
    }
    const h = await session!.write!({ address: P, abi, functionName: "requestRedeem", args: [tier, shares] });
    rememberExit(s.pool, session!.address, s.open!.day); exitStr[tier] = "";
    return esc(pt("pos.exitSent", { time: fmtTime(s.open!.cutoff) })) + txLink(h);
  });
  document.querySelectorAll<HTMLButtonElement>("button[data-exit]").forEach((b) => (b.onclick = () => exit(Number(b.dataset.exit), false)));
  document.querySelectorAll<HTMLButtonElement>("button[data-exitall]").forEach((b) => (b.onclick = () => exit(Number(b.dataset.exitall), true)));
  document.querySelectorAll<HTMLButtonElement>("button[data-claim]").forEach((b) => (b.onclick = () => {
    const [d, tier] = b.dataset.claim!.split(":").map(Number), x = mine!.exits.find((e) => e.day === d && e.tier === tier);
    const s = st!;
    run("pos", async () => { const h = await session!.write!({ address: s.pool.address as Address, abi, functionName: "claim", args: [session!.address, BigInt(d), tier] }); return esc(pt("pos.withdrawn", { n: tok(x?.tokens ?? 0n), tok: s.pool.tokenSymbol })) + txLink(h); });
  }));
}

// ---------------------------------------------------------------- boot
mountShell("pool");
document.title = `SharePot Perp · ${pool?.symbol ?? ""}`;
onSession((s) => { session = s; refresh(); });
onHealth(() => render());
render();
refresh();
setInterval(() => { if (!busy && document.visibilityState === "visible") refresh(); }, 30_000);
