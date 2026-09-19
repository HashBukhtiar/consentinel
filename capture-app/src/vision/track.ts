import type { Track } from "../shared/schema";
import { flags } from "../config/flags";
import type { RawFace } from "./detect";

type Box = { x: number; y: number; w: number; h: number };

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

// Greedy IOU tracker → stable trackId. Holds an unmatched track (and its blur +
// beaconId) for TRACK_MAX_MISSED frames so the blur persists through brief
// occlusion — this is the answer to "what if the badge/face isn't visible?".
// ponytail: O(n·m) greedy match, fine for the 2–3-person demo.
export class Tracker {
  private tracks: Track[] = [];
  private nextId = 1;

  update(dets: RawFace[]): Track[] {
    const used = new Set<number>();
    for (const d of dets) {
      let best = -1, bestIou = flags.IOU_MATCH;
      this.tracks.forEach((t, i) => {
        if (used.has(i)) return;
        const s = iou(d, t.bbox);
        if (s > bestIou) { bestIou = s; best = i; }
      });
      if (best >= 0) {
        this.tracks[best].bbox = d;
        this.tracks[best].missed = 0;
        used.add(best);
      } else {
        this.tracks.push({
          trackId: "T" + this.nextId++, bbox: d, consent: "unknown", blurred: true, missed: 0,
        });
        used.add(this.tracks.length - 1);
      }
    }
    this.tracks.forEach((t, i) => { if (!used.has(i)) t.missed++; });
    this.tracks = this.tracks.filter((t) => t.missed <= flags.TRACK_MAX_MISSED);
    return this.tracks;
  }
}
