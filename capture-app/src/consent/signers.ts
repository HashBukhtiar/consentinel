// Who can sign a consent change from the operator UI:
//  - demo badge keys written by `npm run seed` (devnet only, served from
//    public/demo/badges.json — gitignored), so the on-stage "revoke" is a real
//    owner-signed transaction from the badge's own key;
//  - or an injected browser wallet (Phantom/Solflare/Backpack) whose pubkey
//    owns a record — the "it's really the person's wallet" path.
import { Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { keypairSigner, type TxSigner } from "../../../registry/client/src/registry";

export interface DemoKeys {
  cluster: string;
  owners: Map<string, TxSigner>; // owner pubkey → signer
  secrets: Map<string, Uint8Array>; // owner pubkey → secret key (for badge-signed messages)
  labels: Map<string, string>; // badgeId → label
  relayer: TxSigner | null; // funded fee payer, so badge keys never need SOL
}

export async function loadDemoKeys(): Promise<DemoKeys | null> {
  try {
    const res = await fetch("/demo/badges.json", { cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json();
    const out: DemoKeys = { cluster: j.cluster, owners: new Map(), secrets: new Map(), labels: new Map(), relayer: null };
    for (const b of j.badges ?? []) {
      const kp = Keypair.fromSecretKey(Uint8Array.from(b.secretKey));
      out.owners.set(kp.publicKey.toBase58(), keypairSigner(kp));
      out.secrets.set(kp.publicKey.toBase58(), kp.secretKey);
      out.labels.set(b.badgeId, b.label);
    }
    if (j.relayer?.secretKey) out.relayer = keypairSigner(Keypair.fromSecretKey(Uint8Array.from(j.relayer.secretKey)));
    return out;
  } catch {
    return null;
  }
}

export interface WalletProvider {
  publicKey: PublicKey | null;
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: PublicKey }>;
  disconnect?(): Promise<void>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

export function detectWallet(): WalletProvider | null {
  const w = window as any;
  return w.phantom?.solana ?? w.solana ?? w.solflare ?? w.backpack ?? null;
}

export function walletSigner(w: WalletProvider): TxSigner {
  if (!w.publicKey) throw new Error("wallet not connected");
  return { publicKey: w.publicKey, signTransaction: (tx) => w.signTransaction(tx) };
}
