import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID as T22, ExtensionType, AccountState, getMintLen, getAccount, createMint,
  createInitializeMintInstruction, createInitializeMetadataPointerInstruction, createInitializePermanentDelegateInstruction,
  createInitializeDefaultAccountStateInstruction, createInitializeScaledUiAmountConfigInstruction, createInitializePausableConfigInstruction,
  createInitializeTransferHookInstruction, createPauseInstruction, createResumeInstruction, createUpdateMultiplierDataInstruction,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  createInitializeTransferFeeConfigInstruction, createHarvestWithheldTokensToMintInstruction,
  createCloseAccountInstruction, createFreezeAccountInstruction, createThawAccountInstruction,
  createReallocateInstruction, createEnableRequiredMemoTransfersInstruction, createDisableRequiredMemoTransfersInstruction,
} from "@solana/spl-token";
import { assert } from "chai";
import { Sharepot } from "../target/types/sharepot";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = 100_000_000; // 1 share (xStocks use 8 decimals)
const now = () => Math.floor(Date.now() / 1000);

describe("sharepot: parimutuel pools staked in tokenized stocks", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Sharepot as Program<Sharepot>;
  const conn = provider.connection;   // reads use the provider's commitment, the same level rpc() confirms at
  const admin = (provider.wallet as anchor.Wallet).payer;
  const issuer = Keypair.generate();   // stands in for the xStocks issuer: mint, freeze, pause, delegate, multiplier authority
  const proposer = Keypair.generate();
  const alice = Keypair.generate(), bob = Keypair.generate(), carol = Keypair.generate(), dave = Keypair.generate();
  const people = { admin, alice, bob, carol, dave };
  const nameOf = (k: Keypair) => Object.entries(people).find(([, v]) => v === k)![0];

  // one "stock" = { mint, program, ata per person }
  type Stock = { mint: PublicKey; prog: PublicKey; ata: Record<string, PublicKey> };
  let xTSLA: Stock, xNVDA: Stock;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const marketPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from("market"), new BN(id).toArrayLike(Buffer, "le", 8)], program.programId)[0];
  const vaultPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], program.programId)[0];
  const posPda = (m: PublicKey, u: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), u.toBuffer()], program.programId)[0];
  const expectErr = async (p: Promise<any>, code: string) => {
    try { await p; assert.fail("expected " + code); } catch (e: any) {
      const msg = `${e.error?.errorCode?.code ?? ""} ${e.name ?? ""} ${e.message ?? ""} ${(e.logs ?? []).join(" ")}`; assert.include(msg, code, `got ${msg}`);
    }
  };
  const metric = Array.from(Buffer.from("TSLA.close_bps".padEnd(32, "\0")));
  const qhash = Array.from(Buffer.alloc(32, 7));

  /** A Token-2022 mint with the same extension set as the real TSLAx (XsDoVf…zoB), checked on mainnet 2026-09-14. */
  async function createXStock(): Promise<Stock> {
    const mint = Keypair.generate();
    const exts = [ExtensionType.MetadataPointer, ExtensionType.PermanentDelegate, ExtensionType.DefaultAccountState,
      ExtensionType.ScaledUiAmountConfig, ExtensionType.PausableConfig, ExtensionType.TransferHook];
    const len = getMintLen(exts);
    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: await conn.getMinimumBalanceForRentExemption(len), programId: T22 }),
      createInitializeMetadataPointerInstruction(mint.publicKey, issuer.publicKey, mint.publicKey, T22),
      createInitializePermanentDelegateInstruction(mint.publicKey, issuer.publicKey, T22),
      createInitializeDefaultAccountStateInstruction(mint.publicKey, AccountState.Initialized, T22),
      createInitializeScaledUiAmountConfigInstruction(mint.publicKey, issuer.publicKey, 1, T22),
      createInitializePausableConfigInstruction(mint.publicKey, issuer.publicKey, T22),
      createInitializeTransferHookInstruction(mint.publicKey, issuer.publicKey, PublicKey.default, T22), // empty hook slot, like mainnet
      createInitializeMintInstruction(mint.publicKey, 8, issuer.publicKey, issuer.publicKey, T22));
    await provider.sendAndConfirm(tx, [mint]);
    return fund(mint.publicKey, T22, issuer);
  }
  async function fund(mint: PublicKey, prog: PublicKey, mintAuth: Keypair): Promise<Stock> {
    const ata: Record<string, PublicKey> = {};
    const tx = new Transaction();
    for (const [n, k] of Object.entries(people)) {
      ata[n] = getAssociatedTokenAddressSync(mint, k.publicKey, false, prog);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata[n], k.publicKey, mint, prog),
        createMintToInstruction(mint, ata[n], mintAuth.publicKey, BigInt(10_000) * BigInt(T), [], prog));
    }
    await provider.sendAndConfirm(tx, [mintAuth]);
    return { mint, prog, ata };
  }
  const bal = async (s: Stock, a: PublicKey) => Number((await getAccount(conn, a, undefined, s.prog)).amount);
  // fee rate a winner locked in (early-bird or not), read back from their position instead of assumed from timing
  const lockedBps = async (m: PublicKey, who: Keypair, bucket: number, stake: number) =>
    (await program.account.position.fetch(posPda(m, who.publicKey))).feeW[bucket].div(new BN(stake)).toNumber();

  before(async () => {
    for (const k of [issuer, proposer, alice, bob, carol, dave]) {
      const sig = await conn.requestAirdrop(k.publicKey, 2 * LAMPORTS_PER_SOL); await conn.confirmTransaction(sig, "confirmed");
    }
    xTSLA = await createXStock();
    xNVDA = await createXStock();
  });

  const cfgArgs = () => ({ proposer: proposer.publicKey, treasuryOwner: admin.publicKey, feeBps: 300, earlyBirdDiscountBps: 100, earlyBirdSecs: new BN(3), disputeWindowSecs: new BN(3), minBet: new BN(T / 100) });

  it("initializes config", async () => {
    await program.methods.initialize(cfgArgs()).accounts({ config: configPda, admin: admin.publicKey, systemProgram: SystemProgram.programId }).rpc();
    const c = await program.account.config.fetch(configPda);
    assert.equal(c.feeBps, 300); assert.equal(c.marketCount.toNumber(), 0); assert.ok(c.treasuryOwner.equals(admin.publicKey));
    await expectErr(program.methods.updateConfig({ ...cfgArgs(), feeBps: 2000 }, null, false).accounts({ config: configPda, admin: admin.publicKey }).rpc(), "FeeTooHigh");
  });

  const thr = (...xs: number[]) => Array.from({ length: 7 }, (_, i) => new BN(xs[i] ?? 0));
  async function createMarket(s: Stock, openIn: number, closeIn: number, signer = proposer, thresholds: number[] = [0]) {
    const id = (await program.account.config.fetch(configPda)).marketCount.toNumber();
    const m = marketPda(id), v = vaultPda(m);
    const t = now();
    await program.methods.createMarket({ metric, questionHash: qhash, thresholds: thr(...thresholds), nBuckets: thresholds.length + 1, openTs: new BN(t + openIn), closeTs: new BN(t + closeIn), resolveAfterTs: new BN(t + closeIn), baseline: new BN(0) })
      .accounts({ config: configPda, market: m, vault: v, mint: s.mint, signer: signer.publicKey, tokenProgram: s.prog, systemProgram: SystemProgram.programId }).signers([signer]).rpc();
    return { id, m, v, s };
  }
  type Mk = Awaited<ReturnType<typeof createMarket>>;
  const bet = (k: Mk, who: Keypair, side: "up" | "down" | number, amt: number, userToken?: PublicKey, mint?: PublicKey) =>
    program.methods.placeBet(typeof side === "number" ? side : side === "up" ? 1 : 0, new BN(amt)).accounts({ config: configPda, market: k.m, position: posPda(k.m, who.publicKey), vault: k.v, mint: mint ?? k.s.mint, userToken: userToken ?? k.s.ata[nameOf(who)], user: who.publicKey, tokenProgram: k.s.prog, systemProgram: SystemProgram.programId }).signers([who]).rpc();
  const seed = (k: Mk, amt: number) =>
    program.methods.seedMarket(new BN(amt)).accounts({ market: k.m, vault: k.v, mint: k.s.mint, funderToken: k.s.ata.admin, funder: admin.publicKey, tokenProgram: k.s.prog }).rpc();
  const settle = (k: Mk, owner: Keypair, cranker: Keypair, ownerToken?: PublicKey) =>
    program.methods.settlePosition().accounts({ market: k.m, position: posPda(k.m, owner.publicKey), payer: owner.publicKey, vault: k.v, mint: k.s.mint, ownerToken: ownerToken ?? k.s.ata[nameOf(owner)], cranker: cranker.publicKey, tokenProgram: k.s.prog }).signers([cranker]).rpc();
  const sweep = (k: Mk, signer: Keypair, treasury?: PublicKey) =>
    program.methods.sweepMarket().accounts({ config: configPda, market: k.m, vault: k.v, mint: k.s.mint, treasury: treasury ?? k.s.ata.admin, rentDest: proposer.publicKey, signer: signer.publicKey, tokenProgram: k.s.prog }).signers([signer]).rpc();
  const propose = (k: Mk, v: number, who = proposer) => program.methods.proposeResolution(new BN(v), qhash).accounts({ config: configPda, market: k.m, proposer: who.publicKey }).signers([who]).rpc();
  const finalize = (k: Mk, who: Keypair = admin) => program.methods.finalizeResolution().accounts({ config: configPda, market: k.m, signer: who.publicKey }).signers(who === admin ? [] : [who]).rpc();

  it("rejects bad schedules and unauthorized creators", async () => {
    const t = now();
    const bad = program.methods.createMarket({ metric, questionHash: qhash, thresholds: thr(0), nBuckets: 2, openTs: new BN(t + 10), closeTs: new BN(t + 5), resolveAfterTs: new BN(t + 5), baseline: new BN(0) })
      .accounts({ config: configPda, market: marketPda(0), vault: vaultPda(marketPda(0)), mint: xTSLA.mint, signer: proposer.publicKey, tokenProgram: T22, systemProgram: SystemProgram.programId }).signers([proposer]).rpc();
    await expectErr(bad, "BadSchedule");
    await expectErr(createMarket(xTSLA, 0, 60, alice), "Unauthorized");
  });

  it("full lifecycle in xTSLA: seed, early-bird + normal bets, propose, admin finalize, permissionless settle, sweep", async () => {
    const k = await createMarket(xTSLA, -1, 15);   // up/down on the close-to-close move; early-bird = min(3 s, window/4) = 3 s
    const vaultAcc = await getAccount(conn, k.v, undefined, T22);
    assert.ok(vaultAcc.owner.equals(k.m), "vault owned by the market PDA");
    await seed(k, 100 * T);
    await expectErr(bet(k, alice, "up", T / 1000), "BelowMinBet");
    await bet(k, alice, "up", 100 * T);     // early bird: 200 bps
    await bet(k, bob, "down", 300 * T);     // early bird
    const pA = await program.account.position.fetch(posPda(k.m, alice.publicKey));
    assert.equal(pA.feeW[1].toString(), new BN(100 * T).muln(200).toString());
    await sleep(4500);                        // past early-bird window
    await bet(k, carol, "up", 100 * T);     // 300 bps
    let mk = await program.account.market.fetch(k.m);
    assert.ok(mk.mint.equals(xTSLA.mint));
    assert.equal(mk.pools[1].toString(), String(200 * T)); assert.equal(mk.pools[0].toString(), String(300 * T)); assert.equal(mk.positions, 3);
    await expectErr(propose(k, 42), "TooEarlyToResolve");
    await sleep(11000);                       // past close
    await expectErr(bet(k, alice, "up", T), "BettingClosed");
    await expectErr(propose(k, 42, alice), "Unauthorized");
    await propose(k, 42);                     // TSLA closed +0.42 % → bucket 1 ("up")
    await expectErr(settle(k, alice, dave), "NotResolved");
    await expectErr(finalize(k, dave), "DisputeWindowOpen");
    await finalize(k);
    mk = await program.account.market.fetch(k.m); assert.equal(mk.status, 2); assert.equal(mk.outcome, 1);

    const a0 = await bal(xTSLA, xTSLA.ata.alice), b0 = await bal(xTSLA, xTSLA.ata.bob), c0 = await bal(xTSLA, xTSLA.ata.carol);
    const aliceLamports0 = await conn.getBalance(alice.publicKey);
    await expectErr(sweep(k, dave), "PositionsOutstanding");
    await settle(k, alice, dave); await settle(k, bob, dave); await settle(k, carol, dave);
    // alice: 100 + 300*100/200=150 − fee 150*2%=3 + seed 50 = 297 shares ; carol: 100+150−4.5+50 = 295.5 ; bob: 0
    assert.equal((await bal(xTSLA, xTSLA.ata.alice)) - a0, 297 * T);
    assert.equal((await bal(xTSLA, xTSLA.ata.carol)) - c0, 295.5 * T);
    assert.equal((await bal(xTSLA, xTSLA.ata.bob)) - b0, 0);
    assert.isAbove(await conn.getBalance(alice.publicKey), aliceLamports0, "rent refunded to position payer");
    mk = await program.account.market.fetch(k.m);
    const t0 = await bal(xTSLA, xTSLA.ata.admin), rent0 = await conn.getBalance(proposer.publicKey);
    await sweep(k, dave);
    assert.equal((await bal(xTSLA, xTSLA.ata.admin)) - t0, mk.feeCollected.toNumber());
    assert.equal(mk.feeCollected.toNumber(), 7.5 * T);
    await expectErr(getAccount(conn, k.v, undefined, T22) as any, "TokenAccountNotFoundError");
    // the market account is closed too: its rent, like the vault's, goes back to the proposer that paid it
    assert.isNull(await program.account.market.fetchNullable(k.m), "market account closed by sweep");
    assert.isAbove(await conn.getBalance(proposer.publicKey), rent0 + 3_000_000, "market + vault rent returned to the proposer");
  });

  it("forfeit: a position whose owner's token account is closed or frozen goes to the treasury after the grace (admin at once); a payable owner never does", async () => {
    const k = await createMarket(xTSLA, -1, 6);
    // erin: a throwaway wallet that stakes everything it holds and then closes its token account
    const erin = Keypair.generate(), erinAta = getAssociatedTokenAddressSync(xTSLA.mint, erin.publicKey, false, T22);
    await conn.confirmTransaction(await conn.requestAirdrop(erin.publicKey, LAMPORTS_PER_SOL), "confirmed");
    await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, erinAta, erin.publicKey, xTSLA.mint, T22), createMintToInstruction(xTSLA.mint, erinAta, issuer.publicKey, BigInt(T), [], T22)), [issuer]);
    await bet(k, alice, "up", 100 * T); await bet(k, bob, "down", 100 * T); await bet(k, erin, "up", T, erinAta);
    await provider.sendAndConfirm(new Transaction().add(createCloseAccountInstruction(erinAta, erin.publicKey, erin.publicKey, [], T22)), [erin]);
    await sleep(7500);
    await propose(k, 100); await finalize(k);
    const forfeit = (owner: PublicKey, payer: PublicKey, cranker: Keypair, ownerAta = getAssociatedTokenAddressSync(xTSLA.mint, owner, false, T22)) =>
      program.methods.forfeitPosition().accounts({ config: configPda, market: k.m, position: posPda(k.m, owner), payer, vault: k.v, mint: xTSLA.mint, ownerAta, treasury: xTSLA.ata.admin, cranker: cranker.publicKey, tokenProgram: T22 }).signers(cranker === admin ? [] : [cranker]).rpc();
    await expectErr(forfeit(erin.publicKey, erin.publicKey, dave), "NotForfeitableYet");          // a stranger must wait 30 days
    await expectErr(forfeit(alice.publicKey, alice.publicKey, admin), "OwnerCanBePaid");           // alice's account works: settle her
    await expectErr(forfeit(erin.publicKey, erin.publicKey, admin, xTSLA.ata.alice), "WrongOwnerAccount");
    const t0 = await bal(xTSLA, xTSLA.ata.admin), e0 = await conn.getBalance(erin.publicKey);
    await forfeit(erin.publicKey, erin.publicKey, admin);                                           // account closed → treasury
    // erin: 1 + 100*1/101 − fee ≈ 1.99 shares now in the treasury; her position rent came back to her
    assert.isAbove((await bal(xTSLA, xTSLA.ata.admin)) - t0, 1.9 * T); assert.isAbove(await conn.getBalance(erin.publicKey), e0);
    assert.isNull(await program.account.position.fetchNullable(posPda(k.m, erin.publicKey)));
    // the issuer freezes alice's account: now she cannot be paid either
    await provider.sendAndConfirm(new Transaction().add(createFreezeAccountInstruction(xTSLA.ata.alice, xTSLA.mint, issuer.publicKey, [], T22)), [issuer]);
    await expectErr(settle(k, alice, dave), "frozen");
    await forfeit(alice.publicKey, alice.publicKey, admin);
    await provider.sendAndConfirm(new Transaction().add(createThawAccountInstruction(xTSLA.ata.alice, xTSLA.mint, issuer.publicKey, [], T22)), [issuer]);
    await settle(k, bob, dave);                                                                     // the loser settles as usual
    let mk = await program.account.market.fetch(k.m); assert.equal(mk.positionsOpen, 0);
    await sweep(k, dave);
    assert.isNull(await program.account.market.fetchNullable(k.m));
  });

  it("forfeit: an owner who set their token account to require memos cannot be paid either (it would hold the market open for ever); switching it off makes them payable again", async () => {
    const k = await createMarket(xTSLA, -1, 6);
    await bet(k, alice, "up", 100 * T); await bet(k, bob, "down", 100 * T); await bet(k, carol, "up", 10 * T);
    // carol turns on "required memo transfers" on her own account (a Token-2022 option any owner can enable)
    await provider.sendAndConfirm(new Transaction().add(
      createReallocateInstruction(xTSLA.ata.carol, carol.publicKey, [ExtensionType.MemoTransfer], carol.publicKey, [], T22),
      createEnableRequiredMemoTransfersInstruction(xTSLA.ata.carol, carol.publicKey, [], T22)), [carol]);
    await sleep(7500);
    await propose(k, 100); await finalize(k);
    await expectErr(settle(k, carol, dave), "memo");                                                // the payout has no memo: refused by the token program
    const forfeit = (owner: PublicKey, cranker: Keypair) =>
      program.methods.forfeitPosition().accounts({ config: configPda, market: k.m, position: posPda(k.m, owner), payer: owner, vault: k.v, mint: xTSLA.mint, ownerAta: getAssociatedTokenAddressSync(xTSLA.mint, owner, false, T22), treasury: xTSLA.ata.admin, cranker: cranker.publicKey, tokenProgram: T22 }).signers(cranker === admin ? [] : [cranker]).rpc();
    await expectErr(forfeit(carol.publicKey, dave), "NotForfeitableYet");                          // a stranger still waits 30 days
    await expectErr(forfeit(alice.publicKey, admin), "OwnerCanBePaid");                             // alice is fine
    // carol switches it off again: she is payable, so she is settled, never forfeited
    await provider.sendAndConfirm(new Transaction().add(createDisableRequiredMemoTransfersInstruction(xTSLA.ata.carol, carol.publicKey, [], T22)), [carol]);
    await expectErr(forfeit(carol.publicKey, admin), "OwnerCanBePaid");
    const c0 = await bal(xTSLA, xTSLA.ata.carol);
    await settle(k, carol, dave); assert.isAbove((await bal(xTSLA, xTSLA.ata.carol)) - c0, 10 * T);
    // and back on, for the forfeit path: the admin may forfeit at once
    await provider.sendAndConfirm(new Transaction().add(createReallocateInstruction(xTSLA.ata.alice, alice.publicKey, [ExtensionType.MemoTransfer], alice.publicKey, [], T22), createEnableRequiredMemoTransfersInstruction(xTSLA.ata.alice, alice.publicKey, [], T22)), [alice]);
    await expectErr(settle(k, alice, dave), "memo");
    const t0 = await bal(xTSLA, xTSLA.ata.admin);
    await forfeit(alice.publicKey, admin);
    assert.isAbove((await bal(xTSLA, xTSLA.ata.admin)) - t0, 100 * T);
    await provider.sendAndConfirm(new Transaction().add(createDisableRequiredMemoTransfersInstruction(xTSLA.ata.alice, alice.publicKey, [], T22)), [alice]);
    await settle(k, bob, dave);
    await sweep(k, dave);
    assert.isNull(await program.account.market.fetchNullable(k.m));
  });

  it("each market is locked to its own stock: wrong mint, wrong token account and wrong treasury are all rejected", async () => {
    const kT = await createMarket(xTSLA, -1, 8), kN = await createMarket(xNVDA, -1, 8);
    await expectErr(bet(kT, alice, "up", T, xNVDA.ata.alice, xNVDA.mint), "ConstraintHasOne");  // NVDA mint on a TSLA market
    await expectErr(bet(kT, alice, "up", T, xNVDA.ata.alice), "ConstraintTokenMint");           // right mint, NVDA wallet
    await bet(kT, alice, "up", 5 * T); await bet(kT, bob, "down", 5 * T);
    await bet(kN, alice, "down", 2 * T); await bet(kN, bob, "up", 8 * T);
    await sleep(9000);
    await propose(kT, -80); await finalize(kT);   // TSLA −0.80 % → down
    await propose(kN, 130); await finalize(kN);   // NVDA +1.30 % → up
    const bpsT = await lockedBps(kT.m, bob, 0, 5 * T), bpsN = await lockedBps(kN.m, bob, 1, 8 * T);
    const bT = await bal(xTSLA, xTSLA.ata.bob), bN = await bal(xNVDA, xNVDA.ata.bob);
    await settle(kT, alice, dave); await settle(kT, bob, dave); await settle(kN, alice, dave); await settle(kN, bob, dave);
    assert.equal((await bal(xTSLA, xTSLA.ata.bob)) - bT, 5 * T + 5 * T - (5 * T * bpsT) / 10_000, "paid in TSLAx");
    assert.equal((await bal(xNVDA, xNVDA.ata.bob)) - bN, 8 * T + 2 * T - (2 * T * bpsN) / 10_000, "paid in NVDAx");
    await expectErr(sweep(kT, dave, xNVDA.ata.admin), "ConstraintTokenMint");      // fees can't leave in another stock
    await expectErr(sweep(kT, dave, xTSLA.ata.alice), "ConstraintTokenOwner");     // or to anyone but the treasury owner
    await sweep(kT, dave); await sweep(kN, dave);
  });

  it("void refunds everyone in full and returns the seed to treasury", async () => {
    const k = await createMarket(xTSLA, -1, 60);
    await seed(k, 10 * T);
    await bet(k, alice, "up", 50 * T); await bet(k, bob, "down", 20 * T);
    await expectErr(program.methods.voidMarket().accounts({ config: configPda, market: k.m, admin: alice.publicKey }).signers([alice]).rpc(), "Unauthorized");
    await program.methods.voidMarket().accounts({ config: configPda, market: k.m, admin: admin.publicKey }).rpc();
    const a0 = await bal(xTSLA, xTSLA.ata.alice), b0 = await bal(xTSLA, xTSLA.ata.bob), t0 = await bal(xTSLA, xTSLA.ata.admin);
    await settle(k, alice, dave); await settle(k, bob, dave);
    assert.equal((await bal(xTSLA, xTSLA.ata.alice)) - a0, 50 * T); assert.equal((await bal(xTSLA, xTSLA.ata.bob)) - b0, 20 * T);
    await sweep(k, dave);
    assert.equal((await bal(xTSLA, xTSLA.ata.admin)) - t0, 10 * T);
  });

  it("no winners → everyone refunded; permissionless finalize after dispute window", async () => {
    const k = await createMarket(xTSLA, -1, 4);
    await bet(k, alice, "down", 30 * T); await bet(k, bob, "down", 70 * T);
    await sleep(5500);
    await propose(k, 15);
    await sleep(4000);
    await finalize(k, dave);
    const a0 = await bal(xTSLA, xTSLA.ata.alice), b0 = await bal(xTSLA, xTSLA.ata.bob);
    await settle(k, alice, dave); await settle(k, bob, dave);
    assert.equal((await bal(xTSLA, xTSLA.ata.alice)) - a0, 30 * T); assert.equal((await bal(xTSLA, xTSLA.ata.bob)) - b0, 70 * T);
    await sweep(k, dave);
  });

  it("4 buckets with negative thresholds (big drop / small drop / small gain / big gain), bucket derived on-chain", async () => {
    const k = await createMarket(xNVDA, -1, 13, proposer, [-100, 0, 100]);  // < −1 % | −1 %…0 | 0…+1 % | ≥ +1 %
    let mk = await program.account.market.fetch(k.m); assert.equal(mk.nBuckets, 4);
    await expectErr(bet(k, alice, 4, 10 * T), "BadBuckets");
    await bet(k, alice, 3, 100 * T); await bet(k, bob, 0, 50 * T); await bet(k, carol, 1, 150 * T); await bet(k, dave, 0, 150 * T);
    await sleep(14500);
    await propose(k, -250);                  // NVDA −2.50 %
    mk = await program.account.market.fetch(k.m); assert.equal(mk.proposedOutcome, 0, "−250 bps falls in bucket 0");
    await finalize(k);
    const bobBps = await lockedBps(k.m, bob, 0, 50 * T), daveBps = await lockedBps(k.m, dave, 0, 150 * T);
    assert.include([200, 300], daveBps);
    const b0 = await bal(xNVDA, xNVDA.ata.bob), d0 = await bal(xNVDA, xNVDA.ata.dave), a0 = await bal(xNVDA, xNVDA.ata.alice);
    await settle(k, alice, dave); await settle(k, bob, dave); await settle(k, carol, dave); await settle(k, dave, dave);
    // losing pools = 100 + 150 = 250; bucket-0 pool = 200 → bob gets 50 + 62.5 − fee, dave 150 + 187.5 − fee, alice 0
    assert.equal((await bal(xNVDA, xNVDA.ata.bob)) - b0, 50 * T + 62.5 * T - (62.5 * T * bobBps) / 10_000);
    assert.equal((await bal(xNVDA, xNVDA.ata.dave)) - d0, 150 * T + 187.5 * T - (187.5 * T * daveBps) / 10_000);
    assert.equal((await bal(xNVDA, xNVDA.ata.alice)) - a0, 0);
    await sweep(k, dave);
  });

  it("boundary 0 bps counts as up; re-propose restarts the window; double finalize, void after resolve, foreign owner_token all rejected", async () => {
    await expectErr(createMarket(xTSLA, -1, 60, proposer, [300, 200]), "BadBuckets");
    await expectErr(createMarket(xTSLA, -1, 60, proposer, [1, 2, 3, 4, 5, 6, 7, 8]), "BadBuckets");
    const k = await createMarket(xTSLA, -1, 13);
    await bet(k, alice, "down", 40 * T); await bet(k, bob, "up", 60 * T);
    await sleep(14500);
    await expectErr(seed(k, T), "BettingClosed");
    await propose(k, -1);
    let mk = await program.account.market.fetch(k.m); assert.equal(mk.proposedOutcome, 0); const firstAt = mk.proposedAt.toNumber();
    await sleep(1500);
    await propose(k, 0);
    mk = await program.account.market.fetch(k.m); assert.equal(mk.proposedOutcome, 1, "unchanged close (0 bps) is the lower edge of up"); assert.isAbove(mk.proposedAt.toNumber(), firstAt, "window restarted");
    await finalize(k);
    await expectErr(finalize(k), "NotProposed");
    await expectErr(propose(k, 1), "MarketNotOpen");
    await expectErr(program.methods.voidMarket().accounts({ config: configPda, market: k.m, admin: admin.publicKey }).rpc(), "AlreadyFinal");
    await expectErr(settle(k, alice, dave, xTSLA.ata.bob), "ConstraintTokenOwner");
    const bobBps = await lockedBps(k.m, bob, 1, 60 * T);
    const b0 = await bal(xTSLA, xTSLA.ata.bob);
    await settle(k, alice, dave); await settle(k, bob, dave);
    assert.equal((await bal(xTSLA, xTSLA.ata.bob)) - b0, 60 * T + 40 * T - (40 * T * bobBps) / 10_000);
    await sweep(k, dave);
    await expectErr(settle(k, alice, dave), "AccountNotInitialized");
  });

  it("issuer pause freezes bets and payouts; everything resumes intact once the issuer unpauses", async () => {
    const k = await createMarket(xTSLA, -1, 10);
    await bet(k, alice, "up", 10 * T); await bet(k, bob, "down", 10 * T);
    await provider.sendAndConfirm(new Transaction().add(createPauseInstruction(xTSLA.mint, issuer.publicKey, [], T22)), [issuer]);
    let failed = false; try { await bet(k, carol, "up", T); } catch { failed = true; }
    assert.isTrue(failed, "a paused mint cannot move into the pool");
    await sleep(11000);
    await propose(k, 55); await finalize(k);
    failed = false; try { await settle(k, alice, dave); } catch { failed = true; }
    assert.isTrue(failed, "a paused mint cannot pay out either");
    await provider.sendAndConfirm(new Transaction().add(createResumeInstruction(xTSLA.mint, issuer.publicKey, [], T22)), [issuer]);
    const aliceBps = await lockedBps(k.m, alice, 1, 10 * T);
    const a0 = await bal(xTSLA, xTSLA.ata.alice);
    await settle(k, alice, dave); await settle(k, bob, dave);
    assert.equal((await bal(xTSLA, xTSLA.ata.alice)) - a0, 20 * T - (10 * T * aliceBps) / 10_000);
    await sweep(k, dave);
  });

  it("a dividend-style multiplier change mid-market leaves raw accounting exact", async () => {
    const k = await createMarket(xNVDA, -1, 8);
    await bet(k, alice, "up", 10 * T); await bet(k, bob, "down", 30 * T);
    await provider.sendAndConfirm(new Transaction().add(createUpdateMultiplierDataInstruction(xNVDA.mint, issuer.publicKey, 1.004, BigInt(0), [], T22)), [issuer]);
    await sleep(9000);
    await propose(k, 10); await finalize(k);
    const aliceBps = await lockedBps(k.m, alice, 1, 10 * T);
    const a0 = await bal(xNVDA, xNVDA.ata.alice);
    await settle(k, alice, dave); await settle(k, bob, dave);
    assert.equal((await bal(xNVDA, xNVDA.ata.alice)) - a0, 10 * T + 30 * T - (30 * T * aliceBps) / 10_000, "raw units unaffected by the UI multiplier");
    await sweep(k, dave);
  });

  it("classic SPL mints work through the same code path", async () => {
    const auth = Keypair.generate();
    const legacy = await fund(await createMint(conn, admin, auth.publicKey, null, 6), TOKEN_PROGRAM_ID, auth);
    const k = await createMarket(legacy, -1, 60);
    await bet(k, alice, "up", 5 * T);
    await program.methods.voidMarket().accounts({ config: configPda, market: k.m, admin: admin.publicKey }).rpc();
    const a0 = await bal(legacy, legacy.ata.alice);
    await settle(k, alice, dave);
    assert.equal((await bal(legacy, legacy.ata.alice)) - a0, 5 * T);
    await sweep(k, dave);
  });

  it("transfer-fee mints (Tessera / PreStocks-style): pools book what the vault received; harvest, then sweep", async () => {
    const mintWith = async (ix: (mint: PublicKey) => any, ext: ExtensionType) => {
      const kp = Keypair.generate(); const len = getMintLen([ext]);
      await provider.sendAndConfirm(new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: kp.publicKey, space: len, lamports: await conn.getMinimumBalanceForRentExemption(len), programId: T22 }),
        ix(kp.publicKey), createInitializeMintInstruction(kp.publicKey, 9, issuer.publicKey, issuer.publicKey, T22)), [kp]);
      return { mint: kp.publicKey, prog: T22, ata: {} } as Stock;
    };
    // 50 bps like PreStocks (Tessera charges 20). Minting to a wallet carries no fee, transfers do.
    const feeMint = await mintWith((m) => createInitializeTransferFeeConfigInstruction(m, issuer.publicKey, issuer.publicKey, 50, BigInt(1e12), T22), ExtensionType.TransferFeeConfig);
    const fee = await fund(feeMint.mint, T22, issuer);
    const feeOn = (x: number) => Math.ceil((x * 50) / 10000);
    const k = await createMarket(fee, -1, 8);
    await bet(k, alice, "up", 1000 * T); await bet(k, bob, "down", 1000 * T);
    const credited = 1000 * T - feeOn(1000 * T);
    let mk = await program.account.market.fetch(k.m);
    assert.equal(mk.pools[1].toNumber(), credited, "pool = what the vault received, not what was sent");
    assert.equal(mk.pools[0].toNumber(), credited);
    assert.equal((await program.account.position.fetch(posPda(k.m, alice.publicKey))).amounts[1].toNumber(), credited);
    assert.equal(await bal(fee, k.v), 2 * credited, "vault balance equals the pools exactly");
    await sleep(9500);
    await propose(k, 42); await finalize(k);
    const a0 = await bal(fee, fee.ata.alice);
    const bpsLocked = await lockedBps(k.m, alice, 1, credited);
    await settle(k, alice, dave); await settle(k, bob, dave);
    // alice is paid stake + losing pool − her locked fee rate on the losing pool; the issuer takes its 50 bps on the way out
    const gross = credited + credited - Math.floor((credited * bpsLocked) / 10000);
    assert.equal((await bal(fee, fee.ata.alice)) - a0, gross - feeOn(gross));
    mk = await program.account.market.fetch(k.m);
    const remaining = await bal(fee, k.v);
    assert.equal(remaining, mk.feeCollected.toNumber(), "only the protocol fee is left in the vault");
    // the vault holds withheld issuer fees from the bets; Token-2022 refuses to close it until they are harvested
    await expectErr(sweep(k, dave, getAssociatedTokenAddressSync(fee.mint, admin.publicKey, false, T22)), "withheld");
    await provider.sendAndConfirm(new Transaction().add(createHarvestWithheldTokensToMintInstruction(fee.mint, [k.v], T22)));
    const t0 = await bal(fee, fee.ata.admin);
    await sweep(k, dave, fee.ata.admin);
    assert.equal((await bal(fee, fee.ata.admin)) - t0, remaining - feeOn(remaining));
    await expectErr(getAccount(conn, k.v, undefined, T22) as any, "TokenAccountNotFoundError");
    // an active transfer hook is still refused; an Ondo-style empty hook slot is fine
    const hooked = await mintWith((m) => createInitializeTransferHookInstruction(m, issuer.publicKey, Keypair.generate().publicKey, T22), ExtensionType.TransferHook);
    await expectErr(createMarket(hooked, -1, 60), "UnsupportedMint");
    const ondo = await mintWith((m) => createInitializeTransferHookInstruction(m, issuer.publicKey, PublicKey.default, T22), ExtensionType.TransferHook);
    await createMarket(ondo, -1, 60);
  });

  it("stale void: proposer cannot void before 24 h past the resolve time; a stranger never can; admin can at once", async () => {
    const k = await createMarket(xTSLA, -1, 4);
    await bet(k, alice, "up", T);
    await sleep(5000);   // past resolve_after_ts, but nowhere near STALE_VOID_SECS
    const staleVoid = (who: Keypair) => program.methods.voidStaleMarket().accounts({ config: configPda, market: k.m, proposer: who.publicKey }).signers([who]).rpc();
    await expectErr(staleVoid(proposer), "NotStaleYet");
    await expectErr(staleVoid(alice), "Unauthorized");
    // the admin path is void_market, unchanged: immediate, then a normal refund settlement
    await program.methods.voidMarket().accounts({ config: configPda, market: k.m, admin: admin.publicKey }).rpc();
    await expectErr(staleVoid(proposer), "MarketNotOpen");
    const a0 = await bal(xTSLA, xTSLA.ata.alice);
    await settle(k, alice, dave);
    assert.equal((await bal(xTSLA, xTSLA.ata.alice)) - a0, T, "voided: stake refunded in full");
  });

  it("paused config blocks bets", async () => {
    const k = await createMarket(xTSLA, -1, 60);
    await program.methods.updateConfig(cfgArgs(), null, true).accounts({ config: configPda, admin: admin.publicKey }).rpc();
    await expectErr(bet(k, alice, "up", T), "Paused");
    await program.methods.updateConfig(cfgArgs(), null, false).accounts({ config: configPda, admin: admin.publicKey }).rpc();
    await bet(k, alice, "up", T);
  });
});
