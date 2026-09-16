// Per-network config. Which network a build talks to is decided at build time by
// VITE_CLUSTER so a devnet bundle and a mainnet bundle can never be the same file.
export type Cluster = "localnet" | "devnet" | "mainnet";
export const CLUSTER = ((import.meta.env.VITE_CLUSTER as Cluster) ?? "devnet");
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? (CLUSTER === "localnet" ? "http://127.0.0.1:8899" : CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");
export const PROGRAM_ID = import.meta.env.VITE_PROGRAM_ID ?? "8TzdVXpqa52o3fBvYynSxHTWP4zuWfZmTvSkpdLT9rWW";
export const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
export const IS_TEST = CLUSTER !== "mainnet";
export const explorerAddress = (addr: string) => `https://explorer.solana.com/address/${addr}${CLUSTER === "mainnet" ? "" : "?cluster=" + (CLUSTER === "devnet" ? "devnet" : "custom")}`;
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${CLUSTER === "mainnet" ? "" : "?cluster=" + (CLUSTER === "devnet" ? "devnet" : "custom")}`;
