// Self-check for the optical decoder (firmware v0.4 static key) — synthetic
// frames, no camera/badge. Proves: our painter inverts A's glyph table + CRC,
// the localizer finds the ring, a key decodes with the right consent colour,
// and fine (native-res) sampling recovers a decode the coarse frame cannot.
import assert from "node:assert";
import { hex2, packPayload, unpackPayload, decodeKey, SEG_TO_NIBBLE } from "@shared/beacon";
import { keyMasks, paintKey } from "../src/decode/patch";
import { _internal } from "../src/decode/beacon";

const ID = 0x4e; // Maaz's demo id

// 1) painter ↔ decoder contract
assert.equal(unpackPayload(packPayload(ID)), ID, "crc round-trip");
assert.equal(decodeKey(keyMasks(ID).map((m) => SEG_TO_NIBBLE.get(m)!)), ID, "glyph masks ↔ decodeKey");

// 2) full pixel pipeline: paint the key, decode it back through the camera path
const W = 320, H = 240, rect = { x: 40, y: 30, w: 240, h: 180 }; // aspect 1.33
const frame = (optIn: boolean, lit = true): ImageData => {
  const data = new Uint8ClampedArray(W * H * 4);
  paintKey(data, W, H, rect, ID, optIn, lit);
  return { data, width: W, height: H } as unknown as ImageData;
};
assert.ok(_internal.locatePatches(frame(true)).length >= 1, "localizer finds the ring");

// two consecutive confident frames ⇒ trusted
const run = (f: ImageData, dec = _internal.newDecoder()) => {
  let out = dec.decode(f, 100);
  out = dec.decode(f, 150);
  return out[0];
};
const mint = run(frame(true));
assert.equal(mint?.beaconId, hex2(ID), `decodes ${hex2(ID)}`);
assert.equal(mint?.lightConsent, "opt_in", "mint digits ⇒ opt_in hint");
const rose = run(frame(false));
assert.equal(rose?.beaconId, hex2(ID), "same id in rose");
assert.equal(rose?.lightConsent, "opt_out", "rose digits ⇒ opt_out hint");

// a single frame is NOT enough — the id must repeat before it's trusted
assert.equal(_internal.newDecoder().decode(frame(true), 100).length, 0, "one read is not yet trusted");

console.log("ok — static key: glyphs+CRC, localization, decode + consent colour →", hex2(ID));

// 3) fine-sampling path: a coarse frame whose key has no lit segments can't
// decode — but a native-res crop of the same region (with the digits) can.
const hi = (optIn: boolean): ImageData => {
  const cw = 320, ch = 240, data = new Uint8ClampedArray(cw * ch * 4);
  paintKey(data, cw, ch, { x: 0, y: 0, w: cw, h: ch }, ID, optIn);
  return { data, width: cw, height: ch } as unknown as ImageData;
};
const decA = _internal.newDecoder();
decA.decode(frame(true, false), 100);
assert.equal(decA.decode(frame(true, false), 150).length, 0, "ring-only + no sampler ⇒ no decode");
const decB = _internal.newDecoder();
decB.decode(frame(true, false), 100, () => hi(true));
const fine = decB.decode(frame(true, false), 150, () => hi(true))[0];
assert.equal(fine?.beaconId, hex2(ID), "fine sampler recovers the decode the coarse frame misses");

console.log("ok — fine sampling: native-res crop recovers a decode coarse cannot →", hex2(ID));
