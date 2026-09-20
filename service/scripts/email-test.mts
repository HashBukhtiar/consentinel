// Prove the mailer works before the demo, without filming anyone.
//
//   npm run email-test                  → sends to every contact with an email
//   npm run email-test you@gmail.com    → sends to that address only
//
// Uses the same transport and the same message the notice path uses, so a pass
// here means a real capture will mail too. Reads the key from service/.env —
// the key is never printed, and recipients are masked in the output.
import { composeEmail, maskEmail, type Contact } from "../src/notify";
import { emailDisabledReason, sendEmail } from "../src/email";
import { config } from "../src/config";
import { readFileSync } from "node:fs";
import { normalizeBadgeId } from "../../registry/client/src/core";

const override = process.argv[2];

console.log(`mode      ${config.EMAIL_MODE}`);
console.log(`from      ${config.EMAIL_FROM}`);
console.log(`key       ${config.RESEND_API_KEY ? `set (${config.RESEND_API_KEY.slice(0, 6)}…)` : "NOT SET"}`);
if (config.EMAIL_REDIRECT_TO) console.log(`redirect  ALL mail → ${maskEmail(config.EMAIL_REDIRECT_TO)} (EMAIL_REDIRECT_TO); contacts keep their own addresses on screen`);

const blocked = emailDisabledReason();
if (blocked) {
  console.error(`\n!! not sending: ${blocked}`);
  console.error(`   add these to service/.env, then re-run:\n     EMAIL_MODE=send\n     RESEND_API_KEY=re_...`);
  process.exit(1);
}

// A stand-in film-event: same shape the notice path hashes and mails about.
const entry = { eventId: "email-test", beaconId: "0027", at: Date.now(), cameraId: config.CAMERA_ID, hash: "00".repeat(32), seq: 0 };

let targets: Contact[];
if (override) {
  targets = [{ badgeId: "0027", name: "Test Recipient", email: override }];
} else {
  const j = JSON.parse(readFileSync(config.CONTACTS_FILE, "utf8"));
  targets = (j.badges ?? [])
    .filter((b: any) => b?.contact?.email)
    .map((b: any) => ({ badgeId: normalizeBadgeId(String(b.badgeId)), name: String(b.contact.name), email: String(b.contact.email) }));
}

if (!targets.length) {
  console.error(`\n!! no contacts with an email in ${config.CONTACTS_FILE} — pass an address: npm run email-test you@gmail.com`);
  process.exit(1);
}

console.log(`\nsending to ${targets.length} recipient(s)…\n`);
let failed = 0;
for (const c of targets) {
  const mail = composeEmail(c, { ...entry, beaconId: c.badgeId } as any);
  const r = await sendEmail(mail);
  if (r.ok) {
    console.log(`  ok    ${c.badgeId}  ${maskEmail(c.email!)}${r.redirectedTo ? ` → ${maskEmail(r.redirectedTo)}` : ""}  ${r.ms}ms  ${r.id ?? ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${c.badgeId}  ${maskEmail(c.email!)}  ${r.ms}ms  ${r.error}`);
  }
}

if (failed) {
  console.error(`\n${failed}/${targets.length} failed. In a real capture these would set NO channel bit, so nothing would be claimed on-chain.`);
  console.error(`If the error is a 403 about the recipient: onboarding@resend.dev only delivers to the address that owns the Resend account.`);
  console.error(`Either point the contacts at that address, or verify a domain and set EMAIL_FROM.`);
  process.exit(1);
}
console.log(`\nall ${targets.length} accepted — check the inbox. A real capture will now set CHANNEL_EMAIL on-chain.`);
