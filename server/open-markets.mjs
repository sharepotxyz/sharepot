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
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createInitializeMintInstruction, createInitializeMetadataPointerInstruction, getMintLen, ExtensionType, TYPE_SIZE, LENGTH_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MINT_SIZE } from "@solana/spl-token";
import { createInitializeInstruction as createInitializeMetadataInstruction, pack as packMetadata } from "@solana/spl-token-metadata";
import { Keypair, Transaction } from "@solana/web3.js";
import { sessions, nyDate, addDays, nextSessionLive, chainClose, toPico, utcDate, utcMidnight } from "./prices.mjs";
import { readRegistry, writeRegistry, selectedFor, asStock } from "./chain-tokens.mjs";

const { BN } = anchor;
const CLUSTER = process.env.CLUSTER ?? "devnet";
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DRY = process.env.DRY_RUN === "1";
const tplAll = JSON.parse(fs.readFileSync(process.env.STOCKS ?? new URL("./stock-templates.json", import.meta.url), "utf8"));
// stocks (New York sessions) vs tokens that settle on their on-chain price (UTC days): two schedules, handled below in turn
const tpl = { ...tplAll, stocks: tplAll.stocks.filter((s) => s.kind !== "day") };
const preIpo = tplAll.stocks.filter((s) => s.kind === "day");
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
// House prize per market. On a test network a small seed makes an empty pool look alive; on mainnet there is none.
// A parimutuel does not need house money — players are each other's counterparty, and a market nobody takes the other
// side of refunds everyone in full (compute_payout: win_pool == 0 → refund). Seeding there would just be us paying
// players out of the treasury. SEED_MARKETS=1 overrides, for a deliberate promotion funded from fee income.
const SEED_ON = process.env.SEED_MARKETS === "1" || (process.env.SEED_MARKETS !== "0" && CLUSTER !== "mainnet");
const seedShares = (t) => (SEED_ON ? t.seed ?? 0 : 0);
const seedIx = (market, vault, mint, tokenProgram, amount) => program.methods.seedMarket(new BN(amount))
  .accounts({ market, vault, mint, funderToken: getAssociatedTokenAddressSync(mint, signer, false, tokenProgram), funder: signer, tokenProgram });
const opened = [], seeded = [], skipped = [];
for (const s of tpl.stocks) for (const t of s.tokens) {
  const metric = `${s.symbol}.close:${S.date}`;
  try {
    const mint = mintOf(t);
    const seedAmount = Math.round(seedShares(t) * 10 ** t.decimals);
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
    log(`${DRY ? "would open" : "opening"} #${id} ${metric} in ${t.token} (${t.issuer}) thresholds ${s.thresholdsBps.join("/")} bps, seed ${seedShares(t)} ${t.token}`);
    if (DRY) { opened.push(`${metric} ${t.token}`); continue; }
    await withRetry(() => program.methods.createMarket(args).accounts({ config: configPda, market, vault, mint, signer, tokenProgram, systemProgram: SystemProgram.programId }).rpc());
    if (seedAmount > 0) await withRetry(() => seedIx(market, vault, mint, tokenProgram, seedAmount).rpc());
    fs.appendFileSync(path.join(DATA, "markets-opened.jsonl"), JSON.stringify({ at: new Date().toISOString(), id: id.toNumber(), market: market.toBase58(), metric, symbol: s.symbol, token: t.token, issuer: t.issuer, mint: mint.toBase58(), session: S.date, question, thresholdsBps: s.thresholdsBps, openTs: prev.open, closeTs: S.open, resolveAfterTs: S.close + tpl.resolveDelaySecs, seed: seedShares(t) }) + "\n");
    opened.push(`#${id} ${metric} ${t.token}`);
  } catch (e) { skipped.push(`${metric} ${t.token}: failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}`); }
  await sleep(700); // stay under public-RPC burst limits
}
log(`opened ${opened.length}: ${opened.join(", ") || "-"}${seeded.length ? ` · prize added to ${seeded.join(", ")}` : ""}`);
for (const x of skipped) log("skipped", x);

// ---------- on-chain price markets: pre-IPO tokens every day, plus the memes selected for today ----------
// One market per token per UTC day: opens 00:00, stops taking bets 12:00, resolves after 00:05 the next day on the
// median of the closing-hour quotes (prices.mjs chainMove) against the previous day's close, which is written on the
// market as its baseline. No previous close (a token selected last night whose closing hour was not sampled, or a
// sampler outage) → the market is not opened; there is nothing to measure against.
{
  const D = utcDate(now), lock = utcMidnight(D) + 12 * 3600;
  const reg = readRegistry(DATA);
  const memes = selectedFor(reg, D).map((t) => asStock(t.mainnetMint, t, CLUSTER));
  const chainStocks = [...preIpo, ...memes];
  const copened = [], cskipped = [];
  const faucetPk = state?.faucet ? new PublicKey(state.faucet) : null;
  /** Devnet stand-in for a meme: same decimals and token program as the real mint (plus name/symbol metadata on
   *  Token-2022), minted by the proposer, which also stocks the faucet and keeps a seed supply. Recorded in the registry. */
  async function createMock(mainnetMint, t) {
    const kp = Keypair.generate(), mint = kp.publicKey, decimals = t.decimals;
    const t22 = t.tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58();
    const prog = t22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const tx = new Transaction();
    if (t22) {
      const name = `${t.name} (devnet mock)`.slice(0, 32), symbol = t.symbol.slice(0, 10), uri = "";
      const mintLen = getMintLen([ExtensionType.MetadataPointer]);
      const metaLen = TYPE_SIZE + LENGTH_SIZE + packMetadata({ mint, name, symbol, uri, updateAuthority: signer, additionalMetadata: [] }).length;
      tx.add(SystemProgram.createAccount({ fromPubkey: signer, newAccountPubkey: mint, space: mintLen, lamports: await conn.getMinimumBalanceForRentExemption(mintLen + metaLen), programId: prog }),
        createInitializeMetadataPointerInstruction(mint, signer, mint, prog),
        createInitializeMintInstruction(mint, decimals, signer, null, prog),
        createInitializeMetadataInstruction({ programId: prog, metadata: mint, updateAuthority: signer, mint, mintAuthority: signer, name, symbol, uri }));
    } else {
      tx.add(SystemProgram.createAccount({ fromPubkey: signer, newAccountPubkey: mint, space: MINT_SIZE, lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE), programId: prog }),
        createInitializeMintInstruction(mint, decimals, signer, null, prog));
    }
    const unit = 10n ** BigInt(decimals);
    const mine = getAssociatedTokenAddressSync(mint, signer, false, prog);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(signer, mine, signer, mint, prog), createMintToInstruction(mint, mine, signer, BigInt(Math.round((t.seedUi ?? 1) * 400)) * unit, [], prog));
    if (faucetPk) {
      const fa = getAssociatedTokenAddressSync(mint, faucetPk, false, prog);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(signer, fa, faucetPk, mint, prog), createMintToInstruction(mint, fa, signer, BigInt(Math.round((t.faucetUi ?? 1) * 5000)) * unit, [], prog));
    }
    await withRetry(() => provider.sendAndConfirm(tx, [kp]));
    reg.tokens[mainnetMint].mock = mint.toBase58(); writeRegistry(DATA, reg);
    log(`created devnet mock ${t.symbol} ${mint.toBase58()} (${t22 ? "Token-2022" : "SPL"}, ${decimals} decimals); faucet stocked`);
    return mint;
  }
  for (const s of chainStocks) for (const t of s.tokens) {
    const metric = `${s.symbol}.day:${D}`;
    try {
      if (now >= lock) { cskipped.push(`${metric}: past today's 12:00 UTC lock`); continue; }
      let mint = CLUSTER === "mainnet" ? new PublicKey(t.mainnetMint) : t.mint ? new PublicKey(t.mint) : state?.mints?.[t.token] ? new PublicKey(state.mints[t.token]) : null;
      if (!mint && CLUSTER !== "mainnet" && s.category === "memes") { if (DRY) { cskipped.push(`${metric}: would create a devnet mock first`); continue; } mint = await createMock(t.mainnetMint, { ...t, name: s.name, symbol: s.symbol }); }
      if (!mint) { cskipped.push(`${metric}: no mint on ${CLUSTER}`); continue; }
      const seedAmount = Math.round(seedShares(t) * 10 ** t.decimals);
      const have = existing.get(`${metric}|${mint.toBase58()}`);
      if (have) {
        const m = have.account;
        if (m.status === 0 && now < m.closeTs.toNumber() && m.seedAmount.isZero() && seedAmount > 0 && !DRY) {
          const tokenProgram = (await withRetry(() => conn.getAccountInfo(mint))).owner;
          await withRetry(() => seedIx(have.publicKey, m.vault, mint, tokenProgram, seedAmount).rpc());
          seeded.push(`#${m.id} ${t.token}`);
        } else cskipped.push(`${metric}: already open`);
        continue;
      }
      const prevClose = chainClose(DATA, t.mainnetMint, addDays(D, -1));
      if (!prevClose.ok) { cskipped.push(`${metric}: no baseline — ${prevClose.reason}`); continue; }
      const tokenProgram = (await withRetry(() => conn.getAccountInfo(mint))).owner;
      const thresholds = s.thresholdsBps.map((b) => b * 100);
      const id = (await withRetry(() => program.account.config.fetch(configPda))).marketCount;
      const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], program.programId);
      const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], program.programId);
      const question = `${s.symbol} on ${D} (UTC): on-chain close vs the previous day's close — which range? (staked in ${t.token})`;
      const args = {
        metric: Array.from(Buffer.from(metric.padEnd(32, "\0").slice(0, 32))), questionHash: Array.from(createHash("sha256").update(question).digest()),
        thresholds: Array.from({ length: 7 }, (_, i) => new BN(thresholds[i] ?? 0)), nBuckets: thresholds.length + 1,
        openTs: new BN(utcMidnight(D)), closeTs: new BN(lock), resolveAfterTs: new BN(utcMidnight(D) + 86400 + 300), baseline: new BN(toPico(prevClose.close).toString()),
      };
      log(`${DRY ? "would open" : "opening"} #${id} ${metric} in ${t.token} (${t.issuer}) thresholds ${s.thresholdsBps.join("/")} bps, baseline $${prevClose.close} (${prevClose.samples} samples), seed ${seedShares(t)} ${t.token}`);
      if (DRY) { copened.push(`${metric}`); continue; }
      await withRetry(() => program.methods.createMarket(args).accounts({ config: configPda, market, vault, mint, signer, tokenProgram, systemProgram: SystemProgram.programId }).rpc());
      if (seedAmount > 0) await withRetry(() => seedIx(market, vault, mint, tokenProgram, seedAmount).rpc());
      fs.appendFileSync(path.join(DATA, "markets-opened.jsonl"), JSON.stringify({ at: new Date().toISOString(), id: id.toNumber(), market: market.toBase58(), metric, symbol: s.symbol, category: s.category, token: t.token, issuer: t.issuer, mint: mint.toBase58(), mainnetMint: t.mainnetMint, day: D, question, thresholdsBps: s.thresholdsBps, baseline: prevClose.close, openTs: utcMidnight(D), closeTs: lock, resolveAfterTs: utcMidnight(D) + 86400 + 300, seed: seedShares(t) }) + "\n");
      copened.push(`#${id} ${metric}`);
    } catch (e) { cskipped.push(`${metric}: failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}`); }
    await sleep(700);
  }
  log(`on-chain price markets for ${D}: opened ${copened.length}: ${copened.join(", ") || "-"}`);
  for (const x of cskipped) log("skipped", x);
}
