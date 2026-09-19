// Decoder tuning harness: run the REAL optical decoder over raw RGBA frames
// extracted from a badge recording. Prints localization diagnostics + the ids
// it decodes. Usage: tsx scripts/tune.ts <raw-rgba-file> <width> <height>
import { readFileSync } from "node:fs";
import { decodeBeacons, _internal } from "../src/decode/beacon";
import { decodeFrame, hex2, FRAME_CELL, SYMBOLS_PER_FRAME } from "@shared/beacon";

const [path, wS, hS] = process.argv.slice(2);
const W = +wS, H = +hS, frameBytes = W * H * 4;
const buf = readFileSync(path);
const n = Math.floor(buf.length / frameBytes);
console.log(`frames=${n} ${W}x${H}`);

const frameAt = (i: number): ImageData =>
  ({ data: new Uint8ClampedArray(buf.buffer, buf.byteOffset + i * frameBytes, frameBytes), width: W, height: H }) as unknown as ImageData;

// Phase A — trace the largest (real) patch across consecutive frames
const A = +(process.argv[5] ?? 28), B = +(process.argv[6] ?? 80);
console.log(`\nconsecutive largest-patch trace [${A}..${B}]  (idx0=clock idx1=frame idx2-5=d3..d0)`);
for (let i = A; i < B; i++) {
  const boxes = _internal.locatePatches(frameAt(i));
  if (!boxes.length) { console.log(`  ${i}: —`); continue; }
  const b = boxes.reduce((p, c) => (c.w * c.h > p.w * p.h ? c : p));
  const s = _internal.sampleCells(frameAt(i), b);
  console.log(`  ${i}: bits=${s.bits.map((x) => (x ? 1 : 0)).join("")} border=${s.borderLum.toFixed(0)} conf=${s.confident ? "Y" : "."} ${Math.round(b.w)}x${Math.round(b.h)}`);
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

// Phase C — log every 3-symbol assembly attempt + its decode result
console.log(`\n=== assembly trace ===`);
let lastKey = "", collecting: boolean[][] | null = null;
const results = new Map<string, number>();
for (let i = 0; i < n; i++) {
  const boxes = _internal.locatePatches(frameAt(i));
  if (!boxes.length) continue;
  const b = boxes.reduce((p, c) => (c.w * c.h > p.w * p.h ? c : p));
  const s = _internal.sampleCells(frameAt(i), b);
  if (!s.confident) continue;
  const key = s.bits.slice(1).map((x) => (x ? 1 : 0)).join("");
  if (key === lastKey) continue;
  lastKey = key;
  if (s.bits[FRAME_CELL - 1]) collecting = [s.bits];
  else if (collecting) {
    collecting.push(s.bits);
    if (collecting.length === SYMBOLS_PER_FRAME) {
      const id = decodeFrame(collecting);
      const r = id === null ? "CRC-FAIL" : hex2(id);
      results.set(r, (results.get(r) ?? 0) + 1);
      console.log(`  f${i}: ${collecting.map((c) => c.map((x) => (x ? 1 : 0)).join("")).join(" ")} -> ${r}`);
      collecting = null;
    }
  }
}
console.log("assembly results:", [...results.entries()].map(([r, c]) => `${r}×${c}`).join(", "));
