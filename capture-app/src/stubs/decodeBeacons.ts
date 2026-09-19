import type { DecodeBeacons } from "../shared/schema";

// THROWAWAY stub for A's VLC decoder. Emits two fixed beacons at chest height
// so the pipeline binds them to the two nearest faces above. A's real module
// reads the Manchester-coded LED blink from `frame` and returns what it decoded
// this call (may be empty on frames where no full ID completed).
// ponytail: fixed positions — assumes two people standing left/right. Swap for
// the real decoder; binding persists on the track once set (associate.ts).
export const decodeBeacons: DecodeBeacons = (_frame, _tMs) => [
  { beaconId: "A1B2", imagePosition: { x: 0.33, y: 0.72 }, confidence: 1 },
  { beaconId: "C3D4", imagePosition: { x: 0.66, y: 0.72 }, confidence: 1 },
];
