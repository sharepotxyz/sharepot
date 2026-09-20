// Leaderboard. Points come from the API (server/points.mjs): for every market you were settled in,
//   points = shares staked × the official close the market settled on
// i.e. what the stake was worth in dollars at settlement. Every range you bet counts, won or lost.
import { esc, mountTopbar, onSession } from "./ui";
import { API_BASE, explorerAddress } from "./config";
import { t } from "./i18n";

mountTopbar({});
const boardEl = document.getElementById("board")!, totalsEl = document.getElementById("totals")!;
const winEl = document.getElementById("windows")!, howEl = document.getElementById("how")!;

const WINDOWS: [string, string][] = [["all", t("lb.all")], ["30d", t("lb.30d")], ["7d", t("lb.7d")]];
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

function renderWindows() {
  winEl.innerHTML = WINDOWS.map(([k, label]) => `<button class="tab${k === win ? " on" : ""}" data-w="${k}" role="tab">${esc(label)}</button>`).join("");
  winEl.querySelectorAll<HTMLButtonElement>("button[data-w]").forEach((b) => (b.onclick = () => {
    win = b.dataset.w!;
    const u = new URL(location.href); u.searchParams.set("window", win); history.replaceState(null, "", u);
    renderWindows(); load();
  }));
}

async function load() {
  boardEl.innerHTML = `<div class="note">${t("common.loading")}</div>`;
  let j: any;
  try {
    const r = await fetch(`${API_BASE}/leaderboard?window=${encodeURIComponent(win)}&limit=100`);
    if (!r.ok) throw new Error("leaderboard " + r.status);
    j = await r.json();
  } catch {
    boardEl.innerHTML = `<div class="note">${t("lb.err")}</div>`;
    return;
  }
  const tot = j.totals ?? {};
  howEl.innerHTML = t("lb.how");
  totalsEl.innerHTML = [
    [t("lb.players"), String(tot.players ?? 0)],
    [t("lb.settled"), String(tot.markets ?? 0)],
    [t("lb.awarded"), fmtPoints(tot.points ?? 0)],
  ].map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("");

  const rows: any[] = j.entries ?? [];
  if (!rows.length) {
    boardEl.innerHTML = `<div class="note">${t("lb.empty")}</div>`;
  } else {
    boardEl.innerHTML = `<div class="scroll"><table class="tbl"><thead><tr><th>#</th><th>${t("lb.colWallet")}</th><th class="r">${t("lb.colPoints")}</th><th class="r">${t("lb.colMarkets")}</th><th class="r">${t("lb.colWon")}</th></tr></thead><tbody>${rows.map((e) => `
      <tr${e.wallet === me ? ` style="background:var(--ok-bg)"` : ""}>
        <td class="mono">${Number(e.rank)}</td>
        <td><a class="mono" href="${explorerAddress(e.wallet)}" target="_blank" rel="noopener">${esc(short(e.wallet))}</a>${e.wallet === me ? ` <b>${t("lb.you")}</b>` : ""}${e.test ? ` <span class="note">${t("lb.test")}</span>` : ""}</td>
        <td class="r mono"><b>${esc(fmtPoints(e.points))}</b></td>
        <td class="r mono">${Number(e.markets)}</td>
        <td class="r mono">${Number(e.won)} / ${Number(e.markets)}</td>
      </tr>`).join("")}</tbody></table></div>
`;
  }
}

renderWindows();
load();
onSession((s) => { me = s ? s.publicKey.toBase58() : null; load(); });
