// Keeps exactly one market per listed token open for betting. The market for New York trading session S opens at the
// previous session's opening bell and stops taking bets at S's opening bell; it resolves on S's official close vs the
// previous session's close (resolve.mjs). A stock listed by several issuers gets one pool per token — the tokens are
// not interchangeable — all with the stock's thresholds. Session times come from the NYSE calendar in prices.mjs.
// Idempotent — run it every 15–30 minutes from cron: it opens what is missing and adds the opening prize to any open
// market that does not have it yet (e.g. when a rate-limited RPC cut the previous run short).
//   env: ANCHOR_PROVIDER_URL, ANCHOR_WALLET (operator or proposer), CLUSTER=devnet|mainnet, STATE (devnet mock mints),
//        DATA_DIR, DRY_RUN=1, STOCKS=path
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { sessions, nyDate, addDays, nextSessionLive } from "./prices.mjs";

const { BN } = anchor;
const CLUSTER = process.env.CLUSTER ?? "devnet";
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DRY = process.env.DRY_RUN === "1";
const tpl = JSON.parse(fs.readFileSync(process.env.STOCKS ?? new URL("./stock-templates.json", import.meta.url), "utf8"));
const idl = JSON.parse(fs.readFileSync(new URL("../idl/sharepot.json", import.meta.url), "utf8"));
const state = CLUSTER === "mainnet" ? null : JSON.parse(fs.readFileSync(process.env.STATE ?? "/root/stocklana/secrets/devnet/state.json", "utf8"));
const mintOf = (t) => new PublicKey(CLUSTER === "mainnet" ? t.mainnetMint : state.mints[t.token]);
const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const signer = provider.wallet.publicKey;
const conn = provider.connection;
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const tag = (b) => Buffer.from(b).toString("utf8").replace(/\0+$/, "");
const iso = (ts) => new Date(ts * 1000).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Public RPCs rate-limit bursts; retry transient failures with backoff, surface everything else.
async function withRetry(fn, tries = 5) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !/429|Too Many|fetch failed|timed? ?out|ECONNRESET|503|502|Blockhash not found/i.test(String(e?.message ?? e))) throw e;
      await sleep(1000 * 2 ** (i - 1));
    }
  }
}
fs.mkdirSync(DATA, { recursive: true });

const now = Math.floor(Date.now() / 1000);
const today = nyDate(now);
const cal = await sessions(addDays(today, -7), addDays(today, 14));
const idx = cal.findIndex((s) => s.open > now);
if (idx < 1) throw new Error(`calendar has no session around ${today}`);
let S = cal[idx], prev = cal[idx - 1];
// Cross-check with the live exchange status: on a mismatch (an unscheduled closure, or a table error) follow Nasdaq.
try {
  const live = await withRetry(() => nextSessionLive(now), 3);
  if (live.date !== S.date) {
    log(`⚠ CALENDAR MISMATCH: table says the next session is ${S.date}, Nasdaq says ${live.date} — following Nasdaq`);
    S = cal.find((s) => s.date === live.date) ?? { date: live.date, open: live.open, close: live.close };
    prev = cal.filter((s) => s.date < S.date && (!live.previous || s.date <= live.previous)).at(-1) ?? prev;
  } else log(`calendar check: Nasdaq agrees the next session is ${S.date}`);
} catch (e) { log(`calendar check skipped (Nasdaq unavailable: ${String(e?.message ?? e).slice(0, 80)}) — using the exchange table`); }
log(`next session ${S.date} opens ${iso(S.open)}; betting window ${iso(prev.open)} → ${iso(S.open)}; resolves after ${iso(S.close + tpl.resolveDelaySecs)}`);

// one market per (session, token): key on metric + mint, since every token of a stock shares the metric
const existing = new Map((await withRetry(() => program.account.market.all([{ dataSize: program.account.market.size }])))
  .map((x) => [`${tag(x.account.metric)}|${x.account.mint.toBase58()}`, x]));
const seedIx = (market, vault, mint, tokenProgram, amount) => program.methods.seedMarket(new BN(amount))
  .accounts({ market, vault, mint, funderToken: getAssociatedTokenAddressSync(mint, signer, false, tokenProgram), funder: signer, tokenProgram });
const opened = [], seeded = [], skipped = [];
for (const s of tpl.stocks) for (const t of s.tokens) {
  const metric = `${s.symbol}.close:${S.date}`;
  try {
    const mint = mintOf(t);
    const seedAmount = Math.round(t.seed * 10 ** t.decimals);
    const have = existing.get(`${metric}|${mint.toBase58()}`);
    if (have) {
      // already open: only make sure it carries its opening prize
      const m = have.account;
      if (m.status === 0 && now < m.closeTs.toNumber() && m.seedAmount.isZero() && seedAmount > 0 && !DRY) {
        const tokenProgram = (await withRetry(() => conn.getAccountInfo(mint))).owner;
        await withRetry(() => seedIx(have.publicKey, m.vault, mint, tokenProgram, seedAmount).rpc());
        seeded.push(`#${m.id} ${t.token}`);
      } else skipped.push(`${metric} ${t.token}: already open`);
      continue;
    }
    const tokenProgram = (await withRetry(() => conn.getAccountInfo(mint))).owner;
    const thresholds = s.thresholdsBps.map((b) => b * 100); // ppm
    const id = (await withRetry(() => program.account.config.fetch(configPda))).marketCount;
    const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], program.programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], program.programId);
    const question = `${s.symbol} on ${S.date}: official close vs the previous close — which range? (staked in ${t.token})`;
    const args = {
      metric: Array.from(Buffer.from(metric.padEnd(32, "\0").slice(0, 32))), questionHash: Array.from(createHash("sha256").update(question).digest()),
      thresholds: Array.from({ length: 7 }, (_, i) => new BN(thresholds[i] ?? 0)), nBuckets: thresholds.length + 1,
      openTs: new BN(prev.open), closeTs: new BN(S.open), resolveAfterTs: new BN(S.close + tpl.resolveDelaySecs), baseline: new BN(0),
    };
    log(`${DRY ? "would open" : "opening"} #${id} ${metric} in ${t.token} (${t.issuer}) thresholds ${s.thresholdsBps.join("/")} bps, seed ${t.seed} ${t.token}`);
    if (DRY) { opened.push(`${metric} ${t.token}`); continue; }
    await withRetry(() => program.methods.createMarket(args).accounts({ config: configPda, market, vault, mint, signer, tokenProgram, systemProgram: SystemProgram.programId }).rpc());
    if (seedAmount > 0) await withRetry(() => seedIx(market, vault, mint, tokenProgram, seedAmount).rpc());
    fs.appendFileSync(path.join(DATA, "markets-opened.jsonl"), JSON.stringify({ at: new Date().toISOString(), id: id.toNumber(), market: market.toBase58(), metric, symbol: s.symbol, token: t.token, issuer: t.issuer, mint: mint.toBase58(), session: S.date, question, thresholdsBps: s.thresholdsBps, openTs: prev.open, closeTs: S.open, resolveAfterTs: S.close + tpl.resolveDelaySecs, seed: t.seed }) + "\n");
    opened.push(`#${id} ${metric} ${t.token}`);
  } catch (e) { skipped.push(`${metric} ${t.token}: failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}`); }
  await sleep(700); // stay under public-RPC burst limits
}
log(`opened ${opened.length}: ${opened.join(", ") || "-"}${seeded.length ? ` · prize added to ${seeded.join(", ")}` : ""}`);
for (const x of skipped) log("skipped", x);
