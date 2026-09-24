// Per-network config. Which chain and network a build talks to is decided at build time (VITE_CHAIN, VITE_CLUSTER) so a
// Solana bundle and a Robinhood Chain bundle, a devnet bundle and a mainnet bundle, can never be the same file. The
// chain-specific modules are picked by the bundler too: "@chain" and "@wallet" resolve to chain-solana / wallet-solana
// or chain-evm / wallet-evm (vite.config.ts); every page only ever imports those two names.
export type Cluster = "localnet" | "devnet" | "mainnet";
export type ChainKind = "solana" | "evm";
export const CHAIN: ChainKind = (import.meta.env.VITE_CHAIN as ChainKind) === "evm" ? "evm" : "solana";
export const IS_EVM = CHAIN === "evm";

// Solana
export const CLUSTER = ((import.meta.env.VITE_CLUSTER as Cluster) ?? "devnet");
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? (CLUSTER === "localnet" ? "http://127.0.0.1:8899" : CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");
export const PROGRAM_ID = import.meta.env.VITE_PROGRAM_ID ?? "8TzdVXpqa52o3fBvYynSxHTWP4zuWfZmTvSkpdLT9rWW";

// EVM (Robinhood Chain): the SharePot contract address is baked into the bundle, like the program id above.
export const EVM = {
  chainId: Number(import.meta.env.VITE_EVM_CHAIN_ID ?? 46630),
  name: (import.meta.env.VITE_EVM_NAME as string | undefined) ?? "Robinhood Chain Testnet",
  rpc: (import.meta.env.VITE_EVM_RPC as string | undefined) ?? "https://rpc.testnet.chain.robinhood.com",
  pot: (import.meta.env.VITE_EVM_POT as string | undefined) ?? "",
  explorer: (import.meta.env.VITE_EVM_EXPLORER as string | undefined) ?? "https://explorer.testnet.chain.robinhood.com",
  test: (import.meta.env.VITE_EVM_TEST ?? "1") !== "0",
  /** Where the issuer hands out test ETH and test stock tokens (the site has no faucet of its own on this chain). */
  faucet: (import.meta.env.VITE_EVM_FAUCET as string | undefined) ?? "https://faucet.testnet.chain.robinhood.com",
};

export const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
export const IS_TEST = IS_EVM ? EVM.test : CLUSTER !== "mainnet";
/** Short: the chain switch already names the chain, so the badge only says which network of it. */
export const NETWORK_NAME = IS_EVM ? (EVM.test ? "Testnet" : "Mainnet") : CLUSTER === "devnet" ? "Devnet" : CLUSTER;
/** The gas token: what the wallet button shows next to the address and what a low balance warns about. */
export const NATIVE = IS_EVM ? "ETH" : "SOL";
export const NATIVE_LOW = IS_EVM ? 0.0005 : 0.002;
/** The same product on the other chain, for the switch in the top bar (empty = no switch). */
export const OTHER_CHAIN = { name: (import.meta.env.VITE_OTHER_CHAIN_NAME as string | undefined) ?? "", url: (import.meta.env.VITE_OTHER_CHAIN_URL as string | undefined) ?? "" };
export const THIS_CHAIN_NAME = IS_EVM ? "Robinhood" : "Solana";
// Features the API only provides for Solana so far (they verify ed25519 wallet signatures).
export const HAS_REFERRALS = !IS_EVM;
export const HAS_DISPUTES = !IS_EVM;
export const HAS_FAUCET_API = !IS_EVM;
/** A test EVM network: the API hands a little ETH for fees to any address (the browser test wallet has none). */
export const HAS_GAS_FAUCET = IS_EVM && IS_TEST;

// Only a well-formed id ever goes into an explorer link; anything else links nowhere (these land in href attributes).
const b58 = (s: unknown) => (typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(s) ? s : null);
const hex = (s: unknown, n: number) => (typeof s === "string" && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(s) ? s : null);
export const isTxId = (s: unknown) => (IS_EVM ? !!hex(s, 64) : !!b58(s));
export const isAddress = (s: unknown) => (IS_EVM ? !!hex(s, 40) : !!b58(s));
const solanaSuffix = CLUSTER === "mainnet" ? "" : "?cluster=" + (CLUSTER === "devnet" ? "devnet" : "custom");
export const explorerAddress = (addr: string) => (IS_EVM ? (hex(addr, 40) ? `${EVM.explorer}/address/${addr}` : "#") : b58(addr) ? `https://explorer.solana.com/address/${addr}${solanaSuffix}` : "#");
export const explorerTx = (id: string) => (IS_EVM ? (hex(id, 64) ? `${EVM.explorer}/tx/${id}` : "#") : b58(id) ? `https://explorer.solana.com/tx/${id}${solanaSuffix}` : "#");
