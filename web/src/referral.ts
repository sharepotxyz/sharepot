// Referral links (server/referrals.mjs). A visitor who lands with ?ref=CODE keeps the code in this browser; the
// first bet the connected wallet places then binds the wallet to it — signed by the wallet, so only its owner can.
import { API_BASE } from "./config";
import { esc } from "./ui";
import type { Session } from "./wallet";

const KEY = "sharepot.ref";
const bs58 = (b: Uint8Array) => { const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let n = 0n; for (const x of b) n = n * 256n + BigInt(x); let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = "1" + s; } return s; };
export const pendingReferral = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const clear = () => { try { localStorage.removeItem(KEY); } catch {} };

/** On every page: remember ?ref=CODE and show who invited us (once verified by the API). */
export function captureReferral() {
  const code = new URLSearchParams(location.search).get("ref")?.trim().toUpperCase();
  if (code && /^[A-Z0-9]{4,12}$/.test(code)) { try { localStorage.setItem(KEY, code); } catch {} }
  const have = pendingReferral(); if (!have) return;
  fetch(`${API_BASE}/referral/lookup/${have}`).then((r) => r.json()).then((j) => {
    if (!j.valid) { clear(); return; }
    if (!pendingReferral()) return;   // bound (and cleared) while we were looking it up
    const host = document.querySelector("header.topbar"); if (!host || document.getElementById("refbar")) return;
    const bar = document.createElement("div"); bar.id = "refbar"; bar.className = "refbar";
    bar.innerHTML = `<div class="container">Invited by <b class="mono">${esc(j.referrer)}</b> · ${(j.refereeBps / 100).toFixed(0)}% of the fees on your winnings come back to you. The link binds with your first bet. <a href="/invite.html">How it works</a></div>`;
    host.after(bar);
  }).catch(() => {});
}

/** On connect: if a code is pending and this wallet's only activity is its first bet, bind now (a bet whose confirmation
 *  failed in the browser, or one placed on another device, still counts). Asks the API first so the wallet only ever
 *  sees a signature prompt when the binding will go through. */
export async function bindIfPending(s: Session): Promise<void> {
  const code = pendingReferral(); if (!code) return;
  try {
    const j = await (await fetch(`${API_BASE}/referral/${s.publicKey.toBase58()}`)).json();
    if (j.bound) { clear(); document.getElementById("refbar")?.remove(); return; }
    if (j.firstBet) await bindReferralAfterBet(s);
  } catch {}
}

/** After a confirmed bet: bind the wallet to the pending code. Returns a short note for the UI, or null. */
export async function bindReferralAfterBet(s: Session): Promise<string | null> {
  const code = pendingReferral(); if (!code) return null;
  const wallet = s.publicKey.toBase58();
  try {
    const sig = await s.signMessage(new TextEncoder().encode(`sharepot-referral v1\nwallet=${wallet}\ncode=${code}`));
    const r = await fetch(`${API_BASE}/referral/bind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet, code, signature: bs58(sig) }) });
    const j = await r.json();
    if (r.ok) { clear(); document.getElementById("refbar")?.remove(); document.dispatchEvent(new Event("sharepot:referral-bound")); return j.already ? null : `Referral link applied: ${(10).toFixed(0)}% of the fees on your winnings come back to you.`; }
    if (j.permanent) { clear(); document.getElementById("refbar")?.remove(); }   // wrong wallet for this link; stop asking
    return null;
  } catch { return null; }   // user declined the signature or network hiccup: the code stays for the next bet
}
