// Sequence decoder: identity from the ORDER of colour changes, not from what
// the colours are.
//
// Why: measured on a real webcam (data/diag 2026-09-20, 1.5 m, lit room) the
// badge's colours are nothing like the sRGB alphabet — MINT arrives as
// [130,244,254], AZURE as [1,219,254], BLUE as [1,181,254], the blue channel
// clips for every cool colour, the panel's BLACK is dark teal, and the 3-px
// white ring blurs to half brightness so it cannot serve as a white
// reference. A classifier that needs absolute colours cannot work there.
//
// What survives all of that: the badge's frame is 9 symbols, position 0 is a
// marker, consecutive symbols always differ (differential coding), the same
// symbol is always the same colour and different symbols are different
// colours, BLACK is the darkest, warm colours (LIME/AMBER/ROSE) have R > B and
// cool ones (AZURE/BLUE/MINT) B > R, and brightness is ordered within each
// family. So: track the blinking region, record the run of colours it shows,
// and find the ONE (id, consent) among all 512 whose frame explains the run
// under those constraints. No white reference, no calibration, any exposure.
// Ambiguous ⇒ no reading ⇒ blur (DEFAULT_CONSENT).
//
// Localization is temporal too: the interior changes colour every symbol, so
// a frame-to-frame difference lights it up as a solid rectangle at any
// distance where it is a few pixels wide — and nothing else in a room blinks
// like that. The static white ring (which merges with the badge's own white
// PCB art) is not needed.
import { hex2, frameSymbols, MARK_IN_INDEX, MARK_OUT_INDEX } from "@shared/beacon";
import type { BeaconReading } from "../shared/schema";
import { flags } from "../config/flags";

type Frame = ImageData;
type Box = { x: number; y: number; w: number; h: number };
type RGB = [number, number, number];

const BLACK = 0, AZURE = 1, LIME = 2, AMBER = 3, BLUE = 4;
const WARM = new Set([LIME, AMBER, MARK_OUT_INDEX]); // ROSE
const COOL = new Set([AZURE, BLUE, MARK_IN_INDEX]); // MINT

const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const luma = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

// ---- blink localizer: solid rectangles of frame-to-frame colour change -------
interface Blob extends Box { count: number; fill: number; aspect: number }

function diffBlobs(cur: Frame, prev: Uint8ClampedArray, thr: number): Blob[] {
  const { width: W, height: H } = cur;
  const d = cur.data;
  const mask = new Uint8Array(W * H);
  for (let i = 0, o = 0; i < W * H; i++, o += 4) {
    const s = Math.abs(d[o] - prev[o]) + Math.abs(d[o + 1] - prev[o + 1]) + Math.abs(d[o + 2] - prev[o + 2]);
    mask[i] = s > thr ? 1 : 0;
  }
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  const out: Blob[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || seen[start]) continue;
    let minX = W, minY = H, maxX = 0, maxY = 0, count = 0;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p / W) | 0;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (w < flags.SEQ_MIN_W || w > W * 0.5) continue;
    const fill = count / (w * h), aspect = w / h;
    if (fill < flags.SEQ_MIN_FILL) continue; // moving people are ragged; a lit rectangle is solid
    if (aspect < 0.9 || aspect > 2.4) continue; // 4:3 screen, with perspective slack
    out.push({ x: minX, y: minY, w, h, count, fill, aspect });
  }
  return out;
}

// ---- per-badge colour history -------------------------------------------------
interface Run { c: RGB; n: number; t0: number; t1: number }

export interface SeqTrack {
  box: Box;
  area: number;
  fill: number; // solidity of the blob that set the box (the screen interior is ~0.8–0.9; glow-contaminated blobs are ragged)
  boxAt: number;
  cx: number; cy: number;
  missed: number;
  runs: Run[];
  lastId: number | null;
  lastOptIn: boolean;
  lastMatchMs: number;
  status: string; // for the overlay / panel
}

/** intersection over the smaller box — 1 when one box sits inside the other */
function overlap(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}

function sampleInterior(f: Frame, b: Box): { c: RGB; sd: number } {
  const x0 = Math.round(b.x + b.w * 0.3), x1 = Math.round(b.x + b.w * 0.7);
  const y0 = Math.round(b.y + b.h * 0.3), y1 = Math.round(b.y + b.h * 0.7);
  let n = 0; const s = [0, 0, 0], ss = [0, 0, 0];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * f.width + x) * 4;
    for (let k = 0; k < 3; k++) { const v = f.data[o + k]; s[k] += v; ss[k] += v * v; }
    n++;
  }
  if (!n) return { c: [0, 0, 0], sd: 999 };
  const c: RGB = [s[0] / n, s[1] / n, s[2] / n];
  const sd = Math.sqrt(Math.max(0, ss[0] / n - c[0] * c[0]) + Math.max(0, ss[1] / n - c[1] * c[1]) + Math.max(0, ss[2] / n - c[2] * c[2]));
  return { c, sd };
}

// ---- the matcher: which (id, consent) explains this run of colours? ----------
export interface Hypothesis { id: number; optIn: boolean; offset: number }

// All 512 frames, once.
const FRAMES: { id: number; optIn: boolean; syms: number[] }[] = [];
for (let id = 0; id < 256; id++) for (const optIn of [true, false]) FRAMES.push({ id, optIn, syms: frameSymbols(id, optIn) });

/**
 * Align the observed runs to one frame hypothesis, greedily:
 *   - a run that fits the NEXT expected symbol is that symbol;
 *   - a run that still fits the CURRENT symbol is a spurious split (merge);
 *   - a single-frame run that fits nothing is a temporal blend across a
 *     symbol change (the camera's exposure straddled it) — skipped;
 *   - a longer run that fits the symbol AFTER next means one symbol was never
 *     captured cleanly — allowed once per frame;
 *   - anything else kills the hypothesis.
 * "Fits": within SEQ_SAME_MAX of the symbol's running mean colour, and at least
 * SEQ_DIFF_MIN from every other symbol's mean (first sighting of a symbol is
 * constrained only by the second rule). Returns the per-symbol means or null.
 */
function align(R: Run[], syms: number[], k: number): { cent: Map<number, RGB>; matched: number; skipped: number; score: number } | null {
  const sum = new Map<number, [number, number, number, number]>(); // s → [r,g,b,n]
  const mean = (s: number): RGB | null => { const v = sum.get(s); return v ? [v[0] / v[3], v[1] / v[3], v[2] / v[3]] : null; };
  const maxCh = (c: RGB) => Math.max(c[0], c[1], c[2]);
  const fits = (c: RGB, s: number): boolean => {
    const m = mean(s);
    if (m && dist(c, m) > flags.SEQ_SAME_MAX) return false;
    for (const [t, v] of sum) if (t !== s && dist(c, [v[0] / v[3], v[1] / v[3], v[2] / v[3]]) < flags.SEQ_DIFF_MIN) return false;
    if (m) return true;
    // first sighting: the colour must be PLAUSIBLE for this symbol, or a wrong
    // hypothesis can hide a blue run under "BLACK" and survive to the end
    if (WARM.has(s) && !(c[0] > c[2])) return false; // LIME/AMBER/ROSE: red beats blue
    if (COOL.has(s) && !(c[2] > c[0])) return false; // AZURE/BLUE/MINT: blue beats red
    if (s === BLACK) { for (const [t, v] of sum) if (t !== BLACK && maxCh(c) > 0.6 * maxCh([v[0] / v[3], v[1] / v[3], v[2] / v[3]])) return false; }
    else { const b = sum.get(BLACK); if (b && maxCh(c) < maxCh([b[0] / b[3], b[1] / b[3], b[2] / b[3]]) + 40) return false; }
    return true;
  };
  const add = (c: RGB, n: number, s: number) => { const v = sum.get(s); if (v) { v[0] += c[0] * n; v[1] += c[1] * n; v[2] += c[2] * n; v[3] += n; } else sum.set(s, [c[0] * n, c[1] * n, c[2] * n, n]); };
  let cur = -1, next = k, matched = 0, skipped = 0, deletions = 0, score = 0;
  const maxDel = Math.max(1, Math.floor(R.length / 9));
  for (const r of R) {
    const sN = syms[next % 9];
    if (fits(r.c, sN)) { add(r.c, r.n, sN); cur = next; next++; matched++; score += r.n; continue; }
    if (cur >= 0 && fits(r.c, syms[cur % 9])) { add(r.c, r.n, syms[cur % 9]); matched++; score += r.n; continue; } // spurious split
    if (r.n === 1) { skipped++; score -= 2; continue; } // one blended frame between two symbols
    const sNN = syms[(next + 1) % 9];
    if (deletions < maxDel && fits(r.c, sNN)) { add(r.c, r.n, sNN); cur = next + 1; next = cur + 1; matched++; deletions++; score += r.n - 4; continue; }
    return null;
  }
  const cent = new Map<number, RGB>();
  for (const [s] of sum) cent.set(s, mean(s)!);
  return { cent, matched, skipped, score };
}

export function matchRuns(runs: Run[]): { hit: Hypothesis | null; candidates: number; colours: number } {
  const R = runs.slice(-flags.SEQ_WINDOW_RUNS);
  const colours = distinctColours(R);
  if (R.length < flags.SEQ_MIN_RUNS || colours < 3) return { hit: null, candidates: 0, colours };
  const hits: (Hypothesis & { score: number })[] = [];
  const maxStart = Math.max(0, R.length - flags.SEQ_MIN_RUNS); // a track's first runs may predate a settled box
  const total = R.reduce((a, r) => a + r.n, 0);
  for (const fr of FRAMES) {
    let best: (Hypothesis & { score: number }) | null = null;
    for (let i0 = 0; i0 <= maxStart; i0++) for (let k = 0; k < 9; k++) {
      const Rw = i0 ? R.slice(i0) : R;
      const a = align(Rw, fr.syms, k);
      if (!a || a.cent.size < 3 || a.matched < flags.SEQ_MIN_RUNS || a.skipped > Rw.length * 0.34) continue;
      // different symbols ⇒ clearly different colours (the running check only saw partial means)
      const ents = [...a.cent.entries()];
      let ok = true;
      for (let i = 0; i < ents.length && ok; i++) for (let j = i + 1; j < ents.length; j++) if (dist(ents[i][1], ents[j][1]) < flags.SEQ_DIFF_MIN) { ok = false; break; }
      if (!ok || !semanticsOk(a.cent)) continue;
      if (!best || a.score > best.score) best = { id: fr.id, optIn: fr.optIn, offset: k, score: a.score };
    }
    if (best) hits.push(best);
  }
  hits.sort((a, b) => b.score - a.score);
  // accept only a clear winner: it must explain most of the samples, and beat
  // any runner-up by a margin (two ids that both fit ⇒ no reading ⇒ blur)
  const top = hits[0];
  const ok = !!top && top.score >= total * 0.6 && (hits.length === 1 || top.score - hits[1].score >= total * 0.15);
  return { hit: ok ? { id: top.id, optIn: top.optIn, offset: top.offset } : null, candidates: hits.length, colours };
}

function distinctColours(R: Run[]): number {
  const cs: RGB[] = [];
  for (const r of R) if (!cs.some((c) => dist(c, r.c) < flags.SEQ_DIFF_MIN)) cs.push(r.c);
  return cs.length;
}

function semanticsOk(cent: Map<number, RGB>): boolean {
  const black = cent.get(BLACK);
  const maxCh = (c: RGB) => Math.max(c[0], c[1], c[2]);
  if (black) {
    for (const [s, c] of cent) if (s !== BLACK && maxCh(c) < maxCh(black) + 40) return false; // black must be clearly the darkest
  }
  const sub = (c: RGB): RGB => (black ? [Math.max(0, c[0] - black[0]), Math.max(0, c[1] - black[1]), Math.max(0, c[2] - black[2])] : c);
  for (const [s, c] of cent) {
    if (s === BLACK) continue;
    const v = sub(c);
    if (WARM.has(s) && !(v[0] > v[2])) return false;
    if (COOL.has(s) && !(v[2] > v[0])) return false;
  }
  const L = (s: number) => { const c = cent.get(s); return c ? luma(sub(c)) : null; };
  const order = (hi: number, lo: number) => { const a = L(hi), b = L(lo); return a === null || b === null || a > b; };
  return order(MARK_IN_INDEX, AZURE) && order(AZURE, BLUE) && order(MARK_IN_INDEX, BLUE)
    && order(LIME, AMBER) && order(AMBER, MARK_OUT_INDEX) && order(LIME, MARK_OUT_INDEX);
}

// ---- the decoder ---------------------------------------------------------------
export interface SeqDebug {
  width: number; height: number;
  tracks: (SeqTrack & { runs: Run[] })[];
  blobs: Blob[];
}

export class SeqDecoder {
  private prev: Uint8ClampedArray | null = null;
  private prevW = 0;
  private tracks: SeqTrack[] = [];
  private frameN = 0;
  debug: SeqDebug = { width: 0, height: 0, tracks: [], blobs: [] };

  decode(f: Frame, tMs: number): BeaconReading[] {
    const blobs = this.prev && this.prevW === f.width ? diffBlobs(f, this.prev, flags.SEQ_DIFF_T) : [];
    this.prev = f.data.slice();
    this.prevW = f.width;
    this.frameN++;

    // match blobs to tracks by OVERLAP (a mid-refresh blob is a slice of the
    // screen with a shifted centre), else by centre distance, else new track
    const matched = new Set<SeqTrack>();
    for (const b of blobs.sort((p, q) => q.count - p.count)) {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      let best: SeqTrack | null = null, bestScore = 0;
      for (const t of this.tracks) {
        if (matched.has(t)) continue;
        const ov = overlap(b, t.box);
        const d = Math.hypot(t.cx - cx, t.cy - cy);
        const score = ov > 0.15 ? 1 + ov : d < flags.BEACON_MATCH_PX ? 1 - d / flags.BEACON_MATCH_PX : 0;
        if (score > bestScore) { bestScore = score; best = t; }
      }
      if (!best) { best = { box: b, area: b.w * b.h, fill: b.fill, boxAt: tMs, cx, cy, missed: 0, runs: [], lastId: null, lastOptIn: false, lastMatchMs: 0, status: "found" }; this.tracks.push(best); }
      else {
        // Which blob defines the sampling box? A rolling-shutter split shows only
        // a slice (smaller, still solid); the LED glow flickering with the screen
        // yields a bigger but RAGGED blob. Take a blob that is at least as solid
        // and not much smaller; otherwise only refresh a stale box.
        const solidEnough = b.fill >= best.fill - 0.05;
        if ((solidEnough && b.w * b.h >= best.area * 0.5) || tMs - best.boxAt > 1000) {
          // a box that jumped means the history was sampled somewhere else: start over
          if (overlap(b, best.box) < 0.5) { best.runs = []; best.lastId = null; }
          best.box = b; best.area = b.w * b.h; best.fill = b.fill; best.boxAt = tMs; best.cx = cx; best.cy = cy;
        }
        best.missed = 0;
      }
      matched.add(best);
    }
    for (const t of this.tracks) if (!matched.has(t)) t.missed++;
    this.tracks = this.tracks.filter((t) => t.missed <= flags.SEQ_TRACK_MISS);
    // two tracks on one screen (born from different slices): keep the one with the longer history
    for (let i = 0; i < this.tracks.length; i++) for (let j = this.tracks.length - 1; j > i; j--) {
      if (overlap(this.tracks[i].box, this.tracks[j].box) > 0.3) {
        const keep = this.tracks[i].runs.length >= this.tracks[j].runs.length ? i : j, drop = keep === i ? j : i;
        if (this.tracks[drop].fill > this.tracks[keep].fill + 0.05) { const d = this.tracks[drop], kp = this.tracks[keep]; kp.box = d.box; kp.area = d.area; kp.fill = d.fill; kp.cx = d.cx; kp.cy = d.cy; }
        this.tracks.splice(drop, 1);
        if (drop === i) { i--; break; }
      }
    }

    // sample every track's interior every frame; extend or start a run
    for (const t of this.tracks) {
      const { c, sd } = sampleInterior(f, t.box);
      if (sd <= flags.SEQ_CLEAN_SD) {
        const last = t.runs[t.runs.length - 1];
        if (last && dist(last.c, c) < flags.SEQ_RUN_SPLIT) {
          last.c = [(last.c[0] * last.n + c[0]) / (last.n + 1), (last.c[1] * last.n + c[1]) / (last.n + 1), (last.c[2] * last.n + c[2]) / (last.n + 1)];
          last.n++; last.t1 = tMs;
        } else t.runs.push({ c, n: 1, t0: tMs, t1: tMs });
      }
      while (t.runs.length && tMs - t.runs[0].t1 > flags.SEQ_HISTORY_MS) t.runs.shift();
      if (this.frameN % flags.SEQ_MATCH_EVERY === 0 && t.runs.length >= flags.SEQ_MIN_RUNS) {
        const m = matchRuns(t.runs);
        if (m.hit) { t.lastId = m.hit.id; t.lastOptIn = m.hit.optIn; t.lastMatchMs = tMs; t.status = `${hex2(m.hit.id)} ${m.hit.optIn ? "OPT-IN" : "OPT-OUT"}`; }
        else t.status = `${t.runs.length} runs · ${m.colours} colours · ${m.candidates === 0 ? "no match yet" : m.candidates + " ids fit — ambiguous"}`;
      } else if (t.runs.length < flags.SEQ_MIN_RUNS) t.status = `${t.runs.length}/${flags.SEQ_MIN_RUNS} colour changes seen — hold still`;
    }

    this.debug = { width: f.width, height: f.height, tracks: this.tracks.map((t) => ({ ...t, runs: t.runs.slice() })), blobs };
    const out: BeaconReading[] = [];
    for (const t of this.tracks) {
      if (t.lastId !== null && tMs - t.lastMatchMs < flags.BEACON_ID_HOLD_MS) {
        out.push({ beaconId: hex2(t.lastId), imagePosition: { x: t.cx / f.width, y: t.cy / f.height }, confidence: 1, optIn: t.lastOptIn });
      }
    }
    return out;
  }
}
