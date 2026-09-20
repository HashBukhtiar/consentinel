// Shared bits for the demo scripts: RPC, deployer wallet, badge keys on disk.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConsentRegistryClient, keypairSigner } from "../src/registry";
import { explorerUrl, type Cluster } from "../src/core";

export const REGISTRY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO_DIR = resolve(REGISTRY_DIR, "..");
export const KEYS_DIR = join(REGISTRY_DIR, "keys");
export const SEED_FILE = join(REPO_DIR, "data", "demo", "seed-consents.json");
export const APP_DEMO_KEYS = join(REPO_DIR, "capture-app", "public", "demo", "badges.json");

export const CLUSTER = (process.env.SOLANA_CLUSTER ?? "devnet") as Cluster;
export const RPC_URL =
  process.env.SOLANA_RPC_URL ?? (CLUSTER === "localnet" ? "http://127.0.0.1:8899" : `https://api.${CLUSTER}.solana.com`);
export const SERVICE_URL = process.env.SERVICE_URL ?? "http://localhost:8787";

export interface SeedFile {
  cluster: string;
  cameraLabel: string;
  eventId: string;
  badges: { badgeId: string; consent: boolean; label: string; contact?: { name: string; email?: string } }[];
}

export function readSeed(): SeedFile {
  return JSON.parse(readFileSync(SEED_FILE, "utf8"));
}

export function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function saveKeypair(path: string, kp: Keypair): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
}

/** Load-or-create a keypair file (Solana CLI JSON format, so `solana-keygen` reads it too). */
export function ensureKeypair(path: string): Keypair {
  if (existsSync(path)) return loadKeypair(path);
  const kp = Keypair.generate();
  saveKeypair(path, kp);
  return kp;
}

export function deployerKeypair(): Keypair {
  const p = process.env.ANCHOR_WALLET ?? join(homedir(), ".config", "solana", "id.json");
  if (!existsSync(p)) throw new Error(`no wallet at ${p} — run: solana-keygen new`);
  return loadKeypair(p);
}

export function badgeKeyPath(badgeId: string): string {
  return join(KEYS_DIR, `badge-${badgeId.toUpperCase()}.json`);
}
export function cameraKeyPath(label: string): string {
  return join(KEYS_DIR, `camera-${label}.json`);
}
export const RELAYER_KEY_PATH = join(KEYS_DIR, "relayer.json");

/** Top up `to` from `from` so it holds at least `minSol` (devnet/localnet demo plumbing). */
export async function topUp(conn: Connection, from: Keypair, to: PublicKey, minSol: number, amountSol: number): Promise<boolean> {
  if ((await conn.getBalance(to)) >= minSol * 1e9) return false;
  const { SystemProgram, Transaction } = await import("@solana/web3.js");
  const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Math.round(amountSol * 1e9) }));
  const sig = await conn.sendTransaction(t, [from]);
  await conn.confirmTransaction(sig, "confirmed");
  return true;
}

export function client(): { conn: Connection; reg: ConsentRegistryClient } {
  const conn = new Connection(RPC_URL, "confirmed");
  return { conn, reg: new ConsentRegistryClient(conn) };
}

export const tx = (sig: string) => explorerUrl("tx", sig, CLUSTER);
export const addr = (a: string | PublicKey) => explorerUrl("address", a.toString(), CLUSTER);
export { keypairSigner };

export async function ensureFunded(conn: Connection, pk: PublicKey, minSol = 0.5): Promise<number> {
  let bal = await conn.getBalance(pk);
  if (bal >= minSol * 1e9) return bal;
  if (CLUSTER === "mainnet-beta") throw new Error("wallet is underfunded");
  for (let i = 0; i < 3 && bal < minSol * 1e9; i++) {
    try {
      const sig = await conn.requestAirdrop(pk, 1e9);
      await conn.confirmTransaction(sig, "confirmed");
    } catch (e) {
      console.warn(`airdrop attempt ${i + 1} failed: ${(e as Error).message.split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    bal = await conn.getBalance(pk);
  }
  return bal;
}
