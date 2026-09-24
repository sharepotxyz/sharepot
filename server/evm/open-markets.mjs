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
import { sessions, nyDate, addDays, nextSessionLive } from "../prices.mjs";
import { CHAIN_KEY, chainCfg, walletFor, pot, potAddress, allMarkets, ensureAllowance, send, metricToBytes32, questionHash, Status, publicClient, erc20Abi, explorerTx } from "./chain.mjs";

const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DRY = process.env.DRY_RUN === "1";
const tpl = JSON.parse(fs.readFileSync(process.env.STOCKS ?? new URL("../stock-templates.json", import.meta.url), "utf8"));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const iso = (ts) => new Date(ts * 1000).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !/429|Too Many|fetch failed|timed? ?out|ECONNRESET|503|502|nonce too low|replacement/i.test(String(e?.message ?? e))) throw e;
      await sleep(1000 * 2 ** (i - 1));
    }
  }
}
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
