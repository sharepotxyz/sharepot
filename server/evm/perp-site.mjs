// The SharePot Perp site (Base): its pages from web/dist-base and a small API, in one process on 127.0.0.1 (Caddy fronts
// it as base.sharepot.xyz, and only for Cloudflare's edge, so the CF-* headers below are Cloudflare's). One pool per
// stock (chains.json `perps`: NVDA, TSLA, META …); `?s=<SYMBOL>` picks one where it matters, the first is the default.
//   /, /history, /me, /faucet, /docs   the pages (perp.html, perp-history.html, perp-me.html, perp-faucet.html, perp-docs.html), the same
//                             bytes for everyone so Cloudflare can cache them; each page asks /api/health whether this
//                             visitor is in the United States (readable, nothing can be sent) and sends nothing until told
//   /api/health               chain, the pools, faucet on/off, the caller's country as Cloudflare reports it
//   /api/days?s=SYM           every scheduled day of that pool: its close, the token value proposed and settled, what
//                             moved, the funding paid, the transactions, and a summary of the price evidence
//   /api/evidence/SYM/:day    the evidence file itself, byte for byte: its sha256 is the hash recorded on-chain
//                             (/api/evidence/:day = the first pool's, the address it had when there was one pool)
//   /api/activity/:address    one wallet's entries, exits, bookings and withdrawals in every pool (from the event index)
//   /api/gas (POST)           {address}: a little test ETH for fees (test networks only)
//   /api/feedback (POST)      free-text feedback
// The event index (DATA_DIR/perp/<chain>/<pool>/events.jsonl, one per pool) is kept by this process: every 30 s it reads
// the new blocks of each pool, re-reading the newest ones (a public RPC node behind the head answers eth_getLogs with an
// empty list). Separate from the Solana and Robinhood processes on purpose: nothing here can take those sites down.
//   env: PORT (5043), EVM_CHAIN (base-sepolia), STATIC_DIR, DATA_DIR, EVM_FAUCET_KEY_FILE, GAS_FAUCET_ETH (0.0003),
//        GAS_FAUCET_DAILY (300)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http as viemHttp } from "viem";
import { CHAIN_KEY, chainCfg, publicClient, walletFor } from "./chain.mjs";
import { perpAbi, readEpoch, readState, POOLS, poolDir } from "./perp.mjs";
import { nyDate } from "../prices.mjs";
import { notify } from "../notify.mjs";

const PORT = Number(process.env.PORT ?? 5043);
const STATIC = path.resolve(process.env.STATIC_DIR ?? new URL("../../web/dist-base", import.meta.url).pathname);
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
if (!POOLS.length) throw new Error(`chains.json ${CHAIN_KEY}: no perp pools`);
// Wallets that are ours, shown as such on the site: the demo bots (chains.json perpDemoWallets) and the treasury (read
// from the first pool once; every pool has the same). The contest's rules disqualify presenting them as users.
const DEMO = (chainCfg.perpDemoWallets ?? []).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
let TREASURY = null;
publicClient.readContract({ address: POOLS[0].address, abi: perpAbi, functionName: "treasury" }).then((t) => { TREASURY = t; }).catch(() => {});
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".mp4": "video/mp4" };
// The United States and its territories (Cloudflare country codes). The contest's rules and the stock tokens' issuer
// both exclude US persons; the page still loads (anyone may read it) but cannot send anything.
const BLOCKED = new Set(["US", "PR", "GU", "VI", "AS", "MP", "UM"]);
const country = (req) => String(req.headers["cf-ipcountry"] ?? "").toUpperCase().slice(0, 2);
const isBlocked = (req) => BLOCKED.has(country(req));
// Caddy overwrites CF-Connecting-IP with the client IP it trusts (only Cloudflare's ranges reach this site)
const clientIp = (req) => String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?").trim();
const isAddr = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const SEC = { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" };
const json = (res, code, body, extra = {}) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...SEC, ...extra }); res.end(JSON.stringify(body)); };
const readBody = (req, max = 2048) => new Promise((ok, err) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > max) { err(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); } }); req.on("end", () => ok(b)); req.on("error", err); });
const log = (...a) => console.log(new Date().toISOString(), ...a);
// Read budgets, per minute: per address, and for the whole site. Counters reset only when the minute turns — a flood
// of fresh addresses fills the table and is refused, it cannot clear anyone's count. A request refused by its own
// address's budget is not counted against the site's: one address hammering /api/days used to use up the site budget
// and lock everyone else out for the rest of the minute (weekly audit 2026-11-17).
const READS_PER_MINUTE = 120, SITE_READS_PER_MINUTE = 3_000; const seenReads = new Map(); let readMinute = 0, siteReads = 0;
function chargeRead(req) {
  const m = Math.floor(Date.now() / 60_000); if (m !== readMinute) { readMinute = m; seenReads.clear(); siteReads = 0; }
  const ip = clientIp(req);
  if (!seenReads.has(ip) && seenReads.size >= 50_000) throw Object.assign(new Error("the site is busy; try again in a minute"), { status: 429 });
  const n = (seenReads.get(ip) ?? 0) + 1; seenReads.set(ip, n);
  if (n > READS_PER_MINUTE) throw Object.assign(new Error("too many requests; try again in a minute"), { status: 429 });
  if (++siteReads > SITE_READS_PER_MINUTE) throw Object.assign(new Error("the site is busy; try again in a minute"), { status: 429 });
}

// ---------- event index (one per pool) ----------
// Base Sepolia makes a block about every 0.2 s (≈430k a day) and its own public RPC answers eth_getLogs for 200 blocks
// at most, so the index reads logs from a node that takes wide ranges (chains.json perpLogsRpcs), and re-reads the
// newest perpLogsConfirm blocks every time (a node behind the head returns an empty list, not an error).
// Several such nodes, in order (chains.json perpLogsRpcs: [{url, window}]): a free gateway may rate-limit this host's
// IP (Tenderly does the VPS's), so each window falls back to the next node instead of the index stopping.
const LOG_SOURCES = (chainCfg.perpLogsRpcs ?? [{ url: chainCfg.perpLogsRpc ?? chainCfg.rpc, window: chainCfg.perpLogsWindow ?? 9_000 }])
  .filter((x) => /^https:\/\//.test(x.url ?? ""))
  .map((x) => ({ url: x.url, window: Number(x.window) || 9_000, client: createPublicClient({ transport: viemHttp(x.url, { retryCount: 2, retryDelay: 800 }) }) }));
const CONFIRM = Number(chainCfg.perpLogsConfirm ?? 600);
let logSrc = 0;   // the node that answered last; a run starts with it
async function withLogs(fn) {
  let lastErr;
  for (let k = 0; k < LOG_SOURCES.length; k++) {
    const i = (logSrc + k) % LOG_SOURCES.length;
    try { const r = await fn(LOG_SOURCES[i]); logSrc = i; return r; } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("no log source configured");
}
const plain = (v) => (typeof v === "bigint" ? v.toString() : typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v);
const rowKey = (r) => `${r.tx}:${r.li}`;
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

/** Everything the site keeps per pool. */
const SITES = POOLS.map((pool) => {
  const dir = poolDir(pool, DATA), eventsFile = path.join(dir, "events.jsonl");
  const events = readJsonl(eventsFile);
  return { pool, dir, eventsFile, cursorFile: path.join(dir, "events.cursor"), events, seenKeys: new Set(events.map(rowKey)), lastSyncAt: 0, syncError: "", daysCache: null, daysAt: 0, daysInFlight: null };
});
const BY_SYMBOL = new Map(SITES.map((s) => [s.pool.symbol, s]));
/** The pool a request names with ?s= (the first when it names none); null for a symbol that is not one of ours. */
const siteFor = (url) => { const s = (url.searchParams.get("s") ?? "").toUpperCase(); return s ? BY_SYMBOL.get(s) ?? null : SITES[0]; };

async function syncPool(S) {
  const { pool } = S;
  const head = Number(await withLogs((src) => src.client.getBlockNumber()));
  const saved = fs.existsSync(S.cursorFile) ? Number(fs.readFileSync(S.cursorFile, "utf8").trim()) : NaN;
  const cursor = Number.isFinite(saved) && saved > 0 ? saved : pool.deployBlock || head;   // a garbled cursor re-reads from the deploy block, never stops
  for (let from = Math.max(pool.deployBlock, cursor - CONFIRM); from <= head; ) {
    let to = from;
    const logs = await withLogs((src) => { to = Math.min(head, from + src.window - 1); return src.client.getContractEvents({ address: pool.address, abi: perpAbi, fromBlock: BigInt(from), toBlock: BigInt(to) }); });
    const fresh = logs.filter((l) => !S.seenKeys.has(`${l.transactionHash}:${l.logIndex}`));
    if (fresh.length) {
      const blocks = [...new Set(fresh.map((l) => l.blockNumber))];
      const ts = new Map(await Promise.all(blocks.map(async (b) => [b, Number((await publicClient.getBlock({ blockNumber: b })).timestamp)])));
      const rows = fresh.map((l) => ({ ev: l.eventName, block: Number(l.blockNumber), ts: ts.get(l.blockNumber), tx: l.transactionHash, li: l.logIndex, a: Object.fromEntries(Object.entries(l.args ?? {}).map(([k, v]) => [k, plain(v)])) }));
      fs.appendFileSync(S.eventsFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      for (const r of rows) { S.seenKeys.add(rowKey(r)); S.events.push(r); }
      S.daysCache = null;
    }
    fs.writeFileSync(S.cursorFile, String(to + 1));
    from = to + 1;
  }
}
let syncing = false;
async function syncEvents() {
  if (syncing) return;
  syncing = true;
  try {
    for (const S of SITES) {   // one pool after the other: the free log nodes count calls per second
      try { await syncPool(S); S.lastSyncAt = Date.now(); S.syncError = ""; }
      catch (e) { S.syncError = String(e?.shortMessage ?? e?.message ?? e).slice(0, 160); log(`event sync ${S.pool.symbol} failed:`, S.syncError); }
    }
  } finally { syncing = false; }
}
syncEvents(); setInterval(syncEvents, 30_000);
/** The oldest of the pools' last index reads (the index is as fresh as its stalest pool), in seconds. */
const indexedAt = () => (SITES.every((S) => S.lastSyncAt) ? Math.floor(Math.min(...SITES.map((S) => S.lastSyncAt)) / 1000) : null);

// ---------- days ----------
const evidenceFile = (S, day) => path.join(S.dir, `evidence-${day}.json`);
function evidenceSummary(S, day) {
  const f = evidenceFile(S, day); if (!fs.existsSync(f)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8")), last = d.sessions?.[d.sessions.length - 1] ?? {};
    return { sessions: (d.sessions ?? []).map((s) => ({ date: s.date, close: s.close, prevClose: s.prevClose, prevDate: s.prevDate, dividend: s.dividend, movePpm: s.movePpm ?? null, nasdaq: s.crossCheck?.agreed ?? null, nasdaqClose: s.crossCheck?.close ?? null, nasdaqNote: s.crossCheck?.note ?? null })),
      close: last.close ?? null, chainlink: d.chainlink?.diffBps != null ? { diffBps: d.chainlink.diffBps, price: Number(d.chainlink.price) / 1e8, updatedAt: d.chainlink.updatedAt, feed: d.chainlink.feed } : null,
      sources: (d.evidence ?? []).map((e) => String(e.source ?? "").split("?")[0]).filter((u) => /^https:\/\//.test(u)) };
  } catch { return null; }
}
const DAYS_SHOWN = 120;   // the newest days; older ones stay on-chain and in the evidence files
// One reading at a time per pool: concurrent requests on a cold cache share it instead of each reading every epoch.
async function days(S) {
  if (S.daysCache && Date.now() - S.daysAt < 20_000) return S.daysCache;
  if (!S.daysInFlight) S.daysInFlight = readDays(S).finally(() => { S.daysInFlight = null; });
  return S.daysInFlight;
}
async function readDays(S) {
  const { pool, events } = S;
  const st = await readState(pool), now = Date.now() / 1000;
  const first = Math.max(1, st.lastScheduled - DAYS_SHOWN + 1);
  const eps = await Promise.all([...Array(Math.max(0, st.lastScheduled - first + 1)).keys()].map((i) => readEpoch(pool, first + i)));
  const byDay = (name) => { const m = new Map(); for (const r of events) if (r.ev === name) m.set(Number(r.a.day), r); return m; };
  const proposed = byDay("Proposed"), settled = byDay("Settled"), skipped = byDay("Skipped");
  const rejected = new Map(); for (const r of events) if (r.ev === "Rejected") rejected.set(Number(r.a.day), (rejected.get(Number(r.a.day)) ?? 0) + 1);
  let nextShown = false;
  const out = [];
  for (const e of eps) {
    if (e.cutoff > now) { if (nextShown) continue; nextShown = true; }
    const s = settled.get(e.day), p = proposed.get(e.day), k = skipped.get(e.day);
    out.push({ day: e.day, date: nyDate(e.cutoff), cutoff: e.cutoff, state: e.state, value: e.value.toString(), proposedAt: e.proposedAt, evidenceHash: e.evidence,
      disputeEnds: e.proposedAt ? e.proposedAt + st.disputeWindowSecs : null, rejected: rejected.get(e.day) ?? 0, rolledTo: e.rolledTo || null,
      proposeTx: p?.tx ?? null, settleTx: s?.tx ?? k?.tx ?? null, settledAt: s?.ts ?? k?.ts ?? null,
      prevValue: s?.a.prevValue ?? null, longExp: s?.a.longExp ?? null, shortExp: s?.a.shortExp ?? null, moved: s?.a.moved ?? null, funding: s?.a.funding ?? null,
      evidence: evidenceSummary(S, e.day) });
  }
  S.daysCache = { at: Math.floor(now), symbol: pool.symbol, tokenSymbol: pool.tokenSymbol, pool: pool.address, explorer: chainCfg.explorer, feed: pool.feed, disputeWindowSecs: st.disputeWindowSecs,
    indexedAt: S.lastSyncAt ? Math.floor(S.lastSyncAt / 1000) : null, days: out.reverse() };
  S.daysAt = Date.now();
  return S.daysCache;
}

// ---------- activity ----------
const USER_EVENTS = new Set(["DepositRequested", "RedeemRequested", "EntryBooked", "Claimed"]);
/** One wallet's rows in every pool (each row names its pool: `sym`), and per pool what it put in and took out. The
 *  amounts are in each pool's own stock token, so they are never added across pools here. */
function activity(addr) {
  const a = addr.toLowerCase(), pools = {}, rows = [];
  for (const S of SITES) {
    const mine = S.events.filter((r) => USER_EVENTS.has(r.ev) && r.a.user === a).map((r) => ({ sym: S.pool.symbol, ev: r.ev, ts: r.ts, tx: r.tx, day: Number(r.a.day), tier: Number(r.a.tier), amount: r.a.amount ?? null, shares: r.a.shares ?? null, tokens: r.a.tokens ?? null }));
    const sum = (ev, f) => mine.filter((r) => r.ev === ev).reduce((s, r) => s + BigInt(r[f] ?? 0), 0n);
    pools[S.pool.symbol] = { deposited: sum("DepositRequested", "amount").toString(), withdrawn: sum("Claimed", "tokens").toString() };
    rows.push(...mine);
  }
  return { address: a, indexedAt: indexedAt(), pools, rows: rows.sort((x, y) => y.ts - x.ts || y.day - x.day) };
}

// ---------- gas faucet ----------
const GAS_WEI = BigInt(Math.round(Number(process.env.GAS_FAUCET_ETH ?? 0.0003) * 1e18)), GAS_LOW_WEI = GAS_WEI * 20n, GAS_DAILY = Number(process.env.GAS_FAUCET_DAILY ?? 300);
const faucet = chainCfg.test && process.env.EVM_FAUCET_KEY_FILE && fs.existsSync(process.env.EVM_FAUCET_KEY_FILE) ? walletFor(process.env.EVM_FAUCET_KEY_FILE) : null;
let gasDay = "", gasToday = 0; const gasAddr = new Set(), gasIp = new Map();
let sending = Promise.resolve();   // one transfer at a time: concurrent sends from one key would race for the nonce
async function gas(req, res) {
  if (!faucet) return json(res, 403, { error: `no faucet on ${chainCfg.name}` });
  if (isBlocked(req)) return json(res, 403, { error: "not available in your country" });
  const day = new Date().toISOString().slice(0, 10); if (day !== gasDay) { gasDay = day; gasToday = 0; gasAddr.clear(); gasIp.clear(); }
  let address; try { address = String(JSON.parse(await readBody(req)).address); } catch { return json(res, 400, { error: "body must be {\"address\": \"0x…\"}" }); }
  if (!isAddr(address)) return json(res, 400, { error: "address must be 0x + 40 hex" });
  const k = address.toLowerCase(), ip = clientIp(req);
  if (gasAddr.has(k)) return json(res, 429, { error: "this address already received test ETH today" });
  if ((gasIp.get(ip) ?? 0) >= 5) return json(res, 429, { error: "too many faucet requests from this network today" });
  if (gasToday >= GAS_DAILY) return json(res, 429, { error: "the faucet is empty for today, try tomorrow" });
  gasAddr.add(k); gasIp.set(ip, (gasIp.get(ip) ?? 0) + 1); gasToday++;
  const undo = () => { gasAddr.delete(k); gasIp.set(ip, Math.max(0, (gasIp.get(ip) ?? 1) - 1)); gasToday--; };
  const run = sending.then(async () => {
    const have = await publicClient.getBalance({ address });
    if (have >= GAS_WEI) { gasToday--; return { ok: true, sent: null, note: "this wallet already has enough ETH for fees" }; }   // the address stays marked for the day: asking again is a 429, not another RPC call
    const tx = await faucet.client.sendTransaction({ account: faucet.account, to: address, value: GAS_WEI });
    const rc = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 90_000 });
    if (rc.status !== "success") throw new Error("transfer reverted");
    publicClient.getBalance({ address: faucet.account.address }).then((b) => { if (b < GAS_LOW_WEI) notify("⛽ Base gas 水龍頭快沒 ETH", `剩 ${(Number(b) / 1e18).toFixed(5)} ETH(${faucet.account.address}),每次送 ${Number(GAS_WEI) / 1e18}`, "base-gas-faucet-low", 360); }).catch(() => {});
    return { ok: true, sent: `${Number(GAS_WEI) / 1e18} ETH`, tx };
  });
  sending = run.catch(() => {});
  try { return json(res, 200, await run); }
  catch (e) { undo(); log("gas faucet failed", String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)); return json(res, 503, { error: "faucet transaction failed, try again in a minute" }); }
}

// ---------- feedback ----------
const FEEDBACK = path.join(SITES[0].dir, "feedback.jsonl");   // where it has always been (the first pool's directory)
let fbDay = "", fbToday = 0; const fbIp = new Map();
async function feedback(req, res) {
  const day = new Date().toISOString().slice(0, 10); if (day !== fbDay) { fbDay = day; fbToday = 0; fbIp.clear(); }
  const ip = clientIp(req); fbIp.set(ip, (fbIp.get(ip) ?? 0) + 1);
  if (fbIp.get(ip) > 5 || fbToday >= 200) return json(res, 429, { error: "too much feedback from this network today; email hello@sharepot.xyz instead" });
  let b; try { b = JSON.parse(await readBody(req, 16 * 1024)); } catch { return json(res, 400, { error: "bad body" }); }
  const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, n);
  const message = clean(b.message, 4000), contact = clean(b.contact, 200), page = clean(b.page, 300), wallet = isAddr(b.wallet) ? String(b.wallet) : null;
  if (message.length < 5) return json(res, 400, { error: "please write a few words first" });
  if (b.website) return json(res, 200, { ok: true });   // the hidden field only bots fill in
  fbToday++;
  const rec = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), chain: CHAIN_KEY, message, contact, page, wallet, country: country(req) || null, ua: clean(req.headers["user-agent"], 200) };
  fs.appendFileSync(FEEDBACK, JSON.stringify(rec) + "\n");
  const oneLine = (t) => t.replace(/\s*[\r\n]+\s*/g, " ⏎ ");   // a message cannot forge extra lines in the alert
  notify("💬 網站收到回饋(Base 永續池)", `${oneLine(message).slice(0, 600)}\n— ${oneLine(contact) || "沒留聯絡方式"}${wallet ? ` · ${wallet.slice(0, 8)}…` : ""} · ${oneLine(page) || "?"}`, "base-feedback", 10);
  return json(res, 200, { ok: true, id: rec.id });
}

// ---------- pages ----------
// Only this site's own pages: the same build also emits the four-range SharePot pages, which belong to the other sites.
const PAGES = { "/": "perp.html", "/history": "perp-history.html", "/me": "perp-me.html", "/faucet": "perp-faucet.html", "/docs": "perp-docs.html" };
const HTML_OK = new Set(Object.values(PAGES));
function serveStatic(req, res, p) {
  let rel; try { rel = decodeURIComponent(p); } catch { res.writeHead(400, { "content-type": "text/plain" }); return res.end("bad request"); }
  if (PAGES[rel]) rel = "/" + PAGES[rel];
  const file = path.resolve(STATIC, "." + rel), ext = path.extname(file).toLowerCase();
  if (!rel || rel.includes("\0") || !file.startsWith(STATIC + path.sep) || (ext === ".html" && !HTML_OK.has(path.basename(file))) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // never kept by Cloudflare (it would keep a .js 404 for minutes): a file missing for a moment stays missing that long
    res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store", ...SEC }); return res.end("not found");
  }
  if (ext === ".html") {
    // identical for every visitor (the US check is /api/health's): Cloudflare may keep a copy for a minute (s-maxage),
    // browsers revalidate every time (max-age=0). A deploy is visible everywhere within that minute.
    res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "public, max-age=0, s-maxage=60", ...SEC });
    return res.end(fs.readFileSync(file));
  }
  res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache", ...SEC });
  fs.createReadStream(file).pipe(res);
}

const POOL_LIST = POOLS.map((p) => ({ symbol: p.symbol, tokenSymbol: p.tokenSymbol, pool: p.address, token: p.token }));
const server = http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400, { "content-type": "text/plain" }); return res.end("bad request"); }
  const p = url.pathname;
  try {
    // `country` is what Cloudflare says about the caller (null = no CF-IPCountry header arrived: the US block would be off)
    if (p === "/api/health") return json(res, 200, { ok: true, chain: CHAIN_KEY, chainId: chainCfg.chainId, perp: POOLS[0].address, pools: POOL_LIST, faucet: !!faucet, demoWallets: DEMO, treasury: TREASURY, country: country(req) || null, blocked: isBlocked(req), indexedAt: indexedAt(), indexBehind: SITES.some((S) => !!S.syncError) });
    if (p === "/api/gas") return req.method === "POST" ? await gas(req, res) : json(res, 405, { error: "POST only" });
    if (p === "/api/feedback") return req.method === "POST" ? await feedback(req, res) : json(res, 405, { error: "POST only" });
    if (p === "/api/days") {
      const S = siteFor(url); if (!S) return json(res, 404, { error: `no pool for that symbol (${POOLS.map((x) => x.symbol).join(", ")})` });
      chargeRead(req); return json(res, 200, await days(S), { "cache-control": "public, max-age=15, s-maxage=15" });
    }
    const ev = p.match(/^\/api\/evidence\/(?:([A-Za-z]{1,6})\/)?(\d{1,6})$/);
    if (ev) {
      const S = ev[1] ? BY_SYMBOL.get(ev[1].toUpperCase()) : SITES[0];
      if (!S) return json(res, 404, { error: "no pool for that symbol" });
      chargeRead(req);
      const f = evidenceFile(S, Number(ev[2]));
      if (!fs.existsSync(f)) return json(res, 404, { error: "no evidence for that day yet" });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600", ...SEC });
      return res.end(fs.readFileSync(f));   // the exact bytes that were hashed: re-encoding them would break the check
    }
    const ac = p.match(/^\/api\/activity\/(0x[0-9a-fA-F]{40})$/);
    if (ac) { chargeRead(req); return json(res, 200, activity(ac[1])); }
    if (p.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { "content-type": "text/plain" }); return res.end("GET only"); }
    return serveStatic(req, res, p);
  } catch (e) {
    if (e?.status === 429 || e?.status === 413) return json(res, e.status, { error: e.message });
    log(p, String(e?.message ?? e).slice(0, 200));
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  }
});
server.headersTimeout = 15_000; server.requestTimeout = 60_000; server.keepAliveTimeout = 10_000;
server.listen(PORT, "127.0.0.1", () => log(`perp site (${CHAIN_KEY}) on 127.0.0.1:${PORT}, static ${STATIC}, pools ${SITES.map((S) => `${S.pool.symbol} ${S.dir}`).join(" · ")}, faucet ${faucet ? faucet.account.address : "off"}`));
