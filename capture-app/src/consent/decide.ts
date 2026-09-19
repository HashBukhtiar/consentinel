import type { Track, GetConsent } from "../shared/schema";

// Fail-safe enforcement (§4.2): a face is CLEAR only on an explicit opt_in.
// No beacon, unknown, or opt_out → blur.
export function decide(tracks: Track[], getConsent: GetConsent): void {
  for (const t of tracks) {
    t.consent = t.beaconId ? getConsent(t.beaconId) : "unknown";
    t.blurred = t.consent !== "opt_in";
  }
}
