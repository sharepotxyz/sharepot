// Leaderboard. Points come from the API (server/points.mjs): for every market you were settled in,
//   points = your stake in dollars × that market's player pot in dollars.
// Dollars, not share counts, so no pool is cheaper to farm than another; the house seed is excluded, so bootstrap
// money never inflates a score. Wallets the wash-trading audit has flagged are listed separately, not ranked.
import { fmtUsd } from "./stocks";
import { esc, mountTopbar, onSession } from "./ui";
import { API_BASE, explorerAddress } from "./config";

mountTopbar({});
const boardEl = document.getElementById("board")!, totalsEl = document.getElementById("totals")!;
const winEl = document.getElementById("windows")!, howEl = document.getElementById("how")!, flagEl = document.getElementById("flagged")!;

const WINDOWS: [string, string][] = [["all", "All time"], ["30d", "30 days"], ["7d", "7 days"]];
let win = new URLSearchParams(location.search).get("window") ?? "all";
if (!WINDOWS.some(([k]) => k === win)) win = "all";
let me: string | null = null;

/** Points are dollars × dollars, so they get large fast; show three significant-ish digits with a suffix. */
function fmtPoints(v: number) {
  if (!isFinite(v) || v <= 0) return "0";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return v.toFixed(0);
}
const short = (w: string) => w.slice(0, 4) + "…" + w.slice(-4);
const signed = (v: number) => (v >= 0 ? "+" : "−") + fmtUsd(Math.abs(v));

function renderWindows() {
  winEl.innerHTML = WINDOWS.map(([k, label]) => `<button class="tab${k === win ? " on" : ""}" data-w="${k}" role="tab">${esc(label)}</button>`).join("");
  winEl.querySelectorAll<HTMLButtonElement>("button[data-w]").forEach((b) => (b.onclick = () => {
    win = b.dataset.w!;
    const u = new URL(location.href); u.searchParams.set("window", win); history.replaceState(null, "", u);
    renderWindows(); load();
  }));
}

async function load() {
  boardEl.innerHTML = `<div class="note">Loading…</div>`;
  let j: any;
  try {
    const r = await fetch(`${API_BASE}/leaderboard?window=${encodeURIComponent(win)}&limit=100`);
    if (!r.ok) throw new Error("leaderboard " + r.status);
    j = await r.json();
  } catch {
    boardEl.innerHTML = `<div class="note">The leaderboard is unavailable right now.</div>`;
    return;
  }
  const t = j.totals ?? {};
  howEl.innerHTML = `Points for a settled market = <b>your stake in dollars × the market's player pot in dollars</b>. Bets score whether they win or lose — deep pools are what a parimutuel needs. The house seed is not counted. Scores are frozen at settlement using the token price at that moment.`;
  totalsEl.innerHTML = [
    ["Players", String(t.players ?? 0)],
    ["Settled markets", String(t.markets ?? 0)],
    ["Volume staked", fmtUsd(t.volumeUsd ?? 0)],
    ["Fees to treasury", fmtUsd(t.feesUsd ?? 0)],
  ].map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("");

  const rows: any[] = j.entries ?? [];
  if (!rows.length) {
    boardEl.innerHTML = `<div class="note">No settled markets in this window yet. Points appear once a market pays out.</div>`;
  } else {
    boardEl.innerHTML = `<div class="scroll"><table class="tbl"><thead><tr><th>#</th><th>Wallet</th><th class="r">Points</th><th class="r">Markets</th><th class="r">Staked</th><th class="r">Net P&amp;L</th></tr></thead><tbody>${rows.map((e) => `
      <tr${e.wallet === me ? ` style="background:var(--ok-bg)"` : ""}>
        <td class="mono">${e.rank}</td>
        <td><a class="mono" href="${explorerAddress(e.wallet)}" target="_blank" rel="noopener">${esc(short(e.wallet))}</a>${e.wallet === me ? ` <b>you</b>` : ""}${e.bot ? ` <span class="note">demo bot</span>` : ""}</td>
        <td class="r mono"><b>${esc(fmtPoints(e.points))}</b></td>
        <td class="r mono">${e.markets}</td>
        <td class="r mono">${esc(fmtUsd(e.volumeUsd))}</td>
        <td class="r mono" style="color:${e.pnlUsd >= 0 ? "var(--gain)" : "var(--drop)"}">${esc(signed(e.pnlUsd))}</td>
      </tr>`).join("")}</tbody></table></div>
      ${t.approxRows ? `<div class="note" style="margin-top:8px">${t.approxRows} of ${t.rows} settlements predate frozen pricing and are scored at today's token price.</div>` : ""}`;
  }

  const flagged: any[] = j.banned ?? [];
  flagEl.innerHTML = flagged.length
    ? `<h2>Excluded by the wash-trading audit</h2><div class="scroll"><table class="tbl"><thead><tr><th>Wallet</th><th>Reason</th><th class="r">Points forfeited</th></tr></thead><tbody>${flagged.map((e) => `<tr><td class="mono">${esc(short(e.wallet))}</td><td>${esc(e.reason ?? "")}</td><td class="r mono">${esc(fmtPoints(e.points))}</td></tr>`).join("")}</tbody></table></div>`
    : "";
}

renderWindows();
load();
onSession((s) => { me = s ? s.publicKey.toBase58() : null; load(); });
