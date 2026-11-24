// Small charts for the perp pages, as HTML/SVG strings. Colours come from the CSS variables (light and dark). Red and
// green fail colour-blind checks against each other, so side and sign never ride on colour alone: longs sit left of a
// centre line and shorts right, losses left and gains right, and every value is printed beside its mark with its sign.
import { esc, moveText, netLev, pct, pt, tierCls, tok, usd, type Tier } from "./perp-core";

/** A tier's payoff as a small line: the stock's move across, the position's up; the slope is the tier fully matched
 *  (2× long steep up, the hedge flat, shorts down). */
export const tierGlyph = (t: Tier) => {
  const k = netLev(t, 1), y = (x: number) => (14 - Math.max(-11, Math.min(11, k * x * 2.5))).toFixed(1);
  return `<svg class="pglyph g-${tierCls(t)}" viewBox="0 0 48 28" aria-hidden="true"><path class="ax" d="M2 14H46M24 3V25"/><path class="ln" d="M4 ${y(-2)}L44 ${y(2)}"/></svg>`;
};

/** The pool's two sides on one bar from the centre: longs to the left, shorts to the right, each as long as what it
 *  wants to bet. The solid part next to the centre is what is matched (the same on both sides); the faded ends have no
 *  one across. `usdOf` turns an exposure into dollars. */
export const balanceChart = (L: number, S: number, M: number, usdOf: (x: number) => string) => {
  const max = Math.max(L, S, 1), w = (x: number) => ((x / max) * 100).toFixed(1);
  const side = (cls: string, x: number) => {
    const solid = M > 0 ? `<b style="width:${w(M)}%"></b>` : "", faded = x > M ? `<i style="width:${w(x - M)}%"></i>` : "";
    return `<div class="pbh ${cls}">${cls === "l" ? faded + solid : solid + faded}</div>`;   // the solid part always next to the centre
  };
  const fill = (x: number) => (x > 0 ? M / x : 0);
  const head = (cls: string, name: string, x: number) => `<div class="pbl ${cls}"><span class="pbn"><i class="sw f-${cls}"></i>${esc(name)}</span><b>${esc(usdOf(x))}</b><small>${esc(pt("viz.matched", { pct: pct(fill(x), 0) }))}</small></div>`;
  return `<div class="pbal" title="${esc(pt("viz.balTitle", { m: usdOf(M) }))}">
    <div class="pbls">${head("l", pt("mk.long"), L)}${head("s", pt("mk.short"), S)}</div>
    <div class="pbt">${side("l", L)}${side("s", S)}</div>
    <div class="pkey"><span><i class="sw lsolid"></i>${esc(pt("viz.keyMatched", { usd: usdOf(M) }))}</span><span><i class="sw lfaded"></i>${esc(pt("viz.keyUnmatched"))}</span></div>
  </div>`;
};

/** "If SYM closes −10 … +10 % at the next close, you ±$": bars from a centre line (losses left, gains right) for the pool
 *  as it will be at that close; a thin mark shows the tier fully matched where that differs. `base` is the entry's
 *  dollar value; with no amount entered, per $1,000. */
export const scenarioChart = (sym: string, k: number, kFull: number, base: number) => {
  const b = base > 0 ? base : 1000, two = Math.abs(k - kFull) > 0.005;
  const max = Math.max(Math.abs(k), Math.abs(kFull), 1) * 0.1 * b;   // the scale: at least the stock's own ±10 %
  const signed = (v: number) => (Math.abs(v) < 0.005 ? "$0" : (v > 0 ? "+" : "−") + usd(Math.abs(v)));
  const at = (v: number) => (50 + (v / max) * 50).toFixed(1);
  const rows = [-0.1, -0.05, 0.05, 0.1].map((m) => {
    const v = k * m * b, vf = kFull * m * b, wv = ((Math.abs(v) / max) * 50).toFixed(1);
    const bar = Math.abs(v) < 0.005 ? "" : `<b class="${v < 0 ? "neg" : "pos"}" style="${v < 0 ? "right" : "left"}:50%;width:${wv}%"></b>`;
    const tick = two ? `<s style="left:${at(vf)}%"></s>` : "";
    const tip = pt("viz.scTip", { sym, m: (m > 0 ? "+" : "−") + Math.abs(m * 100) + "%", v: signed(v) }) + (two ? " · " + pt("viz.scTipFull", { v: signed(vf) }) : "");
    return `<span class="psm">${esc(sym)} ${m > 0 ? "+" : "−"}${Math.abs(m * 100)}%</span><span class="pst" title="${esc(tip)}">${bar}${tick}</span><span class="psv">${esc(signed(v))}</span>`;
  }).join("");
  return `<div class="psc"><div class="psch">${esc(pt(base > 0 ? "viz.scHead" : "viz.scHead1000", { sym, usd: usd(b) }))}</div>${rows}
    ${two ? `<div class="pkey"><span><i class="sw solid"></i>${esc(pt("viz.keyNow"))}</span><span><i class="sw mark"></i>${esc(pt("viz.keyFull"))}</span></div>` : ""}</div>`;
};

/** How a held amount splits at a fill `f`: the effective (matched) part and the rest, in raw token units rounded to the
 *  4 decimals shown and in whole cents, so the two add up to the held amount exactly as it is printed. */
export const effSplit = (tokens: bigint, f: number, px: number) => {
  const U = 10_000n, all = ((tokens + U / 2n) / U) * U;
  const eff = f >= 0.995 ? all : f < 0.005 ? 0n : BigInt(Math.round((Number(tokens) * f) / 1e4)) * U;
  const allC = Math.round((Number(tokens) / 1e8) * px * 100), effC = Math.round((Number(eff) / 1e8) * px * 100);
  return { eff, rest: all - eff, effUsd: effC / 100, restUsd: (allC - effC) / 100 };
};

/** A held position right now as a bar: the effective part in the tier's colour, the part no one is across from in grey,
 *  each with its tokens and dollars, then what the two make together. Fully matched (or not at all) is one segment. */
export const effBlock = (t: Tier, f: number, tokens: bigint, px: number, sym: string, tokSym: string) => {
  const { eff, rest, effUsd, restUsd } = effSplit(tokens, f, px), full = rest === 0n, none = eff === 0n;
  const w = full ? 100 : none ? 0 : Math.min(99, Math.max(1, f * 100));
  const bar = `<div class="peb">${none ? "" : `<b class="f-${tierCls(t)}" style="width:${w.toFixed(1)}%"></b>`}${full ? "" : `<i style="width:${(100 - w).toFixed(1)}%"></i>`}</div>`;
  const amt = (n: bigint, d: number) => `${esc(tok(n))} ${esc(tokSym)} <span class="note">≈ ${esc(usd(d))}</span>`;
  const key = [
    none ? "" : `<div><i class="sw f-${tierCls(t)}"></i>${esc(pt(full ? "viz.effAll" : "viz.eff", { pct: pct(f, 0) }))} ${full ? "" : amt(eff, effUsd)}</div>`,
    full ? "" : `<div><i class="sw faded"></i>${esc(pt(t.isLong ? "viz.restL" : "viz.restS"))} ${amt(rest, restUsd)}</div>`,
  ].join("");
  return `<div class="peff">${bar}<div class="pekey">${key}</div><div class="pesum">${esc(pt(full || none ? "pos.now" : "viz.sum", { lev: moveText(netLev(t, f), sym) }))}</div></div>`;
};
