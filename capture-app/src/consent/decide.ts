import type { Track, GetConsent } from "../shared/schema";
import { flags } from "../config/flags";

// Fail-safe enforcement (§4.2): a face is CLEAR only on an explicit opt_in.
// No beacon, unknown, or opt_out → blur.
//
// Bindings EXPIRE. A beacon that stopped being seen stops vouching for a face
// BIND_TTL_MS later — otherwise covering your badge would keep you clear
// forever, and a tracker box-swap between two people would carry one person's
// consent onto the other's face. The badge is a heartbeat, not a login.
export function decide(tracks: Track[], getConsent: GetConsent, nowMs: number): void {
  for (const t of tracks) {
    if (t.beaconId && nowMs - (t.boundAtMs ?? 0) > flags.BIND_TTL_MS) {
      t.beaconId = undefined;
      t.boundAtMs = undefined;
    }
    t.consent = t.beaconId ? getConsent(t.beaconId) : "unknown";
    t.blurred = t.consent !== "opt_in";
  }
}
