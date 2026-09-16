// Wash-trading audit for the leaderboard.
//
// Points reward stake × pot, so the cheapest way to farm them is to bet both sides of a thin market from two wallets
// you control: the money comes back minus the fee on the winning side, and both wallets score. The formula is not
// tightened to stop that — it would punish honest players in thin markets too. Instead this runs after the fact and
// flags clusters, exactly like the referral audit on our other site.
//
// Three signals, all from data we already have plus one RPC lookup:
//   1. recurring opposition — wallets X and Y take different ranges of the SAME market, again and again. Two honest
//      players disagree once or twice; a pair that mirrors each other in market after market is one person.
//   2. shared funding — the wallets were first funded by the same address. KNOWN FUNDERS ARE EXCLUDED: on devnet the
//      faucet funds everybody, so without that exclusion every player looks like every other player's sock puppet.
//   3. private markets — the pair WAS the whole market (nobody else was in it), repeatedly. Real users do not keep
//      finding a public market whose only other player is the same person.
//
// A fourth signal was tried and dropped: "their combined net P&L is about zero". In a parimutuel any two opposing
// players are zero-sum minus the fee, so an honest pair scores identically to a wash pair — it separates nothing.
// Verified against synthetic data before it went in.
//
// Only shared funding is hard evidence, so only that bans. The structural signals raise a pair to `review` for a human
// to look at: two honest players CAN be the only two in a thin market. `--apply` writes the bans to
// data/points-bans.json, which the leaderboard subtracts.
//
//   node scripts/points-audit.mjs [--apply] [--min-pairs=3] [--data=DIR] [--rpc=URL] [--include-bots]
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { leaderboard, readSettlements, readBans } from "../server/points.mjs";

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const APPLY = process.argv.includes("--apply");
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
    verdict: sharedFunder ? "ban" : alone >= MIN_PAIRS ? "review" : "watch",
    why: [`opposed each other in ${s2.markets.length} thin markets`, alone ? `were the only two players in ${alone} of them` : null, sharedFunder ? `both first funded by ${sharedFunder}` : null].filter(Boolean).join("; "),
  });
}
const RANK = { ban: 0, review: 1, watch: 2 };
findings.sort((x, y) => RANK[x.verdict] - RANK[y.verdict] || y.markets - x.markets);

const out = { at: new Date().toISOString(), rows: rows.length, markets: byMarket.size, pairsChecked: pairs.size, ignoredFunders: [...ignore], findings };
fs.writeFileSync(path.join(DATA, "points-audit.json"), JSON.stringify(out, null, 2));
console.log(`${rows.length} settlements · ${byMarket.size} markets · ${findings.length} suspicious pairs (${findings.filter((f) => f.verdict === "ban").length} would be banned)`);
for (const f of findings) console.log(`  [${f.verdict}] ${f.wallets.map((w) => w.slice(0, 6) + "…").join(" ↔ ")}  ${f.why}`);

if (APPLY) {
  const bans = readBans(DATA);
  for (const f of findings.filter((x) => x.verdict === "ban")) for (const w of f.wallets) bans[w] = bans[w] ?? f.why;
  fs.writeFileSync(path.join(DATA, "points-bans.json"), JSON.stringify({ at: new Date().toISOString(), wallets: bans }, null, 2));
  console.log(`applied: ${Object.keys(bans).length} wallets excluded from the leaderboard`);
} else if (findings.some((f) => f.verdict === "ban")) {
  console.log("re-run with --apply to exclude them from the leaderboard");
}
