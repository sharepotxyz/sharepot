// Admin: change the EVM pot's config (SharePot.sol updateConfig). Reads the current values, applies key=value
// overrides, sends; unspecified fields keep their values. The admin key lives on Tokyo (secrets/evm/deployer.env).
//   EVM_CHAIN=robinhood-testnet EVM_ADMIN_KEY_FILE=/root/stocklana/secrets/evm/deployer.env \
//     node scripts/update-config-evm.mjs disputeWindowSecs=21600 [proposer=0x… treasury=0x… feeBps=300 earlyBirdDiscountBps=100 earlyBirdSecs=21600 minBet=<raw>] [paused=true|false] [newAdmin=0x…]
//   DRY_RUN=1 prints what it would send.
import { walletFor, readConfig, send, CHAIN_KEY, explorerTx } from "../server/evm/chain.mjs";
const keyFile = process.env.EVM_ADMIN_KEY_FILE; if (!keyFile) { console.error("EVM_ADMIN_KEY_FILE required"); process.exit(2); }
const admin = walletFor(keyFile);
const cur = await readConfig();
if (String(cur.admin).toLowerCase() !== admin.account.address.toLowerCase()) { console.error(`${admin.account.address} is not the admin ${cur.admin}`); process.exit(2); }
const args = { proposer: cur.proposer, treasury: cur.treasury, feeBps: cur.feeBps, earlyBirdDiscountBps: cur.earlyBirdDiscountBps, earlyBirdSecs: BigInt(cur.earlyBirdSecs), disputeWindowSecs: BigInt(cur.disputeWindowSecs), minBet: BigInt(cur.minBet) };
let paused = cur.paused, newAdmin = "0x0000000000000000000000000000000000000000";
for (const kv of process.argv.slice(2)) {
  const [k, v] = kv.split("=");
  if (k === "paused") paused = v === "true";
  else if (k === "newAdmin") newAdmin = v;
  else if (k in args) args[k] = typeof args[k] === "bigint" ? BigInt(v) : typeof args[k] === "number" ? Number(v) : v;
  else { console.error(`unknown field ${k}; known: ${Object.keys(args).join(",")}, paused, newAdmin`); process.exit(2); }
}
const show = (o) => JSON.stringify(o, (_, x) => (typeof x === "bigint" ? x.toString() : x));
console.log(`${CHAIN_KEY} current: ${show(cur)}`);
console.log(`setting:  ${show({ ...args, paused, newAdmin })}`);
if (process.env.DRY_RUN === "1") process.exit(0);
const { hash } = await send(admin, "updateConfig", [args, newAdmin, paused]);
console.log("ok", explorerTx(hash));
console.log(`now:      ${show(await readConfig())}`);
process.exit(0);
