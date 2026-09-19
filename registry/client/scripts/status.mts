// One-screen status: program, deployer balance, every consent record, camera
// audit heads. Use it to sanity-check the deployment before the demo.
import { CLUSTER, RPC_URL, addr, client, deployerKeypair } from "./_env.mts";

const { conn, reg } = client();
const deployer = deployerKeypair();
console.log(`cluster  ${CLUSTER}  ${RPC_URL}`);
console.log(`program  ${reg.programId.toBase58()}  ${addr(reg.programId)}`);
const info = await conn.getAccountInfo(reg.programId);
console.log(`deployed ${info ? "yes" : "NO — run anchor deploy"}`);
console.log(`deployer ${deployer.publicKey.toBase58()}  ${((await conn.getBalance(deployer.publicKey)) / 1e9).toFixed(3)} SOL`);
const snap = await reg.fetchAll();
console.log(`\nconsent records (${snap.consents.length}) @ slot ${snap.slot}`);
for (const c of snap.consents)
  console.log(`  ${c.badgeId}  ${c.consent ? "opt_in " : "opt_out"}  rev=${c.revision}  owner=${c.owner}  updated=${new Date(c.updatedAt * 1000).toLocaleTimeString()}`);
if (snap.overrides.length) {
  console.log(`\nevent overrides (${snap.overrides.length})`);
  for (const o of snap.overrides) console.log(`  ${o.badgeId} @ ${o.eventId}  ${o.consent ? "opt_in" : "opt_out"}`);
}
console.log(`\ncameras (${snap.cameras.length})`);
for (const c of snap.cameras) console.log(`  ${c.label}  count=${c.count}  head=${c.head}  authority=${c.authority}`);
