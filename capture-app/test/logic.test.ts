// Self-check for the non-trivial pipeline logic (run: `npm test`).
// Covers the three things that must not silently break: track identity,
// beacon→face association, and fail-safe blur.
import assert from "node:assert";
import { Tracker } from "../src/vision/track";
import { associate } from "../src/vision/associate";
import { decide } from "../src/consent/decide";
import type { Consent, Track } from "../src/shared/schema";
import { flags as flagsT } from "../src/config/flags";

// 1) tracker keeps the same id across a small move
const tr = new Tracker();
const id1 = tr.update([{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }])[0].trackId;
const step2 = tr.update([{ x: 0.12, y: 0.11, w: 0.2, h: 0.2 }]);
assert.equal(step2[0].trackId, id1, "track id should persist across small move");

// 2) beacon binds to the nearest face ABOVE it
const tracks: Track[] = [
  { trackId: "L", bbox: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, consent: "unknown", blurred: true, missed: 0 },
  { trackId: "R", bbox: { x: 0.6, y: 0.2, w: 0.2, h: 0.2 }, consent: "unknown", blurred: true, missed: 0 },
];
associate(tracks, [{ beaconId: "X", imagePosition: { x: 0.65, y: 0.7 }, confidence: 1 }], 1000);
assert.equal(tracks.find((t) => t.trackId === "R")!.beaconId, "X", "binds to nearest face above");
assert.equal(tracks.find((t) => t.trackId === "L")!.beaconId, undefined);

// 3) fail-safe: only explicit opt_in clears
const get = (id: string): Consent => (id === "X" ? "opt_in" : "unknown");
decide(tracks, get, 1000);
assert.equal(tracks.find((t) => t.trackId === "R")!.blurred, false, "opt_in ⇒ clear");
assert.equal(tracks.find((t) => t.trackId === "L")!.blurred, true, "no beacon ⇒ blur");

// 3b) the badge's own flag can only add privacy: OPT-OUT on the light forces a blur even on chain opt_in,
//     OPT-IN on the light never clears without the chain
associate(tracks, [{ beaconId: "X", imagePosition: { x: 0.65, y: 0.7 }, confidence: 1, optIn: false }], 1000);
decide(tracks, get, 1000);
assert.equal(tracks.find((t) => t.trackId === "R")!.blurred, true, "badge says OPT-OUT ⇒ blur even though chain says opt_in");
associate(tracks, [{ beaconId: "X", imagePosition: { x: 0.65, y: 0.7 }, confidence: 1, optIn: true }], 1000);
decide(tracks, get, 1000);
assert.equal(tracks.find((t) => t.trackId === "R")!.blurred, false, "badge OPT-IN + chain opt_in ⇒ clear");
decide(tracks, () => "opt_out", 1000);
assert.equal(tracks.find((t) => t.trackId === "R")!.blurred, true, "badge OPT-IN alone never clears: the chain decides");
decide(tracks, get, 1000 + flagsT.BIND_TTL_MS + 1);
assert.equal(tracks.find((t) => t.trackId === "R")!.beaconOptIn, undefined, "an expired binding drops the light's bit too");

// 3c) a badge hangs UNDER its wearer's face. Someone leaning in beside the
//     wearer — even when they are the only face detected — never wins it, and
//     when the wearer's face is back it takes the badge and the neighbour's stale
//     binding is released at once, not when its TTL runs out.
{
  const wearer: Track = { trackId: "W", bbox: { x: 0.40, y: 0.30, w: 0.20, h: 0.24 }, consent: "unknown", blurred: true, missed: 0 };
  const beside: Track = { trackId: "B", bbox: { x: 0.08, y: 0.32, w: 0.20, h: 0.24 }, consent: "unknown", blurred: true, missed: 0 };
  const badge = { beaconId: "27", imagePosition: { x: 0.50, y: 0.78 }, confidence: 1, optIn: true };
  associate([beside], [badge], 2000);
  assert.equal(beside.beaconId, undefined, "a face a full face-height to the side of the badge is not its wearer, even alone");
  associate([wearer, beside], [badge], 2100);
  assert.equal(wearer.beaconId, "27", "the face straight above the badge wins");
  assert.equal(beside.beaconId, undefined);
  // the wearer looks down: only a leaning-in face is left, a face-width to the side but within reach
  const leaner: Track = { trackId: "N", bbox: { x: 0.22, y: 0.34, w: 0.20, h: 0.24 }, consent: "unknown", blurred: true, missed: 0 };
  associate([leaner], [badge], 2200);
  assert.equal(leaner.beaconId, "27", "with nobody else in frame a nearby face above the badge does bind");
  associate([wearer, leaner], [badge], 2300);
  assert.equal(wearer.beaconId, "27", "the wearer's face is back and reclaims the badge");
  assert.equal(leaner.beaconId, undefined, "the neighbour's stale binding is released immediately");
  assert.equal(leaner.beaconOptIn, undefined);
}

console.log("ok — tracker identity, association (a neighbour never wins the badge, stale bindings release), fail-safe blur, light flag only adds privacy");

// 4) chain cache semantics (no network: autoFetch off, synthetic snapshots)
import { ChainConsentCache } from "../src/consent/chainCache";
import { flags } from "../src/config/flags";
let clock = 1_000_000;
const cache = new ChainConsentCache("http://127.0.0.1:8899", { autoFetch: false, cluster: "localnet", now: () => clock });
const rec = (badgeId: string, consent: boolean, revision: number, owner = "o") => ({
  badgeId, badgeIdNum: parseInt(badgeId, 16), owner, consent, revision, instance: 1, createdAt: 1, updatedAt: 1, address: "a",
});
const snap = (consents: any[], slot: number, overrides: any[] = []) => ({ registry: null, consents, overrides, cameras: [], slot });
assert.equal(cache.get("A1B2"), "unknown", "empty cache ⇒ unknown ⇒ blur");
cache.applySnapshot(snap([rec("A1B2", false, 0), rec("C3D4", true, 0)], 100));
cache.status.freshAt = clock; // applySnapshot alone doesn't stamp freshness; syncNow does
assert.equal(cache.get("a1b2"), "opt_out", "case-insensitive id, opt_out");
assert.equal(cache.get("C3D4"), "opt_in");
assert.equal(cache.get("ZZZZ"), "unknown", "garbage id ⇒ unknown");
assert.equal(cache.get("E5F6"), "unknown", "unregistered ⇒ unknown ⇒ blur");
// push: newer slot wins
cache.applyLogs({ signature: "s", slot: 101, err: null, events: [{ name: "ConsentChanged", badgeId: "A1B2", owner: "o", consent: true, revision: 1, instance: 1, at: 2, delegated: true }] });
assert.equal(cache.get("A1B2"), "opt_in", "ws push applied");
// stale poll (older slot) must not revert the push
cache.applySnapshot(snap([rec("A1B2", false, 0), rec("C3D4", true, 0)], 100));
assert.equal(cache.get("A1B2"), "opt_in", "stale snapshot ignored");
// failed tx logs are ignored
cache.applyLogs({ signature: "s2", slot: 102, err: { x: 1 }, events: [{ name: "ConsentChanged", badgeId: "A1B2", owner: "o", consent: false, revision: 2, instance: 1, at: 3, delegated: false }] });
assert.equal(cache.get("A1B2"), "opt_in", "failed tx ignored");
// per-event override takes precedence for the configured EVENT_ID — but only from the record's current owner
cache.applyLogs({ signature: "s3", slot: 103, err: null, events: [{ name: "EventOverrideChanged", badgeId: "A1B2", owner: "someone-else", eventId: flags.EVENT_ID, consent: false, at: 4 }] });
assert.equal(cache.get("A1B2"), "opt_in", "override from a previous owner is ignored");
cache.applyLogs({ signature: "s3b", slot: 103, err: null, events: [{ name: "EventOverrideChanged", badgeId: "A1B2", owner: "o", eventId: flags.EVENT_ID, consent: false, at: 4 }] });
assert.equal(cache.get("A1B2"), "opt_out", "event override wins");
cache.applyLogs({ signature: "s4", slot: 104, err: null, events: [{ name: "EventOverrideChanged", badgeId: "A1B2", owner: "o", eventId: flags.EVENT_ID, consent: null, at: 5 }] });
assert.equal(cache.get("A1B2"), "opt_in", "override cleared ⇒ base consent");
// close ⇒ record gone ⇒ unknown ⇒ blur; a stale snapshot can't resurrect it
cache.applyLogs({ signature: "s5", slot: 105, err: null, events: [{ name: "ConsentClosed", badgeId: "A1B2", owner: "o", at: 6 }] });
assert.equal(cache.get("A1B2"), "unknown", "closed ⇒ unknown ⇒ blur");
cache.applySnapshot(snap([rec("A1B2", true, 1), rec("C3D4", true, 0)], 104));
assert.equal(cache.get("A1B2"), "unknown", "tombstone beats stale snapshot");
cache.applySnapshot(snap([rec("A1B2", true, 2), rec("C3D4", true, 0)], 106));
assert.equal(cache.get("A1B2"), "opt_in", "re-registration in a newer snapshot is applied");
cache.applySnapshot(snap([rec("A1B2", true, 2)], 107));
assert.equal(cache.get("C3D4"), "unknown", "a record missing from a newer full snapshot is dropped");
cache.applySnapshot(snap([rec("A1B2", true, 2), rec("C3D4", true, 0)], 108));
// staleness fail-safe: no sync for CONSENT_STALE_MS ⇒ everything unknown ⇒ blur; a sync restores it
clock += flags.CONSENT_STALE_MS + 1;
assert.equal(cache.get("A1B2"), "unknown", "stale cache ⇒ unknown ⇒ blur");
assert.equal(cache.get("C3D4"), "unknown", "stale cache ⇒ unknown ⇒ blur (opt_in too)");
cache.applyLogs({ signature: "s6", slot: 107, err: null, events: [] });
assert.equal(cache.get("C3D4"), "opt_in", "a fresh push restores authority");

// 4b) partial refresh (getMultipleAccounts path): updates + closes only what it queried
{
  const c2 = new ChainConsentCache("http://127.0.0.1:8899", { autoFetch: false, cluster: "localnet", now: () => clock });
  c2.applySnapshot({ registry: null, consents: [rec("1A", true, 0, "o1"), rec("2B", false, 0, "o2")], overrides: [], cameras: [], slot: 100 });
  c2.status.freshAt = clock; // applySnapshot alone doesn't stamp freshness; syncNow does
  // a partial that only mentions 1A must NOT drop 2B
  c2.applyPartial({ registry: null, consents: [{ ...rec("1A", false, 1, "o1") }], overrides: [], cameras: [], slot: 101 });
  assert.equal(c2.get("1A"), "opt_out", "partial refresh updates the queried record");
  assert.equal(c2.get("2B"), "opt_out", "partial refresh leaves unqueried records alone");
  // an older partial cannot overwrite a newer state
  c2.applyPartial({ registry: null, consents: [{ ...rec("1A", true, 0, "o1") }], overrides: [], cameras: [], slot: 90 });
  assert.equal(c2.get("1A"), "opt_out", "stale partial is ignored (slot-ordered)");
  console.log("ok — chain cache partial refresh: targeted update, no collateral drops, slot-ordered");
}

console.log("ok — chain cache: fail-safe unknown, slot ordering, owner-checked overrides, tombstones, staleness");

// 5) stub fallback normalizes beacon ids like the chain cache does
import { consentStore } from "../src/stubs/consentStore";
assert.equal(consentStore.get("4e"), "opt_out", "stub: case-insensitive");
assert.equal(consentStore.get("c3"), "opt_in");
assert.equal(consentStore.get("zz"), "unknown", "stub: garbage ⇒ unknown ⇒ blur");
consentStore.set("00ab", "opt_in");
assert.equal(consentStore.get("AB"), "opt_in", "stub: zero-padding");
console.log("ok — stub store normalization");
