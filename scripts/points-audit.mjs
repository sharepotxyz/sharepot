// Concentration report for the leaderboard. It bans nobody.
//
// Points are stake × pot, so cycling your own money through a market from two wallets scores well. That is NOT treated
// as abuse: on the ledger it is indistinguishable from two honest players taking opposite ranges — the same fee is
// paid into the treasury, the same pool depth is created, the same points are scored. Someone washing their own money
// is a paying customer, and the fee arrives as real stock either way.
//
// What it does distort is concentration. Their fee cost grows linearly with capital, while points grow quadratically,
// because a self-dealing pair owns BOTH the stake and the pot; an honest player only owns the stake. So this report
// exists to show how much of the board is self-dealt, to be read before any decision that spends the points.
//
// Two signals:
//   1. recurring opposition — wallets X and Y take different ranges of the SAME thin market, again and again.
//   2. shared funding — both were first funded by the same address. KNOWN FUNDERS ARE EXCLUDED: on devnet the faucet
//      funds everybody, so without that exclusion every player looks like every other player's sock puppet.
//   3. private markets — the pair WAS the whole market, repeatedly.
//
// A fourth signal was tried and dropped: "their combined net P&L is about zero". In a parimutuel any two opposing
// players are zero-sum minus the fee, so an honest pair scores identically to a wash pair — it separates nothing.
//
// Output is data/points-audit.json. The leaderboard only ever excludes wallets listed in data/points-bans.json, which
// nothing writes automatically — a human writes it, for an actual exploit, not for cycling one's own money.
//
//   node scripts/points-audit.mjs [--min-pairs=3] [--data=DIR] [--rpc=URL] [--include-bots]
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { leaderboard, readSettlements } from "../server/points.mjs";

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DATA = arg("data", process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
const RPC = arg("rpc", process.env.CLUSTER_RPC ?? "https://api.devnet.solana.com");
const MIN_PAIRS = Number(arg("min-pairs", 3));           // markets a pair must mirror each other in
const conn = new Connection(RPC, "confirmed");
const rows = readSettlements(DATA);
if (!rows.length) { console.log("no settlements yet — nothing to audit"); process.exit(0); }

// Addresses that fund many wallets legitimately (faucet, cranker, deployer). Auto-loaded from the secrets dir when
// present, extendable via data/points-audit-ignore.json.
const ignore = new Set();
for (const f of ["faucet.json", "proposer.json"]) {
  try {
    const kp = JSON.parse(fs.readFileSync(path.join(process.env.SHAREPOT_SECRETS ?? "/root/stocklana/secrets/devnet", f), "utf8"));
    // secret keys are 64 bytes: the last 32 are the public key
    ignore.add(new PublicKey(Uint8Array.from(kp).slice(32)).toBase58());
  } catch {}
}
try { for (const a of JSON.parse(fs.readFileSync(path.join(DATA, "points-audit-ignore.json"), "utf8"))) ignore.add(a); } catch {}

// ---------- signal 1: recurring opposition ----------
// Per market, each wallet's dominant range (where most of its stake sat).
const byMarket = new Map();
for (const r of rows) {
  const stakes = r.amounts.map(Number);
  const top = stakes.indexOf(Math.max(...stakes));
  const total = stakes.reduce((a, b) => a + b, 0);
  if (!total) continue;
  const m = byMarket.get(String(r.id)) ?? new Map();
  const cur = m.get(r.owner) ?? { bucket: top, stake: 0 };
  m.set(r.owner, { bucket: top, stake: cur.stake + total });
  byMarket.set(String(r.id), m);
}
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const pairs = new Map();
for (const [id, m] of byMarket) {
  const es = [...m.entries()];
  for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
    if (es[i][1].bucket === es[j][1].bucket) continue;
    const k = pairKey(es[i][0], es[j][0]);
    const p = pairs.get(k) ?? { markets: [], stakeUsdish: 0 };
    p.markets.push(id);
    pairs.set(k, p);
  }
}
// A pair only matters if they oppose each other in several markets AND those markets had few other players:
// in a busy market everyone opposes everyone, which says nothing.
const THIN = 4;   // distinct wallets in the market
const suspect = [...pairs.entries()]
  .map(([k, p]) => ({ wallets: k.split("|"), markets: p.markets.filter((id) => byMarket.get(id).size <= THIN) }))
  .filter((p) => p.markets.length >= MIN_PAIRS);

// ---------- signal 3: the pair was the whole market ----------
const board = leaderboard(rows, { decimals: () => null, usd: () => null }, {}, 0);
const stats = new Map(board.entries.concat(board.banned).map((e) => [e.wallet, e]));

// ---------- signal 2: shared funding ----------
// The oldest transaction that credited the wallet, minus the known funders.
const funderCache = new Map();
async function funderOf(wallet) {
  if (funderCache.has(wallet)) return funderCache.get(wallet);
  let funder = null;
  try {
    const pk = new PublicKey(wallet);
    const sigs = await conn.getSignaturesForAddress(pk, { limit: 1000 });
    const oldest = sigs.at(-1);
    if (oldest) {
      const tx = await conn.getParsedTransaction(oldest.signature, { maxSupportedTransactionVersion: 0 });
      const keys = tx?.transaction?.message?.accountKeys ?? [];
      const idx = keys.findIndex((k) => k.pubkey.toBase58() === wallet);
      const pre = tx?.meta?.preBalances ?? [], post = tx?.meta?.postBalances ?? [];
      if (idx >= 0 && post[idx] > pre[idx]) {
        // whoever paid: the signer whose lamports went down the most
        let best = null;
        keys.forEach((k, i) => { const d = (pre[i] ?? 0) - (post[i] ?? 0); if (k.signer && d > 0 && (!best || d > best.d)) best = { a: k.pubkey.toBase58(), d }; });
        funder = best?.a ?? null;
      }
    }
  } catch (e) { console.error(`  funder lookup failed for ${wallet.slice(0, 8)}…: ${String(e?.message ?? e).slice(0, 80)}`); }
  if (funder && ignore.has(funder)) funder = null;   // faucet / cranker: tells us nothing
  funderCache.set(wallet, funder);
  return funder;
}

const BOTS = new Set(process.argv.includes("--include-bots") ? [] : (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, "bot-wallets.json"), "utf8")); } catch { return []; }
})());
const findings = [];
for (const s2 of suspect) {
  const [a, b] = s2.wallets;
  if (BOTS.has(a) || BOTS.has(b)) continue;   // the demo bots are labelled on the board, not audited
  const [fa, fb] = [await funderOf(a), await funderOf(b)];
  const sharedFunder = fa && fb && fa === fb ? fa : null;
  // markets where these two were the only participants
  const alone = s2.markets.filter((id) => byMarket.get(id).size === 2).length;
  findings.push({
    wallets: s2.wallets, markets: s2.markets.length, aloneMarkets: alone, marketIds: s2.markets.slice(0, 20),
    sharedFunder,
    points: s2.wallets.map((w) => stats.get(w)?.points ?? 0),
    verdict: sharedFunder ? "self-dealt" : alone >= MIN_PAIRS ? "likely self-dealt" : "noted",
    why: [`opposed each other in ${s2.markets.length} thin markets`, alone ? `were the only two players in ${alone} of them` : null, sharedFunder ? `both first funded by ${sharedFunder}` : null].filter(Boolean).join("; "),
  });
}
const RANK = { "self-dealt": 0, "likely self-dealt": 1, noted: 2 };
findings.sort((x, y) => RANK[x.verdict] - RANK[y.verdict] || y.markets - x.markets);

const out = { at: new Date().toISOString(), rows: rows.length, markets: byMarket.size, pairsChecked: pairs.size, ignoredFunders: [...ignore], findings };
fs.writeFileSync(path.join(DATA, "points-audit.json"), JSON.stringify(out, null, 2));
console.log(`${rows.length} settlements · ${byMarket.size} markets · ${findings.length} opposing pairs (${findings.filter((f) => f.verdict !== "noted").length} look self-dealt)`);
for (const f of findings) console.log(`  [${f.verdict}] ${f.wallets.map((w) => w.slice(0, 6) + "…").join(" ↔ ")}  ${f.why}`);
// How much of the board this accounts for: points held by wallets in a self-dealt pair, against the whole board.
const selfDealt = new Set(findings.filter((f) => f.verdict !== "noted").flatMap((f) => f.wallets));
const totalPoints = board.entries.reduce((a, e) => a + e.points, 0);
const theirPoints = board.entries.filter((e) => selfDealt.has(e.wallet)).reduce((a, e) => a + e.points, 0);
if (totalPoints > 0) console.log(`self-dealt wallets hold ${((theirPoints / totalPoints) * 100).toFixed(1)}% of all points`);
