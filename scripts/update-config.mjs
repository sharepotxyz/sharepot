// Update on-chain config fields (admin key). Usage:
//   ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=... node scripts/update-config.mjs disputeWindowSecs=21600 [earlyBirdSecs=86400 ...]
// Unspecified fields keep their current values. Prints the before/after config. DRY_RUN=1 only prints.
import anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import fs from "node:fs";
const idl = JSON.parse(fs.readFileSync(new URL("../idl/sharepot.json", import.meta.url), "utf8"));
const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const pick = (c) => ({ proposer: c.proposer, treasuryOwner: c.treasuryOwner, feeBps: c.feeBps, earlyBirdDiscountBps: c.earlyBirdDiscountBps, earlyBirdSecs: c.earlyBirdSecs, disputeWindowSecs: c.disputeWindowSecs, minBet: c.minBet });
const show = (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v?.toBase58 ? v.toBase58() : v?.toString?.() ?? v]));
const cur = await program.account.config.fetch(config); const args = pick(cur);
for (const kv of process.argv.slice(2)) {
  const [k, v] = kv.split("="); if (!(k in args)) throw new Error(`unknown field ${k}; known: ${Object.keys(args).join(",")}`);
  args[k] = k === "proposer" || k === "treasuryOwner" ? new PublicKey(v) : typeof args[k] === "number" ? Number(v) : new anchor.BN(v);
}
console.log("before", show(pick(cur)));
if (process.env.DRY_RUN === "1") { console.log("would set", show(args)); process.exit(0); }
const sig = await program.methods.updateConfig(args, null, cur.paused).accounts({ config, admin: provider.wallet.publicKey }).rpc();
console.log("after ", show(pick(await program.account.config.fetch(config))), sig);
