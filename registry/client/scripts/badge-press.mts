// Simulates the badge's "consent button": sign the 33-byte consent message
// with the badge's own key and hand it to the notify service's relayer
// endpoint, exactly as the ESP32 firmware would (no SOL, no Solana stack on
// the badge). The service submits the Ed25519-verified transaction.
//   npm run badge-press -- A1B2 grant|revoke|toggle
import { SERVICE_URL, badgeKeyPath, client, loadKeypair } from "./_env.mts";
import { signConsentMessage } from "../src/registry";
import { toHex } from "../src/core";

const [badgeId, action = "toggle"] = process.argv.slice(2);
if (!badgeId) throw new Error("usage: badge-press <BADGE_ID> [grant|revoke|toggle]");
const badge = loadKeypair(badgeKeyPath(badgeId));
const { reg } = client();
const cur = await reg.fetchConsent(badgeId);
if (!cur) throw new Error(`${badgeId} is not registered`);
const consent = action === "grant" ? true : action === "revoke" ? false : !cur.consent;
const { signature, publicKey } = signConsentMessage(badge.secretKey, badgeId, consent, cur.revision);
const body = { badgeId, consent, nonce: cur.revision, owner: publicKey.toBase58(), signature: toHex(signature) };
console.log(`POST ${SERVICE_URL}/consent/delegated`, body);
const res = await fetch(`${SERVICE_URL}/consent/delegated`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
console.log(res.status, await res.text());
