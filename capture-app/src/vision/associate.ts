import type { Track, BeaconReading } from "../shared/schema";

// Bind each decoded beacon to the nearest face whose center is ABOVE it —
// badges are chest-worn, faces are above. The binding is written onto the
// track and persists (the tracker carries it between decodes), so intermittent
// decoding doesn't drop the link.
export function associate(tracks: Track[], beacons: BeaconReading[]): void {
  for (const b of beacons) {
    let best: Track | null = null, bestD = Infinity;
    for (const t of tracks) {
      const cx = t.bbox.x + t.bbox.w / 2;
      const cy = t.bbox.y + t.bbox.h / 2;
      if (cy > b.imagePosition.y) continue; // face must be above the beacon
      const dx = cx - b.imagePosition.x, dy = cy - b.imagePosition.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best) { best.beaconId = b.beaconId; best.beaconRequest = b.consentRequest; }
  }
}
