import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { resolve } from "path";
export default defineConfig({
  plugins: [nodePolyfills({ include: ["buffer", "process", "stream", "util"], globals: { Buffer: true, process: true } })],
  build: { target: "es2020", rollupOptions: { input: { main: resolve(__dirname, "index.html"), market: resolve(__dirname, "market.html"), portfolio: resolve(__dirname, "portfolio.html") } } },
  define: { "process.env.ANCHOR_BROWSER": true },
});
