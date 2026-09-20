// Optical beacon decoder: camera frame → BeaconReading[]. Finds the badge's
// white-bordered patch, samples its 3×2 cell grid, recovers the symbol clock
// from the clock lane, and hands 3 symbols to A's decodeFrame() for CRC-checked
// assembly. Anything it can't confidently read is simply absent → the face
// stays blurred (DEFAULT_CONSENT). See shared/beacon.ts for the wire format.
//
// ponytail: naive full-frame connected-components + axis-aligned sampling — no
// perspective correction. Fine for the controlled 2–3-badge demo (wearers face
// the camera). Upgrade to a quad homography if badges tilt. Thresholds in
// flags.BEACON_* need ~10 min of tuning against a real badge/recording.
import { decodeFrame, hex2, FRAME_CELL, SYMBOLS_PER_FRAME, PATCH, BORDER_PX } from "@shared/beacon";
import type { SymbolSample } from "@shared/beacon";
import type { BeaconReading, DecodeBeacons } from "../shared/schema";
import { cellRectFrac } from "./patch";
import { flags } from "../config/flags";

type Frame = ImageData; // uses only .data/.width/.height
type Box = { x: number; y: number; w: number; h: number };

// Average luma over a box (robust to noise, perspective offset, JPEG ringing).
function boxLum(f: Frame, cx: number, cy: number, hw: number, hh: number): number {
  const x0 = Math.max(0, Math.round(cx - hw)), x1 = Math.min(f.width - 1, Math.round(cx + hw));
  const y0 = Math.max(0, Math.round(cy - hh)), y1 = Math.min(f.height - 1, Math.round(cy + hh));
  let sum = 0, cnt = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * f.width + x) * 4;
      sum += 0.299 * f.data[o] + 0.587 * f.data[o + 1] + 0.114 * f.data[o + 2];
      cnt++;
    }
  }
  return cnt ? sum / cnt : 0;
}

// ---- localization: bright connected components filtered by size/aspect ------
function locatePatches(f: Frame): Box[] {
  const { width: W, height: H } = f;
  const bright = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    bright[i] = 0.299 * f.data[o] + 0.587 * f.data[o + 1] + 0.114 * f.data[o + 2] > flags.BEACON_BRIGHT_T ? 1 : 0;
  }
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  const out: Box[] = [];
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
    const aspect = w / h;
    if (w < flags.BEACON_MIN_W || w > W * 0.95) continue;
    if (aspect < flags.BEACON_ASPECT_MIN || aspect > flags.BEACON_ASPECT_MAX) continue;
    if (count < w * h * 0.08) continue; // reject sparse noise, keep border-ring shapes
    out.push({ x: minX, y: minY, w, h });
  }
  return out;
}

// ---- cell sampling ----------------------------------------------------------
interface Sampled { bits: boolean[]; borderLum: number; confident: boolean }

// Brightness of the always-lit border: max over the 4 side midpoints (the
// border is uniform, so max is a stable white reference even under tilt/noise).
function borderLum(f: Frame, bb: Box): number {
  const bx = (BORDER_PX / PATCH.w) * bb.w, by = (BORDER_PX / PATCH.h) * bb.h;
  const hw = Math.max(1, bx * 0.4), hh = Math.max(1, by * 0.4);
  return Math.max(
    boxLum(f, bb.x + bb.w * 0.5, bb.y + by * 0.5, hw, hh), // top
    boxLum(f, bb.x + bb.w * 0.5, bb.y + bb.h - by * 0.5, hw, hh), // bottom
    boxLum(f, bb.x + bx * 0.5, bb.y + bb.h * 0.5, hw, hh), // left
    boxLum(f, bb.x + bb.w - bx * 0.5, bb.y + bb.h * 0.5, hw, hh), // right
  );
}

function sampleCells(f: Frame, bb: Box): Sampled {
  const bl = borderLum(f, bb);
  const thr = flags.BEACON_CELL_LIT_FRAC * bl;
  const bits: boolean[] = [];
  let minMargin = Infinity, anyDark = false;
  for (let i = 1; i <= 6; i++) {
    const r = cellRectFrac(i);
    // average the central 60% of each cell — tolerant of the tilt
    const lum = boxLum(f,
      bb.x + (r.fx + r.fw / 2) * bb.w, bb.y + (r.fy + r.fh / 2) * bb.h,
      r.fw * bb.w * 0.3, r.fh * bb.h * 0.3);
    bits.push(lum > thr);
    if (lum <= thr) anyDark = true;
    minMargin = Math.min(minMargin, Math.abs(lum - thr));
  }
  // trust the read only with a bright border, a dark cell (rejects solid-white
  // blobs), and every cell clear of the threshold; CRC rejects the rest
  const confident = bl > flags.BEACON_MIN_BORDER && anyDark && minMargin > bl * flags.BEACON_CONTRAST_FRAC;
  return { bits, borderLum: bl, confident };
}

// ---- per-patch symbol assembly ---------------------------------------------
// The badge holds each symbol for ~2-3 camera frames, so we treat a change in
// the full cell pattern as a symbol boundary (the clock lane alone is a
// free-running square wave and unreliable under motion blur). The frame marker
// (lit on symbol 0) anchors each frame. A decoded id must repeat before we
// trust it — kills the ~1/16 chance a motion-blur transition passes CRC.
class FrameAssembler {
  private lastKey: string | null = null;
  private collecting: SymbolSample[] | null = null;
  private hist: { id: number; t: number }[] = [];
  lastId: number | null = null;
  lastDecodeMs = 0;

  feed(sym: SymbolSample, tMs: number): void {
    // key on frame marker + data cells; the clock lane (idx 0) is too noisy
    // under tilt/motion blur to segment on.
    const key = sym.slice(1).map((b) => (b ? 1 : 0)).join("");
    if (key === this.lastKey) return; // same symbol still on screen
    this.lastKey = key;

    if (sym[FRAME_CELL - 1]) {
      this.collecting = [sym]; // symbol 0 — (re)anchor the frame
    } else if (this.collecting) {
      this.collecting.push(sym);
      if (this.collecting.length === SYMBOLS_PER_FRAME) {
        const id = decodeFrame(this.collecting);
        this.collecting = null;
        if (id !== null) {
          this.hist = this.hist.filter((h) => tMs - h.t < flags.BEACON_CONFIRM_MS);
          this.hist.push({ id, t: tMs });
          if (this.hist.filter((h) => h.id === id).length >= 2) { this.lastId = id; this.lastDecodeMs = tMs; }
        }
      }
    }
  }
}

// ---- diagnostics: what the localizer/sampler saw this frame ------------------
// Read by the pipeline to draw the debug overlay and by the operator panel to
// say *why* nothing decodes (no bright quad / low contrast / no repeat yet).
export interface BeaconDebug {
  width: number;
  height: number;
  candidates: { box: Box; borderLum: number; confident: boolean; bits: boolean[] }[];
  tracks: { cx: number; cy: number; lastId: number | null; sinceDecodeMs: number; missed: number }[];
  bright: number; // fraction of pixels above BEACON_BRIGHT_T (0..1) — ~0 ⇒ too dark / too far
}
export let lastDebug: BeaconDebug = { width: 0, height: 0, candidates: [], tracks: [], bright: 0 };

// ---- decoder: track patches across frames, run an assembler per patch -------
// A patch's assembler MUST survive the frequent non-confident frames (motion
// blur, occlusion) or it never accumulates enough decodes to confirm an id — so
// tracks persist for BEACON_TRACK_MISS frames, exactly like the face tracker.
type PatchTrack = { cx: number; cy: number; asm: FrameAssembler; missed: number };

class BeaconDecoder {
  private tracks: PatchTrack[] = [];

  decode(f: Frame, tMs: number): BeaconReading[] {
    const unmatched = new Set(this.tracks);
    const dbg: BeaconDebug = { width: f.width, height: f.height, candidates: [], tracks: [], bright: brightFraction(f) };
    for (const bb of locatePatches(f)) {
      const s = sampleCells(f, bb);
      dbg.candidates.push({ box: bb, borderLum: s.borderLum, confident: s.confident, bits: s.bits });
      if (!s.confident) continue;
      const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
      let tr = nearest(unmatched, cx, cy, flags.BEACON_MATCH_PX);
      if (tr) { unmatched.delete(tr); tr.cx = cx; tr.cy = cy; tr.missed = 0; }
      else { tr = { cx, cy, asm: new FrameAssembler(), missed: 0 }; this.tracks.push(tr); }
      tr.asm.feed(s.bits, tMs);
    }
    for (const tr of unmatched) tr.missed++;
    this.tracks = this.tracks.filter((tr) => tr.missed <= flags.BEACON_TRACK_MISS);

    const out: BeaconReading[] = [];
    for (const tr of this.tracks) {
      dbg.tracks.push({ cx: tr.cx, cy: tr.cy, lastId: tr.asm.lastId, sinceDecodeMs: tr.asm.lastId === null ? Infinity : tMs - tr.asm.lastDecodeMs, missed: tr.missed });
      if (tr.asm.lastId !== null && tMs - tr.asm.lastDecodeMs < flags.BEACON_ID_HOLD_MS) {
        out.push({ beaconId: hex2(tr.asm.lastId), imagePosition: { x: tr.cx / f.width, y: tr.cy / f.height }, confidence: 1 });
      }
    }
    lastDebug = dbg;
    return out;
  }
}

// cheap: sample every 8th pixel
function brightFraction(f: Frame): number {
  let n = 0, hit = 0;
  for (let i = 0; i < f.width * f.height; i += 8) {
    const o = i * 4;
    if (0.299 * f.data[o] + 0.587 * f.data[o + 1] + 0.114 * f.data[o + 2] > flags.BEACON_BRIGHT_T) hit++;
    n++;
  }
  return n ? hit / n : 0;
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
export const decodeBeacons: DecodeBeacons = (frame, tMs) => decoder.decode(frame, tMs);

// exported for the self-check
export const _internal = { locatePatches, sampleCells };
