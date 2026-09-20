// Optical beacon decoder (firmware v0.4, STATIC key): camera frame →
// BeaconReading[]. Finds the badge's white ring, samples the 21 segments of
// its three 7-segment hex digits, maps each glyph to a nibble, and CRC-checks
// the 12-bit payload with A's unpackPayload(). One frame is enough; an id is
// trusted once it reads the same on two consecutive confident frames.
// Anything unreadable is simply absent → the face stays blurred.
//
// The digit colour is a restrict-only consent hint (mint = opt-in, rose =
// opt-out) surfaced as `lightConsent`; decide() can only use it to BLUR.
//
// ponytail: axis-aligned sampling, no perspective correction — fine for the
// controlled 2–3-badge demo (wearers face the camera). Thresholds in
// flags.BEACON_* are tuned against real recordings; retune with scripts/tune.ts.
import { hex2, decodeKey, SEG_TO_NIBBLE, DIGITS } from "@shared/beacon";
import type { BeaconReading, DecodeBeacons, ConsentState } from "../shared/schema";
import { segRectFrac, RING_REF_FRACS, SEGS } from "./patch";
import { flags } from "../config/flags";

type Frame = ImageData; // uses only .data/.width/.height
type Box = { x: number; y: number; w: number; h: number };

// Mean of max(R,G,B) over a box — "lit" regardless of hue (mint, rose and white
// all read ~255; black reads ~0) — plus mean R and G to tell mint from rose.
function boxStat(f: Frame, cx: number, cy: number, hw: number, hh: number) {
  const x0 = Math.max(0, Math.round(cx - hw)), x1 = Math.min(f.width - 1, Math.round(cx + hw));
  const y0 = Math.max(0, Math.round(cy - hh)), y1 = Math.min(f.height - 1, Math.round(cy + hh));
  let mx = 0, r = 0, g = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * f.width + x) * 4;
      const R = f.data[o], G = f.data[o + 1], B = f.data[o + 2];
      mx += Math.max(R, G, B); r += R; g += G; n++;
    }
  }
  return n ? { max: mx / n, r: r / n, g: g / n } : { max: 0, r: 0, g: 0 };
}

// ---- localization: bright connected components filtered by size/aspect ------
// Split into scan + reject so the tuning page can show WHY a candidate was
// thrown away. locatePatches() is the production path.
export interface Component { x: number; y: number; w: number; h: number; count: number; aspect: number; fill: number }

/** Smallest blob worth reporting to a human — well below BEACON_MIN_W. */
const DIAG_MIN_W = 6;

function scanComponents(f: Frame): Component[] {
  const { width: W, height: H } = f;
  const bright = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    bright[i] = 0.299 * f.data[o] + 0.587 * f.data[o + 1] + 0.114 * f.data[o + 2] > flags.BEACON_BRIGHT_T ? 1 : 0;
  }
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  const out: Component[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!bright[start] || seen[start]) continue;
    let minX = W, minY = H, maxX = 0, maxY = 0, count = 0;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p / W) | 0;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && bright[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && bright[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && bright[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && bright[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (w < DIAG_MIN_W) continue;
    out.push({ x: minX, y: minY, w, h, count, aspect: w / h, fill: count / (w * h) });
  }
  return out;
}

/** null = accepted as a key; otherwise a human-readable reason. */
export function rejectReason(c: Component, frameW: number): string | null {
  if (c.w < flags.BEACON_MIN_W) return `too small (w ${c.w} < ${flags.BEACON_MIN_W})`;
  if (c.w > frameW * 0.95) return "fills the frame";
  if (c.aspect < flags.BEACON_ASPECT_MIN) return `too tall (aspect ${c.aspect.toFixed(2)} < ${flags.BEACON_ASPECT_MIN})`;
  if (c.aspect > flags.BEACON_ASPECT_MAX) return `too wide (aspect ${c.aspect.toFixed(2)} > ${flags.BEACON_ASPECT_MAX})`;
  if (c.fill < 0.08) return `too sparse (fill ${c.fill.toFixed(3)} < 0.08)`; // noise, not a ring
  return null;
}

function locatePatches(f: Frame): Box[] {
  return scanComponents(f)
    .filter((c) => rejectReason(c, f.width) === null)
    .map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }));
}

// ---- segment sampling -------------------------------------------------------
export interface Sampled {
  bits: boolean[]; // 21 segment states, digit-major
  lums: number[]; // per-segment "lit" level (mean max-channel)
  thr: number;
  borderLum: number; // ring reference
  minMargin: number;
  confident: boolean;
  nibbles: (number | null)[]; // per digit; null = not a valid glyph
  light: ConsentState; // mint ⇒ opt_in, rose ⇒ opt_out
}

// White level of the always-lit ring: max over its 4 mid-edges (uniform, so
// max is a stable reference under tilt/noise).
function ringLevel(f: Frame, bb: Box): number {
  const hw = Math.max(1, bb.w * 0.02), hh = Math.max(1, bb.h * 0.02);
  return Math.max(...RING_REF_FRACS.map(([fx, fy]) => boxStat(f, bb.x + fx * bb.w, bb.y + fy * bb.h, hw, hh).max));
}

function sampleCells(f: Frame, bb: Box): Sampled {
  const ring = ringLevel(f, bb);
  const thr = flags.BEACON_CELL_LIT_FRAC * ring;
  const bits: boolean[] = [], lums: number[] = [], nibbles: (number | null)[] = [];
  let minMargin = Infinity, anyDark = false, anyLit = false, litR = 0, litG = 0;
  for (let d = 0; d < DIGITS; d++) {
    let mask = 0;
    for (let s = 1; s <= SEGS; s++) {
      const r = segRectFrac(d, s);
      // average the central ~70% of each segment — tolerant of tilt
      const st = boxStat(f, bb.x + (r.fx + r.fw / 2) * bb.w, bb.y + (r.fy + r.fh / 2) * bb.h, r.fw * bb.w * 0.35, r.fh * bb.h * 0.35);
      const lit = st.max > thr;
      bits.push(lit); lums.push(st.max);
      if (lit) { mask |= 1 << (s - 1); anyLit = true; litR += st.r; litG += st.g; } else anyDark = true;
      minMargin = Math.min(minMargin, Math.abs(st.max - thr));
    }
    nibbles.push(SEG_TO_NIBBLE.get(mask) ?? null);
  }
  // trust the read only with a bright ring, both lit and dark segments (every
  // valid 3-digit key has both; rejects solid blobs), and every segment clear
  // of the threshold; the glyph table + CRC reject the rest
  const confident = ring > flags.BEACON_MIN_BORDER && anyLit && anyDark && minMargin > ring * flags.BEACON_CONTRAST_FRAC;
  return { bits, lums, thr, borderLum: ring, minMargin, confident, nibbles, light: litG > litR ? "opt_in" : "opt_out" };
}

// Funnel counters for the tuning page. Bumping integers per frame is free.
export const decoderStats = {
  symbols: 0, // confident reads
  anchors: 0, // reads where all three glyphs were valid
  assembled: 0, // payloads formed (== anchors for a static key)
  crcOk: 0,
  crcFail: 0,
  confirmed: 0, // ids that read the same twice in a row and became trusted
  reset() { this.symbols = this.anchors = this.assembled = this.crcOk = this.crcFail = this.confirmed = 0; },
};

// ---- per-key confirmation ---------------------------------------------------
// Static key ⇒ no assembly. An id is trusted after the same CRC-valid read on
// two consecutive confident frames — cheap insurance against a motion-blurred
// glyph that happens to pass CRC.
class KeyReader {
  private prevId: number | null = null;
  private prevCount = 0;
  lastId: number | null = null;
  lastLight: ConsentState = "opt_out";
  lastDecodeMs = 0;

  feed(s: Sampled, tMs: number): void {
    decoderStats.symbols++;
    if (s.nibbles.some((n) => n === null)) { this.prevId = null; this.prevCount = 0; return; }
    decoderStats.anchors++; decoderStats.assembled++;
    const id = decodeKey(s.nibbles as number[]);
    if (id === null) { decoderStats.crcFail++; this.prevId = null; this.prevCount = 0; return; }
    decoderStats.crcOk++;
    this.prevCount = id === this.prevId ? this.prevCount + 1 : 1;
    this.prevId = id;
    if (this.prevCount >= 2) {
      if (this.lastId !== id) decoderStats.confirmed++;
      this.lastId = id; this.lastLight = s.light; this.lastDecodeMs = tMs;
    }
  }
}

// ---- decoder: track keys across frames, one reader per key ------------------
// A key's reader survives non-confident frames (motion blur, occlusion) for
// BEACON_TRACK_MISS frames, exactly like the face tracker.
type PatchTrack = { cx: number; cy: number; asm: KeyReader; missed: number };

// A higher-resolution crop of a normalized [0,1] frame region, supplied by the
// loop from the source video: localize cheap (coarse frame), sample fine.
export type RegionSampler = (nx: number, ny: number, nw: number, nh: number) => ImageData | null;

class BeaconDecoder {
  private tracks: PatchTrack[] = [];

  decode(f: Frame, tMs: number, sampler?: RegionSampler): BeaconReading[] {
    const unmatched = new Set(this.tracks);
    for (const bb of locatePatches(f)) {
      const fine = sampler?.(bb.x / f.width, bb.y / f.height, bb.w / f.width, bb.h / f.height);
      const s = fine ? sampleCells(fine, { x: 0, y: 0, w: fine.width, h: fine.height }) : sampleCells(f, bb);
      if (!s.confident) continue;
      const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
      let tr = nearest(unmatched, cx, cy, flags.BEACON_MATCH_PX);
      if (tr) { unmatched.delete(tr); tr.cx = cx; tr.cy = cy; tr.missed = 0; }
      else { tr = { cx, cy, asm: new KeyReader(), missed: 0 }; this.tracks.push(tr); }
      tr.asm.feed(s, tMs);
    }
    for (const tr of unmatched) tr.missed++;
    this.tracks = this.tracks.filter((tr) => tr.missed <= flags.BEACON_TRACK_MISS);

    const out: BeaconReading[] = [];
    for (const tr of this.tracks) {
      if (tr.asm.lastId !== null && tMs - tr.asm.lastDecodeMs < flags.BEACON_ID_HOLD_MS) {
        out.push({
          beaconId: hex2(tr.asm.lastId),
          imagePosition: { x: tr.cx / f.width, y: tr.cy / f.height },
          confidence: 1,
          lightConsent: tr.asm.lastLight,
        });
      }
    }
    return out;
  }
}

function nearest(set: Iterable<PatchTrack>, cx: number, cy: number, maxPx: number): PatchTrack | null {
  let best: PatchTrack | null = null, bestD = maxPx * maxPx;
  for (const t of set) {
    const d = (t.cx - cx) ** 2 + (t.cy - cy) ** 2;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

const decoder = new BeaconDecoder();
export const decodeBeacons = (frame: ImageData, tMs: number, sampler?: RegionSampler): BeaconReading[] =>
  decoder.decode(frame, tMs, sampler);

/** A decoder with its own key-track state — for the offline sweep, which
 *  runs hundreds of independent trials and must not leak state between them. */
export function createDecoder(): DecodeBeacons {
  const d = new BeaconDecoder();
  return (frame, tMs) => d.decode(frame, tMs);
}

// exported for the self-check and the tuning page
export const _internal = { locatePatches, sampleCells, scanComponents, newDecoder: () => new BeaconDecoder() };
