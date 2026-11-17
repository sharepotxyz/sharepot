// pm2 process for the SharePot Perp site on Base Sepolia: static pages from web/dist-base + /api/health + /api/gas, on
// 127.0.0.1:5043 (Caddy fronts it as base.sharepot.xyz). Runs as the `sharepot` unix user next to the other two sites.
//   pm2 start deploy/ecosystem.base.config.cjs && pm2 save
// The gas faucet pays from the same low-balance key as the Robinhood site's (a separate balance on this chain).
const HOME = "/home/sharepot";
module.exports = {
  apps: [
    {
      name: "sharepot-base",
      cwd: `${HOME}/apps/sharepot`,
      script: "server/evm/perp-site.mjs",
      env: { EVM_CHAIN: "base-sepolia", STATIC_DIR: `${HOME}/apps/sharepot/web/dist-base`, DATA_DIR: `${HOME}/data`, PORT: "5043", EVM_FAUCET_KEY_FILE: `${HOME}/secrets/evm/faucet.key` },
      max_memory_restart: "200M",
      out_file: `${HOME}/logs/base-site.out.log`,
      error_file: `${HOME}/logs/base-site.err.log`,
    },
  ],
};
