// Register just this camera's audit log on-chain — the one prerequisite for the
// notice path (`record_capture` / `record_notice`) and for attestation.
//
//   npx tsx scripts/register-camera.mts [label]
//
// Unlike `seed`, this needs NO issuer key: `register_camera` is permissionless
// (RegisterCamera takes no Registry account), so a camera can stand up its own
// log with nothing but a funded keypair. Badge registration still needs the
// issuer — this script deliberately does not touch it.
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ConsentRegistryClient, keypairSigner } from "../client/src/registry";
import { explorerUrl } from "../client/src/core";

const label = process.argv[2] ?? "cam-1";
const cluster = (process.env.SOLANA_CLUSTER ?? "devnet") as "devnet" | "localnet";
const rpc = process.env.SOLANA_RPC_URL ?? (cluster === "localnet" ? "http://127.0.0.1:8899" : `https://api.${cluster}.solana.com`);
const path = process.env.CAMERA_KEYPAIR ?? `keys/camera-${label}.json`;

mkdirSync("keys", { recursive: true });
let kp: Keypair;
if (existsSync(path)) {
  kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  console.log(`camera key   ${path} (existing)`);
} else {
  kp = Keypair.generate();
  writeFileSync(path, JSON.stringify([...kp.secretKey]));
  console.log(`camera key   ${path} (generated)`);
}
console.log(`pubkey       ${kp.publicKey.toBase58()}`);
console.log(`cluster      ${cluster}  ${rpc}`);

const conn = new Connection(rpc, "confirmed");
const reg = new ConsentRegistryClient(conn);

const bal = await conn.getBalance(kp.publicKey);
console.log(`balance      ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
if (bal < 0.02 * LAMPORTS_PER_SOL) {
  console.error(`\n!! not enough SOL to pay rent + fees.`);
  console.error(`   fund it at https://faucet.solana.com (0.5 SOL is plenty):`);
  console.error(`   ${kp.publicKey.toBase58()}`);
  process.exit(1);
}

const existing = await reg.fetchCamera(kp.publicKey);
if (existing) {
  console.log(`\nalready registered — label "${existing.label}", count ${existing.count}, head ${existing.head.slice(0, 16)}…`);
  console.log(`nothing to do.`);
  process.exit(0);
}

console.log(`\nregistering camera log "${label}"…`);
const sig = await reg.registerCamera(keypairSigner(kp), label);
console.log(`  tx  ${sig}`);
console.log(`      ${explorerUrl("tx", sig, cluster)}`);

const now = await reg.fetchCamera(kp.publicKey);
console.log(`\nregistered: label "${now?.label}", count ${now?.count}, head ${now?.head.slice(0, 16)}…`);
console.log(`the service will now report cameraRegistered: true and can file notices.`);
