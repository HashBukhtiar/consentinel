// Self-check for the optical decoder — synthetic frames, no camera/badge.
// Proves: our colour mapping inverts A's decodeFrame, the localizer finds the
// patch, and symbol assembly + CRC reconstruct the id end-to-end.
import assert from "node:assert";
import {
  hex2, packPayload, unpackPayload, decodeFrame, frameSymbols, SYMBOLS_PER_FRAME,
} from "@shared/beacon";
import { symbolColors, paintPatch } from "../src/decode/patch";
import { decodeBeacons, _internal } from "../src/decode/beacon";

const ID = 0x4e; // Maaz's real demo id
const OPT_IN = true;

// 1) the wire format round-trips, for both consents and every id
for (const optIn of [true, false]) {
  const rt = unpackPayload(packPayload(ID, optIn));
  assert.deepEqual(rt, { id: ID, optIn }, `crc round-trip (optIn=${optIn})`);
  assert.deepEqual(
    decodeFrame(frameSymbols(ID, optIn)), { id: ID, optIn },
    `frameSymbols <-> decodeFrame (optIn=${optIn})`,
  );
}

// 2) full pixel pipeline: paint each symbol, decode it back through the camera
//    path. 4:3 patch, matching the full-screen badge geometry.
const W = 260, H = 200, rect = { x: 60, y: 50, w: 120, h: 90 };
const colors = symbolColors(ID, OPT_IN);
const frameFor = (s: number): ImageData => {
  const data = new Uint8ClampedArray(W * H * 4);
  paintPatch(data, W, H, rect, colors[s]);
  return { data, width: W, height: H } as unknown as ImageData;
};

assert.ok(_internal.locatePatches(frameFor(0)).length >= 1, "localizer finds the patch");

// every painted symbol must classify back to the symbol we painted
for (let s = 0; s < SYMBOLS_PER_FRAME; s++) {
  const f = frameFor(s);
  const bb = _internal.locatePatches(f)[0];
  const got = _internal.sampleSymbol(f, bb);
  assert.ok(got.confident, `symbol ${s} sampled confidently`);
  assert.equal(got.symbol, frameSymbols(ID, OPT_IN)[s], `symbol ${s} classifies back`);
}

// 3 cycles so the "confirm an id twice" guard fires (each symbol ~2 frames)
let got: string | undefined;
let optIn: boolean | undefined;
let t = 0;
for (let cycle = 0; cycle < 3; cycle++) {
  for (let s = 0; s < SYMBOLS_PER_FRAME; s++) {
    const f = frameFor(s);
    for (let k = 0; k < 2; k++) {
      const out = decodeBeacons(f, (t += 50));
      if (out.length) { got = out[0].beaconId; optIn = out[0].optIn; }
    }
  }
}
assert.equal(got, hex2(ID), `decodes beacon id ${hex2(ID)}`);
assert.equal(optIn, OPT_IN, "consent rides along in the light");

console.log("ok — optical decode: colour mapping, localization, assembly+CRC →", hex2(ID));

// 3) fine-sampling path: a coarse frame whose interior is an unclassifiable
// grey (what a tiny, blurred badge looks like) can't decode — but a native-res
// crop of the same region carrying the real colour can. Localize coarse,
// sample fine: the distance de-risk.
const GREY: [number, number, number] = [80, 80, 80]; // below BEACON_WHITE_T: stays out of the ring's component
const coarseGrey = (): ImageData => {
  const data = new Uint8ClampedArray(W * H * 4);
  paintPatch(data, W, H, rect, GREY);
  return { data, width: W, height: H } as unknown as ImageData;
};
const fineFor = (s: number): ImageData => {
  const cw = 320, ch = 240, data = new Uint8ClampedArray(cw * ch * 4);
  paintPatch(data, cw, ch, { x: 0, y: 0, w: cw, h: ch }, colors[s]);
  return { data, width: cw, height: ch } as unknown as ImageData;
};
const decA = _internal.newColorDecoder(); // the fine-sampling path belongs to the colour decoder
let coarseOnly: string | undefined; let ta = 0;
for (let c = 0; c < 3; c++) for (let s = 0; s < SYMBOLS_PER_FRAME; s++) for (let k = 0; k < 2; k++) {
  const o = decA.decode(coarseGrey(), (ta += 50));
  if (o.length) coarseOnly = o[0].beaconId;
}
assert.equal(coarseOnly, undefined, "grey interior + no sampler ⇒ no decode");
const decB = _internal.newColorDecoder();
let fine: string | undefined; let tb = 0; let curS = 0;
for (let c = 0; c < 3; c++) for (let s = 0; s < SYMBOLS_PER_FRAME; s++) { curS = s; for (let k = 0; k < 2; k++) {
  const o = decB.decode(coarseGrey(), (tb += 50), () => fineFor(curS));
  if (o.length) fine = o[0].beaconId;
} }
assert.equal(fine, hex2(ID), "fine sampler recovers the decode the coarse frame misses");
console.log("ok — fine sampling: native-res crop recovers a decode coarse cannot →", hex2(ID));
