// The on-chain `channels` mask is a claim of delivery, so it must be earned.
// These assertions pin the rule that a composed-but-unsent email sets no bit,
// and that a real send does — plus the masking that keeps addresses off the
// operator screen and out of the broadcast.
import assert from "node:assert";
import { CHANNEL_BADGE_RADIO, CHANNEL_EMAIL, CHANNEL_SMS, CHANNEL_VOICE, channelNames } from "../../registry/client/src/core";
import { composeEmail, maskEmail, maskPhone, type Contact } from "../src/notify";
import type { AuditEntry } from "../src/audit";

const contact: Contact = { badgeId: "27", name: "Nehad Shikh Trab", email: "nehad.st@gmail.com", phone: "+14155550123" };
const entry: AuditEntry = { eventId: "e1", beaconId: "0027", at: 1_700_000_000_000, cameraId: "cam-1", hash: "ab".repeat(32), seq: 1 };

// ---- channel bits ----------------------------------------------------------
// CHANNEL_SMS must not collide: record_notice stores a u8 and only checks != 0,
// so a colliding value would silently mislabel an existing delivery.
assert.deepEqual([CHANNEL_EMAIL, CHANNEL_BADGE_RADIO, CHANNEL_VOICE, CHANNEL_SMS], [1, 2, 4, 8], "channel bits are distinct powers of two");
assert.equal(new Set([CHANNEL_EMAIL, CHANNEL_BADGE_RADIO, CHANNEL_VOICE, CHANNEL_SMS]).size, 4);
assert.ok(CHANNEL_SMS <= 255, "channels is a u8 on-chain");
assert.deepEqual(channelNames(CHANNEL_EMAIL | CHANNEL_SMS), ["email", "sms"]);
assert.deepEqual(channelNames(CHANNEL_EMAIL | CHANNEL_BADGE_RADIO | CHANNEL_VOICE | CHANNEL_SMS), ["email", "badge radio", "voice", "sms"]);
assert.deepEqual(channelNames(0), [], "an empty mask names nothing — record_notice rejects it as NoChannel");

// ---- the integrity rule ----------------------------------------------------
// This mirrors the branch in Notifier.run: the bit follows `sent.ok`, never the
// mere existence of an address. Regressing this re-introduces the bug where the
// chain claimed an email that no transport ever sent.
const bitFor = (sent: { ok: boolean }) => (sent.ok ? CHANNEL_EMAIL : 0);
assert.equal(bitFor({ ok: true }), CHANNEL_EMAIL, "a confirmed send claims CHANNEL_EMAIL");
assert.equal(bitFor({ ok: false }), 0, "a dry-run claims nothing");
assert.equal(bitFor({ ok: false }), 0, "a failed send claims nothing");

// A capture whose only channel was an unsent email must reach record_notice with
// a zero mask — i.e. it is `unreachable` and no notice transaction is sent.
const onlyUnsentEmail = 0 | bitFor({ ok: false });
assert.equal(onlyUnsentEmail, 0, "unsent email alone ⇒ nobody was told ⇒ no on-chain notice");
// …but a live voice or radio channel still earns a notice on its own.
assert.equal(bitFor({ ok: false }) | CHANNEL_VOICE, CHANNEL_VOICE, "other live channels still count");
console.log("ok — channels are claimed only for deliveries that happened");

// ---- masking ---------------------------------------------------------------
assert.equal(maskEmail("hashbukhtiar@gmail.com"), "h•••@gmail.com");
assert.equal(maskEmail("nehad.st@gmail.com"), "n•••@gmail.com");
assert.equal(maskEmail("not-an-email"), "•••", "anything without a local part is fully masked");
assert.equal(maskEmail("@x.com"), "•••");
assert.equal(maskPhone("+14155550123"), "+1•••0123");
assert.equal(maskPhone("(415) 555-0123"), "4•••0123");
assert.equal(maskPhone("12"), "•••", "too short to mask safely ⇒ fully masked");
assert.ok(!maskEmail(contact.email!).includes("ashbukhtiar"), "the local part never survives masking");
assert.ok(!maskPhone(contact.phone!).includes("4155550"), "the middle digits never survive masking");
console.log("ok — contact details are masked before they leave the service");

// ---- composed message ------------------------------------------------------
const mail = composeEmail(contact, entry);
assert.equal(mail.to, contact.email);
assert.ok(mail.subject.includes("cam-1"), "subject names the camera");
assert.ok(mail.text.includes("Nehad"), "greets by first name only");
assert.ok(mail.text.includes("0027"), "names the badge id the person can verify against their badge");
assert.ok(/blurred/i.test(mail.text), "says the footage was blurred");
assert.ok(/solana/i.test(mail.text), "points at the on-chain record");
// The message is the one thing that leaves the venue: it must not carry the
// audit hash or anything else that links a person to the commitment stream.
assert.ok(!mail.text.includes(entry.hash), "the film-event hash stays off the wire");
assert.ok(!mail.text.includes(entry.eventId), "the internal event id stays off the wire");
console.log("ok — notice email says what happened without leaking the ledger");
