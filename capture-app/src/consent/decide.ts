import type { Track, GetConsent } from "../shared/schema";

// Fail-safe enforcement (§4.2): a face is CLEAR only on an explicit on-chain
// opt_in. No beacon, unknown, or opt_out → blur. The badge's own flag can only
// add privacy: a beacon that says OPT-OUT forces a blur immediately, before
// (and regardless of) the chain round-trip. It can never clear a face.
export function decide(tracks: Track[], getConsent: GetConsent): void {
  for (const t of tracks) {
    t.consent = t.beaconId ? getConsent(t.beaconId) : "unknown";
    t.blurred = t.consent !== "opt_in" || t.beaconRequest === false;
  }
}
