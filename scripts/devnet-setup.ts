/**
 * One-shot devnet bootstrap (idempotent — re-running prints what exists instead of recreating):
 *  1. one mock per listed token in server/stock-templates.json: a Token-2022 mint with the same extension set and
 *     decimals as that issuer's real mainnet tokens (checked on-chain 2026-09-14):
 *       xstocks / backpack: metadata, permanent delegate, default account state, scaled UI amount, pausable, empty hook
 *       ondo:               metadata, default account state, scaled UI amount, pausable, empty hook (no permanent delegate)
 *     The operator plays the issuer on devnet.
 *  2. operator token accounts holding a seed supply of each mock (the operator is also the treasury owner)
 *  3. proposer keypair (server key) and faucet keypair (API key) with a little SOL and 100,000 shares of each mock
 *  4. initialize config (fee 3 %, early-bird −1 % for up to 6 h, dispute 1 h, min bet 1,000 raw units)
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID as T22, ExtensionType, AccountState, getMintLen, getMint, TYPE_SIZE, LENGTH_SIZE,
  createInitializeMintInstruction, createInitializeMetadataPointerInstruction, createInitializePermanentDelegateInstruction,
  createInitializeDefaultAccountStateInstruction, createInitializeScaledUiAmountConfigInstruction, createInitializePausableConfigInstruction,
  createInitializeTransferHookInstruction, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import * as fs from "fs";
import * as path from "path";
import idl from "../idl/sharepot.json";
import templates from "../server/stock-templates.json";

const SECRETS = process.env.SHAREPOT_SECRETS ?? "/root/stocklana/secrets/devnet";
const STATE = path.join(SECRETS, "state.json");
const SUPPLY_SHARES = 1_000_000n, FAUCET_SHARES = 100_000n;
const tokens = templates.stocks.flatMap((s) => s.tokens.map((t) => ({ ...t, stock: s })));
const unit = (decimals: number) => 10n ** BigInt(decimals);
const mockName = (t: (typeof tokens)[number]) =>
  (t.issuer === "xStocks" ? `${t.stock.name} xStock` : t.issuer === "Ondo" ? `${t.stock.name} (Ondo Tokenized)` : `${t.stock.name} - Backpack Securities`) + " (devnet mock)";
const loadOrCreateKeypair = (file: string) => {
  const p = path.join(SECRETS, file);
  if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
  const k = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  return k;
};

async function main() {
  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(idl as anchor.Idl, provider);
  const admin = (provider.wallet as anchor.Wallet).payer;
  const conn = provider.connection;
  const state: any = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
  state.mints ??= {};
  const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log("cluster", conn.rpcEndpoint, "operator", admin.publicKey.toBase58(), "balance", (await conn.getBalance(admin.publicKey)) / 1e9);

  // 1 + 2. mock tokens and the operator's supply
  for (const t of tokens) {
    let mint: PublicKey;
    if (state.mints[t.token]) { mint = new PublicKey(state.mints[t.token]); await getMint(conn, mint, "confirmed", T22); }
    else {
      const kp = Keypair.generate(); mint = kp.publicKey;
      const name = mockName(t), symbol = t.token, uri = "";
      const exts = [ExtensionType.MetadataPointer, ExtensionType.DefaultAccountState, ExtensionType.ScaledUiAmountConfig, ExtensionType.PausableConfig, ExtensionType.TransferHook];
      if (t.profile !== "ondo") exts.push(ExtensionType.PermanentDelegate);
      const mintLen = getMintLen(exts);
      const metaLen = TYPE_SIZE + LENGTH_SIZE + pack({ mint, name, symbol, uri, updateAuthority: admin.publicKey, additionalMetadata: [] }).length;
      const tx = new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint, space: mintLen, lamports: await conn.getMinimumBalanceForRentExemption(mintLen + metaLen), programId: T22 }),
        createInitializeMetadataPointerInstruction(mint, admin.publicKey, mint, T22));
      if (t.profile !== "ondo") tx.add(createInitializePermanentDelegateInstruction(mint, admin.publicKey, T22));
      tx.add(
        createInitializeDefaultAccountStateInstruction(mint, AccountState.Initialized, T22),
        createInitializeScaledUiAmountConfigInstruction(mint, admin.publicKey, 1, T22),
        createInitializePausableConfigInstruction(mint, admin.publicKey, T22),
        createInitializeTransferHookInstruction(mint, admin.publicKey, PublicKey.default, T22),
        createInitializeMintInstruction(mint, t.decimals, admin.publicKey, admin.publicKey, T22),
        createInitializeInstruction({ programId: T22, metadata: mint, updateAuthority: admin.publicKey, mint, mintAuthority: admin.publicKey, name, symbol, uri }));
      await provider.sendAndConfirm(tx, [kp]);
      state.mints[t.token] = mint.toBase58(); save();
      console.log(`created mock ${symbol} (${t.issuer}, ${t.decimals} decimals) ${mint.toBase58()}`);
    }
    const ata = getAssociatedTokenAddressSync(mint, admin.publicKey, false, T22);
    const have = (await conn.getAccountInfo(ata)) ? BigInt((await conn.getTokenAccountBalance(ata)).value.amount) : 0n;
    if (have < SUPPLY_SHARES * unit(t.decimals)) {
      await provider.sendAndConfirm(new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata, admin.publicKey, mint, T22),
        createMintToInstruction(mint, ata, admin.publicKey, SUPPLY_SHARES * unit(t.decimals) - have, [], T22)));
      console.log(`topped up ${t.token} supply to ${SUPPLY_SHARES} shares`);
    }
  }

  // 3. proposer + faucet
  // The proposer runs the scheduled jobs: it opens markets (paying their rent), seeds them from its own stock supply,
  // proposes results and cranks payouts, so it gets a SOL float and a seed supply of every token.
  const proposer = loadOrCreateKeypair("proposer.json");
  state.proposer = proposer.publicKey.toBase58(); save();
  const proposerSol = Number(process.env.PROPOSER_FUND_SOL ?? 0.2) * 1e9;
  if ((await conn.getBalance(proposer.publicKey)) < proposerSol / 2) {
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: proposer.publicKey, lamports: proposerSol })));
    console.log(`funded proposer ${proposerSol / 1e9} SOL`);
  }
  for (const t of tokens) {
    const mint = new PublicKey(state.mints[t.token]), u = unit(t.decimals);
    const from = getAssociatedTokenAddressSync(mint, admin.publicKey, false, T22), to = getAssociatedTokenAddressSync(mint, proposer.publicKey, false, T22);
    const have = (await conn.getAccountInfo(to)) ? BigInt((await conn.getTokenAccountBalance(to)).value.amount) : 0n;
    if (have < 1_000n * u) {
      await provider.sendAndConfirm(new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, to, proposer.publicKey, mint, T22),
        createTransferCheckedInstruction(from, mint, to, admin.publicKey, 10_000n * u, t.decimals, [], T22)));
      console.log(`proposer seed supply: 10000 ${t.token}`);
    }
  }
  const faucet = loadOrCreateKeypair("faucet.json");
  state.faucet = faucet.publicKey.toBase58(); save();
  const faucetSol = Number(process.env.FAUCET_FUND_SOL ?? 0.3) * 1e9;
  if ((await conn.getBalance(faucet.publicKey)) < faucetSol / 2) {
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: faucet.publicKey, lamports: faucetSol })));
    console.log(`funded faucet ${faucetSol / 1e9} SOL`);
  }
  for (const t of tokens) {
    const mint = new PublicKey(state.mints[t.token]), u = unit(t.decimals);
    const from = getAssociatedTokenAddressSync(mint, admin.publicKey, false, T22), to = getAssociatedTokenAddressSync(mint, faucet.publicKey, false, T22);
    const have = (await conn.getAccountInfo(to)) ? BigInt((await conn.getTokenAccountBalance(to)).value.amount) : 0n;
    if (have < (FAUCET_SHARES / 10n) * u) {
      await provider.sendAndConfirm(new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, to, faucet.publicKey, mint, T22),
        createTransferCheckedInstruction(from, mint, to, admin.publicKey, FAUCET_SHARES * u, t.decimals, [], T22)));
      console.log(`faucet stocked with ${FAUCET_SHARES} ${t.token}`);
    }
  }

  // 4. config
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  if (!(await conn.getAccountInfo(config))) {
    await program.methods.initialize({ proposer: proposer.publicKey, treasuryOwner: admin.publicKey, feeBps: 300, earlyBirdDiscountBps: 100, earlyBirdSecs: new BN(6 * 3600), disputeWindowSecs: new BN(3600), minBet: new BN(1000) })
      .accounts({ config, admin: admin.publicKey, systemProgram: SystemProgram.programId }).rpc();
    console.log("config initialized", config.toBase58());
  } else console.log("config exists", config.toBase58());
  state.config = config.toBase58(); state.programId = program.programId.toBase58(); state.operator = admin.publicKey.toBase58(); save();
  console.log("state written to", STATE); console.log(JSON.stringify(state, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
