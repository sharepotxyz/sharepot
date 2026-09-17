// Public read API + devnet faucet + the static site, in one process on 127.0.0.1 (the web server fronts it).
//   /api/markets, /api/markets/:id, /api/config   cached program state (15 s); markets carry their token's decimals
//   /api/prices                                     live prices of the listed tokens (Jupiter), for dollar estimates
//   /api/stocks                                     listed stocks, their tokens per issuer and each token's mint here
//   /api/evidence/:id, /api/evidence/:id/raw        price evidence behind a proposed result (raw bytes hash to the on-chain hash)
//   /api/positions/:owner                           settlement history of a wallet
//   /api/leaderboard?window=7d|30d|all              points ranking (shares staked x official close, per settled market)
//   /api/faucet (POST, test networks)               2 shares of every mock token + a little SOL
//   /api/dispute (POST), /api/disputes              signed disputes against a proposed result
//   everything else                                 files from web/dist
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
import nacl from "tweetnacl";
import bs58 from "bs58";
import anchor from "@coral-xyz/anchor";
import { xstockPrices, utcDate, addDays, chainClose } from "./prices.mjs";
import { readRegistry, asStock, REGISTRY_FILE } from "./chain-tokens.mjs";
import { leaderboard, readSettlements } from "./points.mjs";
import { homeHtml, eventHtml } from "./ssr.mjs";
import { notify } from "./notify.mjs";
import * as referrals from "./referrals.mjs";

const PORT = Number(process.env.PORT ?? 5041);
const CLUSTER = process.env.CLUSTER ?? "devnet";
const RPC = process.env.CLUSTER_RPC ?? "https://api.devnet.solana.com";
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const SECRETS = process.env.SHAREPOT_SECRETS ?? path.join("/root/stocklana/secrets", CLUSTER);
const STATIC = path.resolve(process.env.STATIC_DIR ?? new URL("../web/dist", import.meta.url).pathname);
const tpl = JSON.parse(fs.readFileSync(new URL("./stock-templates.json", import.meta.url), "utf8"));
const state = CLUSTER === "mainnet" ? { mints: {} } : JSON.parse(fs.readFileSync(path.join(SECRETS, "state.json"), "utf8"));
// Listed tokens: the stocks and pre-IPO tokens of stock-templates.json plus the memes in data/chain-tokens.json (the
// registry select-chain.mjs maintains; re-read whenever that file changes). A meme is "active" on the days it was
// selected for (today / tomorrow UTC): only active tokens come out of the faucet; every known token is listed so old
// markets keep their names.
const FAUCET_SHARES = 2;   // devnet faucet: shares of each stock token per claim (pre-IPO / memes carry their own faucetUi)
let stocks = [], tokens = [], listingStamp = null;
function refreshListing() {
  let stamp = "-"; try { const st = fs.statSync(REGISTRY_FILE(DATA)); stamp = `${st.size}:${st.mtimeMs}`; } catch {}
  if (stamp === listingStamp) return;
  listingStamp = stamp;
  const today = utcDate(Date.now() / 1000), activeDays = [today, addDays(today, 1)];
  const fromTpl = tpl.stocks.map((s) => ({ symbol: s.symbol, name: s.name, category: s.category ?? "stocks", kind: s.kind ?? "close", thresholdsBps: s.thresholdsBps, mark: s.mark ?? null, icon: null, active: true,
    tokens: s.tokens.map((t) => ({ token: t.token, issuer: t.issuer, decimals: t.decimals, mint: CLUSTER === "mainnet" ? t.mainnetMint : state.mints[t.token] ?? null, mainnetMint: t.mainnetMint, faucetUi: t.faucetUi ?? FAUCET_SHARES })) }));
  const reg = readRegistry(DATA);
  const memes = Object.entries(reg.tokens).map(([mint, t]) => ({ ...asStock(mint, t, CLUSTER), mark: null, active: (t.selectedFor ?? []).some((d) => activeDays.includes(d)), selectedFor: t.selectedFor ?? [], liquidity: t.liquidity ?? null, volume24h: t.volume24h ?? null, holders: t.holders ?? null }))
    .filter((s) => s.tokens[0].mint).sort((a, b) => Number(b.active) - Number(a.active) || (b.volume24h ?? 0) - (a.volume24h ?? 0));
  stocks = [...fromTpl, ...memes];
  tokens = stocks.flatMap((s) => s.tokens.filter((t) => t.mint).map((t) => ({ ...t, symbol: s.symbol, active: s.active })));
  decimalsByMint = new Map(tokens.map((t) => [t.mint, t.decimals]));
}
let decimalsByMint = new Map();
refreshListing(); setInterval(() => { try { refreshListing(); } catch (e) { console.error("listing refresh failed:", String(e?.message ?? e).slice(0, 120)); } }, 60_000).unref();
const FAUCET_ENABLED = CLUSTER !== "mainnet" && process.env.FAUCET_DISABLED !== "1";
const FAUCET_SOL = Number(process.env.FAUCET_SOL ?? 0.01);
const FAUCET_DAILY_GLOBAL = Number(process.env.FAUCET_DAILY_GLOBAL ?? 300);
const FAUCET_LOW_SOL = Number(process.env.FAUCET_LOW_SOL ?? 0.5);   // ≈ 15 more claims; alert the operator below this
// The faucet pays from a dedicated low-balance key; the operator / mint authority never lives in this process.
const faucetKeyFile = process.env.FAUCET_KEYPAIR ?? path.join(SECRETS, "faucet.json");
const faucet = FAUCET_ENABLED && fs.existsSync(faucetKeyFile) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(faucetKeyFile, "utf8")))) : null;
const conn = new Connection(RPC, "confirmed");
fs.mkdirSync(DATA, { recursive: true });

// ---------- cached program state ----------
const IDL = JSON.parse(fs.readFileSync(new URL("../idl/sharepot.json", import.meta.url), "utf8"));
const ro = new anchor.Program(IDL, new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ro.programId);
const tagOf = (b) => Buffer.from(b).toString("utf8").replace(/\0+$/, "");
const num = (x) => (x?.toNumber ? x.toNumber() : Number(x));
// token program, decimals and current ScaledUiAmount multiplier (dividends / splits) of each mint; re-read every 10 min
const mintInfos = new Map();
async function mintInfo(mint) {
  const k = mint.toBase58(), hit = mintInfos.get(k);
  if (hit && Date.now() - hit.at < 600_000) return hit;
  const a = await conn.getParsedAccountInfo(mint), info = a.value.data.parsed.info;
  const sc = (info.extensions ?? []).find((e) => e.extension === "scaledUiAmountConfig")?.state;
  const multiplier = sc ? Number(Date.now() / 1000 >= Number(sc.newMultiplierEffectiveTimestamp) ? sc.newMultiplier : sc.multiplier) : 1;
  const v = { tokenProgram: a.value.owner.toBase58(), decimals: info.decimals, multiplier, at: Date.now() };
  mintInfos.set(k, v); return v;
}
const serializeMarket = (pubkey, a, mi) => ({ pubkey: pubkey.toBase58(), id: num(a.id), mint: a.mint.toBase58(), tokenProgram: mi.tokenProgram, decimals: mi.decimals, multiplier: mi.multiplier, metric: tagOf(a.metric), nBuckets: a.nBuckets, thresholds: a.thresholds.slice(0, a.nBuckets - 1).map(num), openTs: num(a.openTs), closeTs: num(a.closeTs), resolveAfterTs: num(a.resolveAfterTs), baseline: num(a.baseline), pools: a.pools.slice(0, a.nBuckets).map(num), seed: num(a.seedAmount), status: a.status, outcome: a.outcome, proposedOutcome: a.proposedOutcome, proposedValue: num(a.proposedValue), proposedAt: num(a.proposedAt), positions: a.positions, positionsOpen: a.positionsOpen, feeCollected: num(a.feeCollected), snapshotHash: Buffer.from(a.snapshotHash).toString("hex") });
const serializeConfig = (c) => ({ admin: c.admin.toBase58(), proposer: c.proposer.toBase58(), treasuryOwner: c.treasuryOwner.toBase58(), feeBps: c.feeBps, earlyBirdDiscountBps: c.earlyBirdDiscountBps, earlyBirdSecs: num(c.earlyBirdSecs), disputeWindowSecs: num(c.disputeWindowSecs), minBet: num(c.minBet), marketCount: num(c.marketCount), paused: c.paused });
let chainCache = { at: 0, markets: null, config: null, pending: null };
const CHAIN_TTL_MS = Number(process.env.CHAIN_CACHE_MS ?? 15000);
function chainState() {
  if (chainCache.markets && Date.now() - chainCache.at < CHAIN_TTL_MS) return Promise.resolve(chainCache);
  if (chainCache.pending) return chainCache.markets ? Promise.resolve(chainCache) : chainCache.pending;   // stale-while-revalidate
  const stale = chainCache.markets ? chainCache : null;
  chainCache.pending = (async () => {
    const [all, cfg] = await Promise.all([ro.account.market.all([{ dataSize: ro.account.market.size }]), ro.account.config.fetch(configPda)]);
    const markets = await Promise.all(all.map(async (x) => serializeMarket(x.publicKey, x.account, await mintInfo(x.account.mint))));
    chainCache = { at: Date.now(), markets: markets.sort((a, b) => b.id - a.id), config: serializeConfig(cfg), pending: null };
    return chainCache;
  })().catch((e) => { chainCache.pending = null; throw e; });
  // While serving stale data nobody awaits the refresh; without a handler its failure (RPC down) would kill the process.
  if (stale) { chainCache.pending.catch((e) => console.error("chain refresh failed:", String(e?.message ?? e).slice(0, 120))); return Promise.resolve(stale); }
  return chainCache.pending;
}
// Last line of defence: a failed background read must never take the site down.
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", String(e?.message ?? e).slice(0, 200)));
setInterval(() => chainState().catch(() => {}), CHAIN_TTL_MS).unref(); chainState().catch(() => {});

// Jupiter prices of the real (mainnet) tokens, keyed by token symbol; devnet mocks borrow them for dollar estimates.
// Refreshed in the background every minute, so no page view ever waits on the price source. Pre-IPO tokens also carry
// the issuer's official mark price (Tessera / PreStocks APIs, every 10 min) next to the on-chain quote.
let priceCache = { at: 0, prices: {} }, markCache = { at: 0, marks: {} };
async function refreshMarks() {
  if (Date.now() - markCache.at < 600_000) return;
  const marks = {};
  try { for (const t of await (await fetch("https://rest-api.tessera.pe/v1/public/token-details", { signal: AbortSignal.timeout(15_000) })).json()) if (t.symbol && t.markPrice > 0) marks[`tessera:${t.symbol}`] = t.markPrice; } catch (e) { console.error("tessera marks:", String(e?.message ?? e).slice(0, 80)); }
  try { for (const t of await (await fetch("https://prestocks.com/api/prestocks", { headers: { "user-agent": "Mozilla/5.0 (SharePot)" }, signal: AbortSignal.timeout(15_000) })).json()) if (t.symbol && t.markPrice > 0) marks[`prestocks:${t.symbol}`] = t.markPrice; } catch (e) { console.error("prestocks marks:", String(e?.message ?? e).slice(0, 80)); }
  if (Object.keys(marks).length) markCache = { at: Date.now(), marks };
}
async function refreshPrices() {
  await refreshMarks().catch(() => {});
  const all = stocks.flatMap((s) => s.tokens.map((t) => ({ ...t, mark: s.mark })));
  const mints = [...new Set(all.map((t) => t.mainnetMint))], byMint = {};
  for (let i = 0; i < mints.length; i += 50) Object.assign(byMint, await xstockPrices(mints.slice(i, i + 50)));
  // on-chain price tokens: the latest known daily close (yesterday's, or the day before's until yesterday's samples exist)
  const closes = {}, today = utcDate(Date.now() / 1000);
  for (const s of stocks) if (s.kind === "day") for (const t of s.tokens) for (const d of [addDays(today, -1), addDays(today, -2)]) {
    const c = chainClose(DATA, t.mainnetMint, d); if (c.ok) { closes[t.token] = { date: d, close: c.close, samples: c.samples }; break; }
  }
  priceCache = { at: Date.now(), prices: Object.fromEntries(all.map((t) => [t.token, byMint[t.mainnetMint] ? { ...byMint[t.mainnetMint], mark: t.mark ? markCache.marks[t.mark] ?? null : null, prevClose: closes[t.token] ?? null } : null])) };
}
async function prices() {
  if (!priceCache.at) await refreshPrices();
  return priceCache.prices;
}
setInterval(() => refreshPrices().catch((e) => console.error("price refresh failed:", String(e?.message ?? e).slice(0, 120))), 60_000).unref();
refreshPrices().catch(() => {});

// ---------- leaderboard ----------
// Scored from the crank's settlement log, so it only ever counts markets that actually paid out. Recomputed when that
// file grows (roughly once a day, after the close), not per request.
// Our own wallets: the demo bots that keep the devnet markets alive, plus the throwaway wallets the browser tests and
// the video recording create (each run makes a fresh one, takes the faucet and stakes on TSLA). Listed so the board
// can say so out loud instead of passing them off as players. data/test-wallets.json, re-read every few minutes.
let testWallets = { at: 0, set: new Set() };
function ownWallets() {
  if (Date.now() - testWallets.at > 300_000) {
    const f = path.join(DATA, "test-wallets.json");
    let list = []; try { if (fs.existsSync(f)) list = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    testWallets = { at: Date.now(), set: new Set(list) };
  }
  return testWallets.set;
}
const boardCache = new Map();
function leaderboardCached(key, since) {
  const f = path.join(DATA, "settlements.jsonl");
  let stamp = "-"; try { const st = fs.statSync(f); stamp = `${st.size}:${st.mtimeMs}`; } catch {}
  const hit = boardCache.get(key);
  // A window that ends "n days ago" slides, so a cached board also goes stale on its own after a few minutes.
  if (hit && hit.stamp === stamp && Date.now() - hit.at < (since ? 300_000 : 3_600_000)) return hit;
  // Rows from before the crank froze the close: read it from the evidence file the result came from.
  const fallback = { decimals: (mint) => decimalsByMint.get(mint) ?? null, close: (id) => {
    try { const c = JSON.parse(fs.readFileSync(path.join(DATA, "evidence", `${id}.json`), "utf8")).close; return Number.isFinite(c) && c > 0 ? c : null; } catch { return null; }
  } };
  const v = { ...leaderboard(readSettlements(DATA), fallback, since), at: Date.now(), stamp };
  boardCache.set(key, v);
  return v;
}

// ---------- helpers ----------
const seenAddr = new Map(), seenIp = new Map(), seenDispute = new Map(); let seenDay = "", faucetToday = 0;
const dayKey = () => new Date().toISOString().slice(0, 10);
function rollDay() { const d = dayKey(); if (d !== seenDay) { seenDay = d; seenAddr.clear(); seenIp.clear(); seenDispute.clear(); seenLookup.clear(); faucetToday = 0; } }
// Behind Cloudflare the real client is CF-Connecting-IP; direct localhost callers fall back to the socket address.
const clientIp = (req) => String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?").trim();
const json = (res, code, body, extra = {}) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS", ...extra }); res.end(JSON.stringify(body)); };
const readBody = (req, max = 4096) => new Promise((ok, err) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > max) { err(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); } }); req.on("end", () => ok(b)); req.on("error", err); });
const DISPUTES = path.join(DATA, "disputes.jsonl");
// ---------- referrals (referrals.mjs) ----------
// One file for every network (keyed by wallet address): point REFERRALS_FILE at the same path on mainnet.
const REFERRALS_FILE = process.env.REFERRALS_FILE ?? path.join(DATA, "referrals.json");
const REFERRAL_PAYOUTS = path.join(DATA, "referral-payouts.jsonl");
const SITE_URL = process.env.SITE_URL ?? (CLUSTER === "mainnet" ? "https://sharepot.xyz" : "https://devnet.sharepot.xyz");
const isPubkey = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s ?? ""));
const settledRowsOf = (wallet) => readSettlements(DATA).filter((r) => r.owner === wallet);
// Open positions of a wallet straight from the chain (they close on payout, so settled history is checked separately).
const openPositionsOf = async (wallet) => (await ro.account.position.all([{ dataSize: ro.account.position.size }, { memcmp: { offset: 40, bytes: wallet } }])).length;
const betCache = new Map();   // wallet → { at, open, settled }
// A cache miss costs one getProgramAccounts call on the RPC this process also reads the markets with. A stranger can
// trigger misses at will (any address is a valid question), so they are budgeted per network per day and globally per
// minute; over budget the answer is 429, never a slower site.
const LOOKUP_IP_DAILY = Number(process.env.LOOKUP_IP_DAILY ?? 60), LOOKUP_PER_MINUTE = Number(process.env.LOOKUP_PER_MINUTE ?? 30);
const seenLookup = new Map(); let lookupMinute = { at: 0, n: 0 };
function chargeLookup(ip) {
  rollDay(); const minute = Math.floor(Date.now() / 60_000); if (lookupMinute.at !== minute) lookupMinute = { at: minute, n: 0 };
  if (lookupMinute.n >= LOOKUP_PER_MINUTE || (seenLookup.get(ip) ?? 0) >= LOOKUP_IP_DAILY) throw Object.assign(new Error("too many wallet lookups; try again later"), { status: 429 });
  lookupMinute.n++; seenLookup.set(ip, (seenLookup.get(ip) ?? 0) + 1);
}
// "No bets yet" goes stale the moment the first bet lands, so it is only trusted for 10 s; a positive answer for 60 s.
async function betHistory(wallet, fresh = false, ip = "?") {
  const hit = betCache.get(wallet); if (!fresh && hit && Date.now() - hit.at < (hit.open + hit.settled ? 60_000 : 10_000)) return hit;
  chargeLookup(ip);
  const v = { at: Date.now(), open: await openPositionsOf(wallet), settled: settledRowsOf(wallet).length };
  betCache.set(wallet, v); return v;
}
const referralPoints = () => { const b = leaderboardCached("all", 0); return new Map(b.entries.map((e) => [e.wallet, e.points])); };
function referralView(wallet) {
  const db = referrals.load(REFERRALS_FILE), rows = readSettlements(DATA), pts = referralPoints();
  const earn = referrals.earnings(rows, db, (w) => pts.get(w) ?? 0), payouts = referrals.effectivePayouts(referrals.readPayouts(REFERRAL_PAYOUTS));
  const e = earn.byWallet.get(wallet), own = db.wallets[wallet], b = db.bindings[wallet] ?? null, points = pts.get(wallet) ?? 0;
  const ui = (raw, m) => (m.decimals == null ? null : (Number(raw) / 10 ** m.decimals) * (m.multiplier || 1));
  const paidBy = new Map(); for (const p of payouts) if (p.wallet === wallet) paidBy.set(p.mint, (paidBy.get(p.mint) ?? 0n) + BigInt(p.raw));
  const earned = e ? [...e.earned.values()].map((m) => ({ mint: m.mint, token: m.token, earned: ui(m.raw, m), asReferrer: ui(m.asReferrer, m), asReferee: ui(m.asReferee, m), paid: ui(paidBy.get(m.mint) ?? 0n, m), usd: m.usd, settlements: m.rows })) : [];
  return { wallet, code: own?.code ?? null, link: own ? `${SITE_URL}/?ref=${own.code}` : null,
    bound: b ? { code: b.code, referrer: b.referrer.slice(0, 4) + "…" + b.referrer.slice(-4), at: b.at } : null,
    referred: e?.referred.size ?? 0, points, tierBps: referrals.tierBps(points), nextTier: referrals.nextTier(points), refereeBps: referrals.REFEREE_BPS, tiers: referrals.REFERRER_TIERS,
    earned, earnedUsd: earned.reduce((a, x) => a + (x.usd ?? 0), 0),
    payouts: payouts.filter((p) => p.wallet === wallet).slice(-20).reverse().map(({ at, mint, token, raw, ui: amount, signature }) => ({ at, mint, token, raw, amount, signature })) };
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2", ".mp4": "video/mp4", ".jpg": "image/jpeg" };
// Pages ship with the data they render on first paint (markets, config, listed stocks, prices from the in-memory
// caches) embedded as window.__BOOT__, so the browser needs no API round trip to Germany after the scripts load.
const htmlCache = new Map();
// Rendered pages (boot script + SSR) are memoised for a few seconds per path+query: the data behind them is already
// cached 15 s (CHAIN_TTL_MS), so this changes nothing a visitor can see, only how many times per second we re-render.
const RENDER_TTL_MS = Number(process.env.RENDER_CACHE_MS ?? 5000), RENDER_CACHE_MAX = 500, renderCache = new Map();
function pageHtml(file) {
  const mtime = fs.statSync(file).mtimeMs, hit = htmlCache.get(file);
  if (hit && hit.mtime === mtime) return hit.html;
  const html = fs.readFileSync(file, "utf8"); htmlCache.set(file, { mtime, html }); return html;
}
function bootScript() {
  const boot = { at: Date.now(), stocks: { cluster: CLUSTER, stocks }, prices: priceCache.at ? priceCache.prices : null,
    markets: chainCache.markets, config: chainCache.config, chainAt: chainCache.at };
  return `<script>window.__BOOT__=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>`;
}
function serveStatic(res, url, req) {
  const pathname = url.pathname;
  // A malformed percent-escape ("/%") throws here; answered as 404 instead of leaving the connection hanging.
  let rel; try { rel = pathname === "/" ? "/index.html" : decodeURIComponent(pathname); } catch { rel = null; }
  const file = rel ? path.resolve(STATIC, "." + rel) : "";
  if (!rel || rel.includes("\0") || !file.startsWith(STATIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
  const ext = path.extname(file);
  if (ext === ".html") {
    // Wallet pages must never be framed (clickjacking); the rest of the policy is left to the front web server.
    res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-cache", "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" });
    const key = rel + url.search, hit = renderCache.get(key);
    if (hit && Date.now() - hit.at < RENDER_TTL_MS) return res.end(hit.html);
    let html = pageHtml(file).replace("</head>", bootScript() + "</head>");
    // first-paint content rendered here (ssr.mjs); a rendering error only costs the pre-render, never the page
    const data = { markets: chainCache.markets, config: chainCache.config, stocks, prices: priceCache.at ? priceCache.prices : null };
    try { if (rel === "/index.html") html = homeHtml(data, html, url); else if (rel === "/market.html") html = eventHtml(data, url, html); }
    catch (e) { console.error("ssr failed:", String(e?.message ?? e).slice(0, 160)); }
    if (renderCache.size >= RENDER_CACHE_MAX) renderCache.clear();   // unbounded query strings must not grow memory
    renderCache.set(key, { at: Date.now(), html });
    return res.end(html);
  }
  const size = fs.statSync(file).size, range = String(req?.headers?.range ?? "").match(/^bytes=(\d*)-(\d*)$/);
  const hdr = { "content-type": TYPES[ext] ?? "application/octet-stream", "accept-ranges": "bytes", "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : ext === ".mp4" ? "public, max-age=3600" : "no-cache" };
  if (range && ext === ".mp4") {   // byte ranges so the video can seek
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2])), end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!(start >= 0 && start <= end && end < size)) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...hdr, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...hdr, "content-length": size });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400, { "content-type": "text/plain" }); return res.end("bad request"); }
  if (req.method === "OPTIONS") return json(res, 204, {});
  const p = url.pathname.slice(4);
  try {
    if (!url.pathname.startsWith("/api/")) return serveStatic(res, url, req);
    if (p === "/health") return json(res, 200, { ok: true, cluster: CLUSTER, programId: ro.programId.toBase58(), faucet: !!faucet });
    if (p === "/stocks") return json(res, 200, { cluster: CLUSTER, stocks }, { "cache-control": "public, max-age=60" });
    if (p === "/prices") { try { return json(res, 200, { prices: await prices() }, { "cache-control": "public, max-age=60" }); } catch (e) { return json(res, 503, { error: "price source unavailable" }); } }
    if (p === "/markets" || p === "/config" || /^\/markets\/\d+$/.test(p)) {
      let st; try { st = await chainState(); } catch (e) { return json(res, 503, { error: "chain read failed: " + String(e?.message ?? e).slice(0, 120) }); }
      const hdr = { "cache-control": "public, max-age=10" };
      if (p === "/config") return json(res, 200, { at: st.at, config: st.config }, hdr);
      if (p === "/markets") return json(res, 200, { at: st.at, markets: st.markets }, hdr);
      const m = st.markets.find((x) => x.id === Number(p.slice(9))); return m ? json(res, 200, { at: st.at, market: m, config: st.config }, hdr) : json(res, 404, { error: "no such market" });
    }
    const ev = p.match(/^\/evidence\/(\d+)(\/raw)?$/);
    if (ev) {
      const f = path.join(DATA, "evidence", `${ev[1]}.json`);
      if (!fs.existsSync(f)) return json(res, 404, { error: "no evidence published for that market yet" });
      const e = JSON.parse(fs.readFileSync(f, "utf8"));
      if (ev[2]) { res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" }); return res.end(e.response); } // exact bytes that were hashed
      const { response, ...rest } = e; return json(res, 200, rest, { "cache-control": "public, max-age=300" });
    }
    const po = p.match(/^\/positions\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
    if (po) {
      const f = path.join(DATA, "settlements.jsonl");
      const rows = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.owner === po[1]) : [];
      return json(res, 200, { owner: po[1], settled: rows.reverse() }, { "cache-control": "no-store" });
    }
    // Leaderboard: points = shares staked × the official close the market settled on (points.mjs).
    // ?window=7d|30d|all, ?limit=n. Recomputed only when the settlement log has grown.
    if (p === "/leaderboard") {
      const win = url.searchParams.get("window") ?? "all";
      const days = win === "7d" ? 7 : win === "30d" ? 30 : 0;
      const since = days ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
      const board = leaderboardCached(win, since);
      const own = ownWallets();
      return json(res, 200, { window: win, at: board.at, totals: board.totals,
        entries: board.entries.slice(0, limit).map((e) => ({ ...e, test: own.has(e.wallet) })) },
        { "cache-control": "public, max-age=30" });
    }
    // ---------- referrals ----------
    // GET /referral/lookup/:code → who a code belongs to (for the "invited by" banner)
    const rl = p.match(/^\/referral\/lookup\/([A-Za-z0-9]{4,12})$/);
    if (rl) {
      const code = referrals.normalizeCode(rl[1]), w = referrals.referrerOf(referrals.load(REFERRALS_FILE), code);
      return json(res, 200, w ? { valid: true, code, referrer: w.slice(0, 4) + "…" + w.slice(-4), refereeBps: referrals.REFEREE_BPS } : { valid: false, code }, { "cache-control": "public, max-age=60" });
    }
    // GET /referral/:wallet → the wallet's code, link, binding and earnings
    const rw = p.match(/^\/referral\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
    if (rw && req.method === "GET") {
      const h = await betHistory(rw[1], false, clientIp(req));
      return json(res, 200, { ...referralView(rw[1]), eligible: h.open + h.settled > 0, bets: h.open + h.settled, firstBet: h.settled === 0 && h.open > 0 }, { "cache-control": "no-store" });
    }
    // POST /referral/code {wallet} → create the wallet's code once it has placed a bet (nothing to sign: a code only
    // ever pays its owner)
    if (p === "/referral/code" && req.method === "POST") {
      let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad body" }); }
      const wallet = String(b.wallet ?? ""); if (!isPubkey(wallet)) return json(res, 400, { error: "wallet required" });
      const db = referrals.load(REFERRALS_FILE);
      if (!db.wallets[wallet]) {
        const h = await betHistory(wallet, true, clientIp(req));
        if (h.open + h.settled === 0) return json(res, 403, { error: "place a bet first — the link unlocks with your first stake" });
        referrals.ensureCode(db, wallet); referrals.save(REFERRALS_FILE, db);
        console.log("referral code", wallet.slice(0, 6), db.wallets[wallet].code);
      }
      return json(res, 200, { ...referralView(wallet), eligible: true });
    }
    // POST /referral/bind {wallet, code, signature} → bind a first-time bettor to the code it arrived with. The wallet
    // signs the canonical message; only a wallet with an open position and no settled history qualifies (= first bet).
    if (p === "/referral/bind" && req.method === "POST") {
      let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad body" }); }
      const wallet = String(b.wallet ?? ""), code = referrals.normalizeCode(b.code);
      if (!isPubkey(wallet) || !referrals.CODE_RE.test(code)) return json(res, 400, { error: "wallet and code required" });
      let ok = false; try { ok = nacl.sign.detached.verify(new TextEncoder().encode(referrals.bindMessage(wallet, code)), bs58.decode(String(b.signature ?? "")), bs58.decode(wallet)); } catch {}
      if (!ok) return json(res, 401, { error: "signature does not match the wallet" });
      const db = referrals.load(REFERRALS_FILE);
      if (db.bindings[wallet]) return json(res, db.bindings[wallet].code === code ? 200 : 409, db.bindings[wallet].code === code ? { ok: true, already: true } : { error: "this wallet is already bound to another code", permanent: true });
      if (!referrals.referrerOf(db, code)) return json(res, 404, { error: "unknown referral code", permanent: true });
      const h = await betHistory(wallet, true, clientIp(req));
      if (h.open === 0 && h.settled === 0) return json(res, 409, { error: "place your first bet, then the link binds" });
      if (h.settled > 0) return json(res, 409, { error: "a referral link only counts on a wallet's first bet", permanent: true });
      const r = referrals.bind(db, { wallet, code, cluster: CLUSTER });
      if (r.error) return json(res, 409, { error: r.error, permanent: true });
      referrals.save(REFERRALS_FILE, db);
      console.log("referral bind", wallet.slice(0, 6), "→", code);
      return json(res, 200, { ok: true });
    }
    // Public: raise a dispute on a proposed result. The wallet signs a canonical message so a dispute is attributable;
    // resolution happens on-chain (re-propose / void) inside the dispute window.
    if (p === "/dispute" && req.method === "POST") {
      rollDay(); const ip = clientIp(req);
      seenDispute.set(ip, (seenDispute.get(ip) ?? 0) + 1); if (seenDispute.get(ip) > 20) return json(res, 429, { error: "too many disputes from this network today" });
      let b; try { b = JSON.parse(await readBody(req, 64 * 1024)); } catch { return json(res, 400, { error: "bad body" }); }
      const market = String(b.market ?? ""), wallet = String(b.wallet ?? ""), reason = String(b.reason ?? "").slice(0, 2000), claimed = b.claimedValue == null ? null : String(b.claimedValue).slice(0, 40);
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(market) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) || reason.length < 5) return json(res, 400, { error: "market, wallet and a reason (≥5 chars) are required" });
      const msg = `sharepot-dispute v1\nmarket=${market}\nwallet=${wallet}\nclaimed=${claimed ?? ""}\nreason=${reason}`;
      let ok = false; try { ok = nacl.sign.detached.verify(new TextEncoder().encode(msg), bs58.decode(String(b.signature ?? "")), bs58.decode(wallet)); } catch {}
      if (!ok) return json(res, 401, { error: "signature does not match the wallet" });
      const rec = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), market, wallet, reason, claimedValue: claimed, status: "open" };
      fs.appendFileSync(DISPUTES, JSON.stringify(rec) + "\n");
      console.log("dispute", rec.id, market, reason.slice(0, 120));
      notify("⚠️ 有人對結算提出異議", `market ${market.slice(0, 8)}… · ${wallet.slice(0, 6)}…${claimed ? ` · 主張值 ${claimed}` : ""}\n${reason.slice(0, 300)}\n爭議窗 6h 內可 re-propose / void(admin 金鑰在東京)`, "dispute:" + market, 5);
      return json(res, 200, { ok: true, id: rec.id });
    }
    if (p === "/disputes") {
      const m = url.searchParams.get("market");
      const rows = fs.existsSync(DISPUTES) ? fs.readFileSync(DISPUTES, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      return json(res, 200, { disputes: rows.filter((d) => !m || d.market === m).map(({ id, at, market, wallet, reason, claimedValue, status }) => ({ id, at, market, wallet: wallet.slice(0, 4) + "…" + wallet.slice(-4), reason, claimedValue, status })) });
    }
    if (p === "/faucet" && req.method === "POST") {
      if (!faucet) return json(res, 403, { error: "faucet is disabled on this network" });
      rollDay();
      const ip = clientIp(req);
      let address; try { address = new PublicKey(JSON.parse(await readBody(req)).address); } catch { return json(res, 400, { error: "body must be {\"address\": \"<pubkey>\"}" }); }
      const k = address.toBase58();
      // Reserve the slot BEFORE any await so concurrent requests for one address cannot all pass the check.
      if (seenAddr.has(k)) return json(res, 429, { error: "this address already received test stocks today" });
      if ((seenIp.get(ip) ?? 0) >= 20) return json(res, 429, { error: "too many faucet requests from this network today" });
      if (faucetToday >= FAUCET_DAILY_GLOBAL) return json(res, 429, { error: "faucet is empty for today, try tomorrow" });
      seenAddr.set(k, true); seenIp.set(ip, (seenIp.get(ip) ?? 0) + 1); faucetToday++;
      try {
        const giveSol = (await conn.getBalance(address)) < FAUCET_SOL * LAMPORTS_PER_SOL;
        // Every token needs an account-create + a transfer; three tokens per transaction stay well under the size limit.
        const sigs = [], give = tokens.filter((t) => t.active);
        for (let i = 0; i < give.length; i += 3) {
          const tx = new Transaction();
          if (i === 0 && giveSol) tx.add(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: address, lamports: Math.round(FAUCET_SOL * LAMPORTS_PER_SOL) }));
          for (const t of give.slice(i, i + 3)) {
            const mint = new PublicKey(t.mint), { tokenProgram } = await mintInfo(mint), tp = new PublicKey(tokenProgram);
            const to = getAssociatedTokenAddressSync(mint, address, false, tp), from = getAssociatedTokenAddressSync(mint, faucet.publicKey, false, tp);
            tx.add(createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, to, address, mint, tp),
              createTransferCheckedInstruction(from, mint, to, faucet.publicKey, BigInt(Math.round((t.faucetUi ?? FAUCET_SHARES) * 10 ** t.decimals)), t.decimals, [], tp));
          }
          // A busy public RPC sometimes hands out a blockhash its simulator has not seen yet; the transaction is then
          // rejected before it lands, so a fresh blockhash and one more try cannot double-send.
          for (let tries = 1; ; tries++) {
            try { sigs.push(await sendAndConfirmTransaction(conn, tx, [faucet])); break; }
            catch (e) { if (tries >= 3 || !/Blockhash not found/i.test(String(e?.message ?? e))) throw e; await new Promise((r) => setTimeout(r, 1500 * tries)); }
          }
        }
        conn.getBalance(faucet.publicKey).then((b) => { if (b < FAUCET_LOW_SOL * LAMPORTS_PER_SOL) notify("💧 水龍頭快沒 SOL", `剩 ${(b / LAMPORTS_PER_SOL).toFixed(2)} SOL(每次領水約 0.03)\n補:solana transfer ${faucet.publicKey.toBase58()} 2 -u devnet,或 solana airdrop`, "faucet-low", 360); }).catch(() => {});
        return json(res, 200, { ok: true, address: k, sent: `test tokens of ${give.length} pools${giveSol ? ` + ${FAUCET_SOL} SOL` : ""}`, signatures: sigs });
      } catch (e) {
        seenAddr.delete(k); faucetToday--; console.error("faucet failed", e?.message);
        if (/insufficient|0x1\b/i.test(String(e?.message ?? e))) notify("💧 水龍頭發不出去", `餘額不足,使用者領水失敗:${String(e?.message ?? e).split("\n")[0].slice(0, 160)}\n補:solana transfer ${faucet.publicKey.toBase58()} 2 -u devnet`, "faucet-empty", 60);
        return json(res, 503, { error: "faucet transaction failed, try again in a minute" });
      }
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (e?.status === 429 || e?.status === 413) return json(res, e.status, { error: e.message });
    console.error(e); json(res, 500, { error: "internal error" });
  }
});
server.headersTimeout = 15_000; server.requestTimeout = 60_000; server.keepAliveTimeout = 10_000;
server.listen(PORT, "127.0.0.1", () => console.log(`sharepot api+site on 127.0.0.1:${PORT} cluster=${CLUSTER} faucet=${!!faucet} tokens=${tokens.length} static=${STATIC} rpc=${RPC.replace(/api-key=[^&\s]*/, "api-key=…")}`));
