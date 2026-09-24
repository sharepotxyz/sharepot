// Public read API + the static site for the EVM deployment, in one process on 127.0.0.1 (the web server fronts it).
// A separate process from server/api.mjs (Solana) on purpose: nothing here can take the Solana site down. Same routes
// and JSON shapes, so the pages (web/dist-evm, built with VITE_CHAIN=evm) do not care which chain they are on:
//   /api/markets, /api/markets/:id, /api/config   cached contract state (15 s); status in the Solana numbering
//   /api/prices                                     last stock prices (Yahoo), for dollar estimates
//   /api/stocks                                     listed stocks and the issuer's token of each (chains.json)
//   /api/evidence/:id, /api/evidence/:id/raw        price evidence behind a proposed result
//   /api/positions/:owner                           open positions (from the event index) + settlement history
//   /api/leaderboard?window=7d|30d|all              points ranking over this chain's settlements
//   /api/feedback (POST)                            free-text feedback
//   /api/disputes, /api/faucet                      not on this chain (empty list / 403): the pages hide them
//   everything else                                 files from web/dist-evm
//   env: PORT (5042), EVM_CHAIN, DATA_DIR, STATIC_DIR, EVM_RPC
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { CHAIN_KEY, chainCfg, allMarkets, readConfig, publicClient, erc20Abi } from "./chain.mjs";
import { sync, openPositions, evmDir } from "./index-events.mjs";
import { readRegistry, asStock, REGISTRY_FILE } from "../chain-tokens.mjs";
import { utcDate, addDays, chainClose } from "../prices.mjs";
import { leaderboard } from "../points.mjs";
import { homeHtml, eventHtml } from "../ssr.mjs";
import { resolveLang, translateHtml, translator, langScript } from "../i18n.mjs";
import { notify } from "../notify.mjs";

const PORT = Number(process.env.PORT ?? 5042);
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DIR = evmDir(DATA);
const STATIC = path.resolve(process.env.STATIC_DIR ?? new URL("../../web/dist-evm", import.meta.url).pathname);
fs.mkdirSync(DIR, { recursive: true });
const parseLine = (l) => { try { return JSON.parse(l); } catch { return null; } };
const readRows = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(parseLine).filter(Boolean) : []);

// ---------- listing ----------
// One token per stock on this chain, named by its ticker (the issuer's token symbol is the ticker itself), plus the
// memes select-chain.mjs picks (registry in <data>/evm/<chain>/chain-tokens.json, re-read when it changes). On the
// testnet a meme's token is the mock the opener deployed, flagged `mock` so the faucet page offers to mint it.
const TESTNET = chainCfg.test === true;
const fromChains = chainCfg.stocks.filter((s) => Array.isArray(s.thresholdsBps)).map((s) => ({ symbol: s.symbol, name: s.name, category: "stocks", kind: "close", thresholdsBps: s.thresholdsBps, icon: null, active: true,
  tokens: [{ token: s.symbol, issuer: s.issuer, decimals: s.decimals, mint: s.token, mainnetMint: s.token, faucetUi: 5 }] }));
let stocks = fromChains, stockByToken = new Map(), listingStamp = null;
function refreshListing() {
  let stamp = "-"; try { const st = fs.statSync(REGISTRY_FILE(DIR)); stamp = `${st.size}:${st.mtimeMs}`; } catch {}
  if (stamp === listingStamp) return;
  listingStamp = stamp;
  const today = utcDate(Date.now() / 1000), activeDays = [today, addDays(today, 1)];
  const memes = Object.entries(readRegistry(DIR).tokens).map(([addr, t]) => ({ ...asStock(addr, t, TESTNET ? "devnet" : "mainnet"), active: (t.selectedFor ?? []).some((d) => activeDays.includes(d)), selectedFor: t.selectedFor ?? [], liquidity: t.liquidity ?? null, volume24h: t.volume24h ?? null }))
    .filter((s) => s.tokens[0].mint).map((s) => ({ ...s, tokens: s.tokens.map((t) => ({ ...t, mock: TESTNET })) }))
    .sort((a, b) => Number(b.active) - Number(a.active) || (b.volume24h ?? 0) - (a.volume24h ?? 0));
  stocks = [...fromChains, ...memes];
  stockByToken = new Map(stocks.map((s) => [s.tokens[0].mint.toLowerCase(), s]));
}
refreshListing(); setInterval(() => { try { refreshListing(); } catch (e) { console.error("listing refresh failed:", String(e?.message ?? e).slice(0, 120)); } }, 60_000).unref();

// ---------- cached contract state ----------
const multipliers = new Map();   // token → { m, at }: the ERC-8056 multiplier (dividends / splits), re-read every 10 min
async function multiplierOf(token) {
  const k = token.toLowerCase(), hit = multipliers.get(k);
  if (hit && Date.now() - hit.at < 600_000) return hit.m;
  let m = 1; try { m = Number(await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "uiMultiplier" })) / 1e18 || 1; } catch {}
  multipliers.set(k, { m, at: Date.now() }); return m;
}
const serializeMarket = (m, multiplier) => ({ pubkey: `${chainCfg.pot}#${m.id}`, id: m.id, mint: m.token, tokenProgram: "", decimals: stockByToken.get(m.token.toLowerCase())?.tokens[0].decimals ?? 18, multiplier, metric: m.metric, nBuckets: m.nBuckets, thresholds: m.thresholds, openTs: m.openTs, closeTs: m.closeTs, resolveAfterTs: m.resolveAfterTs, baseline: m.baseline,
  pools: m.pools.map(Number), seed: Number(m.seedAmount), status: m.status - 1, outcome: m.outcome, proposedOutcome: m.proposedOutcome, proposedValue: m.proposedValue, proposedAt: m.proposedAt, positions: m.positions, positionsOpen: m.positionsOpen, feeCollected: Number(m.feeCollected), snapshotHash: String(m.snapshotHash).replace(/^0x/, "") });
const serializeConfig = (c, marketCount) => ({ admin: c.admin, proposer: c.proposer, treasuryOwner: c.treasury, feeBps: c.feeBps, earlyBirdDiscountBps: c.earlyBirdDiscountBps, earlyBirdSecs: c.earlyBirdSecs, disputeWindowSecs: c.disputeWindowSecs, minBet: Number(c.minBet), marketCount, paused: c.paused });
let chainCache = { at: 0, markets: null, config: null, pending: null };
const CHAIN_TTL_MS = Number(process.env.CHAIN_CACHE_MS ?? 15000);
function chainState() {
  if (chainCache.markets && Date.now() - chainCache.at < CHAIN_TTL_MS) return Promise.resolve(chainCache);
  if (chainCache.pending) return chainCache.markets ? Promise.resolve(chainCache) : chainCache.pending;   // stale-while-revalidate
  const stale = chainCache.markets ? chainCache : null;
  chainCache.pending = (async () => {
    const [all, cfg] = await Promise.all([allMarkets(), readConfig()]);
    const markets = await Promise.all(all.map(async (m) => serializeMarket(m, await multiplierOf(m.token))));
    chainCache = { at: Date.now(), markets: markets.sort((a, b) => b.id - a.id), config: serializeConfig(cfg, all.length), pending: null };
    return chainCache;
  })().catch((e) => { chainCache.pending = null; throw e; });
  if (stale) { chainCache.pending.catch((e) => console.error("chain refresh failed:", String(e?.message ?? e).slice(0, 120))); return Promise.resolve(stale); }
  return chainCache.pending;
}
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", String(e?.message ?? e).slice(0, 200)));
setInterval(() => chainState().catch(() => {}), CHAIN_TTL_MS).unref(); chainState().catch(() => {});
// the position index (who is in which market) follows the chain's events; a read that fails just leaves the last copy
setInterval(() => sync(DATA).catch((e) => console.error("event sync failed:", String(e?.message ?? e).slice(0, 120))), 30_000).unref(); sync(DATA).catch(() => {});

// ---------- prices ----------
// The token tracks the stock one for one, so its dollar price is the stock's last trade (Yahoo, no key), keyed by the
// token symbol like the Solana API's Jupiter prices. Refreshed in the background every minute.
let priceCache = { at: 0, prices: {} };
async function refreshPrices() {
  const out = {};
  // memes: the sampler's latest quote (server/evm/sample-prices.mjs) and the latest known daily close
  try {
    const latest = JSON.parse(fs.readFileSync(path.join(DIR, "ticks", "latest.json"), "utf8")), today = utcDate(Date.now() / 1000);
    for (const s of stocks) if (s.kind === "day") for (const t of s.tokens) {
      const px = latest.p?.[String(t.mainnetMint).toLowerCase()];
      let prevClose = null; for (const d of [addDays(today, -1), addDays(today, -2)]) { const c = chainClose(DIR, String(t.mainnetMint).toLowerCase(), d); if (c.ok) { prevClose = { date: d, close: c.close, samples: c.samples }; break; } }
      if (px > 0) out[t.token] = { usd: px, stock: null, prevClose };
    }
  } catch (e) { if (e?.code !== "ENOENT") console.error("meme prices:", String(e?.message ?? e).slice(0, 100)); }
  await Promise.all(stocks.filter((s) => s.kind === "close").map(async (s) => {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s.symbol}?range=1d&interval=1d`, { headers: { "user-agent": "Mozilla/5.0 (SharePot)" }, signal: AbortSignal.timeout(8000) });
      const px = Number((await r.json())?.chart?.result?.[0]?.meta?.regularMarketPrice);
      if (Number.isFinite(px) && px > 0) out[s.symbol] = { usd: px, stock: px };
    } catch {}
  }));
  if (Object.keys(out).length) priceCache = { at: Date.now(), prices: { ...priceCache.prices, ...out } };
}
setInterval(() => refreshPrices().catch(() => {}), 60_000).unref(); refreshPrices().catch(() => {});

// ---------- leaderboard ----------
const SETTLEMENTS = path.join(DIR, "settlements.jsonl");
const boards = new Map();
function leaderboardCached(key, since) {
  let stamp = "-"; try { const st = fs.statSync(SETTLEMENTS); stamp = `${st.size}:${st.mtimeMs}`; } catch {}
  const hit = boards.get(key);
  if (hit && hit.stamp === stamp) return hit.board;
  const rows = readRows(SETTLEMENTS);
  const board = { ...leaderboard(rows, { decimals: (mint) => stockByToken.get(String(mint).toLowerCase())?.tokens[0].decimals ?? 18, close: () => null }, since), at: new Date().toISOString() };
  boards.set(key, { stamp, board }); return board;
}

// ---------- pages ----------
// The static pages describe the Solana site in a few places (which tokens, who the issuer is, the faucet); on this chain
// those elements get their own words, in the visitor's language where overlay.json has them and in English otherwise.
const overlay = JSON.parse(fs.readFileSync(new URL("./overlay.json", import.meta.url), "utf8"));
function applyOverlay(html, lang) {
  const d = { ...overlay.en, ...(overlay[lang] ?? {}) };
  return html
    .replace(/<(\w+)\b([^>]*?\sdata-t="([\w.-]+)"[^>]*)>([\s\S]*?)<\/\1>/g, (all, tag, attrs, key) => (d[key] != null ? `<${tag}${attrs}>${d[key]}</${tag}>` : all))
    .replace(/<\w+\b[^>]*\sdata-t-attr="([^"]+)"[^>]*>/g, (tag, spec) => spec.split(";").reduce((out, pair) => {
      const [attr, key] = pair.split(":"); if (!/^[\w-]+$/.test(attr ?? "") || d[key] == null) return out;
      return out.replace(new RegExp(`(\\s${attr}=")[^"]*(")`), (m, a, b) => a + String(d[key]).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])) + b);
    }, tag));
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".map": "application/json", ".mp4": "video/mp4", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
const htmlCache = new Map(), renderCache = new Map(), RENDER_TTL_MS = 5000, RENDER_CACHE_MAX = 100;
function pageHtml(file) {
  const mtime = fs.statSync(file).mtimeMs, hit = htmlCache.get(file);
  if (hit && hit.mtime === mtime) return hit.html;
  const html = fs.readFileSync(file, "utf8"); htmlCache.set(file, { mtime, html }); return html;
}
function bootScript() {
  const boot = { at: Date.now(), stocks: { cluster: CHAIN_KEY, stocks }, prices: priceCache.at ? priceCache.prices : null, markets: chainCache.markets, config: chainCache.config, chainAt: chainCache.at };
  return `<script>window.__BOOT__=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>`;
}
function serveStatic(res, url, req) {
  let rel; try { rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname); } catch { rel = null; }
  const lm = rel?.match(/^\/i18n\/([A-Za-z-]{2,10})\.js$/), ljs = lm ? langScript(lm[1]) : null;
  if (ljs) { res.writeHead(200, { "content-type": TYPES[".js"] + "; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" }); return res.end(ljs); }
  const file = rel ? path.resolve(STATIC, "." + rel) : "";
  if (!rel || rel.includes("\0") || !file.startsWith(STATIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
  const ext = path.extname(file);
  if (ext === ".html") {
    const { lang, fromQuery } = resolveLang(req, url);
    res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-cache", "vary": "accept-language, cookie", "content-language": lang, "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY",
      ...(fromQuery ? { "set-cookie": `sp_lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax` } : {}) });
    const key = lang + "|" + rel + url.search, hit = renderCache.get(key);
    if (hit && Date.now() - hit.at < RENDER_TTL_MS) return res.end(hit.html);
    let html = pageHtml(file).replace("</head>", () => bootScript() + "</head>");
    const data = { markets: chainCache.markets, config: chainCache.config, stocks, prices: priceCache.at ? priceCache.prices : null };
    try { const tr = translator(lang); if (rel === "/index.html") html = homeHtml(data, html, url, tr); else if (rel === "/market.html") html = eventHtml(data, url, html, tr); }
    catch (e) { console.error("ssr failed:", String(e?.message ?? e).slice(0, 160)); }
    try { html = applyOverlay(translateHtml(html, lang), lang); } catch (e) { console.error("i18n failed:", String(e?.message ?? e).slice(0, 160)); }
    if (renderCache.size >= RENDER_CACHE_MAX) renderCache.clear();
    renderCache.set(key, { at: Date.now(), html });
    return res.end(html);
  }
  const size = fs.statSync(file).size, range = String(req?.headers?.range ?? "").match(/^bytes=(\d*)-(\d*)$/);
  const hdr = { "content-type": TYPES[ext] ?? "application/octet-stream", "accept-ranges": "bytes", "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : ext === ".mp4" ? "public, max-age=3600" : "no-cache" };
  if (range && ext === ".mp4") {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2])), end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!(start >= 0 && start <= end && end < size)) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...hdr, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...hdr, "content-length": size });
  fs.createReadStream(file).pipe(res);
}

// ---------- API ----------
const json = (res, code, body, extra = {}) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS", ...extra }); res.end(JSON.stringify(body)); };
const readBody = (req, max = 4096) => new Promise((ok, err) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > max) { err(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); } }); req.on("end", () => ok(b)); req.on("error", err); });
const clientIp = (req) => String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?").trim();
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s ?? ""));
const FEEDBACK = path.join(DIR, "feedback.jsonl");
let feedbackDay = "", feedbackToday = 0; const seenFeedback = new Map();

const server = http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400, { "content-type": "text/plain" }); return res.end("bad request"); }
  if (req.method === "OPTIONS") return json(res, 204, {});
  const p = url.pathname.slice(4);
  try {
    if (!url.pathname.startsWith("/api/")) return serveStatic(res, url, req);
    if (p === "/health") return json(res, 200, { ok: true, chain: CHAIN_KEY, chainId: chainCfg.chainId, pot: chainCfg.pot, faucet: false });
    if (p === "/stocks") return json(res, 200, { cluster: CHAIN_KEY, stocks }, { "cache-control": "public, max-age=60" });
    if (p === "/prices") return priceCache.at ? json(res, 200, { prices: priceCache.prices }, { "cache-control": "public, max-age=60" }) : json(res, 503, { error: "price source unavailable" });
    if (p === "/markets" || p === "/config" || /^\/markets\/\d+$/.test(p)) {
      let st; try { st = await chainState(); } catch (e) { return json(res, 503, { error: "chain read failed: " + String(e?.message ?? e).slice(0, 120) }); }
      const hdr = { "cache-control": "public, max-age=10" };
      if (p === "/config") return json(res, 200, { at: st.at, config: st.config }, hdr);
      if (p === "/markets") return json(res, 200, { at: st.at, markets: st.markets }, hdr);
      const m = st.markets.find((x) => x.id === Number(p.slice(9))); return m ? json(res, 200, { at: st.at, market: m, config: st.config }, hdr) : json(res, 404, { error: "no such market" });
    }
    const ev = p.match(/^\/evidence\/(\d+)(\/raw)?$/);
    if (ev) {
      const f = path.join(DIR, "evidence", `${ev[1]}.json`);
      if (!fs.existsSync(f)) return json(res, 404, { error: "no evidence published for that market yet" });
      const e = JSON.parse(fs.readFileSync(f, "utf8"));
      if (ev[2]) { res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" }); return res.end(e.response); }
      const { response, ...rest } = e; return json(res, 200, rest, { "cache-control": "public, max-age=300" });
    }
    const po = p.match(/^\/positions\/(0x[0-9a-fA-F]{40})$/);
    if (po) {
      const owner = po[1].toLowerCase(), open = [];
      for (const [id, set] of openPositions(DATA)) if (set.has(owner)) open.push({ id });
      const settled = readRows(SETTLEMENTS).filter((r) => String(r.owner).toLowerCase() === owner);
      return json(res, 200, { owner: po[1], open, settled: settled.reverse() }, { "cache-control": "no-store" });
    }
    if (p === "/leaderboard") {
      const w0 = url.searchParams.get("window"), win = w0 === "7d" || w0 === "30d" ? w0 : "all";
      const days = win === "7d" ? 7 : win === "30d" ? 30 : 0, since = days ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
      const board = leaderboardCached(win, since);
      return json(res, 200, { window: win, at: board.at, totals: board.totals, entries: board.entries.slice(0, limit).map((e) => ({ ...e, test: false })) }, { "cache-control": "public, max-age=30" });
    }
    if (p === "/disputes") return json(res, 200, { disputes: [] });
    if (p === "/faucet" || p === "/dispute" || p.startsWith("/referral")) return json(res, 403, { error: `not available on ${chainCfg.name}` });
    if (p === "/feedback" && req.method === "POST") {
      const day = new Date().toISOString().slice(0, 10); if (day !== feedbackDay) { feedbackDay = day; feedbackToday = 0; seenFeedback.clear(); }
      const ip = clientIp(req); seenFeedback.set(ip, (seenFeedback.get(ip) ?? 0) + 1);
      if (seenFeedback.get(ip) > 5 || feedbackToday >= 200) return json(res, 429, { error: "too much feedback from this network today; email hello@sharepot.xyz instead" });
      let b; try { b = JSON.parse(await readBody(req, 16 * 1024)); } catch { return json(res, 400, { error: "bad body" }); }
      const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, n);
      const message = clean(b.message, 4000), contact = clean(b.contact, 200), page = clean(b.page, 300), wallet = isAddr(b.wallet) ? String(b.wallet) : null;
      if (message.length < 5) return json(res, 400, { error: "please write a few words first" });
      if (b.website) return json(res, 200, { ok: true });
      feedbackToday++;
      const rec = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), chain: CHAIN_KEY, message, contact, page, wallet, ua: clean(req.headers["user-agent"], 200) };
      fs.appendFileSync(FEEDBACK, JSON.stringify(rec) + "\n");
      notify("💬 網站收到回饋(Robinhood)", `${message.slice(0, 600)}\n— ${contact || "沒留聯絡方式"}${wallet ? ` · ${wallet.slice(0, 8)}…` : ""} · ${page || "?"}`, "evm-feedback", 10);
      return json(res, 200, { ok: true, id: rec.id });
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (e?.status === 429 || e?.status === 413) return json(res, e.status, { error: e.message });
    console.error(e); json(res, 500, { error: "internal error" });
  }
});
server.headersTimeout = 15_000; server.requestTimeout = 60_000; server.keepAliveTimeout = 10_000;
server.listen(PORT, "127.0.0.1", () => console.log(`sharepot evm api+site on 127.0.0.1:${PORT} chain=${CHAIN_KEY} pot=${chainCfg.pot} static=${STATIC}`));
