// Public read API + devnet faucet + the static site, in one process on 127.0.0.1 (the web server fronts it).
//   /api/markets, /api/markets/:id, /api/config   cached program state (15 s); markets carry their token's decimals
//   /api/prices                                     live prices of the listed tokens (Jupiter), for dollar estimates
//   /api/stocks                                     listed stocks, their tokens per issuer and each token's mint here
//   /api/evidence/:id, /api/evidence/:id/raw        price evidence behind a proposed result (raw bytes hash to the on-chain hash)
//   /api/positions/:owner                           settlement history of a wallet
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
import { xstockPrices } from "./prices.mjs";
import { homeHtml, eventHtml } from "./ssr.mjs";
import { notify } from "./notify.mjs";

const PORT = Number(process.env.PORT ?? 5041);
const CLUSTER = process.env.CLUSTER ?? "devnet";
const RPC = process.env.CLUSTER_RPC ?? "https://api.devnet.solana.com";
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const SECRETS = process.env.SHAREPOT_SECRETS ?? path.join("/root/stocklana/secrets", CLUSTER);
const STATIC = path.resolve(process.env.STATIC_DIR ?? new URL("../web/dist", import.meta.url).pathname);
const tpl = JSON.parse(fs.readFileSync(new URL("./stock-templates.json", import.meta.url), "utf8"));
const state = CLUSTER === "mainnet" ? { mints: {} } : JSON.parse(fs.readFileSync(path.join(SECRETS, "state.json"), "utf8"));
const stocks = tpl.stocks.map((s) => ({ symbol: s.symbol, name: s.name, thresholdsBps: s.thresholdsBps,
  tokens: s.tokens.map((t) => ({ token: t.token, issuer: t.issuer, decimals: t.decimals, mint: CLUSTER === "mainnet" ? t.mainnetMint : state.mints[t.token] ?? null, mainnetMint: t.mainnetMint })) }));
const tokens = stocks.flatMap((s) => s.tokens.filter((t) => t.mint).map((t) => ({ ...t, symbol: s.symbol })));
const FAUCET_ENABLED = CLUSTER !== "mainnet" && process.env.FAUCET_DISABLED !== "1";
const FAUCET_SHARES = 2;
const FAUCET_SOL = Number(process.env.FAUCET_SOL ?? 0.01);
const FAUCET_DAILY_GLOBAL = Number(process.env.FAUCET_DAILY_GLOBAL ?? 300);
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
// Refreshed in the background every minute, so no page view ever waits on the price source.
let priceCache = { at: 0, prices: {} };
async function refreshPrices() {
  const all = stocks.flatMap((s) => s.tokens);
  const byMint = await xstockPrices(all.map((t) => t.mainnetMint));
  priceCache = { at: Date.now(), prices: Object.fromEntries(all.map((t) => [t.token, byMint[t.mainnetMint]])) };
}
async function prices() {
  if (!priceCache.at) await refreshPrices();
  return priceCache.prices;
}
setInterval(() => refreshPrices().catch((e) => console.error("price refresh failed:", String(e?.message ?? e).slice(0, 120))), 60_000).unref();
refreshPrices().catch(() => {});

// ---------- helpers ----------
const seenAddr = new Map(), seenIp = new Map(), seenDispute = new Map(); let seenDay = "", faucetToday = 0;
const dayKey = () => new Date().toISOString().slice(0, 10);
function rollDay() { const d = dayKey(); if (d !== seenDay) { seenDay = d; seenAddr.clear(); seenIp.clear(); seenDispute.clear(); faucetToday = 0; } }
// Behind Cloudflare the real client is CF-Connecting-IP; direct localhost callers fall back to the socket address.
const clientIp = (req) => String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?").trim();
const json = (res, code, body, extra = {}) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS", ...extra }); res.end(JSON.stringify(body)); };
const readBody = (req, max = 4096) => new Promise((ok, err) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > max) { err(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); } }); req.on("end", () => ok(b)); req.on("error", err); });
const DISPUTES = path.join(DATA, "disputes.jsonl");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2", ".mp4": "video/mp4", ".jpg": "image/jpeg" };
// Pages ship with the data they render on first paint (markets, config, listed stocks, prices from the in-memory
// caches) embedded as window.__BOOT__, so the browser needs no API round trip to Germany after the scripts load.
const htmlCache = new Map();
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
    let html = pageHtml(file).replace("</head>", bootScript() + "</head>");
    // first-paint content rendered here (ssr.mjs); a rendering error only costs the pre-render, never the page
    const data = { markets: chainCache.markets, config: chainCache.config, stocks, prices: priceCache.at ? priceCache.prices : null };
    try { if (rel === "/index.html") html = homeHtml(data, html, url); else if (rel === "/market.html") html = eventHtml(data, url, html); }
    catch (e) { console.error("ssr failed:", String(e?.message ?? e).slice(0, 160)); }
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
    if (p === "/stocks") return json(res, 200, { cluster: CLUSTER, stocks }, { "cache-control": "public, max-age=300" });
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
        const sigs = [];
        for (let i = 0; i < tokens.length; i += 3) {
          const tx = new Transaction();
          if (i === 0 && giveSol) tx.add(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: address, lamports: Math.round(FAUCET_SOL * LAMPORTS_PER_SOL) }));
          for (const t of tokens.slice(i, i + 3)) {
            const mint = new PublicKey(t.mint), { tokenProgram } = await mintInfo(mint), tp = new PublicKey(tokenProgram);
            const to = getAssociatedTokenAddressSync(mint, address, false, tp), from = getAssociatedTokenAddressSync(mint, faucet.publicKey, false, tp);
            tx.add(createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, to, address, mint, tp),
              createTransferCheckedInstruction(from, mint, to, faucet.publicKey, BigInt(FAUCET_SHARES) * 10n ** BigInt(t.decimals), t.decimals, [], tp));
          }
          // A busy public RPC sometimes hands out a blockhash its simulator has not seen yet; the transaction is then
          // rejected before it lands, so a fresh blockhash and one more try cannot double-send.
          for (let tries = 1; ; tries++) {
            try { sigs.push(await sendAndConfirmTransaction(conn, tx, [faucet])); break; }
            catch (e) { if (tries >= 3 || !/Blockhash not found/i.test(String(e?.message ?? e))) throw e; await new Promise((r) => setTimeout(r, 1500 * tries)); }
          }
        }
        return json(res, 200, { ok: true, address: k, sent: `${FAUCET_SHARES} of each of ${tokens.length} test stocks${giveSol ? ` + ${FAUCET_SOL} SOL` : ""}`, signatures: sigs });
      } catch (e) { seenAddr.delete(k); faucetToday--; console.error("faucet failed", e?.message); return json(res, 503, { error: "faucet transaction failed, try again in a minute" }); }
    }
    json(res, 404, { error: "not found" });
  } catch (e) { console.error(e); json(res, 500, { error: "internal error" }); }
});
server.headersTimeout = 15_000; server.requestTimeout = 60_000; server.keepAliveTimeout = 10_000;
server.listen(PORT, "127.0.0.1", () => console.log(`sharepot api+site on 127.0.0.1:${PORT} cluster=${CLUSTER} faucet=${!!faucet} tokens=${tokens.length} static=${STATIC} rpc=${RPC.replace(/api-key=[^&\s]*/, "api-key=…")}`));
