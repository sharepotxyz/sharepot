// pm2 process list for the devnet deployment (runs as the `sharepot` unix user).
//   pm2 start deploy/ecosystem.config.cjs && pm2 save
// The API reads program state through the public devnet RPC (getProgramAccounts every 15 s) and serves web/dist.
const HOME = "/home/sharepot";
const fs = require("fs");
// The provider endpoint the crons use (one line in the secrets dir): the faucet sends through it, the state polling does not.
let FAUCET_RPC = ""; try { FAUCET_RPC = fs.readFileSync(`${HOME}/secrets/devnet/rpc-url`, "utf8").trim(); } catch {}
module.exports = {
  apps: [
    {
      name: "sharepot-api",
      cwd: `${HOME}/apps/sharepot`,
      script: "server/api.mjs",
      env: {
        CLUSTER: "devnet",
        CLUSTER_RPC: "https://api.devnet.solana.com",
        SHAREPOT_SECRETS: `${HOME}/secrets/devnet`,
        DATA_DIR: `${HOME}/data`,
        PORT: "5041",
        ...(FAUCET_RPC ? { FAUCET_RPC } : {}),
      },
      max_memory_restart: "300M",
      out_file: `${HOME}/logs/api.out.log`,
      error_file: `${HOME}/logs/api.err.log`,
    },
  ],
};
