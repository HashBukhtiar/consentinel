// One-screen status: program, deployer balance, every consent record, camera
// audit heads. Use it to sanity-check the deployment before the demo.
import { CLUSTER, RPC_URL, addr, client, deployerKeypair } from "./_env.mts";
import { channelNames } from "../src/core";

const { conn, reg } = client();
const deployer = deployerKeypair();
console.log(`cluster  ${CLUSTER}  ${RPC_URL}`);
console.log(`program  ${reg.programId.toBase58()}  ${addr(reg.programId)}`);
const info = await conn.getAccountInfo(reg.programId);
console.log(`deployed ${info ? "yes" : "NO — run anchor deploy"}`);
console.log(`deployer ${deployer.publicKey.toBase58()}  ${((await conn.getBalance(deployer.publicKey)) / 1e9).toFixed(3)} SOL`);
const snap = await reg.fetchAll();
console.log(`registry ${snap.registry ? `issuer=${snap.registry.issuer} registrations=${snap.registry.registrations}` : "NOT INITIALIZED — run npm run seed"}`);
console.log(`\nconsent records (${snap.consents.length}) @ slot ${snap.slot}`);
for (const c of snap.consents)
  console.log(`  ${c.badgeId}  ${c.consent ? "opt_in " : "opt_out"}  rev=${c.revision}  inst=${c.instance}  owner=${c.owner}  updated=${new Date(c.updatedAt * 1000).toLocaleTimeString()}`);
if (snap.overrides.length) {
  console.log(`\nevent overrides (${snap.overrides.length})`);
  for (const o of snap.overrides) console.log(`  ${o.badgeId} @ ${o.eventId}  ${o.consent ? "opt_in" : "opt_out"}  owner=${o.owner}`);
}
console.log(`\ncameras (${snap.cameras.length})`);
for (const c of snap.cameras) console.log(`  ${c.label}  count=${c.count}  head=${c.head}  authority=${c.authority}`);
const notices = snap.captures.sort((a, b) => b.recordedAt - a.recordedAt);
console.log(`\ncapture notices (${notices.length}) — filmed / told, per film-event of an opted-out badge`);
for (const n of notices.slice(0, 10))
  console.log(`  ${n.badgeId}  filmed=${new Date(n.filmedAt * 1000).toLocaleTimeString()}  filed=${new Date(n.recordedAt * 1000).toLocaleTimeString()}  told=${n.notifiedAt ? `${new Date(n.notifiedAt * 1000).toLocaleTimeString()} via ${channelNames(n.channels).join("+")}` : "pending"}  ${addr(n.address)}`);
if (notices.length > 10) console.log(`  … ${notices.length - 10} more`);
