import type { DecodeBeacons } from "../shared/schema";
import { hex2 } from "@shared/beacon";

// THROWAWAY stub for A's optical decoder (lands at capture-app/src/decode/beacon.ts).
// A's real module finds the badge's white-bordered patch, samples its 3×2 cell
// grid across frames, and calls decodeFrame() from shared/beacon.ts. Here we
// emit two fixed beacons at chest height with REAL 2-hex-digit ids so the id
// format already matches A's wire contract and the swap is seamless.
// ponytail: fixed positions — assumes two people standing left/right; real
// imagePosition comes from the located patch quad. Binding persists on the track.
const IDS = [0xa1, 0xc3] as const; // → "A1", "C3"
export const decodeBeacons: DecodeBeacons = (_frame, _tMs) => [
  { beaconId: hex2(IDS[0]), imagePosition: { x: 0.33, y: 0.72 }, confidence: 1 },
  { beaconId: hex2(IDS[1]), imagePosition: { x: 0.66, y: 0.72 }, confidence: 1 },
];
