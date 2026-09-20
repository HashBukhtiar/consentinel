// Self-check for the optical decoder — synthetic frames, no camera/badge.
// Proves: our cell mapping inverts A's decodeFrame, the localizer finds the
// patch, and symbol assembly + CRC reconstruct the id end-to-end.
import assert from "node:assert";
import { hex2, packPayload, unpackPayload, decodeFrame } from "@shared/beacon";
import { symbolCells, paintPatch } from "../src/decode/patch";
import { decodeBeacons, _internal } from "../src/decode/beacon";

const ID = 0x4e; // Maaz's real demo id

// 1) our painter must be the exact inverse of A's decoder
assert.equal(unpackPayload(packPayload(ID)), ID, "crc round-trip");
assert.equal(decodeFrame([0, 1, 2].map((s) => symbolCells(ID, s))), ID, "symbolCells ↔ decodeFrame");

// 2) full pixel pipeline: paint 3 symbols, decode them back through the camera path
const W = 240, H = 140, rect = { x: 60, y: 50, w: 138, h: 60 }; // aspect ≈ 2.3
const frameFor = (s: number): ImageData => {
  const data = new Uint8ClampedArray(W * H * 4);
  paintPatch(data, W, H, rect, symbolCells(ID, s));
  return { data, width: W, height: H } as unknown as ImageData;
};

assert.ok(_internal.locatePatches(frameFor(0)).length >= 1, "localizer finds the patch");

// 3 cycles so the "confirm an id twice" guard fires (each symbol ~2 frames)
let got: string | undefined;
let t = 0;
for (let cycle = 0; cycle < 3; cycle++) {
  for (const s of [0, 1, 2]) {
    const f = frameFor(s);
    for (let k = 0; k < 2; k++) {
      const out = decodeBeacons(f, (t += 50));
      if (out.length) got = out[0].beaconId;
    }
  }
}
assert.equal(got, hex2(ID), `decodes beacon id ${hex2(ID)}`);

console.log("ok — optical decode: cell mapping, localization, assembly+CRC →", hex2(ID));

// 3) fine-sampling path: a coarse frame with a localizable but data-less patch
// (border only) can't decode — but a native-res crop of the same region can.
// This is the distance de-risk (localize coarse, sample fine).
const dark = [false, false, false, false, false, false];
const borderOnly = (): ImageData => {
  const data = new Uint8ClampedArray(W * H * 4);
  paintPatch(data, W, H, rect, dark);
  return { data, width: W, height: H } as unknown as ImageData;
};
const hiFor = (s: number): ImageData => {
  const cw = 300, ch = 130, data = new Uint8ClampedArray(cw * ch * 4);
  paintPatch(data, cw, ch, { x: 0, y: 0, w: cw, h: ch }, symbolCells(ID, s));
  return { data, width: cw, height: ch } as unknown as ImageData;
};

const decA = _internal.newDecoder();
let coarseOnly: string | undefined; let ta = 0;
for (let c = 0; c < 3; c++) for (const s of [0, 1, 2]) for (let k = 0; k < 2; k++) {
  const o = decA.decode(borderOnly(), (ta += 50));
  if (o.length) coarseOnly = o[0].beaconId;
}
assert.equal(coarseOnly, undefined, "border-only + no sampler ⇒ no decode");

const decB = _internal.newDecoder();
let fine: string | undefined; let tb = 0; let curS = 0;
for (let c = 0; c < 3; c++) for (const s of [0, 1, 2]) { curS = s; for (let k = 0; k < 2; k++) {
  const o = decB.decode(borderOnly(), (tb += 50), () => hiFor(curS));
  if (o.length) fine = o[0].beaconId;
} }
assert.equal(fine, hex2(ID), "fine sampler recovers the decode the coarse frame misses");

console.log("ok — fine sampling: native-res crop recovers a decode coarse cannot →", hex2(ID));
