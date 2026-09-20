// Decoder tuning harness: run the REAL optical decoder over raw RGBA frames
// extracted from a badge recording. Prints localization diagnostics + the ids
// it decodes. Usage: tsx scripts/tune.ts <raw-rgba-file> <width> <height>
import { readFileSync } from "node:fs";
import { decodeBeacons, _internal } from "../src/decode/beacon";
import {
  decodeFrame, hex2, SYMBOLS_PER_FRAME, ALPHABET_NAMES, MARK_IN_INDEX, MARK_OUT_INDEX,
} from "@shared/beacon";

const [path, wS, hS] = process.argv.slice(2);
const W = +wS, H = +hS, frameBytes = W * H * 4;
const buf = readFileSync(path);
const n = Math.floor(buf.length / frameBytes);
console.log(`frames=${n} ${W}x${H}`);

const frameAt = (i: number): ImageData =>
  ({ data: new Uint8ClampedArray(buf.buffer, buf.byteOffset + i * frameBytes, frameBytes), width: W, height: H }) as unknown as ImageData;

// Phase A — trace the largest (real) patch across consecutive frames
const A = +(process.argv[5] ?? 28), B = +(process.argv[6] ?? 80);
console.log(`\nconsecutive largest-patch trace [${A}..${B}]  (one colour symbol per frame)`);
for (let i = A; i < B; i++) {
  const boxes = _internal.locatePatches(frameAt(i));
  if (!boxes.length) { console.log(`  ${i}: —`); continue; }
  const b = boxes.reduce((p, c) => (c.w * c.h > p.w * p.h ? c : p));
  const s = _internal.sampleSymbol(frameAt(i), b);
  const name = s.symbol === null ? "-----" : ALPHABET_NAMES[s.symbol];
  console.log(`  ${i}: sym=${name.padEnd(5)} border=${s.borderLum.toFixed(0)} conf=${s.confident ? "Y" : "."} ${Math.round(b.w)}x${Math.round(b.h)}`);
}

// Phase B — temporal decode across the clip
const seen = new Map<string, number>();
let first = -1;
for (let i = 0; i < n; i++) {
  for (const r of decodeBeacons(frameAt(i), i * 33.34)) {
    seen.set(r.beaconId, (seen.get(r.beaconId) ?? 0) + 1);
    if (first < 0) first = i;
  }
}
console.log(`\n=== decode summary ===`);
console.log(`first reading at frame ${first}`);
console.log(`ids seen: ${[...seen.entries()].map(([id, c]) => `${id}×${c}`).join(", ") || "NONE"}`);

// Phase C — log every 9-symbol assembly attempt + its decode result
console.log(`\n=== assembly trace ===`);
let lastSym: number | null = null, collecting: number[] | null = null;
const results = new Map<string, number>();
for (let i = 0; i < n; i++) {
  const boxes = _internal.locatePatches(frameAt(i));
  if (!boxes.length) continue;
  const b = boxes.reduce((p, c) => (c.w * c.h > p.w * p.h ? c : p));
  const s = _internal.sampleSymbol(frameAt(i), b);
  if (!s.confident || s.symbol === null) continue;
  if (s.symbol === lastSym) continue; // same symbol still on screen
  lastSym = s.symbol;
  if (s.symbol === MARK_IN_INDEX || s.symbol === MARK_OUT_INDEX) collecting = [s.symbol];
  else if (collecting) {
    collecting.push(s.symbol);
    if (collecting.length === SYMBOLS_PER_FRAME) {
      const out = decodeFrame(collecting);
      const r = out === null ? "CRC-FAIL" : `${hex2(out.id)} ${out.optIn ? "in" : "out"}`;
      results.set(r, (results.get(r) ?? 0) + 1);
      console.log(`  f${i}: ${collecting.map((c) => ALPHABET_NAMES[c]).join(" ")} -> ${r}`);
      collecting = null;
    }
  }
}
console.log("assembly results:", [...results.entries()].map(([r, c]) => `${r}×${c}`).join(", "));
