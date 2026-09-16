import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { resolve } from "path";
export default defineConfig({
  plugins: [nodePolyfills({ include: ["buffer", "process", "stream", "util"], globals: { Buffer: true, process: true } })],
  build: { target: "es2020", rollupOptions: { input: { main: resolve(__dirname, "index.html"), market: resolve(__dirname, "market.html"), portfolio: resolve(__dirname, "portfolio.html"), faucet: resolve(__dirname, "faucet.html"), docs: resolve(__dirname, "docs.html"), leaderboard: resolve(__dirname, "leaderboard.html") } } },
  define: { "process.env.ANCHOR_BROWSER": true },
});
