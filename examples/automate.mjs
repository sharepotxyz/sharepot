// SharePot from a script: list the pools you can bet on, place a bet, read the results.
// Everything a bot needs is the public read API plus the on-chain program (bets are signed by your own wallet;
// there is no server-side bet endpoint, so nobody can bet with your tokens but you).
//
//   node examples/automate.mjs markets                 open pools: id, question, ranges, closes in, pool sizes
//   node examples/automate.mjs bet <id> <range> <n>    stake n shares on range index <range> of market <id>
//   node examples/automate.mjs results [wallet]        settled markets and, for a wallet, what it was paid
//
// env: API     (default https://devnet.sharepot.xyz/api)
//      RPC     (default https://api.devnet.solana.com)
//      KEYPAIR (default ~/.config/solana/id.json, the Solana CLI wallet; only `bet` needs it)
// Node 22 and the server's dependencies: `cd server && npm ci` once. On devnet, POST /api/faucet {"address"} hands a
// wallet mock shares of every open pool once a day, so a bot can be tested end to end for free.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dep = (name) => import(createRequire(path.join(here, "../server/package.json")).resolve(name)); // server/node_modules
const { default: anchor } = await dep("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = await dep("@solana/web3.js");
const { getAssociatedTokenAddressSync } = await dep("@solana/spl-token");

const API = process.env.API ?? "https://devnet.sharepot.xyz/api";
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const KEYPAIR = process.env.KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json");
const STATUS = ["open", "proposed", "resolved", "voided", "settled"]; // market.status 0..4
const get = async (p) => { const r = await fetch(API + p); if (!r.ok) throw new Error(`${p}: ${r.status} ${(await r.json().catch(() => ({}))).error ?? ""}`); return r.json(); };
const pct = (ppm) => (ppm / 10_000).toFixed(2) + "%"; // thresholds and observed moves are in ppm: 1 % = 10 000
const shares = (raw, m) => (Number(raw) / 10 ** m.decimals).toFixed(2);
const inH = (ts) => ((ts - Date.now() / 1000) / 3600).toFixed(1) + "h";
// Range names as the site shows them: below the first threshold, between each pair, at or above the last.
const ranges = (m) => Array.from({ length: m.nBuckets }, (_, i) => i === 0 ? `< ${pct(m.thresholds[0])}` : i === m.nBuckets - 1 ? `≥ ${pct(m.thresholds[i - 1])}` : `${pct(m.thresholds[i - 1])} … ${pct(m.thresholds[i])}`);

async function markets() {
  const [{ markets }, { config }] = await Promise.all([get("/markets"), get("/config")]);
  const now = Date.now() / 1000;
  const open = markets.filter((m) => m.status === 0 && now >= m.openTs && now < m.closeTs).sort((a, b) => a.closeTs - b.closeTs);
  console.log(`${open.length} open pools (fee ${config.feeBps / 100}%, min bet ${config.minBet} base units)`);
  for (const m of open) console.log(`#${String(m.id).padStart(4)} ${m.metric.padEnd(26)} closes in ${inH(m.closeTs).padStart(6)}  pools ${m.pools.map((p, i) => `[${i}] ${ranges(m)[i]}: ${shares(p, m)}`).join("  ")}`);
}

async function bet(id, bucket, n) {
  const { market: m } = await get(`/markets/${id}`);
  if (m.status !== 0 || Date.now() / 1000 >= m.closeTs) throw new Error(`market #${id} is ${STATUS[m.status]}, betting closed`);
  if (!(bucket >= 0 && bucket < m.nBuckets)) throw new Error(`range must be 0..${m.nBuckets - 1}: ${ranges(m).join(" | ")}`);
  const amount = BigInt(Math.round(n * 10 ** m.decimals)); // the program takes base units
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const idl = JSON.parse(fs.readFileSync(path.join(here, "../idl/sharepot.json"), "utf8"));
  const programId = new PublicKey(idl.address);
  const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" }));
  const market = new PublicKey(m.pubkey), mint = new PublicKey(m.mint), tokenProgram = new PublicKey(m.tokenProgram), user = kp.publicKey;
  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const ix = await program.methods.placeBet(bucket, new anchor.BN(amount.toString())).accountsPartial({
    config: pda(Buffer.from("config")), market, mint, user, tokenProgram, systemProgram: SystemProgram.programId,
    position: pda(Buffer.from("position"), market.toBuffer(), user.toBuffer()), // one position per wallet per market; a second bet adds to it
    vault: pda(Buffer.from("vault"), market.toBuffer()),
    userToken: getAssociatedTokenAddressSync(mint, user, false, tokenProgram),
  }).instruction();
  const tx = new Transaction().add(ix);
  tx.feePayer = user;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 }); // resending the same bytes can never double a bet
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`bet ${n} shares on range ${bucket} (${ranges(m)[bucket]}) of #${id} ${m.metric}: ${sig}`);
}

async function results(wallet) {
  const { markets } = await get("/markets");
  const done = markets.filter((m) => m.status === 2 || m.status === 4).sort((a, b) => b.id - a.id).slice(0, 15);
  for (const m of done) console.log(`#${String(m.id).padStart(4)} ${m.metric.padEnd(26)} ${STATUS[m.status].padEnd(8)} moved ${pct(m.proposedValue).padStart(7)} → range ${m.outcome} (${ranges(m)[m.outcome]})  evidence ${API}/evidence/${m.id}`);
  if (!wallet) return;
  const { settled } = await get(`/positions/${wallet}`); // every payout the crank pushed to that wallet, newest first
  for (const s of settled.slice(0, 15)) console.log(`#${String(s.id).padStart(4)} ${s.metric.padEnd(26)} ${s.kind.padEnd(8)} paid ${(Number(s.payout) / 10 ** s.decimals).toFixed(2)} ${s.token}  ${s.signature}`);
}

const [cmd, ...a] = process.argv.slice(2);
const help = async () => console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 14).join("\n"));
try { await ({ markets, bet: () => bet(Number(a[0]), Number(a[1]), Number(a[2])), results: () => results(a[0]) }[cmd] ?? help)(); }
catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
