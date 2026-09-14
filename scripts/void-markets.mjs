// Void markets by id (admin key): everyone is refunded in full by the settlement crank, seed goes back to the treasury.
//   ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=... node scripts/void-markets.mjs 10 13 14
import anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import fs from "node:fs";
const idl = JSON.parse(fs.readFileSync(new URL("../idl/sharepot.json", import.meta.url), "utf8"));
const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
for (const idStr of process.argv.slice(2)) {
  const id = new anchor.BN(idStr);
  const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], program.programId);
  const before = await program.account.market.fetch(market);
  if (before.status >= 2) { console.log(`#${idStr}: already final (status ${before.status}), skipped`); continue; }
  const sig = await program.methods.voidMarket().accounts({ config, market, admin: provider.wallet.publicKey }).rpc();
  const after = await program.account.market.fetch(market);
  console.log(`#${idStr}: voided (status ${after.status}, ${after.positions} positions to refund) ${sig}`);
}
