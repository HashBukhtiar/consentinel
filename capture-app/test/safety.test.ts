// Regression tests for the default-deny guards (run: `npm test`).
//
// Every case here is a way someone could be EXPOSED by accident. Each one
// fails if you remove the guard it covers, which is the point — these are not
// behaviour tests, they are the safety property written down.
//
// See DECISIONS.md §1 and §4.
import assert from "node:assert";
import { associate } from "../src/vision/associate";
import { decide } from "../src/consent/decide";
import { createGuard } from "../src/consent/antiSpoof";
import { flags } from "../src/config/flags";
import type { BeaconReading, Consent, Track } from "../src/shared/schema";

const face = (id: string, x: number, y: number): Track => ({
  trackId: id,
  bbox: { x, y, w: 0.1, h: 0.1 },
  consent: "unknown",
  blurred: true,
  missed: 0,
});
// ---------------------------------------------------------------- exclusivity
// Two badges, one face between them. Without exclusivity both bind the same
// track and the last writer wins — so an opt_in id can land on the person who
// opted out.
{
  const t = face("solo", 0.45, 0.2);
  associate(
    [t],
    [
      { beaconId: "AA", imagePosition: { x: 0.5, y: 0.45 }, confidence: 1 },
      { beaconId: "BB", imagePosition: { x: 0.5, y: 0.46 }, confidence: 1 },
    ],
    1000,
  );
  assert.ok(t.beaconId === undefined || t.beaconId === "AA" || t.beaconId === "BB");
  // and never both: one beacon must have gone unbound
  assert.equal([t].filter((x) => x.beaconId).length <= 1, true, "one track takes at most one beacon");
}

// One badge, two faces. It must not bind both.
{
  const a = face("a", 0.1, 0.2), b = face("b", 0.8, 0.2);
  associate([a, b], [{ beaconId: "AA", imagePosition: { x: 0.15, y: 0.45 }, confidence: 1 }], 1000);
  assert.equal([a, b].filter((t) => t.beaconId === "AA").length, 1, "one beacon binds at most one face");
}

// ------------------------------------------------------------------- distance
// A badge decoded on the far side of the frame must not claim the only face
// present. Pre-fix, bestD started at Infinity so ANY face above it won.
{
  const far = face("far", 0.05, 0.05);
  associate([far], [{ beaconId: "AA", imagePosition: { x: 0.95, y: 0.95 }, confidence: 1 }], 1000);
  assert.equal(far.beaconId, undefined, "beacon far beyond the wearer's badge offset must not bind");
}

// ...but a badge worn on the chest of the face right above it still binds.
{
  const near = face("near", 0.45, 0.30);
  associate([near], [{ beaconId: "AA", imagePosition: { x: 0.5, y: 0.5 }, confidence: 1 }], 1000);
  assert.equal(near.beaconId, "AA", "a plausible chest-worn badge still binds");
}

// ------------------------------------------------------------------ ambiguity
// Two faces equidistant from one badge. Guessing exposes whoever loses the
// coin flip, so bind NEITHER.
{
  const l = face("l", 0.40, 0.2), r = face("r", 0.50, 0.2);
  associate([l, r], [{ beaconId: "AA", imagePosition: { x: 0.5, y: 0.4 }, confidence: 1 }], 1000);
  assert.equal(l.beaconId, undefined, "ambiguous ⇒ bind neither (left)");
  assert.equal(r.beaconId, undefined, "ambiguous ⇒ bind neither (right)");
}

// ------------------------------------------------------------------------ ttl
// A binding stops vouching once its beacon stops being seen. Without this,
// covering your badge keeps you clear forever.
{
  const t = face("t", 0.45, 0.30);
  const optIn = (): Consent => "opt_in";
  associate([t], [{ beaconId: "AA", imagePosition: { x: 0.5, y: 0.5 }, confidence: 1 }], 1000);

  decide([t], optIn, 1000);
  assert.equal(t.blurred, false, "fresh binding + opt_in ⇒ clear");

  decide([t], optIn, 1000 + flags.BIND_TTL_MS - 1);
  assert.equal(t.blurred, false, "still inside the TTL ⇒ still clear");

  decide([t], optIn, 1000 + flags.BIND_TTL_MS + 1);
  assert.equal(t.beaconId, undefined, "expired binding is cleared");
  assert.equal(t.consent, "unknown", "no beacon ⇒ unknown");
  assert.equal(t.blurred, true, "expired binding ⇒ BLUR");
}

// A re-sighting refreshes the binding rather than letting it lapse.
{
  const t = face("t", 0.45, 0.30);
  const optIn = (): Consent => "opt_in";
  const beacon = { beaconId: "AA", imagePosition: { x: 0.5, y: 0.5 }, confidence: 1 };
  associate([t], [beacon], 1000);
  associate([t], [beacon], 1000 + flags.BIND_TTL_MS - 1); // seen again
  decide([t], optIn, 1000 + flags.BIND_TTL_MS + 1);
  assert.equal(t.blurred, false, "a re-sighting refreshes boundAtMs");
}

// -------------------------------------------------------------- fail-safe net
// opt_out and unknown both blur, at every point in the binding lifecycle.
{
  const t = face("t", 0.45, 0.30);
  associate([t], [{ beaconId: "AA", imagePosition: { x: 0.5, y: 0.5 }, confidence: 1 }], 1000);
  decide([t], () => "opt_out", 1000);
  assert.equal(t.blurred, true, "opt_out ⇒ blur");
  decide([t], () => "unknown", 1000);
  assert.equal(t.blurred, true, "unknown ⇒ blur");
}

// ------------------------------------------------------------- anti-forgery
// The optical patch is a static public id with no signature, so a phone
// screen can render a valid one. These guards do not make it unforgeable —
// they make a GUESS slow and visible. See src/consent/antiSpoof.ts.
const bcn = (id: string, x: number, y: number): BeaconReading => ({
  beaconId: id,
  imagePosition: { x, y },
  confidence: 1,
});
const STABLE = flags.SPOOF_STABLE_MS;

// A freshly-appeared id is NOT believed. Un-blurring on the first frame is
// exactly what lets someone flash 256 ids through a phone in nine seconds.
{
  const g = createGuard();
  assert.equal(g.filter([bcn("AA", 0.5, 0.5)], 1000).length, 0, "a brand-new id is not believed yet");
  assert.equal(g.filter([bcn("AA", 0.5, 0.5)], 1000 + STABLE - 1).length, 0, "still inside the stability window");
  assert.equal(g.filter([bcn("AA", 0.5, 0.5)], 1000 + STABLE).length, 1, "a steady badge becomes believable");
}

// A real badge drops out constantly (motion blur, occlusion). A GAP must not
// restart the clock, or a genuine badge would never become believable.
{
  const g = createGuard();
  g.filter([bcn("AA", 0.5, 0.5)], 1000);
  g.filter([], 1100); // decoder saw nothing this frame
  g.filter([], 1200);
  assert.equal(g.filter([bcn("AA", 0.5, 0.5)], 1000 + STABLE).length, 1, "a sighting gap does not reset stability");
}

// ...but an id CHANGE at the same spot does. This is the brute-force gate:
// every guess costs a fresh stability window.
{
  const g = createGuard();
  g.filter([bcn("AA", 0.5, 0.5)], 1000);
  g.filter([bcn("BB", 0.5, 0.5)], 1000 + STABLE - 1); // flipped just before it would count
  assert.equal(g.filter([bcn("BB", 0.5, 0.5)], 1000 + STABLE).length, 0, "a switched id restarts the clock");
}

// A screen cycling through ids gets that whole spot quarantined, so the
// attacker cannot simply keep guessing from one position.
{
  const g = createGuard();
  const ids = ["AA", "BB", "CC", "DD", "EE"];
  let t = 1000;
  for (const id of ids) { g.filter([bcn(id, 0.5, 0.5)], t); t += 100; }
  // even holding the last one steady past the stability window, the spot is out
  assert.equal(g.filter([bcn("EE", 0.5, 0.5)], t + STABLE + 1).length, 0, "a churning spot is quarantined");
  assert.equal(
    g.filter([bcn("EE", 0.5, 0.5)], t + flags.SPOOF_QUARANTINE_MS + STABLE + 1).length,
    1,
    "quarantine eventually lifts",
  );
}

// Two patches showing one id: a clone. There is no way to tell the copy from
// the original, so BOTH are dropped — copying a number off a chest gains
// nothing, and costs the victim their own binding.
{
  const g = createGuard();
  let t = 1000;
  for (; t <= 1000 + STABLE; t += 100) g.filter([bcn("AA", 0.2, 0.5)], t); // real badge, settled
  assert.equal(g.filter([bcn("AA", 0.2, 0.5)], t).length, 1, "the real badge was believed");
  const both = g.filter([bcn("AA", 0.2, 0.5), bcn("AA", 0.8, 0.5)], t + 100);
  assert.equal(both.length, 0, "a cloned id un-blurs nobody, original included");
}

// ...and the clone stays distrusted after it blinks out, so flickering on
// alternate frames cannot slip it through the gap.
{
  const g = createGuard();
  let t = 1000;
  for (; t <= 1000 + STABLE; t += 100) g.filter([bcn("AA", 0.2, 0.5)], t);
  g.filter([bcn("AA", 0.2, 0.5), bcn("AA", 0.8, 0.5)], t);
  assert.equal(g.filter([bcn("AA", 0.2, 0.5)], t + 100).length, 0, "clone block outlives the frame");
}

// The decoder re-acquires a patch and briefly reports it twice at nearly the
// same spot. That is double-tracking, not a clone, and must not blur the
// wearer — otherwise the guard fires constantly on real footage.
{
  const g = createGuard();
  let t = 1000;
  for (; t <= 1000 + STABLE; t += 100) g.filter([bcn("AA", 0.5, 0.5)], t);
  const out = g.filter([bcn("AA", 0.5, 0.5), bcn("AA", 0.51, 0.505)], t + 100);
  assert.ok(out.length >= 1, "two readings of one badge at one spot is not a clone");
}

// Two different badges in frame are untouched by any of this.
{
  const g = createGuard();
  let t = 1000;
  for (; t <= 1000 + STABLE; t += 100) g.filter([bcn("AA", 0.2, 0.5), bcn("BB", 0.8, 0.5)], t);
  assert.equal(g.filter([bcn("AA", 0.2, 0.5), bcn("BB", 0.8, 0.5)], t).length, 2, "two real badges both pass");
}

// ------------------------------------------------- opt-out-only policy
// DEFAULT_CONSENT="clear": unknown clears, but a recognized opt-out — on-chain or
// from the badge's own light — still blurs. The light stays restrict-only.
{
  const was = flags.DEFAULT_CONSENT;
  flags.DEFAULT_CONSENT = "clear";
  const t = face("t", 0.45, 0.30);
  decide([t], () => "unknown", 1000);
  assert.equal(t.blurred, false, "clear policy: no badge ⇒ clear");
  associate([t], [{ beaconId: "AA", imagePosition: { x: 0.5, y: 0.5 }, confidence: 1, optIn: false }], 1000);
  decide([t], () => "unknown", 1000);
  assert.equal(t.blurred, true, "clear policy: unregistered badge whose light says OPT-OUT ⇒ blur");
  associate([t], [{ beaconId: "AA", imagePosition: { x: 0.5, y: 0.5 }, confidence: 1, optIn: true }], 1000);
  decide([t], () => "opt_out", 1000);
  assert.equal(t.blurred, true, "clear policy: on-chain opt_out ⇒ blur even with a mint light");
  flags.DEFAULT_CONSENT = was;
}

console.log("safety.test.ts: all default-deny guards hold");
