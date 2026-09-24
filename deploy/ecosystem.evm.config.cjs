// pm2 process for the Robinhood Chain (EVM) site: the read API + static pages from web/dist-evm, on 127.0.0.1:5042
// (Caddy fronts it as robinhood.sharepot.xyz). Runs as the `sharepot` unix user next to the Solana process.
//   pm2 start deploy/ecosystem.evm.config.cjs && pm2 save
// The chain's SharePot address and RPC live in ~/secrets/evm/robinhood-testnet.env on the host (EVM_RPC optional).
const HOME = "/home/sharepot";
const fs = require("fs");
const env = {};
try { for (const l of fs.readFileSync(`${HOME}/secrets/evm/robinhood-testnet.env`, "utf8").split("\n")) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !m[1].includes("KEY")) env[m[1]] = m[2]; } } catch {}
module.exports = {
  apps: [
    {
      name: "sharepot-evm",
      cwd: `${HOME}/apps/sharepot`,
      script: "server/evm/api.mjs",
      env: { EVM_CHAIN: "robinhood-testnet", DATA_DIR: `${HOME}/data`, STATIC_DIR: `${HOME}/apps/sharepot/web/dist-evm`, PORT: "5042", EVM_FAUCET_KEY_FILE: `${HOME}/secrets/evm/faucet.key`, ...env },
      max_memory_restart: "300M",
      out_file: `${HOME}/logs/evm-api.out.log`,
      error_file: `${HOME}/logs/evm-api.err.log`,
    },
  ],
};
