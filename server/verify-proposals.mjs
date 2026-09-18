// Independent check of every proposed result, run where the admin key lives — NOT on the app host. The proposer (the
// app host's hot key) publishes the observed value a market settles on; the dispute window is the only thing between
// a wrong or hostile proposal and the payout. This job re-derives the value from its own sources on its own machine
// and, if the range it lands in is not the proposed one, voids the market (every stake refunded) before the window
// closes, and says so. Stocks: Yahoo + Nasdaq official closes (prices.mjs, same rule as the resolver but fetched
// here). On-chain tokens: this host samples Jupiter and DexScreener every minute itself (sample-prices.mjs with
// TOKENS_API, into DATA_DIR/ticks) and applies the very same closing-hour rule (prices.mjs chainMove) to its own
// samples, so the comparison is like for like and nothing sampled on the app host is trusted. Only when this host has
// no samples for the baseline day (its first day) does it fall back to GeckoTerminal minute candles of the token's
// deepest pool, which are sparse for thin tokens and often cannot answer. Idempotent: a verdict is kept in
// DATA_DIR/verified.json and not repeated.
//   env: CLUSTER, CLUSTER_RPC, ADMIN_KEYPAIR, DATA_DIR, API (site, for the meme mint map), STOCKS, DRY_RUN=1
import fs from "node:fs";
import path from "node:path";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idlJson from "../idl/sharepot.json" with { type: "json" };
import { closeMove, chainMove, chainClose, parseMetric, movePpm, bucketOf, utcMidnight, addDays } from "./prices.mjs";
import { notify } from "./notify.mjs";
import { sendSigned } from "./tx.mjs";
import { unverifiedAction } from "./verify-policy.mjs";

const CLUSTER = process.env.CLUSTER ?? "devnet";
const RPC = process.env.CLUSTER_RPC ?? "https://api.devnet.solana.com";
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "verify-data");
const API = process.env.API ?? (CLUSTER === "mainnet" ? "https://sharepot.xyz" : "https://devnet.sharepot.xyz");
const DRY = process.env.DRY_RUN === "1";
// Real money never settles on a value this host could not re-derive (verify-policy.mjs); devnet keeps its markets.
const VOID_UNVERIFIED = (process.env.VOID_UNVERIFIED ?? (CLUSTER === "mainnet" ? "1" : "0")) === "1";
// Two honest DEX feeds can differ a little; a day-market value closer than this to a range boundary is reported, not acted on.
const AMBIGUOUS_PPM = Number(process.env.AMBIGUOUS_PPM ?? 5000);
const MIN_CANDLES = 30;
const keyFile = process.env.ADMIN_KEYPAIR; if (!keyFile) { console.error("ADMIN_KEYPAIR required"); process.exit(2); }
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const program = new anchor.Program(idlJson, new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" }));
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = (b) => Buffer.from(b).toString("utf8").replace(/\0+$/, "");
process.on("unhandledRejection", (e) => log(`unhandled rejection (ignored): ${String(e?.message ?? e).slice(0, 160)}`));
fs.mkdirSync(DATA, { recursive: true });
const STATE = path.join(DATA, "verified.json");
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } })();
const saveState = () => { fs.writeFileSync(STATE + ".tmp", JSON.stringify(state, null, 1)); fs.renameSync(STATE + ".tmp", STATE); };

// ---------- mainnet mint of an on-chain token, by symbol ----------
const tpl = JSON.parse(fs.readFileSync(process.env.STOCKS ?? new URL("./stock-templates.json", import.meta.url), "utf8"));
const mintBySymbol = new Map(tpl.stocks.filter((s) => s.kind === "day").flatMap((s) => s.tokens.map((t) => [s.symbol, t.mainnetMint])));
let apiStocks = null;
async function mainnetMintOf(symbol) {
  if (mintBySymbol.has(symbol)) return mintBySymbol.get(symbol);            // pre-IPO tokens: pinned here, not asked of the app host
  if (!apiStocks) apiStocks = (await (await fetch(`${API}/api/stocks`, { signal: AbortSignal.timeout(15_000) })).json()).stocks ?? [];
  return apiStocks.find((s) => s.symbol === symbol)?.tokens?.[0]?.mainnetMint ?? null;
}

// ---------- GeckoTerminal: closing-hour median of a token's deepest pool ----------
const gecko = async (p) => {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://api.geckoterminal.com/api/v2${p}`, { headers: { "user-agent": "Mozilla/5.0 (SharePot verifier)", accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 429 && attempt < 3) { await sleep(20_000); continue; }
    if (!r.ok) throw new Error(`geckoterminal ${r.status} ${p.split("?")[0]}`);
    return r.json();
  }
};
const pools = new Map();
async function poolOf(mint) {
  if (!pools.has(mint)) {
    const list = (await gecko(`/networks/solana/tokens/${mint}/pools?page=1`)).data ?? [];
    list.sort((a, b) => Number(b.attributes?.reserve_in_usd ?? 0) - Number(a.attributes?.reserve_in_usd ?? 0));
    if (!list.length) throw new Error(`no pool on GeckoTerminal for ${mint}`);
    const top = list[0], base = top.relationships?.base_token?.data?.id ?? "";
    pools.set(mint, { pool: top.id.split("_").slice(1).join("_"), side: base.endsWith(mint) ? "base" : "quote", name: top.attributes?.name });
    await sleep(2500);
  }
  return pools.get(mint);
}
async function closingMedian(mint, date) {
  const { pool, side } = await poolOf(mint);
  const start = utcMidnight(date) + 23 * 3600, end = utcMidnight(date) + 24 * 3600;
  const list = (await gecko(`/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=60&before_timestamp=${end}&currency=usd&token=${side}`)).data?.attributes?.ohlcv_list ?? [];
  await sleep(2500);
  const closes = list.filter((c) => c[0] >= start && c[0] < end && c[4] > 0).map((c) => c[4]);
  if (closes.length < MIN_CANDLES) throw new Error(`only ${closes.length} closing-hour candles for ${date}`);
  const s = [...closes].sort((a, b) => a - b), n = s.length;
  return { median: n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2, candles: n };
}

// ---------- the check ----------
async function independentValue(spec, now, thr) {
  if (spec.kind === "close") {
    const ev = await closeMove(spec.symbol, spec.date, now, thr);
    return ev.ok ? { value: ev.value, detail: `${ev.detail.prevClose} → ${ev.detail.close} (${ev.detail.source}${ev.detail.crossCheck?.agreed ? " + nasdaq" : ""})` } : { error: ev.reason };
  }
  // On mainnet the market account itself says which token it settles on; the app host's symbol → mint map is only
  // needed on devnet, where markets sit on mock mints. Nothing the app host serves can point the check at another coin.
  const mint = CLUSTER === "mainnet" ? spec.mint : await mainnetMintOf(spec.symbol); if (!mint) return { error: `no mainnet mint known for ${spec.symbol}` };
  // own samples first (same rule as the resolver, this host's data)
  const own = chainMove(DATA, mint, spec.symbol, spec.date, now, thr);
  if (own.ok) return { value: own.value, detail: `$${own.detail.baseline} → $${own.detail.close} (own samples ${own.detail.prevSamples}/${own.detail.samples}${own.detail.crossCheck?.agreed ? ", dexscreener agrees" : ""})` };
  if (own.alert && /disagree/.test(own.reason)) return { error: own.reason };            // own two sources split: no verdict
  if (chainClose(DATA, mint, addDays(spec.date, -1)).ok) return { error: own.reason };   // baseline known, today short: wait
  // no baseline of our own (first day): GeckoTerminal candles, sparse for thin tokens
  const prev = await closingMedian(mint, addDays(spec.date, -1)), cur = await closingMedian(mint, spec.date);
  return { value: movePpm(prev.median, cur.median), detail: `$${prev.median} → $${cur.median} (geckoterminal ${pools.get(mint).name}, ${prev.candles}/${cur.candles} candles; no own samples for the baseline day)` };
}

const cfg = await program.account.config.fetch(configPda);
if (!cfg.admin.equals(admin.publicKey)) { console.error(`ADMIN_KEYPAIR ${admin.publicKey.toBase58()} is not the config admin ${cfg.admin.toBase58()}`); process.exit(2); }
const now = Math.floor(Date.now() / 1000);
// Markets are PDAs of their ids (0 … market_count−1): read them by address in batches, which needs no
// getProgramAccounts (not on every RPC plan) and no list from the app host — nothing it says can hide a market.
const marketPda = (id) => PublicKey.findProgramAddressSync([Buffer.from("market"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], program.programId)[0];
const count = cfg.marketCount.toNumber(), proposed = [], sampleList = new Map();
for (let i = 0; i < count; i += 100) {
  const keys = Array.from({ length: Math.min(100, count - i) }, (_, j) => marketPda(i + j));
  const accs = await program.account.market.fetchMultiple(keys);
  accs.forEach((a, j) => {
    if (!a) return;
    if (a.status === 1) proposed.push({ publicKey: keys[j], account: a });
    // every live on-chain-price market's token, for this host's own sampler (sample-prices.mjs TOKENS_FILE): read from
    // the chain, so the app host cannot leave a token out of the verifier's samples
    const sp = a.status <= 1 ? parseMetric(tag(a.metric)) : null;
    if (sp?.kind === "day") sampleList.set(a.mint.toBase58(), { symbol: sp.symbol, market: keys[j].toBase58() });
  });
}
if (CLUSTER === "mainnet") { const f = path.join(DATA, "tokens.json"), tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), tokens: [...sampleList].map(([mint, t]) => ({ mint, ...t })) })); fs.renameSync(tmp, f); }
log(`cluster=${CLUSTER} proposed=${proposed.length}${DRY ? " DRY RUN" : ""}`);
let checked = 0, agreed = 0, voided = 0; const late = [];
async function voidMarket(publicKey) {
  const tx = await program.methods.voidMarket().accounts({ config: configPda, market: publicKey, admin: admin.publicKey }).transaction();
  const { sig, landed } = await sendSigned(conn, tx, [admin]);
  if (!landed) throw new Error("void did not land before its blockhash expired");
  return sig;
}
for (const { publicKey, account: m } of proposed) {
  const key = publicKey.toBase58(), id = m.id.toNumber(), metric = tag(m.metric), spec = parseMetric(metric);
  const windowEnd = m.proposedAt.toNumber() + cfg.disputeWindowSecs.toNumber();
  const done = state[key];
  if (done && done.proposedAt === m.proposedAt.toNumber() && done.verdict !== "pending") continue;   // same proposal, already judged
  if (!spec) { log(`#${id}: unknown metric ${metric}`); continue; }
  const thr = m.thresholds.slice(0, m.nBuckets - 1).map((t) => t.toNumber()), pv = m.proposedValue.toNumber(), pb = m.proposedOutcome;
  let r; try { r = await independentValue({ ...spec, mint: m.mint.toBase58() }, now, thr); } catch (e) { r = { error: String(e?.message ?? e).slice(0, 160) }; }
  checked++;
  if (r.error) {
    log(`#${id} ${metric}: cannot verify yet — ${r.error} (window closes ${new Date(windowEnd * 1000).toISOString()})`);
    // the clock is read again here: a run over many markets takes minutes, and the deadline is a real one
    const act = unverifiedAction({ now: Math.floor(Date.now() / 1000), proposedAt: m.proposedAt.toNumber(), windowEnd, voidUnverified: VOID_UNVERIFIED });
    if (act === "void") {
      log(`#${id} ${metric}: UNVERIFIED with the window closing — voiding, every stake refunded`);
      if (DRY) { log(`  would void #${id}`); continue; }
      try {
        const sig = await voidMarket(publicKey); voided++;
        log(`  VOIDED #${id} ${sig}`);
        notify("⛔ 核對不到,已自動作廢退款", `#${id} ${metric}\n提案 ${pv} ppm → 第 ${pb} 格,但獨立查價到窗快關都沒答案:${r.error}\n沒核對過的結果不放行,已 void,下一輪全額退款。不需處理;若連續發生請看東京取樣(sample-cron)與價源。`, `verify-void:${key}`, 60);
        state[key] = { proposedAt: m.proposedAt.toNumber(), verdict: "voided-unverified", proposed: pv, error: r.error, signature: sig, at: new Date().toISOString() }; saveState();
      } catch (e) {
        log(`  void failed: ${String(e?.message ?? e).slice(0, 160)}`);
        notify("⛔ 核對不到且自動作廢失敗", `#${id} ${metric}\n${String(e?.message ?? e).slice(0, 200)}\n下一輪(10 分內)會自動再試;窗到 ${new Date(windowEnd * 1000).toISOString()},過了就會照提案結算。`, `verify-fail:${key}`, 60);
      }
      continue;
    }
    // say so an hour into the window, not in its last hour (a first-run 429 clears well before that)
    if (act === "report") late.push(`#${id} ${metric}: 提案 ${pv} ppm → 第 ${pb} 格;${r.error}(窗到 ${new Date(windowEnd * 1000).toISOString()})`);
    state[key] = { proposedAt: m.proposedAt.toNumber(), verdict: "pending", error: r.error, at: new Date().toISOString() }; saveState();
    continue;
  }
  const mb = bucketOf(thr, r.value), dist = Math.min(...thr.map((t) => Math.abs(r.value - t)));
  if (mb === pb) {
    agreed++;
    log(`#${id} ${metric}: agrees — proposed ${pv} ppm, independent ${r.value} ppm ${r.detail}, both range ${pb}`);
    state[key] = { proposedAt: m.proposedAt.toNumber(), verdict: "ok", proposed: pv, independent: r.value, at: new Date().toISOString() }; saveState();
    continue;
  }
  if (spec.kind === "day" && dist <= AMBIGUOUS_PPM) {
    log(`#${id} ${metric}: AMBIGUOUS — proposed ${pv} ppm (range ${pb}), independent ${r.value} ppm (range ${mb}) ${r.detail}; ${dist} ppm from a boundary`);
    notify("⚠️ 核對落在邊界", `#${id} ${metric}\n提案 ${pv} ppm → 第 ${pb} 格;獨立查價 ${r.value} ppm → 第 ${mb} 格\n${r.detail}\n離邊界 ${dist} ppm(${(dist / 10000).toFixed(2)}%),兩個 DEX 價源本來就會差一點,照提案結算、沒作廢。僅供知悉,不需處理。`, `verify-amb:${key}`, 720);
    state[key] = { proposedAt: m.proposedAt.toNumber(), verdict: "ambiguous", proposed: pv, independent: r.value, at: new Date().toISOString() }; saveState();
    continue;
  }
  log(`#${id} ${metric}: MISMATCH — proposed ${pv} ppm (range ${pb}), independent ${r.value} ppm (range ${mb}) ${r.detail}`);
  if (DRY) { log(`  would void #${id}`); continue; }
  try {
    const sig = await voidMarket(publicKey); voided++;
    log(`  VOIDED #${id} ${sig}`);
    notify("⛔ 提案與獨立查價不符,已作廢退款", `#${id} ${metric}\n提案 ${pv} ppm → 第 ${pb} 格;獨立查價 ${r.value} ppm → 第 ${mb} 格\n${r.detail}\n已用 admin 金鑰 void,下一輪全額退款。若 app 主機沒被動過,請查價源;若提案者被入侵,先換 proposer 金鑰(scripts/update-config.mjs proposer=…)`, `verify-void:${key}`, 60);
    state[key] = { proposedAt: m.proposedAt.toNumber(), verdict: "voided", proposed: pv, independent: r.value, signature: sig, at: new Date().toISOString() }; saveState();
  } catch (e) {
    log(`  void failed: ${String(e?.message ?? e).slice(0, 160)}`);
    notify("⛔ 提案不符且自動作廢失敗", `#${id} ${metric}\n提案 ${pv} ppm(第 ${pb} 格)vs 獨立 ${r.value} ppm(第 ${mb} 格)\n${String(e?.message ?? e).slice(0, 200)}\n下一輪(10 分內)會自動再試;窗到 ${new Date(windowEnd * 1000).toISOString()}。連續失敗才需要看 admin 金鑰餘額與 RPC。`, `verify-fail:${key}`, 60);
  }
}
// devnet: play money, and nothing the reader could do about a missing price source — the log line is enough
if (late.length && CLUSTER === "mainnet") notify("⚠️ 提案超過 1 小時還沒核對到", `${late.length} 個盤獨立查價還沒答案:\n${late.slice(0, 15).join("\n")}\n每 10 分會重試;到窗關前 45 分仍沒答案就自動作廢退款。僅供知悉,不需處理。`, "verify-late", 360);
log(`done: checked ${checked}, agreed ${agreed}, voided ${voided}, unverifiable ${late.length}`);
