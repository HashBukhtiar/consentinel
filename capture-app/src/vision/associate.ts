import type { Track, BeaconReading } from "../shared/schema";
import { flags } from "../config/flags";

// Bind each decoded beacon to the face it belongs to — badges are chest-worn,
// so the wearer's face is the nearest one ABOVE the patch.
//
// Binding is the ONLY thing in this pipeline that can un-blur someone, so every
// rule here is written to refuse rather than guess (§2.2 of DECISIONS.md):
//
//   * a beacon must be within BIND_MAX_FACE_HEIGHTS of the face, so a badge
//     decoded across the room can't claim a stranger. Measuring in face
//     heights keeps the rule the same at any camera distance;
//   * if two faces are near-equidistant the beacon binds to NEITHER, because
//     a coin-flip here exposes whoever lost the flip;
//   * one beacon binds one track and one track takes one beacon, so two
//     badges can't both land on the same face (last-writer-wins used to let
//     an opt_in id overwrite an opt_out neighbour's).
//
// `nowMs` stamps the binding so decide() can expire it — the badge is a
// heartbeat, not a login.
export function associate(tracks: Track[], beacons: BeaconReading[], nowMs: number): void {
  type Cand = { t: Track; d: number };

  // Eligible (beacon → faces above it, within range), nearest first.
  const shortlist = new Map<BeaconReading, Cand[]>();
  for (const b of beacons) {
    const cands: Cand[] = [];
    for (const t of tracks) {
      const cx = t.bbox.x + t.bbox.w / 2;
      const cy = t.bbox.y + t.bbox.h / 2;
      if (cy > b.imagePosition.y) continue; // face must be above the badge
      const dx = cx - b.imagePosition.x, dy = cy - b.imagePosition.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > t.bbox.h * flags.BIND_MAX_FACE_HEIGHTS) continue; // not plausibly this face's badge
      cands.push({ t, d });
    }
    cands.sort((p, q) => p.d - q.d);

    // Ambiguous: the runner-up is nearly as close as the winner. Refuse.
    if (cands.length > 1 && cands[1].d <= cands[0].d * flags.BIND_AMBIGUOUS_RATIO) continue;
    if (cands.length) shortlist.set(b, cands);
  }

  // Globally greedy, nearest pair first, mutually exclusive.
  const pairs: { b: BeaconReading; t: Track; d: number }[] = [];
  for (const [b, cands] of shortlist) for (const c of cands) pairs.push({ b, t: c.t, d: c.d });
  pairs.sort((p, q) => p.d - q.d);

  const usedBeacon = new Set<BeaconReading>();
  const usedTrack = new Set<Track>();
  for (const p of pairs) {
    if (usedBeacon.has(p.b) || usedTrack.has(p.t)) continue;
    usedBeacon.add(p.b);
    usedTrack.add(p.t);
    p.t.beaconId = p.b.beaconId;
    p.t.boundAtMs = nowMs;
    p.t.lightConsent = p.b.lightConsent;
  }
}
