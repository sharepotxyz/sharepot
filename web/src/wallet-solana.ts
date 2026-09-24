// Wallet Standard connection: works with Phantom, Solflare, Backpack and Seed Vault Wallet without per-wallet adapters.
// Selected as "@wallet" when VITE_CHAIN is not "evm".
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { buildPlaceBetTx, confirmBySig, connection } from "./chain-solana";
import { CLUSTER } from "./config";
import type { MarketView, Session, SignInInput, SignInOutput, WalletChoice } from "./chain-core";
export type { Session, SignInInput, SignInOutput, WalletChoice };

const chain = CLUSTER === "mainnet" ? "solana:mainnet" : CLUSTER === "devnet" ? "solana:devnet" : "solana:localnet";

export function listWallets(): WalletChoice[] {
  return getWallets().get().filter((w) => "solana:signAndSendTransaction" in w.features || "solana:signTransaction" in w.features).map((w) => ({ name: w.name, icon: w.icon, handle: w }));
}

/** Sign, send and wait: the transaction id once the stake is confirmed. */
async function betWith(signAndSend: (tx: Transaction) => Promise<string>, publicKey: PublicKey, m: MarketView, bucket: number, amount: number, onSent?: (txid: string) => void) {
  const sig = await signAndSend(await buildPlaceBetTx(publicKey, m, bucket, amount));
  onSent?.(sig);
  await confirmBySig(sig);
  return sig;
}

export async function connectWallet(choice: WalletChoice): Promise<Session> {
  const w = choice.handle as Wallet;
  const connect = (w.features as any)["standard:connect"];
  const { accounts } = await connect.connect();
  const acc: WalletAccount = accounts.find((a: WalletAccount) => a.chains.includes(chain as any)) ?? accounts[0];
  if (!acc) throw new Error("wallet returned no account");
  const publicKey = new PublicKey(acc.publicKey);
  const signAndSend = async (tx: Transaction) => {
    const f = w.features as any;
    if (f["solana:signAndSendTransaction"]) {
      const [{ signature }] = await f["solana:signAndSendTransaction"].signAndSendTransaction({ account: acc, chain, transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }) });
      return encodeSig(signature);
    }
    const [{ signedTransaction }] = await f["solana:signTransaction"].signTransaction({ account: acc, chain, transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }) });
    return connection.sendRawTransaction(signedTransaction, { skipPreflight: false });
  };
  const disconnect = async () => { try { await (w.features as any)["standard:disconnect"]?.disconnect(); } catch {} };
  const signMessage = async (message: Uint8Array) => { const f = (w.features as any)["solana:signMessage"]; if (!f) throw new Error("This wallet cannot sign messages"); const [{ signature }] = await f.signMessage({ account: acc, message }); return signature as Uint8Array; };
  const signIn = (w.features as any)["solana:signIn"] ? async (input: SignInInput) => { const [{ signedMessage, signature }] = await (w.features as any)["solana:signIn"].signIn(input); return { signedMessage, signature }; } : undefined;
  return { label: w.name, address: publicKey.toBase58(), placeBet: (m, b, a, onSent) => betWith(signAndSend, publicKey, m, b, a, onSent), signMessage, signIn, disconnect };
}

/** Test-only burner wallet kept in localStorage (never offered on mainnet). */
export function devWallet(): Session | null {
  if (CLUSTER === "mainnet") return null;
  let kp: Keypair;
  try {
    const raw = localStorage.getItem("sharepot.devwallet");
    kp = raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))) : Keypair.generate();
    localStorage.setItem("sharepot.devwallet", JSON.stringify(Array.from(kp.secretKey)));
  } catch { kp = Keypair.generate(); }
  const signAndSend = async (tx: Transaction) => {
    tx.sign(kp);
    // public devnet RPC rate-limits bursts; resend the same signed bytes a few times (a duplicate cannot land twice)
    for (let i = 0; ; i++) {
      try { return await connection.sendRawTransaction(tx.serialize()); }
      catch (e: any) { if (i >= 4 || !/429|rate limit/i.test(String(e?.message ?? e))) throw e; await new Promise((r) => setTimeout(r, 800 * 2 ** i)); }
    }
  };
  return {
    label: "Test wallet (browser)", address: kp.publicKey.toBase58(),
    placeBet: (m, b, a, onSent) => betWith(signAndSend, kp.publicKey, m, b, a, onSent),
    signMessage: async (message: Uint8Array) => (await import("tweetnacl")).default.sign.detached(message, kp.secretKey),
    disconnect: async () => {},
  };
}

/** Signatures travel to the API as base58 on Solana. */
export function encodeSig(bytes: Uint8Array) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let x = BigInt(0); for (const b of bytes) x = x * 256n + BigInt(b);
  let s = ""; while (x > 0n) { s = A[Number(x % 58n)] + s; x /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
export { VersionedTransaction };
