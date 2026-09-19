// On-stage backup for the live beat: flip a badge's consent from the CLI.
//   npm run toggle -- A1B2 revoke            (owner-signed; deployer pays the fee)
//   npm run toggle -- A1B2 grant --delegated (badge signs the 49-byte message,
//                                             deployer relays; exercises the
//                                             Ed25519-verified path)
//   npm run toggle -- A1B2 close             (delete the record ⇒ fail-safe blur)
import { addr, badgeKeyPath, client, deployerKeypair, keypairSigner, loadKeypair, tx } from "./_env.mts";

const [badgeId, action = "toggle"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const delegated = process.argv.includes("--delegated");
if (!badgeId) throw new Error("usage: toggle <BADGE_ID> [grant|revoke|toggle|close] [--delegated]");

const { reg } = client();
const deployer = keypairSigner(deployerKeypair());
const badge = loadKeypair(badgeKeyPath(badgeId));
const owner = keypairSigner(badge);

const before = await reg.fetchConsent(badgeId);
if (!before) throw new Error(`${badgeId} is not registered — run npm run seed`);
console.log(`${badgeId} before: consent=${before.consent} rev=${before.revision} inst=${before.instance} owner=${before.owner}`);

const target = action === "grant" ? true : action === "revoke" ? false : action === "toggle" ? !before.consent : null;
const t0 = Date.now();
let sig: string;
if (action === "close") {
  sig = await reg.closeConsent(owner, badgeId, deployer);
} else if (delegated) {
  sig = await reg.setConsentAsBadge(deployer, badge.secretKey, badgeId, target!);
} else {
  sig = await reg.setConsent(owner, badgeId, target!, deployer);
}
const after = await reg.fetchConsent(badgeId);
console.log(`confirmed in ${((Date.now() - t0) / 1000).toFixed(1)}s  ${tx(sig)}`);
console.log(after ? `${badgeId} after:  consent=${after.consent} rev=${after.revision}  ${addr(after.address)}` : `${badgeId} record closed ⇒ capture app fail-safes to blur`);
