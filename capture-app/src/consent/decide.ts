import type { Track, GetConsent } from "../shared/schema";
import { flags } from "../config/flags";

// Fail-safe enforcement (§4.2): a face is CLEAR only on an explicit on-chain
// opt_in. No beacon, unknown, or opt_out → blur.
//
// Bindings EXPIRE. A beacon that stopped being seen stops vouching for a face
// BIND_TTL_MS later — otherwise covering your badge would keep you clear
// forever, and a tracker box-swap between two people would carry one person's
// consent onto the other's face. The badge is a heartbeat, not a login.
//
// The light's consent bit is RESTRICT-ONLY (DECISIONS.md §2.2/§2.4): a beacon
// that says OPT-OUT forces a blur immediately, before and regardless of the
// chain round-trip. It can never clear a face — only the chain record can.
export function decide(tracks: Track[], getConsent: GetConsent, nowMs: number): void {
  for (const t of tracks) {
    if (t.beaconId && nowMs - (t.boundAtMs ?? 0) > flags.BIND_TTL_MS) {
      t.beaconId = undefined;
      t.boundAtMs = undefined;
      t.beaconOptIn = undefined;
    }
    t.consent = t.beaconId ? getConsent(t.beaconId) : "unknown";
    const allowed = t.consent === "opt_in" || (t.consent === "unknown" && flags.DEFAULT_CONSENT === "clear");
    t.blurred = !allowed || t.beaconOptIn === false;
  }
}
