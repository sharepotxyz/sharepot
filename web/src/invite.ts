// Invite page: the wallet's referral link (unlocked by its first bet), who it brought in, and what that earned.
import { esc, mountTopbar, onSession, short } from "./ui";
import { API_BASE, explorerTx } from "./config";
import { t } from "./i18n";

mountTopbar({});
const el = document.getElementById("invite")!;
const usd = (v: number) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (bps: number) => (bps / 100).toFixed(0) + "%";
let wallet: string | null = null;

async function render() {
  if (!wallet) { el.innerHTML = `<div class="fcard"><div class="note">${t("inv.connect")}</div></div>`; return; }
  el.innerHTML = `<div class="fcard"><div class="note">${t("common.loading")}</div></div>`;
  try {
    let r = await fetch(`${API_BASE}/referral/${wallet}`); let j = await r.json();
    if (j.eligible && !j.code) { r = await fetch(`${API_BASE}/referral/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) }); j = await r.json(); }
    if (!r.ok) throw new Error(j.error ?? "failed");
    const tiers = (j.tiers as { points: number; bps: number }[]).map((x) => `<tr${x.bps === j.tierBps ? ' class="sel"' : ""}><td>${x.points ? t("inv.tierPoints", { n: x.points.toLocaleString("en-US") }) : t("inv.tierFirst")}</td><td class="r">${t("inv.tierShare", { pct: `<b>${pct(x.bps)}</b>` })}</td></tr>`).join("");
    const link = j.eligible
      ? `<div class="linkbox"><input class="mono" id="link" readonly value="${esc(j.link)}"><button class="primary" id="copy">${t("inv.copy")}</button></div>
         <div class="note">${t("inv.code", { code: `<b class="mono">${esc(j.code)}</b>` })}</div>`
      : `<div class="msg">${t("inv.locked")}</div>`;
    const earned = (j.earned as any[]);
    const table = earned.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>${t("inv.colToken")}</th><th class="r">${t("inv.colEarned")}</th><th class="r">${t("inv.colReferrer")}</th><th class="r">${t("inv.colInvitee")}</th><th class="r">${t("inv.colPaid")}</th><th class="r">≈ USD</th></tr></thead><tbody>${earned.map((e) => `<tr><td><b>${esc(e.token ?? short(e.mint))}</b></td><td class="r mono">${fmt(e.earned)}</td><td class="r mono">${fmt(e.asReferrer)}</td><td class="r mono">${fmt(e.asReferee)}</td><td class="r mono">${fmt(e.paid)}</td><td class="r">${e.usd != null ? usd(e.usd) : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="note">${t("inv.nothing")}</div>`;
    const payouts = (j.payouts as any[]).length ? `<div class="note" style="margin-top:8px">${t("inv.lastPayouts")} ${(j.payouts as any[]).slice(0, 5).map((p) => `${fmt(p.amount)} ${esc(p.token ?? "")} <a href="${explorerTx(p.signature)}" target="_blank" rel="noopener">tx</a>`).join(" · ")}</div>` : "";
    el.innerHTML = `
      <div class="fcard"><h2 style="margin:0">${t("inv.yourLink")}</h2>${link}
        <div class="lbstats four"><div><span class="note">${t("inv.invited")}</span><b>${j.referred}</b></div><div><span class="note">${t("inv.share")}</span><b>${pct(j.tierBps)}</b></div><div><span class="note">${t("inv.earnedAll")}</span><b>${usd(j.earnedUsd)}</b></div><div><span class="note">${t("inv.points")}</span><b>${Math.round(j.points).toLocaleString("en-US")}</b></div></div>
        ${j.nextTier ? `<div class="note">${t("inv.next", { n: (j.nextTier.points - j.points).toLocaleString("en-US", { maximumFractionDigits: 0 }), pct: pct(j.nextTier.bps) })}</div>` : ""}
        ${j.bound ? `<div class="note">${t("inv.joined", { code: `<b class="mono">${esc(j.bound.code)}</b>`, who: esc(j.bound.referrer), pct: pct(j.refereeBps) })}</div>` : ""}
      </div>
      <div class="fcard"><h3 style="margin:0">${t("inv.byToken")}</h3><div class="note">${t("inv.byTokenNote")}</div>${table}${payouts}</div>
      <div class="fcard"><h3 style="margin:0">${t("inv.how")}</h3>
        <ol class="fsteps">
          <li>${t("inv.how1")}</li>
          <li>${t("inv.how2", { pct: pct(j.refereeBps) })}</li>
          <li>${t("inv.how3")}</li>
        </ol>
        <table class="tbl"><thead><tr><th>${t("inv.colAllTime")}</th><th class="r">${t("inv.share")}</th></tr></thead><tbody>${tiers}</tbody></table>
      </div>`;
    const cp = document.getElementById("copy") as HTMLButtonElement | null, inp = document.getElementById("link") as HTMLInputElement | null;
    if (cp && inp) cp.onclick = async () => { try { await navigator.clipboard.writeText(inp.value); cp.textContent = t("common.copied"); } catch { inp.select(); } setTimeout(() => (cp.textContent = t("inv.copy")), 1500); };
  } catch (e: any) { el.innerHTML = `<div class="fcard"><div class="msg err">${esc(e?.message ?? e)}</div></div>`; }
}
const fmt = (v: number | null) => (v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 6 }));
onSession((s) => { wallet = s ? s.publicKey.toBase58() : null; render(); });
document.addEventListener("sharepot:referral-bound", () => render());
