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
const colorDec = _internal.newColorDecoder(); // this section is the blink-era colour engine
let got: string | undefined;
let optIn: boolean | undefined;
let t = 0;
for (let cycle = 0; cycle < 3; cycle++) {
  for (let s = 0; s < SYMBOLS_PER_FRAME; s++) {
    const f = frameFor(s);
    for (let k = 0; k < 2; k++) {
      const out = colorDec.decode(f, (t += 50));
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

// 4) v3 STATIC KEY (firmware 0.4.0) — the engine the app runs by default.
//    Contract: every id round-trips and a wrong CRC nibble never yields an id.
//    Pixels: rendered keys at six sizes, both consents, read through the real
//    decoder; the dispatch; the confirm gate; and three things that must NOT read.
import { packKey, unpackKey, keyText, crc4, KEY, MARK_OPT_IN } from "@shared/beacon";
import { paintKey } from "../src/decode/patch";
import { KeyDecoder } from "../src/decode/key";
import { flags } from "../src/config/flags";

assert.equal(flags.BEACON_OPTICAL_MODE, "key", "the static key is the default engine");
assert.equal(keyText(0x27), "271", "the badge in the PR photo: id 0x27 shows 271");
assert.equal(crc4(0x27, 8), 1);
for (let id = 0; id < 256; id++) {
  assert.equal(unpackKey(packKey(id)), id, `key round-trip ${id}`);
  for (let n = 0; n < 16; n++) if (n !== (packKey(id) & 0xf)) assert.equal(unpackKey((id << 4) | n), null, "a wrong CRC nibble never yields an id");
}

const scene = (W: number, H: number, paint: (data: Uint8ClampedArray) => void): ImageData => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = 40; data[i * 4 + 1] = 40; data[i * 4 + 2] = 60; data[i * 4 + 3] = 255; }
  paint(data);
  return { data, width: W, height: H } as unknown as ImageData;
};
const keyScene = (id: number, optIn: boolean, kw: number): ImageData => {
  const W = Math.round(kw * 2.2), H = Math.round(W * 0.7);
  return scene(W, H, (data) => paintKey(data, W, H, { x: Math.round(W * 0.25), y: Math.round(H * 0.2), w: kw, h: Math.round(kw * 0.75) }, id, optIn));
};
const readKey = (f: ImageData) => { const dec = new KeyDecoder(); dec.decode(f, 0); return dec.decode(f, 60); };
for (const [id, optIn, kw] of [[0x27, true, 320], [0x27, false, 200], [0x11, true, 120], [0xcf, true, 80], [0x88, false, 60], [0x5e, true, 96]] as const) {
  const out = readKey(keyScene(id, optIn, kw));
  assert.equal(out[0]?.beaconId, hex2(id), `key ${keyText(id)} on a ${kw} px screen (${Math.round((kw * KEY.span) / 320)} px key) reads back`);
  assert.equal(out[0]?.optIn, optIn, `consent rides on the digit colour (${keyText(id)})`);
  assert.equal(out.length, 1, "one badge, one reading");
}
{ // the dispatch: decodeBeacons in the default mode IS the key engine
  const f = keyScene(0x27, true, 240);
  decodeBeacons(f, 1000);
  assert.equal(decodeBeacons(f, 1060)[0]?.beaconId, "27", "decodeBeacons dispatches to the key engine");
}
assert.equal(new KeyDecoder().decode(keyScene(0x27, true, 240), 0).length, 0, "a single sighting never confirms an id");
{ // refusals ⇒ blur: a solid mint rectangle, six LED-like dots, noise
  const solid = scene(400, 300, (data) => { for (let y = 60; y < 240; y++) for (let x = 100; x < 340; x++) { const o = (y * 400 + x) * 4; data[o] = MARK_OPT_IN[0]; data[o + 1] = MARK_OPT_IN[1]; data[o + 2] = MARK_OPT_IN[2]; } });
  assert.equal(readKey(solid).length, 0, "a solid mint rectangle is not a key");
  const dots = scene(400, 300, (data) => { for (const [cx, cy] of [[80, 60], [320, 60], [80, 150], [320, 150], [120, 260], [280, 260]]) for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 4; x <= cx + 4; x++) { const o = (y * 400 + x) * 4; data[o] = 0; data[o + 1] = 255; data[o + 2] = 40; } });
  assert.equal(readKey(dots).length, 0, "six LED dots are not a key");
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const noise = scene(400, 300, (data) => { for (let i = 0; i < 400 * 300; i++) { data[i * 4] = rnd() * 255; data[i * 4 + 1] = rnd() * 255; data[i * 4 + 2] = rnd() * 255; } });
  assert.equal(readKey(noise).length, 0, "noise is not a key");
}
console.log("ok — static key: contract (256 ids, CRC refusals), 6 rendered keys both consents, dispatch, confirm gate, 3 refusals");
