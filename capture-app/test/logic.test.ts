// Self-check for the non-trivial pipeline logic (run: `npm test`).
// Covers the three things that must not silently break: track identity,
// beacon→face association, and fail-safe blur.
import assert from "node:assert";
import { Tracker } from "../src/vision/track";
import { associate } from "../src/vision/associate";
import { decide } from "../src/consent/decide";
import type { Consent, Track } from "../src/shared/schema";

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
associate(tracks, [{ beaconId: "X", imagePosition: { x: 0.65, y: 0.7 }, confidence: 1 }]);
assert.equal(tracks.find((t) => t.trackId === "R")!.beaconId, "X", "binds to nearest face above");
assert.equal(tracks.find((t) => t.trackId === "L")!.beaconId, undefined);

// 3) fail-safe: only explicit opt_in clears
const get = (id: string): Consent => (id === "X" ? "opt_in" : "unknown");
decide(tracks, get);
assert.equal(tracks.find((t) => t.trackId === "R")!.blurred, false, "opt_in ⇒ clear");
assert.equal(tracks.find((t) => t.trackId === "L")!.blurred, true, "no beacon ⇒ blur");

console.log("ok — tracker identity, association, fail-safe blur");

// 4) chain cache semantics (no network: autoFetch off, synthetic snapshots)
import { ChainConsentCache } from "../src/consent/chainCache";
import { flags } from "../src/config/flags";
const cache = new ChainConsentCache("http://127.0.0.1:8899", { autoFetch: false, cluster: "localnet" });
const rec = (badgeId: string, consent: boolean, revision: number) => ({
  badgeId, badgeIdNum: parseInt(badgeId, 16), owner: "o", consent, revision, createdAt: 1, updatedAt: 1, address: "a",
});
assert.equal(cache.get("A1B2"), "unknown", "empty cache ⇒ unknown ⇒ blur");
cache.applySnapshot({ consents: [rec("A1B2", false, 0), rec("C3D4", true, 0)], overrides: [], cameras: [], slot: 100 });
assert.equal(cache.get("a1b2"), "opt_out", "case-insensitive id, opt_out");
assert.equal(cache.get("C3D4"), "opt_in");
assert.equal(cache.get("ZZZZ"), "unknown", "garbage id ⇒ unknown");
assert.equal(cache.get("E5F6"), "unknown", "unregistered ⇒ unknown ⇒ blur");
// push: newer slot wins
cache.applyLogs({ signature: "s", slot: 101, err: null, events: [{ name: "ConsentChanged", badgeId: "A1B2", owner: "o", consent: true, revision: 1, at: 2, delegated: true }] });
assert.equal(cache.get("A1B2"), "opt_in", "ws push applied");
// stale poll (older slot) must not revert the push
cache.applySnapshot({ consents: [rec("A1B2", false, 0), rec("C3D4", true, 0)], overrides: [], cameras: [], slot: 100 });
assert.equal(cache.get("A1B2"), "opt_in", "stale snapshot ignored");
// failed tx logs are ignored
cache.applyLogs({ signature: "s2", slot: 102, err: { x: 1 }, events: [{ name: "ConsentChanged", badgeId: "A1B2", owner: "o", consent: false, revision: 2, at: 3, delegated: false }] });
assert.equal(cache.get("A1B2"), "opt_in", "failed tx ignored");
// per-event override takes precedence for the configured EVENT_ID
cache.applyLogs({ signature: "s3", slot: 103, err: null, events: [{ name: "EventOverrideChanged", badgeId: "A1B2", owner: "o", eventId: flags.EVENT_ID, consent: false, at: 4 }] });
assert.equal(cache.get("A1B2"), "opt_out", "event override wins");
cache.applyLogs({ signature: "s4", slot: 104, err: null, events: [{ name: "EventOverrideChanged", badgeId: "A1B2", owner: "o", eventId: flags.EVENT_ID, consent: null, at: 5 }] });
assert.equal(cache.get("A1B2"), "opt_in", "override cleared ⇒ base consent");
// close ⇒ record gone ⇒ unknown ⇒ blur; a stale snapshot can't resurrect it
cache.applyLogs({ signature: "s5", slot: 105, err: null, events: [{ name: "ConsentClosed", badgeId: "A1B2", owner: "o", at: 6 }] });
assert.equal(cache.get("A1B2"), "unknown", "closed ⇒ unknown ⇒ blur");
cache.applySnapshot({ consents: [rec("A1B2", true, 1)], overrides: [], cameras: [], slot: 104 });
assert.equal(cache.get("A1B2"), "unknown", "tombstone beats stale snapshot");
cache.applySnapshot({ consents: [rec("A1B2", true, 2)], overrides: [], cameras: [], slot: 106 });
assert.equal(cache.get("A1B2"), "opt_in", "re-registration in a newer snapshot is applied");

console.log("ok — chain cache: fail-safe unknown, slot ordering, overrides, tombstones");
