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
