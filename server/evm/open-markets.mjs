// Keeps exactly one market per listed stock token open for betting on the EVM deployment — the same schedule as
// server/open-markets.mjs on Solana: the market for New York session S opens at the previous session's opening bell
// and stops taking bets at S's opening bell; it resolves on S's official close vs the previous session's close.
// Idempotent — run it every 15–30 minutes from cron: it opens what is missing and adds the opening prize to any open
// market that does not have it yet.
//   env: EVM_CHAIN, EVM_PROPOSER_KEY_FILE (chain.mjs), DATA_DIR, DRY_RUN=1, SEED_MARKETS=0|1, STOCKS=path (templates,
//        only for resolveDelaySecs)
import fs from "node:fs";
import path from "node:path";
import { parseUnits } from "viem";
import { sessions, nyDate, addDays, nextSessionLive, utcDate, utcMidnight, chainClose } from "../prices.mjs";
import { withRetry, guardProcess } from "../retry.mjs";
import { readRegistry, writeRegistry, selectedFor } from "../chain-tokens.mjs";
import { CHAIN_KEY, chainCfg, walletFor, pot, potAddress, allMarkets, ensureAllowance, send, metricToBytes32, questionHash, Status, publicClient, erc20Abi, explorerTx } from "./chain.mjs";
import { evmDir } from "./index-events.mjs";

const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DRY = process.env.DRY_RUN === "1";
const tpl = JSON.parse(fs.readFileSync(process.env.STOCKS ?? new URL("../stock-templates.json", import.meta.url), "utf8"));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const iso = (ts) => new Date(ts * 1000).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
guardProcess(log);   // an uncaught error (e.g. a torn RPC batch while listing markets) ends the run in one line, not a stack dump
fs.mkdirSync(path.join(DATA, "evm", CHAIN_KEY), { recursive: true });

const wallet = DRY ? null : walletFor();
const p = pot(wallet ?? undefined);
const now = Math.floor(Date.now() / 1000);
const today = nyDate(now);
const cal = await sessions(addDays(today, -7), addDays(today, 14));
const idx = cal.findIndex((s) => s.open > now);
if (idx < 1) throw new Error(`calendar has no session around ${today}`);
let S = cal[idx], prev = cal[idx - 1];
try {
  const live = await withRetry(() => nextSessionLive(now), 3);
  if (live.date !== S.date) {
    log(`⚠ CALENDAR MISMATCH: table says the next session is ${S.date}, Nasdaq says ${live.date} — following Nasdaq`);
    S = cal.find((s) => s.date === live.date) ?? { date: live.date, open: live.open, close: live.close };
    prev = cal.filter((s) => s.date < S.date && (!live.previous || s.date <= live.previous)).at(-1) ?? prev;
  } else log(`calendar check: Nasdaq agrees the next session is ${S.date}`);
} catch (e) { log(`calendar check skipped (Nasdaq unavailable: ${String(e?.message ?? e).slice(0, 80)}) — using the exchange table`); }
log(`${CHAIN_KEY}: next session ${S.date} opens ${iso(S.open)}; betting window ${iso(prev.open)} → ${iso(S.open)}; resolves after ${iso(S.close + tpl.resolveDelaySecs)}`);

const existing = new Map((await allMarkets(p)).map((m) => [`${m.metric}|${m.token.toLowerCase()}`, m]));
// House prize per market: only on a test network (see server/open-markets.mjs for why mainnet has none).
const SEED_ON = process.env.SEED_MARKETS === "1";   // no house prize unless asked for (see server/open-markets.mjs)
const seedRaw = (s) => (SEED_ON && s.seed ? parseUnits(String(s.seed), s.decimals) : 0n);
async function seed(id, s, amount) {
  const have = await publicClient.readContract({ address: s.token, abi: erc20Abi, functionName: "balanceOf", args: [wallet.account.address] });
  if (have < amount) { log(`  no prize for #${id}: proposer holds ${have} raw ${s.symbol} < ${amount} (faucet: ${chainCfg.faucet ?? "-"})`); return false; }
  await ensureAllowance(wallet, s.token, potAddress(), amount);
  const { hash } = await withRetry(() => send(wallet, "seedMarket", [BigInt(id), amount]));
  log(`  seeded #${id} with ${s.seed} ${s.symbol} ${explorerTx(hash)}`);
  return true;
}

const opened = [], seeded = [], skipped = [];
for (const s of chainCfg.stocks) {
  const metric = `${s.symbol}.close:${S.date}`;
  try {
    if (!Array.isArray(s.thresholdsBps)) { skipped.push(`${metric}: no thresholds in chains.json`); continue; }
    const amount = seedRaw(s);
    const have = existing.get(`${metric}|${s.token.toLowerCase()}`);
    if (have) {
      if (have.status === Status.Open && now < have.closeTs && have.seedAmount === "0" && amount > 0n && !DRY) { if (await seed(have.id, s, amount)) seeded.push(`#${have.id} ${s.symbol}`); }
      else skipped.push(`${metric}: already open`);
      continue;
    }
    const thresholds = s.thresholdsBps.map((b) => b * 100); // ppm
    const question = `${s.symbol} on ${S.date}: official close vs the previous close — which range? (staked in ${s.symbol} on ${chainCfg.name})`;
    const args = { token: s.token, metric: metricToBytes32(metric), questionHash: questionHash(question), thresholds: Array.from({ length: 7 }, (_, i) => BigInt(thresholds[i] ?? 0)), nBuckets: thresholds.length + 1,
      openTs: BigInt(prev.open), closeTs: BigInt(S.open), resolveAfterTs: BigInt(S.close + tpl.resolveDelaySecs), baseline: 0n };
    log(`${DRY ? "would open" : "opening"} ${metric} in ${s.symbol} thresholds ${s.thresholdsBps.join("/")} bps, seed ${SEED_ON ? s.seed ?? 0 : 0}`);
    if (DRY) { opened.push(metric); continue; }
    const { hash, receipt } = await withRetry(() => send(wallet, "createMarket", [args]));
    const id = Number(await p.read.marketCount()) - 1;
    fs.appendFileSync(path.join(DATA, "evm", CHAIN_KEY, "markets-opened.jsonl"), JSON.stringify({ at: new Date().toISOString(), id, metric, symbol: s.symbol, token: s.token, issuer: s.issuer, session: S.date, question, thresholdsBps: s.thresholdsBps, openTs: prev.open, closeTs: S.open, resolveAfterTs: S.close + tpl.resolveDelaySecs, seed: SEED_ON ? s.seed ?? 0 : 0, tx: hash, block: Number(receipt.blockNumber) }) + "\n");
    opened.push(`#${id} ${metric}`);
    if (amount > 0n && (await seed(id, s, amount))) seeded.push(`#${id} ${s.symbol}`);
  } catch (e) { skipped.push(`${metric}: failed: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 200)}`); }
}
log(`opened ${opened.length}: ${opened.join(", ") || "-"}${seeded.length ? ` · prize added to ${seeded.join(", ")}` : ""}`);
for (const x of skipped) log("skipped", x);

// ---------- on-chain price markets: the memes select-chain.mjs picked, one market per UTC day ----------
// Same schedule as the Solana memes (server/open-markets.mjs): day D's market opens at D−1 11:00 UTC, stops taking
// bets at D 12:00 UTC and resolves after D+1 00:05 on the median of D's closing-hour quotes vs D−1's. The memes
// trade on Robinhood Chain mainnet; on the testnet each one is stood in for by a MockStock the proposer deploys
// once (recorded in the registry as `mock`), which anyone can mint from the faucet page.
{
  const DIR = evmDir(DATA), TESTNET = chainCfg.test === true;   // chains.json: a test network stands memes in with mocks
  const reg = readRegistry(DIR);
  const copened = [], cskipped = [];
  const mockAbi = JSON.parse(fs.readFileSync(new URL("../../evm/abi/MockStock.json", import.meta.url), "utf8"));
  const mockCode = fs.readFileSync(new URL("../../evm/abi/MockStock.bin", import.meta.url), "utf8").trim();
  async function createMock(addr, t) {
    const hash = await wallet.client.deployContract({ abi: mockAbi, bytecode: mockCode, args: [`${t.name} (testnet mock)`.slice(0, 64), String(t.symbol).slice(0, 16), Number(t.decimals)] });
    const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rc.status !== "success" || !rc.contractAddress) throw new Error(`mock deployment failed ${hash}`);
    reg.tokens[addr].mock = rc.contractAddress; writeRegistry(DIR, reg);
    log(`created testnet mock ${t.symbol} ${rc.contractAddress} (${t.decimals} decimals) ${explorerTx(hash)}`);
    return rc.contractAddress;
  }
  for (const D of [utcDate(now), addDays(utcDate(now), 1)]) {
    const openTs = utcMidnight(D) - 13 * 3600, lock = utcMidnight(D) + 12 * 3600;
    if (now >= lock) { cskipped.push(`${D}: past its 12:00 UTC lock`); continue; }
    if (now < openTs) { cskipped.push(`${D}: opens at ${new Date(openTs * 1000).toISOString()}`); continue; }
    for (const t of selectedFor(reg, D)) {
      const metric = `${t.symbol}.day:${D}`;
      try {
        let token = TESTNET ? t.mock : t.mainnetMint;
        if (!token) { if (DRY) { cskipped.push(`${metric}: would create a testnet mock first`); continue; } token = await createMock(t.mainnetMint, t); }
        if (existing.get(`${metric}|${token.toLowerCase()}`)) { cskipped.push(`${metric}: already open`); continue; }
        const thresholds = t.thresholdsBps.map((b) => b * 100);
        const question = `${t.symbol} on ${D} (UTC): on-chain close vs the previous day's close — which range? (staked in ${t.symbol} on ${chainCfg.name})`;
        const args = { token, metric: metricToBytes32(metric), questionHash: questionHash(question), thresholds: Array.from({ length: 7 }, (_, i) => BigInt(thresholds[i] ?? 0)), nBuckets: thresholds.length + 1,
          openTs: BigInt(openTs), closeTs: BigInt(lock), resolveAfterTs: BigInt(utcMidnight(D) + 86400 + 300), baseline: 0n };
        const prevClose = chainClose(DIR, t.mainnetMint, addDays(D, -1));
        log(`${DRY ? "would open" : "opening"} ${metric} in ${t.symbol} thresholds ${t.thresholdsBps.join("/")} bps, previous close ${prevClose.ok ? `$${prevClose.close}` : "not known yet"}`);
        if (DRY) { copened.push(metric); continue; }
        const { hash, receipt } = await withRetry(() => send(wallet, "createMarket", [args]));
        const id = Number(await p.read.marketCount()) - 1;
        fs.appendFileSync(path.join(DATA, "evm", CHAIN_KEY, "markets-opened.jsonl"), JSON.stringify({ at: new Date().toISOString(), id, metric, symbol: t.symbol, category: "memes", token, mainnetToken: t.mainnetMint, issuer: t.issuer, day: D, question, thresholdsBps: t.thresholdsBps, openTs, closeTs: lock, resolveAfterTs: utcMidnight(D) + 86400 + 300, seed: 0, tx: hash, block: Number(receipt.blockNumber) }) + "\n");
        copened.push(`#${id} ${metric}`);
      } catch (e) { cskipped.push(`${metric}: failed: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 200)}`); }
    }
  }
  log(`on-chain price markets: opened ${copened.length}: ${copened.join(", ") || "-"}`);
  for (const x of cskipped) log("skipped", x);
}
