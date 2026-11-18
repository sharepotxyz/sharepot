// SharePot Perp (the Base site): what every page shares — the strings, the formatting, the chain reads and the pool
// arithmetic. The pages are perp.ts (the pool), perp-history.ts, perp-me.ts, perp-faucet.ts and perp-docs.ts; the top bar, the wallet
// and the footer are perp-shell.ts. Strings live in perp-i18n/ (English and Traditional Chinese so far; other
// languages fall back to English).
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import perpAbiJson from "../../evm/abi/SharePotPerp.json";
import { EVM, PERP } from "./config";
import { LANG, LANGS } from "./i18n";
import en from "./perp-i18n/en.json";
import zhTW from "./perp-i18n/zh-TW.json";

// ---------------------------------------------------------------- language
const DICTS: Record<string, Record<string, string>> = { en, "zh-TW": zhTW };
const known = (l: string | null | undefined) => (l && LANGS.some(([k]) => k === l) ? l : null);
const cookieLang = document.cookie.match(/(?:^|;\s*)sp_lang=([\w-]+)/)?.[1];
const navLang = /^zh-(tw|hk|mo|hant)/i.test(navigator.language) ? "zh-TW" : null;
export const PL = known(new URLSearchParams(location.search).get("lang")) ?? known(cookieLang) ?? (LANG !== "en" ? LANG : null) ?? navLang ?? "en";
const dict: Record<string, string> = { ...en, ...(DICTS[PL] ?? {}) };
/** The string for `key` with {slots} filled; strings are ours and may carry markup, slot values are the caller's to escape. */
export const pt = (key: string, vars?: Record<string, string | number>) => { const s = dict[key] ?? key; return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s; };
export const LOCALE = PL === "en" ? "en-GB" : PL;
document.documentElement.lang = PL;

// ---------------------------------------------------------------- formatting
export const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const H23 = { hourCycle: "h23" } as const;
/** "Tue 17 Nov, 05:00 GMT+8": the viewer's own clock, zone named */
export const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleString(LOCALE, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset", ...H23 });
/** "Fri 13 Nov": a New York session date, printed as that date (not shifted into the viewer's zone) */
export const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short", timeZone: "America/New_York" });
export const left = (ts: number, now: number) => { const s = ts - now; if (s <= 0) return pt("time.now"); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.max(1, Math.floor((s % 3600) / 60)); return d > 0 ? pt("time.dh", { d, h }) : h > 0 ? pt("time.hm", { h, m }) : pt("time.m", { m }); };
export const usd = (v: number) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const pct = (f: number, dp = 1) => (f * 100).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }) + "%";
/** signed percentage: "+1.23%" / "−0.40%" */
export const spct = (f: number, dp = 2) => (f > 0 ? "+" : f < 0 ? "−" : "") + pct(Math.abs(f), dp);
export const DEC = 8, ONE = 10n ** BigInt(DEC);
export const tok = (raw: bigint, dp = 4) => (Number(raw) / 1e8).toLocaleString("en-US", { maximumFractionDigits: dp });
/** "12.5" → raw units, exact (no float); null if not a positive amount with ≤ 8 decimals */
export function parseAmount(s: string): bigint | null {
  const m = s.trim().replace(/,/g, "").match(/^(\d*)(?:\.(\d{0,8})\d*)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const v = BigInt(m[1] || "0") * ONE + BigInt((m[2] ?? "").padEnd(DEC, "0") || "0");
  return v > 0n ? v : null;
}
export const hex = (s: unknown, n: number) => typeof s === "string" && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(s);
export const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
/** Explorer links: only a well-formed hash or address ever goes into an href. */
export const txLink = (h: string, label = pt("tx")) => (hex(h, 64) && EVM.explorer ? ` <a href="${esc(EVM.explorer)}/tx/${esc(h)}" target="_blank" rel="noopener">${esc(label)}</a>` : "");
export const addrLink = (a: string, label = short(a), explorer = EVM.explorer) => (hex(a, 40) && explorer ? `<a class="mono" href="${esc(explorer)}/address/${esc(a)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label));
export const errText = (e: any) => String(e?.shortMessage ?? e?.details ?? e?.message ?? e).split("\n")[0].slice(0, 200);
/** GET /api/… on this site; throws on a non-2xx answer. */
export async function api<T = any>(path: string): Promise<T> {
  const r = await fetch("/api" + path, { headers: { accept: "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any).error ?? `HTTP ${r.status}`);
  return j as T;
}

// ---------------------------------------------------------------- chain
export const abi = perpAbiJson as any;
export const P = PERP.address as Address, TOKEN = PERP.token as Address;
// Reads are cheap on the wire but the public RPC counts them: sepolia.base.org answers "25/second request limit
// reached" per call past 25 a second, and a page load asks ~30 (a connected wallet ~70), so the extra ones came back
// after a 0.7 s retry on every load. Every contract read of a round therefore goes out as ONE Multicall3 call (the
// canonical deployment on Base; a deployless one elsewhere, e.g. a local anvil); failed reads still fail one by one.
// And sent as text/plain where the RPC accepts it (sepolia.base.org / mainnet.base.org do): a "simple" request, so the
// browser skips the CORS preflight that otherwise costs one more round trip (~0.23 s from Asia) before the first read.
const BASE_RPC = /(^|\.)base\.org$/.test(new URL(EVM.rpc).hostname);
const MULTICALL3 = [8453, 84532].includes(EVM.chainId) ? "0xcA11bde05977b3631167028862bE2a173976CA11" : null;
const chain = { id: EVM.chainId, name: EVM.name ?? "EVM", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [EVM.rpc] } },
  ...(MULTICALL3 ? { contracts: { multicall3: { address: MULTICALL3 as Address } } } : {}) };
export const pc = createPublicClient({
  chain, batch: { multicall: { batchSize: 16_384, deployless: !MULTICALL3 } },
  transport: http(EVM.rpc, { batch: true, retryCount: 3, retryDelay: 700, ...(BASE_RPC ? { fetchOptions: { headers: { "Content-Type": "text/plain" } } } : {}) }),
});
export const erc20 = [
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function allowance(address, address) view returns (uint256)"),
  parseAbiItem("function approve(address, uint256) returns (bool)"),
  parseAbiItem("function mint(address to, uint256 amount)"),
];
export const read = (functionName: string, args: unknown[] = []) => pc.readContract({ address: P, abi, functionName, args } as any) as Promise<any>;
export const MAXU = 2n ** 256n - 1n;
/** Test-network behaviour (the browser test wallet, the mint button, the "no value" notices) follows the chain the
 *  build talks to, never an env default: a mainnet build that forgot a flag must not ship them. 84532 = Base Sepolia,
 *  31337 = a local anvil. */
export const TESTNET = EVM.chainId === 84532 || EVM.chainId === 31337;
/** Only an https URL ever goes into an href built from configuration. */
export const httpsUrl = (u: string) => (/^https:\/\/[^\s"'<>]+$/.test(u) ? u : "#");
/** Raw units → the exact decimal string (no float on the way, so "Max" never rounds above the balance). */
export const rawToStr = (raw: bigint) => { const w = raw / ONE, f = (raw % ONE).toString().padStart(DEC, "0").replace(/0+$/, ""); return f ? `${w}.${f}` : `${w}`; };
/** Whether this visitor may send transactions, from the site's /api/health (Cloudflare's country for the request).
 *  Until that answer arrives nothing can be sent — fail closed; `blocked` = placed in the United States, where the page
 *  stays readable but every button that sends is off. (It used to be written into the HTML, which kept Cloudflare from
 *  caching the page: every visitor got a different copy.) */
export const geo = { known: false, blocked: false };
/** True when sending is off for this visitor right now: not known yet, or blocked. */
export const noSend = () => !geo.known || geo.blocked;

export type Tier = { i: number; c: number; isLong: boolean; gen: number; held: bigint; shares: bigint };
export type Ep = { day: number; cutoff: number; state: number; proposedAt: number; value: bigint; rolledTo: number };
export const SCHEDULED = 1, PROPOSED = 2, SETTLED = 3, SKIPPED = 4;
export type St = {
  now: number; lastScheduled: number; lastSettled: number; lastValue: bigint; dispute: number; feeBps: number; fundingBps: number; paused: boolean;
  tiers: Tier[]; hedge: number; treasuryTok: bigint; open: Ep | null; next: Ep | null; settled: Ep | null;
  /** Set when this page is not talking to the pool it was built for (wrong chain, or the pool's token is not the one
   *  the page would ask to approve): nothing may be sent then. */
  problem: string | null;
};
/** An exit: `ready` once its close settled (tokens = what a claim pays); before that, tokens is an estimate at today's share value. */
export type Exit = { day: number; tier: number; ready: boolean; tokens: bigint; cutoff: number };
export type Mine = { bal: bigint; allowance: bigint; eth: bigint; pos: { tier: number; tokens: bigint; shares: bigint; pending: { day: number; amount: bigint; cutoff: number }[] }[]; exits: Exit[] };

export const epoch = async (day: number): Promise<Ep> => { const e = await read("epochs", [BigInt(day)]); return { day, cutoff: Number(e[0]), state: Number(e[1]), proposedAt: Number(e[2]), value: e[3] as bigint, rolledTo: Number(e[5]) }; };
/** The day a request of `day` is (or will be) filled at, following skipped days; `filled` once that day settled. */
export async function fillDay(day: number): Promise<{ filled: boolean; ep: Ep }> {
  let e = await epoch(day);
  for (let i = 0; e.state === SKIPPED && e.rolledTo && i < 64; i++) e = await epoch(e.rolledTo);
  return { filled: e.state === SETTLED, ep: e };
}

export async function loadState(): Promise<St> {
  // Round 1, one batched request: everything that depends on nothing else — including the first 4 tiers (this pool
  // has 4; a read past tierCount fails, and a failed read also makes viem fetch its offchain-lookup chunk — another
  // request — so no more are asked than a pool usually has; a 5th, if a pool ever has one, follows on its own).
  const [blk, lastScheduled, lastSettled, lastValue, openEpoch, dispute, feeBps, fundingBps, paused, treasury, hedge, n, chainId, poolToken, ...tierRaw] = await Promise.all([
    pc.getBlock({ blockTag: "latest" }), read("lastScheduled"), read("lastSettled"), read("lastValue"), read("openEpoch"), read("disputeWindowSecs"),
    read("feeBps"), read("fundingBps"), read("paused"), read("treasury"), read("hedgeTier"), read("tierCount"), pc.getChainId(), read("token"),
    ...[0, 1, 2, 3].map((i) => read("tierInfo", [i]).catch(() => null))]);
  for (let i = tierRaw.length; i < Number(n); i++) tierRaw.push(await read("tierInfo", [i]).catch(() => null));
  const problem = chainId !== EVM.chainId ? `this page expects chain ${EVM.chainId} but its RPC answers for chain ${chainId}`
    : String(poolToken).toLowerCase() !== TOKEN.toLowerCase() ? "the pool's token is not the one this page was built for" : null;
  const now = Number(blk.timestamp);
  const tiers: Tier[] = tierRaw.slice(0, Number(n)).map((t: any, i) => ({ i, c: Number(t.c), isLong: t.isLong, gen: Number(t.gen), held: t.held, shares: t.shares }));
  if (tiers.length !== Number(n) || tierRaw.slice(0, Number(n)).some((t) => !t)) throw new Error("could not read the pool's tiers");
  const ls = Number(lastSettled), sched = Number(lastScheduled);
  // Round 2: the days around now, the last settled one and the treasury's hedge shares.
  const from = Math.max(Number(openEpoch), ls + 1), ahead: number[] = [];
  for (let d = from; d <= Math.min(sched, from + 6); d++) ahead.push(d);
  const [eps, settled, tSh] = await Promise.all([Promise.all(ahead.map(epoch)), ls ? epoch(ls) : Promise.resolve(null), read("sharesOf", [treasury, Number(hedge)])]);
  const h = tiers[Number(hedge)];
  const treasuryTok = h && h.shares > 0n ? ((tSh as bigint) * h.held) / h.shares : 0n;   // = sharesToTokens, from the tier's own books
  let last = settled; for (let d = ls; last && last.state !== SETTLED && d > 1; ) last = await epoch(--d);   // only after a skipped day
  return { now, problem, lastScheduled: sched, lastSettled: ls, lastValue, dispute: Number(dispute), feeBps: Number(feeBps), fundingBps: Number(fundingBps), paused, tiers, hedge: Number(hedge), treasuryTok,
    open: eps.find((e) => e.cutoff > now) ?? null, next: eps.find((e) => e.day === ls + 1) ?? null, settled: last && last.state === SETTLED ? last : null };
}

const exitDaysKey = (user: string) => `sharepot.perp.exits.${P.toLowerCase()}.${user.toLowerCase()}`;
const rememberedExits = (user: string): number[] => { try { return JSON.parse(localStorage.getItem(exitDaysKey(user)) ?? "[]").filter((x: unknown) => Number.isInteger(x)); } catch { return []; } };
/** Exits are found by looking at recent days; a day this browser asked for an exit on is always looked at too. */
export const rememberExit = (user: string, day: number) => { try { localStorage.setItem(exitDaysKey(user), JSON.stringify([...new Set([...rememberedExits(user), day])].slice(-50))); } catch {} };

/** One wallet's side of the pool: balances, each tier's position, entries waiting for their close, exits. Two or three
 *  batched requests: round 1 asks everything at once (exits are looked for on the last two weeks of days, on any day
 *  this browser asked to exit on, and on any the caller found in the index), round 2 which close each request fills
 *  at, round 3 (only with filled exits) what withdrawing them pays. Token amounts of shares come from the tiers' own
 *  books in `st`, the same arithmetic as the contract's sharesToTokens. */
export async function loadMine(st: St, user: Address, extraExitDays: number[] = []): Promise<Mine> {
  const days = new Set<number>([...rememberedExits(user), ...extraExitDays]); for (let d = Math.max(1, st.lastSettled - 14); d <= st.lastScheduled; d++) days.add(d);
  const ix = st.tiers.map((t) => t.i);
  const [bal, allowance, eth, shares, pends, reqs] = await Promise.all([
    pc.readContract({ address: TOKEN, abi: erc20, functionName: "balanceOf", args: [user] }),
    pc.readContract({ address: TOKEN, abi: erc20, functionName: "allowance", args: [user, P] }),
    pc.getBalance({ address: user }),
    Promise.all(ix.map((i) => read("sharesOf", [user, i]) as Promise<bigint>)),
    Promise.all(ix.map((i) => read("pendingEntries", [user, i]))),
    Promise.all([...days].flatMap((d) => ix.map(async (i) => ({ d, i, r: await read("requests", [user, BigInt(d), i]) })))),
  ]);
  const toTok = (i: number, sh: bigint) => { const t = st.tiers[i]; return t && t.shares > 0n ? (sh * t.held) / t.shares : 0n; };
  const exitReqs = reqs.filter((x) => x.r[1] > 0n);
  const need = new Set<number>([...pends.flatMap((p: any) => (p[0] as bigint[]).map(Number)), ...exitReqs.map((x) => x.d)]);
  const fills = new Map<number, { filled: boolean; ep: Ep }>(await Promise.all([...need].map(async (d) => [d, await fillDay(d)] as [number, { filled: boolean; ep: Ep }])));
  const pos = st.tiers.map((t, k) => {
    const p = pends[k] as [bigint[], bigint[]];
    const pending = p[0].map((d, j) => { const f = fills.get(Number(d))!; return { day: Number(d), amount: p[1][j], cutoff: f.ep.cutoff, filled: f.filled }; }).filter((x) => x.amount > 0n && !x.filled);
    return { tier: t.i, tokens: toTok(t.i, shares[k]), shares: shares[k], pending };
  });
  const exits: Exit[] = await Promise.all(exitReqs.map(async ({ d, i, r }) => {
    const f = fills.get(d)!; let tokens = 0n;
    if (f.filled) { try { const sim = await pc.simulateContract({ address: P, abi, functionName: "claim", args: [user, BigInt(d), i], account: user } as any); tokens = (sim.result as any)[1]; } catch {} }
    else tokens = toTok(i, r[1] as bigint);   // an estimate at today's share value until its close
    return { day: d, tier: i, ready: f.filled, tokens, cutoff: f.ep.cutoff };
  }));
  exits.sort((a, b) => a.day - b.day || a.tier - b.tier);
  return { bal, allowance, eth, pos, exits };
}

// ---------------------------------------------------------------- pool arithmetic (display only; the contract decides)
export const exposures = (tiers: Tier[], add?: { tier: number; amount: bigint }) => {
  let L = 0, S = 0;
  for (const t of tiers) { const x = t.c * (Number(t.held) + (add && add.tier === t.i ? Number(add.amount) : 0)); if (t.isLong) L += x; else S += x; }
  return { L, S, M: Math.min(L, S) };
};
export const fillOf = (t: Tier, e: { L: number; S: number; M: number }) => { const side = t.isLong ? e.L : e.S; return side > 0 ? e.M / side : 0; };
/** Net exposure to the stock: 1 + c·f long, 1 − c·f short (negative = net short). */
export const netLev = (t: Tier, f: number) => (t.isLong ? 1 + t.c * f : 1 - t.c * f);
export const levText = (k: number) => (k > 0.005 ? pt("ord.levLong", { x: k.toFixed(2) }) : k < -0.005 ? pt("ord.levShort", { x: (-k).toFixed(2) }) : pt("ord.levFlat"));
export const tierKey = (t: { isLong: boolean; c: number }) => `tier.${t.isLong ? "L" : "S"}${t.c}`;
/** Colour class: long green, short red, the value-locked hedge (short, c = 1) in the accent colour. */
export const tierCls = (t: { isLong: boolean; c: number }) => (t.isLong ? "l" : t.c === 1 ? "h" : "s");
export const fundingDaily = (fundingBps: number, e: { L: number; S: number }) => (e.L + e.S > 0 ? (fundingBps / 1e4) * ((e.L - e.S) / (e.L + e.S)) : 0);
export const price = (st: St) => Number(st.lastValue) / 1e8;   // the last settled close, the price shown in dollars
