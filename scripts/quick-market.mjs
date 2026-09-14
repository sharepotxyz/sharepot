// Test networks only: open a short market on a PAST trading session, so the whole cycle — bet, resolve from the real
// official close, dispute window, payout — can be watched in minutes instead of waiting for tonight's close.
//   TOKEN=TSLAx SESSION=2026-09-11 BET_SECS=120 CLUSTER=devnet ANCHOR_PROVIDER_URL=… ANCHOR_WALLET=… STATE=… node scripts/quick-market.mjs
import fs from "node:fs";
import { createHash } from "node:crypto";
import anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const { BN } = anchor;
if ((process.env.CLUSTER ?? "devnet") === "mainnet") throw new Error("quick markets are for test networks only");
const TOKEN = process.env.TOKEN ?? "TSLAx", SESSION = process.env.SESSION, BET_SECS = Number(process.env.BET_SECS ?? 120);
if (!/^\d{4}-\d{2}-\d{2}$/.test(SESSION ?? "")) throw new Error("SESSION=YYYY-MM-DD (a past trading day) is required");
const tpl = JSON.parse(fs.readFileSync(new URL("../server/stock-templates.json", import.meta.url), "utf8"));
const s = tpl.stocks.find((x) => x.tokens.some((t) => t.token === TOKEN)); if (!s) throw new Error("unknown token " + TOKEN);
const t = s.tokens.find((x) => x.token === TOKEN);
const state = JSON.parse(fs.readFileSync(process.env.STATE ?? "/root/stocklana/secrets/devnet/state.json", "utf8"));
const idl = JSON.parse(fs.readFileSync(new URL("../idl/sharepot.json", import.meta.url), "utf8"));
const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const signer = provider.wallet.publicKey;
const mint = new PublicKey(state.mints[TOKEN]), tokenProgram = (await provider.connection.getAccountInfo(mint)).owner;
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const id = (await program.account.config.fetch(configPda)).marketCount;
const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], program.programId);
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], program.programId);
const now = Math.floor(Date.now() / 1000), metric = `${s.symbol}.close:${SESSION}`;
const thresholds = s.thresholdsBps.map((b) => b * 100);
await program.methods.createMarket({
  metric: Array.from(Buffer.from(metric.padEnd(32, "\0"))), questionHash: Array.from(createHash("sha256").update(`[replay] ${metric} ${TOKEN}`).digest()),
  thresholds: Array.from({ length: 7 }, (_, i) => new BN(thresholds[i] ?? 0)), nBuckets: thresholds.length + 1,
  openTs: new BN(now - 5), closeTs: new BN(now + BET_SECS), resolveAfterTs: new BN(now + BET_SECS + 5), baseline: new BN(0),
}).accounts({ config: configPda, market, vault, mint, signer, tokenProgram, systemProgram: SystemProgram.programId }).rpc();
const funderToken = getAssociatedTokenAddressSync(mint, signer, false, tokenProgram);
await program.methods.seedMarket(new BN(Math.round(t.seed * 10 ** t.decimals))).accounts({ market, vault, mint, funderToken, funder: signer, tokenProgram }).rpc();
console.log(`opened replay market #${id} ${metric} in ${TOKEN}: bets close in ${BET_SECS}s, then run resolve.mjs`);
