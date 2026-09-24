// EVM wallets (MetaMask, Rabby, Coinbase Wallet, Robinhood Wallet, …) over EIP-6963 discovery with the plain
// window.ethereum as fallback, plus a browser test wallet on test networks (a key kept in localStorage, like the
// Solana one). Selected as "@wallet" when VITE_CHAIN=evm. Staking is two signatures the first time (an ERC-20
// approval for the contract, then the bet) and one after that.
import { createWalletClient, custom, http, parseAbiItem, type Address, type EIP1193Provider, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { abi, erc20Abi, potAddress, publicClient } from "./chain-evm";
import { EVM, IS_TEST } from "./config";
import type { MarketView, Session, SignInInput, SignInOutput, WalletChoice } from "./chain-core";
export type { Session, SignInInput, SignInOutput, WalletChoice };

type Announced = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider };
const announced = new Map<string, Announced>();
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e: any) => { const d = e.detail as Announced; if (d?.info?.uuid) announced.set(d.info.uuid, d); });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}
export function listWallets(): WalletChoice[] {
  const list: WalletChoice[] = [...announced.values()].map((a) => ({ name: a.info.name, icon: a.info.icon, handle: a.provider }));
  const eth = (window as any).ethereum as EIP1193Provider | undefined;
  if (eth && !list.length) list.push({ name: eth && (eth as any).isMetaMask ? "MetaMask" : "Browser wallet", handle: eth });
  return list;
}

const chain = { id: EVM.chainId, name: EVM.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [EVM.rpc] } } } as const;
const chainHex = `0x${EVM.chainId.toString(16)}`;
/** Ask the wallet for this chain; add it first if the wallet has never seen it. */
async function ensureChain(provider: EIP1193Provider) {
  const cur = (await provider.request({ method: "eth_chainId" })) as string;
  if (parseInt(cur, 16) === EVM.chainId) return;
  try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] }); }
  catch (e: any) {
    if (e?.code !== 4902 && !/unrecognized|not added|4902/i.test(String(e?.message ?? ""))) throw e;
    await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: chainHex, chainName: EVM.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [EVM.rpc], blockExplorerUrls: [EVM.explorer] }] });
  }
}
/** Wait for a sent transaction; "not seen in time" is reported as unconfirmed, never as failed. */
async function wait(hash: `0x${string}`) {
  try { const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 1500 }); if (r.status !== "success") throw new Error("Transaction failed: " + hash); }
  catch (e: any) { if (/timed? ?out|Timed out/i.test(String(e?.message ?? e))) throw Object.assign(new Error("Not confirmed after 90s. Check transaction " + hash), { unconfirmed: true, txid: hash }); throw e; }
}

/** The session behind both kinds of wallet: the same approve-then-bet flow, signed by whichever client. */
function sessionFor(label: string, account: Address, client: WalletClient, before: () => Promise<void>, signMessage: Session["signMessage"]): Session {
  const placeBet = async (m: MarketView, bucket: number, amountRaw: number, onSent?: (txid: string) => void) => {
    await before();
    // The token to approve is the one the contract records for this market, never the one a listing named: a wrong
    // or forged API answer can then at most fail the bet, not make the wallet approve another token.
    const onChain = (await publicClient.readContract({ address: potAddress, abi, functionName: "getMarket", args: [BigInt(m.id)] })) as any;
    const token = onChain.token as Address, amount = BigInt(Math.round(amountRaw));
    if (token.toLowerCase() !== m.mint.toLowerCase()) throw new Error("This market's token does not match the listing; reload the page.");
    const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, potAddress] });
    if (allowance < amount) {
      const h = await client.writeContract({ account, chain, address: token, abi: erc20Abi, functionName: "approve", args: [potAddress, 2n ** 256n - 1n] });
      await wait(h);
    }
    const { request } = await publicClient.simulateContract({ account, address: potAddress, abi, functionName: "placeBet", args: [BigInt(m.id), bucket, amount] });
    const hash = await client.writeContract({ ...request, account, chain });
    onSent?.(hash);
    await wait(hash);
    return hash;
  };
  const mintMock = async (token: string, amountRaw: bigint) => {
    await before();
    const hash = await client.writeContract({ account, chain, address: token as Address, abi: [parseAbiItem("function mint(address to, uint256 amount)")], functionName: "mint", args: [account, amountRaw] });
    await wait(hash);
    return hash;
  };
  return { label, address: account, placeBet, signMessage, mintMock, disconnect: async () => {} };
}

export async function connectWallet(choice: WalletChoice): Promise<Session> {
  const provider = choice.handle as EIP1193Provider;
  const [addr] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!addr) throw new Error("wallet returned no account");
  await ensureChain(provider);
  const account = addr as Address;
  const client = createWalletClient({ account, transport: custom(provider) });
  const signMessage = async (message: Uint8Array) => hexToBytes(await client.signMessage({ account, message: { raw: message } }));
  return sessionFor(choice.name, account, client, () => ensureChain(provider), signMessage);
}

/** Test-only burner wallet kept in localStorage (never offered on mainnet). Its fees come from the site's gas faucet
 *  (faucet page); test memes it mints itself; the issuer's test stock tokens can be claimed for its address on
 *  Robinhood's faucet like for any other wallet. */
export function devWallet(): Session | null {
  if (!IS_TEST) return null;
  let key: `0x${string}`;
  try {
    const raw = localStorage.getItem("sharepot.evm.devwallet");
    key = raw && /^0x[0-9a-fA-F]{64}$/.test(raw) ? (raw as `0x${string}`) : generatePrivateKey();
    localStorage.setItem("sharepot.evm.devwallet", key);
  } catch { key = generatePrivateKey(); }
  const account = privateKeyToAccount(key);
  const client = createWalletClient({ account, chain, transport: http(EVM.rpc, { retryCount: 3, retryDelay: 800 }) });
  const signMessage = async (message: Uint8Array) => hexToBytes(await account.signMessage({ message: { raw: message } }));
  return sessionFor("Test wallet (browser)", account.address, client, async () => {}, signMessage);
}

const hexToBytes = (sig: string) => Uint8Array.from(sig.slice(2).match(/.{2}/g)!.map((x) => parseInt(x, 16)));
/** Signatures travel to the API as 0x-hex on EVM chains. */
export const encodeSig = (bytes: Uint8Array) => "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
