// SharePot Perp — daily closes (/history): every scheduled day, newest first, with the close it settled on, where that
// price came from (Yahoo, Nasdaq's second opinion, Chainlink on Base mainnet), what moved between the sides, the funding,
// the transactions, and a button that hashes the evidence file in the browser and compares it with the hash on-chain.
import { PERP } from "./config";
import { addrLink, api, esc, fmtDate, fmtTime, left, pct, pt, spct, tok, txLink, usd, PROPOSED, SETTLED, SKIPPED, SCHEDULED } from "./perp-core";
import { mountShell } from "./perp-shell";

type Sess = { date: string; close: number; prevClose: number; prevDate: string; dividend: number; movePpm: number | null; nasdaq: boolean | null; nasdaqClose: number | null; nasdaqNote: string | null };
type Day = {
  day: number; date: string; cutoff: number; state: number; value: string; proposedAt: number; evidenceHash: string; disputeEnds: number | null; rejected: number; rolledTo: number | null;
  proposeTx: string | null; settleTx: string | null; settledAt: number | null; prevValue: string | null; longExp: string | null; shortExp: string | null; moved: string | null; funding: string | null;
  evidence: { sessions: Sess[]; close: number | null; chainlink: { diffBps: number; price: number; updatedAt: number; feed: string } | null; sources: string[] } | null;
};
type Days = { at: number; pool: string; explorer: string; feed: string | null; disputeWindowSecs: number; indexedAt: number | null; days: Day[] };

let data: Days | null = null, err = "";
const checks: Record<number, string> = {};   // day -> result line (HTML)

function pill(d: Day, now: number) {
  if (d.state === SETTLED) return `<span class="pill ok">${esc(pt("h.settled"))}</span>`;
  if (d.state === PROPOSED) return `<span class="pill warnp">${esc(pt("h.inDispute"))}</span>`;
  if (d.state === SKIPPED) return `<span class="pill">${esc(pt("h.skipped"))}</span>`;
  return d.cutoff > now ? `<span class="pill">${esc(pt("h.next"))}</span>` : `<span class="pill warnp">${esc(pt("h.waiting"))}</span>`;
}

function dayCard(d: Day, prevSettled: Day | undefined, now: number) {
  const v = Number(d.value) / 1e8, ev = d.evidence;
  const rows: string[] = [];
  const row = (k: string, val: string) => rows.push(`<dt>${esc(pt(k))}</dt><dd>${val}</dd>`);
  if (d.state === SCHEDULED && d.cutoff > now) row("h.closesAt", esc(pt("h.closesAtVal", { time: fmtTime(d.cutoff), left: left(d.cutoff, now) })));
  if (d.state === SCHEDULED && d.cutoff <= now) row("h.status", esc(pt("h.waitingNote")));
  if (d.state === SKIPPED) row("h.status", esc(pt("h.skippedNote", { day: d.rolledTo ?? "?" })));
  if (ev?.sessions?.length) {
    for (const s of ev.sessions) {
      row("h.close", `<b>${usd(s.close)}</b> <span class="note">${esc(pt("h.closeOf", { date: s.date }))}${s.dividend ? " · " + esc(pt("h.dividend", { d: usd(s.dividend) })) : ""}</span>`);
      row("h.nasdaq", s.nasdaq === true ? `<span class="gain">✓</span> ${esc(pt("h.nasdaqAgreed", { close: usd(s.nasdaqClose ?? s.close) }))}` : s.nasdaq === false ? esc(pt("h.nasdaqSameRange")) : esc(pt("h.nasdaqNone")));
    }
  }
  if (ev?.chainlink) row("h.chainlink", `${usd(ev.chainlink.price)} · ${esc(pt("h.chainlinkDiff", { pct: pct(ev.chainlink.diffBps / 1e4, 2) }))} ${addrLink(ev.chainlink.feed, pt("h.feed"), "https://basescan.org")}`);
  if (d.state === PROPOSED || d.state === SETTLED) {
    const base = d.prevValue ? Number(d.prevValue) / 1e8 : prevSettled ? Number(prevSettled.value) / 1e8 : 0;
    row("h.value", `${v.toLocaleString("en-US", { maximumFractionDigits: 8 })}${base ? ` <span class="${v >= base ? "gain" : "drop"}">${esc(spct(v / base - 1))}</span>` : ` <span class="note">${esc(pt("h.first"))}</span>`}`);
  }
  if (d.state === PROPOSED && d.disputeEnds) row("h.dispute", esc(pt("h.disputeUntil", { time: fmtTime(d.disputeEnds), left: left(d.disputeEnds, now) })));
  if (d.state === SETTLED) {
    const L = Number(d.longExp ?? 0) / 1e8, S = Number(d.shortExp ?? 0) / 1e8, up = d.prevValue ? Number(d.value) > Number(d.prevValue) : false;
    row("h.sides", esc(pt("h.sidesVal", { l: L.toLocaleString("en-US", { maximumFractionDigits: 2 }), s: S.toLocaleString("en-US", { maximumFractionDigits: 2 }), tok: PERP.tokenSymbol })));
    const moved = BigInt(d.moved ?? "0"), fund = BigInt(d.funding ?? "0");
    row("h.moved", moved > 0n ? esc(pt(up ? "h.movedUp" : "h.movedDown", { n: tok(moved, 6), tok: PERP.tokenSymbol })) : esc(pt(d.prevValue ? "h.movedNone" : "h.movedFirst")));
    row("h.funding", fund > 0n ? esc(pt(L > S ? "h.fundLongs" : "h.fundShorts", { n: tok(fund, 6), tok: PERP.tokenSymbol })) : esc(pt("h.fundNone")));
  }
  if (d.rejected) row("h.rejected", esc(pt("h.rejectedVal", { n: d.rejected })));
  const links = [d.proposeTx ? txLink(d.proposeTx, pt("h.txProposed")) : "", d.settleTx ? txLink(d.settleTx, pt(d.state === SKIPPED ? "h.txSkipped" : "h.txSettled")) : ""].filter(Boolean).join(" ·");
  const hasHash = /^0x[0-9a-fA-F]{64}$/.test(d.evidenceHash) && !/^0x0{64}$/.test(d.evidenceHash);
  const evidence = hasHash ? `<div class="pevid"><div><span class="note">${esc(pt("h.hash"))}</span> <code class="mono">${esc(d.evidenceHash.slice(0, 10) + "…" + d.evidenceHash.slice(-8))}</code></div>
      <div class="prow">${ev ? `<button data-check="${d.day}">${esc(pt("h.check"))}</button><a class="btn" href="/api/evidence/${d.day}" target="_blank" rel="noopener">${esc(pt("h.file"))}</a>` : `<span class="note">${esc(pt("h.noFile"))}</span>`}${(ev?.sources ?? []).slice(0, 2).map((u) => `<a class="btn" href="${esc(u)}" target="_blank" rel="noopener nofollow">${esc(pt("h.source", { host: new URL(u).hostname }))}</a>`).join("")}</div>
      ${checks[d.day] ? `<div class="pmsg">${checks[d.day]}</div>` : ""}</div>` : "";
  return `<section class="card pday" id="day-${d.day}"><div class="pdayh"><h2>${esc(fmtDate(d.cutoff))}</h2>${pill(d, now)}<span class="note">${esc(pt("h.dayN", { n: d.day }))}</span></div>
    ${rows.length ? `<dl class="pkv">${rows.join("")}</dl>` : ""}${links ? `<div class="note ptx">${links}</div>` : ""}${evidence}</section>`;
}

function render() {
  const root = document.getElementById("perp")!;
  const intro = `<section class="phero"><h1>${esc(pt("h.title"))}</h1><p>${esc(pt("h.intro"))}</p></section>`;
  if (!data) { root.innerHTML = intro + `<div class="note">${err ? esc(pt("err", { err })) : "…"}</div>`; return; }
  const now = Date.now() / 1000, settled = data.days.filter((d) => d.state === SETTLED);
  const cards = data.days.map((d) => dayCard(d, settled.find((x) => x.day < d.day), now)).join("");
  root.innerHTML = intro + `<div class="phist">${cards || `<div class="note">${esc(pt("h.none"))}</div>`}</div>`
    + `<p class="note">${esc(pt("h.updated", { time: fmtTime(data.at) }))}</p>`;
  root.querySelectorAll<HTMLButtonElement>("button[data-check]").forEach((b) => (b.onclick = () => check(Number(b.dataset.check))));
}

/** Hash the evidence file exactly as served and compare it with the hash the pool stored on-chain. */
async function check(day: number) {
  const d = data?.days.find((x) => x.day === day); if (!d) return;
  checks[day] = esc(pt("h.checking")); render();
  try {
    const buf = await (await fetch(`/api/evidence/${day}`)).arrayBuffer();
    const h = "0x" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
    checks[day] = h.toLowerCase() === d.evidenceHash.toLowerCase()
      ? `<span class="gain">✓ ${esc(pt("h.match"))}</span> <code class="mono">${esc(h.slice(0, 10) + "…" + h.slice(-8))}</code>`
      : `<span class="drop">✗ ${esc(pt("h.mismatch"))}</span> <code class="mono">${esc(h)}</code>`;
  } catch (e: any) { checks[day] = `<span class="drop">${esc(pt("err", { err: String(e?.message ?? e) }))}</span>`; }
  render();
}

async function load() {
  try { data = await api<Days>("/days"); err = ""; } catch (e: any) { err = String(e?.message ?? e); }
  render();
}

mountShell("history");
document.title = `SharePot Perp · ${pt("h.title")}`;
render();
load();
setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
