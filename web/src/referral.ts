// Referral links (server/referrals.mjs). A visitor who lands with ?ref=CODE keeps the code in this browser; the
// first bet the connected wallet places then binds the wallet to it — signed by the wallet, so only its owner can.
import { API_BASE } from "./config";
import { esc } from "./ui";
import { t } from "./i18n";
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
    bar.innerHTML = `<div class="container">${t("ref.bar", { who: `<b class="mono">${esc(j.referrer)}</b>`, pct: (j.refereeBps / 100).toFixed(0) })}</div>`;
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
    // Sign-In-With-Solana where the wallet offers it: the wallet checks the domain is this page, so no other site can
    // collect a binding for sharepot. Otherwise a plain message naming the site and the time (valid 10 minutes).
    let body: Record<string, unknown>;
    if (s.signIn) {
      const { signedMessage, signature } = await s.signIn({ domain: location.host, address: wallet, statement: `Apply SharePot referral code ${code} to this wallet's first bet.`, uri: location.origin + "/", version: "1", nonce: `${code}${Math.random().toString(36).slice(2, 10)}`, issuedAt: new Date().toISOString() });
      body = { wallet, code, signedMessage: bs58(signedMessage), signature: bs58(signature) };
    } else {
      const ts = Math.floor(Date.now() / 1000);
      const sig = await s.signMessage(new TextEncoder().encode(`sharepot-referral v2\ndomain=${location.host}\nwallet=${wallet}\ncode=${code}\nts=${ts}`));
      body = { wallet, code, ts, signature: bs58(sig) };
    }
    const r = await fetch(`${API_BASE}/referral/bind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (r.ok) { clear(); document.getElementById("refbar")?.remove(); document.dispatchEvent(new Event("sharepot:referral-bound")); return j.already ? null : t("ref.applied", { pct: (10).toFixed(0) }); }
    if (j.permanent) { clear(); document.getElementById("refbar")?.remove(); }   // wrong wallet for this link; stop asking
    return null;
  } catch { return null; }   // user declined the signature or network hiccup: the code stays for the next bet
}
