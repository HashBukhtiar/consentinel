// Generate (or reuse) the demo badge keypairs + camera keypair on disk.
// These are DEVNET DEMO KEYS: in the product the badge key lives on the badge.
import { readSeed, badgeKeyPath, cameraKeyPath, ensureKeypair, KEYS_DIR } from "./_env.mts";

const seed = readSeed();
console.log(`keys dir: ${KEYS_DIR}`);
for (const b of seed.badges) {
  const kp = ensureKeypair(badgeKeyPath(b.badgeId));
  console.log(`badge ${b.badgeId}  owner ${kp.publicKey.toBase58()}  (${b.label})`);
}
const cam = ensureKeypair(cameraKeyPath(seed.cameraLabel));
console.log(`camera ${seed.cameraLabel}  authority ${cam.publicKey.toBase58()}`);
