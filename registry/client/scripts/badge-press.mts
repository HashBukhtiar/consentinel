// Simulates the badge's "consent button": read the record's nonce + instance
// from the service, sign the 49-byte consent message with the badge's own
// key, and hand it to the notify service's relayer endpoint — exactly as the
// ESP32 firmware does (no SOL, no Solana stack on the badge). The service
// submits the Ed25519-verified transaction and pays the fee.
//   npm run badge-press -- A1B2 grant|revoke|toggle
import { SERVICE_URL, badgeKeyPath, loadKeypair } from "./_env.mts";
import { signConsentMessage } from "../src/registry";
import { toHex } from "../src/core";

const [badgeId, action = "toggle"] = process.argv.slice(2);
if (!badgeId) throw new Error("usage: badge-press <BADGE_ID> [grant|revoke|toggle]");
const badge = loadKeypair(badgeKeyPath(badgeId));

const st = await (await fetch(`${SERVICE_URL}/badge/${badgeId}/consent`)).json();
if (!st.registered) throw new Error(`${badgeId} is not registered`);
const consent = action === "grant" ? true : action === "revoke" ? false : !st.consent;
const expiresAt = st.serverTime + 120;
const { signature, publicKey } = signConsentMessage(badge.secretKey, badgeId, { consent, nonce: st.nonce, instance: st.instance, expiresAt });
const body = { badgeId, consent, nonce: st.nonce, instance: st.instance, expiresAt, owner: publicKey.toBase58(), signature: toHex(signature) };
console.log(`POST ${SERVICE_URL}/consent/delegated`, body);
const res = await fetch(`${SERVICE_URL}/consent/delegated`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
console.log(res.status, await res.text());
