// Optical beacon decoder: camera frame → BeaconReading[]. Finds the badge's
// white-ringed patch, classifies the colour of its interior against that ring,
// and hands 9 symbols to A's decodeFrame() for CRC-checked assembly. Anything
// it can't confidently read is simply absent → the face stays blurred
// (DEFAULT_CONSENT). See shared/beacon.ts for the wire format.
//
// v2: the interior is one blob carrying a 7-colour alphabet, not a 3x2 grid of
// lit/unlit cells. Two consequences worth knowing:
//   - there is no clock lane. The differential step is never 0, so the colour
//     ALWAYS changes between symbols and a change IS the symbol boundary;
//   - there is no frame-marker cell. Symbol 0 is a MARKER COLOUR (MINT/ROSE)
//     that lives outside the data ring, so any marker sighting re-anchors the
//     frame with no counter and no preamble correlation.
//
// ponytail: naive full-frame connected-components + axis-aligned sampling — no
// perspective correction. Fine for the controlled 2–3-badge demo (wearers face
// the camera). Upgrade to a quad homography if badges tilt. Thresholds in
// flags.BEACON_* need ~10 min of tuning against a real badge/recording.
import {
  decodeFrame, hex2, classifySymbol, lumaOf,
  SYMBOLS_PER_FRAME, PATCH, BORDER_PX,
  MARK_IN_INDEX, MARK_OUT_INDEX,
} from "@shared/beacon";
import type { RGB } from "@shared/beacon";
import type { BeaconReading, DecodeBeacons } from "../shared/schema";
import { SAMPLE_BOX_FRAC } from "./patch";
import { flags } from "../config/flags";
import { SeqDecoder } from "./seq";
import { KeyDecoder, type KeyDebug } from "./key";
import { remoteKeyFrame } from "./remoteKey";
import type { RemoteResult } from "../vision/remote";

type Frame = ImageData; // uses only .data/.width/.height
type Box = { x: number; y: number; w: number; h: number };

// Average RGB over a box (robust to noise, perspective offset, JPEG ringing).
// The classifier needs colour, so this replaces v1's luma-only sampler; luma is
// derived from the same average where a scalar is still wanted.
function boxRGB(f: Frame, cx: number, cy: number, hw: number, hh: number): RGB {
  const x0 = Math.max(0, Math.round(cx - hw)), x1 = Math.min(f.width - 1, Math.round(cx + hw));
  const y0 = Math.max(0, Math.round(cy - hh)), y1 = Math.min(f.height - 1, Math.round(cy + hh));
  let r = 0, g = 0, b = 0, cnt = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * f.width + x) * 4;
      r += f.data[o]; g += f.data[o + 1]; b += f.data[o + 2];
      cnt++;
    }
  }
  return cnt ? [r / cnt, g / cnt, b / cnt] : [0, 0, 0];
}

// ---- localization: bright connected components filtered by size/aspect ------
// Split into scan + reject so the tuning page (tune.html) can show WHY a
// candidate was thrown away. locatePatches() is the production path and keeps
// exactly the old behaviour.
export interface Component {
  x: number; y: number; w: number; h: number;
  count: number; aspect: number; fill: number;
  /** mean RGB of the pixels that formed this component — for a badge, that IS the white ring, whatever its thickness */
  ref: RGB;
}

/** Smallest blob worth reporting to a human. Well below BEACON_MIN_W so the
 *  tuner can say "your badge is 14px, the floor is 22" instead of nothing. */
const DIAG_MIN_W = 6;

// The mask is WHITENESS — min(R,G,B) — not luma. Measured on a real webcam
// frame (data/diag, 2026-09-20): auto-exposure in a lit room rendered the
// badge's white ring at luma ~155 with a blue cast [121,169,203], well under
// a 175 luma gate, while the ceiling light (247) and a grey T-shirt (190)
// sailed through. Whiteness fixes both directions at once: the ring's darkest
// channel is still ~120, and every alphabet colour has a channel at ~0, so the
// interior can NEVER join the ring's component however bright it is. The ring
// therefore comes out as a hollow component on its own, and the mean colour of
// that component is the white reference — no assumption about how thick the
// ring is (the badge as pushed draws it ~3% of the width, not the 7.5% the
// firmware constants say).
function scanComponents(f: Frame): Component[] {
  const { width: W, height: H } = f;
  const bright = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    const r = f.data[o], g = f.data[o + 1], b = f.data[o + 2];
    bright[i] = (r < g ? (r < b ? r : b) : (g < b ? g : b)) > flags.BEACON_WHITE_T ? 1 : 0;
  }
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  const out: Component[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!bright[start] || seen[start]) continue;
    let minX = W, minY = H, maxX = 0, maxY = 0, count = 0, sr = 0, sg = 0, sb = 0;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p / W) | 0;
      count++;
      const o = p * 4;
      sr += f.data[o]; sg += f.data[o + 1]; sb += f.data[o + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && bright[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && bright[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && bright[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && bright[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (w < DIAG_MIN_W) continue;
    out.push({ x: minX, y: minY, w, h, count, aspect: w / h, fill: count / (w * h), ref: [sr / count, sg / count, sb / count] });
  }
  return out;
}

/** null = accepted as a badge patch; otherwise a human-readable reason. */
export function rejectReason(c: Component, frameW: number): string | null {
  if (c.w < flags.BEACON_MIN_W) return `too small (w ${c.w} < ${flags.BEACON_MIN_W})`;
  if (c.w > frameW * 0.95) return "fills the frame";
  if (c.aspect < flags.BEACON_ASPECT_MIN) return `too tall (aspect ${c.aspect.toFixed(2)} < ${flags.BEACON_ASPECT_MIN})`;
  if (c.aspect > flags.BEACON_ASPECT_MAX) return `too wide (aspect ${c.aspect.toFixed(2)} > ${flags.BEACON_ASPECT_MAX})`;
  if (c.fill < 0.08) return `too sparse (fill ${c.fill.toFixed(3)} < 0.08)`; // noise, not a border ring
  return null;
}

type Patch = Box & { ref: RGB };

function locatePatches(f: Frame): Patch[] {
  return scanComponents(f)
    .filter((c) => rejectReason(c, f.width) === null)
    .map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, ref: c.ref }));
}

// ---- symbol sampling --------------------------------------------------------
export interface Sampled {
  symbol: number | null; // alphabet index, or null when not CLEARLY nearest
  px: RGB; // interior average
  ref: RGB; // border ring average (the white reference)
  borderLum: number;
  confident: boolean;
}

// Fallback white reference when the caller has no component mean (a bare
// box from a harness): the brightest of the 4 side midpoints, sampled at the
// nominal border thickness. Unreliable on the real badge, whose ring is thinner
// than nominal — prefer the component's own mean (Component.ref).
function borderRef(f: Frame, bb: Box): RGB {
  const bx = (BORDER_PX / PATCH.w) * bb.w, by = (BORDER_PX / PATCH.h) * bb.h;
  const hw = Math.max(1, bx * 0.4), hh = Math.max(1, by * 0.4);
  const cands: RGB[] = [
    boxRGB(f, bb.x + bb.w * 0.5, bb.y + by * 0.5, hw, hh), // top
    boxRGB(f, bb.x + bb.w * 0.5, bb.y + bb.h - by * 0.5, hw, hh), // bottom
    boxRGB(f, bb.x + bx * 0.5, bb.y + bb.h * 0.5, hw, hh), // left
    boxRGB(f, bb.x + bb.w - bx * 0.5, bb.y + bb.h * 0.5, hw, hh), // right
  ];
  let best = cands[0], bestL = lumaOf(cands[0]);
  for (const c of cands) { const l = lumaOf(c); if (l > bestL) { bestL = l; best = c; } }
  return best;
}

// `ref` = the ring's mean colour from the localizer (same camera frame, same
// exposure/AWB as the interior — that is what makes the classifier invariant).
function sampleSymbol(f: Frame, bb: Box, ref: RGB = borderRef(f, bb)): Sampled {
  const bl = lumaOf(ref);
  const px = boxRGB(f,
    bb.x + SAMPLE_BOX_FRAC.fcx * bb.w, bb.y + SAMPLE_BOX_FRAC.fcy * bb.h,
    SAMPLE_BOX_FRAC.fhw * bb.w, SAMPLE_BOX_FRAC.fhh * bb.h);
  const symbol = classifySymbol(px, ref, flags.BEACON_SYMBOL_MARGIN);
  // A uniform blob (lamp, paper, a photo of a badge) normalizes to a point that
  // clears no margin, so it rejects here structurally — no brightness rule.
  const confident = bl > flags.BEACON_MIN_BORDER && symbol !== null;
  return { symbol, px, ref, borderLum: bl, confident };
}

// Funnel counters for the tuning page (tune.html). Bumping four integers per
// frame is free; nothing in the hero path reads them.
export const decoderStats = {
  symbols: 0, // distinct colours seen (= symbol transitions)
  anchors: 0, // marker symbols seen (frame boundaries)
  assembled: 0, // 9-symbol groups completed
  crcOk: 0,
  crcFail: 0,
  confirmed: 0, // ids that repeated within BEACON_CONFIRM_MS and became trusted
  reset() { this.symbols = this.anchors = this.assembled = this.crcOk = this.crcFail = this.confirmed = 0; },
};

// ---- per-patch symbol assembly ---------------------------------------------
// The badge holds each symbol for ~2-3 camera frames, so a CHANGE of symbol is
// a symbol boundary — sound here in a way it never was in v1, because the
// differential step is never 0 and the colour is guaranteed to move. A marker
// colour anchors the frame. A decoded id must repeat before we trust it.
class FrameAssembler {
  private lastSym: number | null = null;
  private collecting: number[] | null = null;
  private hist: { id: number; t: number }[] = [];
  lastId: number | null = null;
  lastOptIn = false;
  lastDecodeMs = 0;

  feed(sym: number, tMs: number): void {
    if (sym === this.lastSym) return; // same symbol still on screen
    this.lastSym = sym;
    decoderStats.symbols++;

    if (sym === MARK_IN_INDEX || sym === MARK_OUT_INDEX) {
      decoderStats.anchors++;
      this.collecting = [sym]; // symbol 0 — (re)anchor the frame
    } else if (this.collecting) {
      this.collecting.push(sym);
      if (this.collecting.length === SYMBOLS_PER_FRAME) {
        const out = decodeFrame(this.collecting);
        this.collecting = null;
        decoderStats.assembled++;
        if (out === null) decoderStats.crcFail++;
        else {
          decoderStats.crcOk++;
          this.hist = this.hist.filter((h) => tMs - h.t < flags.BEACON_CONFIRM_MS);
          this.hist.push({ id: out.id, t: tMs });
          if (this.hist.filter((h) => h.id === out.id).length >= 2) {
            if (this.lastId !== out.id) decoderStats.confirmed++;
            this.lastId = out.id;
            this.lastOptIn = out.optIn;
            this.lastDecodeMs = tMs;
          }
        }
      }
    }
  }
}

// ---- diagnostics: what the localizer/classifier saw this frame ---------------
// Read by the pipeline to draw the debug overlay and by the operator panel to
// say *why* nothing decodes (no bright ring / dim ring / no clear symbol / no
// repeat yet). Bumped once per decode call; nothing in the hero path reads it.
export interface BeaconDebug {
  width: number;
  height: number;
  /** `label` is set by the seq decoder (its status per blinking region); `symbol` by the colour decoder */
  candidates: { box: Box; borderLum: number; confident: boolean; symbol: number | null; label?: string }[];
  tracks: { cx: number; cy: number; lastId: number | null; sinceDecodeMs: number; missed: number }[];
  bright: number; // fraction of pixels passing the whiteness mask (0..1) — ~0 ⇒ ring too dim / too far
  ms?: number; // decode time this frame (key engine)
}
export let lastDebug: BeaconDebug = { width: 0, height: 0, candidates: [], tracks: [], bright: 0 };

// cheap: sample every 8th pixel — fraction that passes the whiteness mask
function brightFraction(f: Frame): number {
  let n = 0, hit = 0;
  for (let i = 0; i < f.width * f.height; i += 8) {
    const o = i * 4;
    if (Math.min(f.data[o], f.data[o + 1], f.data[o + 2]) > flags.BEACON_WHITE_T) hit++;
    n++;
  }
  return n ? hit / n : 0;
}

// ---- decoder: track patches across frames, run an assembler per patch -------
// A patch's assembler MUST survive the frequent non-confident frames (motion
// blur, occlusion) or it never accumulates enough decodes to confirm an id — so
// tracks persist for BEACON_TRACK_MISS frames, exactly like the face tracker.
type PatchTrack = { cx: number; cy: number; asm: FrameAssembler; missed: number };

// A higher-resolution crop of a normalized [0,1] frame region, supplied by the
// loop from the source video. Lets us localize cheap (coarse frame) but sample
// fine (native res) — many more pixels per symbol when the badge is far/small.
export type RegionSampler = (nx: number, ny: number, nw: number, nh: number) => ImageData | null;

class BeaconDecoder {
  private tracks: PatchTrack[] = [];

  decode(f: Frame, tMs: number, sampler?: RegionSampler): BeaconReading[] {
    const unmatched = new Set(this.tracks);
    const dbg: BeaconDebug = { width: f.width, height: f.height, candidates: [], tracks: [], bright: brightFraction(f) };
    for (const bb of locatePatches(f)) {
      // localize on the coarse frame, classify the colour from a native-res crop
      // of just this patch region — the distance de-risk.
      const fine = sampler?.(bb.x / f.width, bb.y / f.height, bb.w / f.width, bb.h / f.height);
      const s = fine ? sampleSymbol(fine, { x: 0, y: 0, w: fine.width, h: fine.height }, bb.ref) : sampleSymbol(f, bb, bb.ref);
      dbg.candidates.push({ box: bb, borderLum: s.borderLum, confident: s.confident, symbol: s.symbol });
      if (!s.confident) continue;
      const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
      let tr = nearest(unmatched, cx, cy, flags.BEACON_MATCH_PX);
      if (tr) { unmatched.delete(tr); tr.cx = cx; tr.cy = cy; tr.missed = 0; }
      else { tr = { cx, cy, asm: new FrameAssembler(), missed: 0 }; this.tracks.push(tr); }
      tr.asm.feed(s.symbol!, tMs);
    }
    for (const tr of unmatched) tr.missed++;
    this.tracks = this.tracks.filter((tr) => tr.missed <= flags.BEACON_TRACK_MISS);

    const out: BeaconReading[] = [];
    for (const tr of this.tracks) {
      dbg.tracks.push({ cx: tr.cx, cy: tr.cy, lastId: tr.asm.lastId, sinceDecodeMs: tr.asm.lastId === null ? Infinity : tMs - tr.asm.lastDecodeMs, missed: tr.missed });
      if (tr.asm.lastId !== null && tMs - tr.asm.lastDecodeMs < flags.BEACON_ID_HOLD_MS) {
        out.push({
          beaconId: hex2(tr.asm.lastId),
          imagePosition: { x: tr.cx / f.width, y: tr.cy / f.height },
          confidence: 1,
          optIn: tr.asm.lastOptIn,
        });
      }
    }
    lastDebug = dbg;
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

// ---- engine selection ------------------------------------------------------------
// "key" (default) reads the STATIC KEY firmware 0.4.0 shows — three 7-segment
// hex digits, one frame is enough (see key.ts). The two blink-era engines stay
// selectable for old recordings, the tune page and the sweep.
const colorDecoder = new BeaconDecoder();
const seqDecoder = new SeqDecoder();
const keyDecoder = new KeyDecoder();

function publishKeyDebug(d: KeyDebug): void {
  // the overlay draws the candidates: once a key is read, only the read ones (the
  // rejected blobs — a green shirt, a red chair — are noise then); when nothing
  // reads they stay, as the answer to "what does it see?"
  const read = d.candidates.filter((c) => c.fit);
  const shown = (read.length ? read : d.candidates.filter((c) => !c.status.startsWith("too small"))).slice(0, 8);
  lastDebug = {
    width: d.width, height: d.height, bright: 0, ms: d.ms,
    candidates: shown.map((c) => ({ box: c.fit ? c.fit.key : c.box, borderLum: 0, confident: !!c.fit, symbol: null, label: c.status })),
    tracks: d.tracks.map((t) => ({ cx: t.cx, cy: t.cy, lastId: t.lastId, sinceDecodeMs: t.sinceDecodeMs, missed: t.missed })),
  };
}

function keyDecode(frame: ImageData, tMs: number, sampler?: RegionSampler): BeaconReading[] {
  const out = keyDecoder.decode(frame, tMs, sampler);
  publishKeyDebug(keyDecoder.debug);
  return out;
}

/**
 * The sidecar's readings for one frame (vision/server.py: YOLO glyphs grouped
 * into CRC-valid keys) through the SAME confirm / hold / track logic as the
 * classical engine. W×H = the frame the result's boxes are normalized to.
 */
export function decodeBeaconsRemote(r: RemoteResult, W: number, H: number, tMs: number): BeaconReading[] {
  const fr = remoteKeyFrame(r, W, H);
  const out = keyDecoder.ingest(fr.fits, fr.seen, W, H, tMs, fr.candidates, r.ms?.keys ?? 0);
  publishKeyDebug(keyDecoder.debug);
  return out;
}

/** Between sidecar results: the ids still within their hold, nothing new ingested. */
export function heldBeacons(W: number, H: number, tMs: number): BeaconReading[] {
  const out = keyDecoder.readings(W, H, tMs);
  publishKeyDebug(keyDecoder.debug);
  return out;
}

function seqDecode(frame: ImageData, tMs: number): BeaconReading[] {
  const out = seqDecoder.decode(frame, tMs);
  const d = seqDecoder.debug;
  lastDebug = {
    width: d.width, height: d.height, bright: 0,
    candidates: d.tracks.map((t) => ({ box: t.box, borderLum: 0, confident: t.lastId !== null, symbol: null, label: t.status })),
    tracks: d.tracks.map((t) => ({ cx: t.cx, cy: t.cy, lastId: t.lastId, sinceDecodeMs: t.lastId === null ? Infinity : tMs - t.lastMatchMs, missed: t.missed })),
  };
  return out;
}

export const decodeBeacons = (frame: ImageData, tMs: number, sampler?: RegionSampler): BeaconReading[] =>
  flags.BEACON_OPTICAL_MODE === "key" ? keyDecode(frame, tMs, sampler)
    : flags.BEACON_OPTICAL_MODE === "seq" ? seqDecode(frame, tMs)
      : colorDecoder.decode(frame, tMs, sampler);

/** A COLOUR decoder with its own patch-track state — for the offline sweep, which
 *  models the colour path and must not leak state between trials. */
export function createDecoder(): DecodeBeacons {
  const d = new BeaconDecoder();
  return (frame, tMs) => d.decode(frame, tMs);
}

// exported for the self-check / replay. newDecoder() follows BEACON_OPTICAL_MODE.
export const _internal = {
  locatePatches, sampleSymbol, scanComponents,
  newDecoder: (): { decode: (f: ImageData, tMs: number, sampler?: RegionSampler) => BeaconReading[] } =>
    flags.BEACON_OPTICAL_MODE === "key" ? new KeyDecoder() : flags.BEACON_OPTICAL_MODE === "seq" ? new SeqDecoder() : new BeaconDecoder(),
  newColorDecoder: () => new BeaconDecoder(),
  newSeqDecoder: () => new SeqDecoder(),
  newKeyDecoder: () => new KeyDecoder(),
};
