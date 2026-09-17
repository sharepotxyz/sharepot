// Invite page: the wallet's referral link (unlocked by its first bet), who it brought in, and what that earned.
import { esc, mountTopbar, onSession, short } from "./ui";
import { API_BASE, explorerTx } from "./config";

mountTopbar({});
const el = document.getElementById("invite")!;
const usd = (v: number) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (bps: number) => (bps / 100).toFixed(0) + "%";
let wallet: string | null = null;

async function render() {
  if (!wallet) { el.innerHTML = `<div class="fcard"><div class="note">Connect a wallet to see your invite link.</div></div>`; return; }
  el.innerHTML = `<div class="fcard"><div class="note">Loading…</div></div>`;
  try {
    let r = await fetch(`${API_BASE}/referral/${wallet}`); let j = await r.json();
    if (j.eligible && !j.code) { r = await fetch(`${API_BASE}/referral/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) }); j = await r.json(); }
    if (!r.ok) throw new Error(j.error ?? "failed");
    const tiers = (j.tiers as { points: number; bps: number }[]).map((t) => `<tr${t.bps === j.tierBps ? ' class="sel"' : ""}><td>${t.points ? t.points.toLocaleString("en-US") + "+ points" : "From the first bet"}</td><td class="r"><b>${pct(t.bps)}</b> of their fees</td></tr>`).join("");
    const link = j.eligible
      ? `<div class="linkbox"><input class="mono" id="link" readonly value="${esc(j.link)}"><button class="primary" id="copy">Copy link</button></div>
         <div class="note">Your code: <b class="mono">${esc(j.code)}</b> · works on devnet and mainnet alike; the binding follows the wallet.</div>`
      : `<div class="msg">Your link unlocks with your first bet. <a href="/">Pick a market</a> and stake some shares — then come back here.</div>`;
    const earned = (j.earned as any[]);
    const table = earned.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Token</th><th class="r">Earned</th><th class="r">as referrer</th><th class="r">as invitee</th><th class="r">Paid out</th><th class="r">≈ USD</th></tr></thead><tbody>${earned.map((e) => `<tr><td><b>${esc(e.token ?? short(e.mint))}</b></td><td class="r mono">${fmt(e.earned)}</td><td class="r mono">${fmt(e.asReferrer)}</td><td class="r mono">${fmt(e.asReferee)}</td><td class="r mono">${fmt(e.paid)}</td><td class="r">${e.usd != null ? usd(e.usd) : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="note">Nothing yet. A row appears here when an invited wallet's winning bet settles.</div>`;
    const payouts = (j.payouts as any[]).length ? `<div class="note" style="margin-top:8px">Last payouts: ${(j.payouts as any[]).slice(0, 5).map((p) => `${fmt(p.amount)} ${esc(p.token ?? "")} <a href="${explorerTx(p.signature)}" target="_blank" rel="noopener">tx</a>`).join(" · ")}</div>` : "";
    el.innerHTML = `
      <div class="fcard"><h2 style="margin:0">Your invite link</h2>${link}
        <div class="lbstats four"><div><span class="note">Invited</span><b>${j.referred}</b></div><div><span class="note">Your share</span><b>${pct(j.tierBps)}</b></div><div><span class="note">Earned, all tokens</span><b>${usd(j.earnedUsd)}</b></div><div><span class="note">Your points</span><b>${Math.round(j.points).toLocaleString("en-US")}</b></div></div>
        ${j.nextTier ? `<div class="note">${(j.nextTier.points - j.points).toLocaleString("en-US", { maximumFractionDigits: 0 })} more points lift your share to ${pct(j.nextTier.bps)}.</div>` : ""}
        ${j.bound ? `<div class="note">You joined through <b class="mono">${esc(j.bound.code)}</b> (${esc(j.bound.referrer)}): ${pct(j.refereeBps)} of the fees on your winnings come back to you.</div>` : ""}
      </div>
      <div class="fcard"><h3 style="margin:0">By token</h3><div class="note">Rebates are paid in the pool's own token, so the total above splits into these; “Paid out” is what has already reached your wallet.</div>${table}${payouts}</div>
      <div class="fcard"><h3 style="margin:0">How it works</h3>
        <ol class="fsteps">
          <li>Share your link. A wallet that arrives through it and places its <b>first</b> bet is bound to you — permanently, on every network.</li>
          <li>Fees are charged on winnings only (3% of what a winner takes from the losing ranges). When an invited wallet wins, you earn a share of that fee and they get ${pct(j.refereeBps)} of it back — both in the same stock token as the pool.</li>
          <li>Payouts go straight to your wallet once a week; nothing to claim. Amounts under $0.05 wait for the next round.</li>
        </ol>
        <table class="tbl"><thead><tr><th>Your all-time points</th><th class="r">Your share</th></tr></thead><tbody>${tiers}</tbody></table>
      </div>`;
    const cp = document.getElementById("copy") as HTMLButtonElement | null, inp = document.getElementById("link") as HTMLInputElement | null;
    if (cp && inp) cp.onclick = async () => { try { await navigator.clipboard.writeText(inp.value); cp.textContent = "Copied ✓"; } catch { inp.select(); } setTimeout(() => (cp.textContent = "Copy link"), 1500); };
  } catch (e: any) { el.innerHTML = `<div class="fcard"><div class="msg err">${esc(e?.message ?? e)}</div></div>`; }
}
const fmt = (v: number | null) => (v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 6 }));
onSession((s) => { wallet = s ? s.publicKey.toBase58() : null; render(); });
document.addEventListener("sharepot:referral-bound", () => render());
