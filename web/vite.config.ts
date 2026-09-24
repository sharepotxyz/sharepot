import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { resolve } from "path";
// One bundle per chain: VITE_CHAIN=evm builds the Robinhood Chain site (viem, EIP-1193 wallets); anything else the
// Solana one. The pages import "@chain" and "@wallet"; which files those are is decided here.
const evm = process.env.VITE_CHAIN === "evm";
export default defineConfig({
  plugins: [nodePolyfills({ include: ["buffer", "process", "stream", "util"], globals: { Buffer: true, process: true } })],
  resolve: { alias: { "@chain": resolve(__dirname, evm ? "src/chain-evm.ts" : "src/chain-solana.ts"), "@wallet": resolve(__dirname, evm ? "src/wallet-evm.ts" : "src/wallet-solana.ts") } },
  build: { target: "es2020", outDir: process.env.VITE_OUT_DIR || "dist", rollupOptions: { input: { main: resolve(__dirname, "index.html"), market: resolve(__dirname, "market.html"), portfolio: resolve(__dirname, "portfolio.html"), faucet: resolve(__dirname, "faucet.html"), docs: resolve(__dirname, "docs.html"), leaderboard: resolve(__dirname, "leaderboard.html"), invite: resolve(__dirname, "invite.html") } } },
  define: { "process.env.ANCHOR_BROWSER": true },
});
