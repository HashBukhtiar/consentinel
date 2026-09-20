// Static-key decoder (firmware v3, PR #10): ONE camera frame → BeaconReading[].
//
// The badge shows a fixed picture — three giant 7-segment hex digits
// (id(8) << 4 | crc4(id)) in MINT (opt-in) or ROSE (opt-out) on black, with a
// white bar to the right and below (the ring's other two edges are clipped by
// the firmware's widget tree; see KEY in shared/beacon.ts). Nothing blinks, so
// there is no clock to recover and no frame to assemble: a badge locks on the
// first clean frame and re-confirms every frame after.
//
// Pipeline, per frame:
//   1. MASK. A pixel is "lit" when it is chromatic in the digit hue (cool =
//      mint/green/cyan, warm = rose/magenta), bright, AND stands out from its
//      local surroundings (a top-hat on the chroma channel). The local-contrast
//      term is what separates the digits from LED flare, a coloured T-shirt
//      behind the badge and the badge's own glow: those are smooth, segments
//      have edges. The white bars are neutral and never enter the mask, and
//      because the mask is chroma-based they do not suppress the digit next to
//      them either.
//   2. CLUSTER. 8-connected components, agglomerated when a component sits
//      within 45% of ITS OWN size of a cluster (the '1' digit is two bars 18
//      units apart, digits are 14 apart; an LED 100+ units away never joins).
//      A cluster's bounding box is the extent of the LIT segments.
//   3. FIT. The lit extent is the digit grid minus an unlit border segment on
//      each side — and which sides are missing is a small discrete set (left:
//      0, t or w−t; right/top/bottom: 0 or t). Each of the 24 hypotheses fixes
//      the whole 256x160 grid, so we sample the 21 segment centres plus 8
//      always-dark spots (the two holes of every '8', the two inter-digit
//      gaps), threshold at the midpoint between the dark spots and the lit
//      level, and keep a hypothesis only if every sample is unambiguous, the
//      decoded digits IMPLY the hypothesised offsets, all three are valid
//      hex glyphs and the CRC nibble checks. Two different ids that both fit
//      is "no reading". Far away, the fit runs on a native-resolution crop of
//      the cluster (RegionSampler) — many more pixels per segment.
//   4. CONFIRM. An id must decode KEY_CONFIRM_N times within BEACON_CONFIRM_MS
//      before it is reported (two consecutive frames ≈ 100 ms), and is held for
//      BEACON_ID_HOLD_MS after the last decode. Consent rides on the colour.
//
// Every "no" here means the face stays blurred (DEFAULT_CONSENT). Nothing is
// guessed: a misread segment fails the glyph table or the CRC, a wrong grid
// fails the dark spots or the margins.
import {
  hex2, KEY, SEG_RECTS, digitFromSegments, unpackKey,
  SEG_A, SEG_B, SEG_C, SEG_D, SEG_E, SEG_F, SEG_G,
} from "@shared/beacon";
import type { BeaconReading } from "../shared/schema";
import { flags } from "../config/flags";

type Frame = ImageData; // uses only .data/.width/.height
export type Box = { x: number; y: number; w: number; h: number };
/** 1 = cool hue (MINT ⇒ opt-in), 2 = warm hue (ROSE ⇒ opt-out) */
export type KeyClass = 1 | 2;
export type RegionSampler = (nx: number, ny: number, nw: number, nh: number) => ImageData | null;

export interface KeyCluster {
  box: Box; // extent of the lit segments, in frame px
  cls: KeyClass;
  n: number; // mask pixels
  parts: number; // components merged
  lit: number; // mean of the class's dominant channel over the mask pixels (the lit reference)
  members: (Box & { lit: number; n: number })[]; // the merged components (for the outlier-trim retry and diagnostics)
}

export interface KeyFit {
  id: number;
  optIn: boolean;
  key: Box; // the 3-cell digit grid, in frame px
  digits: [number, number, number];
  margin: number; // smallest distance of any sample from the lit/dark midpoint, in units of the contrast (0..0.5)
  contrast: number; // lit − dark, in channel units
  hyp: string; // which border segments were unlit (L/R/U/D offsets)
}

export interface KeyCandidate { box: Box; cls: KeyClass; status: string; fit: KeyFit | null }
export interface KeyDebug {
  width: number;
  height: number;
  candidates: KeyCandidate[];
  tracks: { cx: number; cy: number; lastId: number | null; sinceDecodeMs: number; missed: number }[];
  ms: number; // decode time
}

// ---- 1. mask ------------------------------------------------------------------
// Reused buffers, one set per frame size (the coarse frame and the fine crops).
type Bufs = { n: number; w: number; chroma: Uint8Array; cls: Uint8Array; dom: Uint8Array; sat: Uint32Array; mask: Uint8Array; seen: Uint8Array };
const bufCache = new Map<string, Bufs>();
function bufs(W: number, H: number): Bufs {
  const k = `${W}x${H}`;
  let b = bufCache.get(k);
  if (!b) {
    if (bufCache.size > 6) bufCache.clear();
    const n = W * H;
    b = { n, w: W, chroma: new Uint8Array(n), cls: new Uint8Array(n), dom: new Uint8Array(n), sat: new Uint32Array((W + 1) * (H + 1)), mask: new Uint8Array(n), seen: new Uint8Array(n) };
    bufCache.set(k, b);
  }
  return b;
}

/** Local-contrast chroma mask. `win` = top-hat half-window in px. */
function litMask(f: Frame, win: number, B: Bufs): void {
  const { width: W, height: H, data } = f;
  const { chroma, cls, dom, sat, mask } = B;
  const n = W * H;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const cool = ((g + b) >> 1) - r; // mint / green / cyan / blue
    const warm = ((r + b) >> 1) - g; // rose / magenta / purple
    const c = cool >= warm ? cool : warm;
    chroma[i] = c <= 0 ? 0 : c > 255 ? 255 : c;
    cls[i] = cool >= warm ? 1 : 2;
    const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
    dom[i] = m;
  }
  // summed-area table of the chroma channel → O(1) box means
  const SW = W + 1;
  for (let x = 0; x <= W; x++) sat[x] = 0;
  for (let y = 1; y <= H; y++) {
    let row = 0;
    const so = y * SW, po = (y - 1) * W;
    sat[so] = 0;
    for (let x = 1; x <= W; x++) {
      row += chroma[po + x - 1];
      sat[so + x] = sat[so - SW + x] + row;
    }
  }
  // Two windows, OR-ed: the small one keeps a far, thin segment at full
  // response; the wide one (2x) keeps a close, thick bar WHOLE — with only the
  // small window, the middle of a 12 px bar sees almost no background and the
  // bar hollows out and splits into pieces the clusterer cannot reassemble.
  const CT = flags.KEY_CHROMA_T, TT = flags.KEY_TOPHAT_T, LM = flags.KEY_LIT_MIN;
  const big = win * 2;
  const boxMean = (x: number, y: number, r: number): number => {
    const y0 = y - r < 0 ? 0 : y - r, y1 = y + r + 1 > H ? H : y + r + 1;
    const x0 = x - r < 0 ? 0 : x - r, x1 = x + r + 1 > W ? W : x + r + 1;
    return (sat[y1 * SW + x1] - sat[y0 * SW + x1] - sat[y1 * SW + x0] + sat[y0 * SW + x0]) / ((y1 - y0) * (x1 - x0));
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = chroma[i];
      if (c < CT || dom[i] < LM) { mask[i] = 0; continue; }
      mask[i] = c - boxMean(x, y, win) >= TT || c - boxMean(x, y, big) >= TT ? 1 : 0;
    }
  }
}

// ---- 2. clusters ----------------------------------------------------------------
interface Comp { x0: number; y0: number; x1: number; y1: number; n: number; cool: number; sumDom: number }

function components(B: Bufs, W: number, H: number): Comp[] {
  const { mask, seen, cls, dom } = B;
  seen.fill(0);
  const out: Comp[] = [];
  const stack: number[] = [];
  const n = W * H;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue;
    const c: Comp = { x0: W, y0: H, x1: 0, y1: 0, n: 0, cool: 0, sumDom: 0 };
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p / W) | 0;
      c.n++; if (cls[p] === 1) c.cool++; c.sumDom += dom[p];
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      // 8-connected: segments meet at corners
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx;
          if (mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
    }
    if (c.n >= flags.KEY_MIN_PX) out.push(c);
  }
  return out;
}

const gapX = (a: Box, b: Box): number => Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
const gapY = (a: Box, b: Box): number => Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export interface KeyPart { box: Box; cls: KeyClass; n: number; lit: number }

/**
 * Mask → components → clusters of the same hue and brightness. Pure function
 * of the frame. A component joins a cluster when
 *   - the bounding-box gap to one of the cluster's MEMBERS (not the cluster's
 *     hull — a sparse cloud of flare fragments must not get a free overlap) is
 *     within KEY_MERGE_GAP × the smaller of the two, and
 *   - its lit level agrees with the cluster's: segments are one uniform
 *     brightness, flare and glow are dimmer and graded.
 */
export function locateKeys(f: Frame, win: number, parts?: KeyPart[]): KeyCluster[] {
  const B = bufs(f.width, f.height);
  litMask(f, win, B);
  // Left to right, so a newcomer always bridges BACK to a cluster on its left
  // and the reach can be capped by the newcomer's own size: the long gaps in a
  // key (72 units to a trailing '1', 90 past a C/E/F) are always bridged by the
  // '1'\'s own 53-unit bar. Arrival order then cannot split a key.
  const comps = components(B, f.width, f.height).map((c) => ({ c, lit: c.sumDom / c.n })).sort((a, b) => a.c.x0 - b.c.x0 || a.c.y0 - b.c.y0);
  type Member = Box & { lit: number; n: number };
  type Acc = KeyCluster & { sumDom: number; anchor: Member; maxSize: number; members: Member[] };
  const size = (b: Box) => Math.max(b.w, b.h);
  const thin = (b: Box) => Math.min(b.w, b.h) < flags.KEY_THIN_PX;
  // Brightness band, against the cluster's ANCHOR — its largest member — never
  // a running mean (a mean drifts down as junk joins and lets in more junk) and
  // never a speck (a 2 px sliver reads brighter than the bar it came from). A
  // thin part's mean is pulled down by its edge pixels, so far-away bars get a
  // looser band.
  const bandOk = (m: Member, cl: Acc) => Math.abs(m.lit - cl.anchor.lit) <= (thin(m) ? flags.KEY_MERGE_LIT_TOL_THIN : flags.KEY_MERGE_LIT_TOL) * Math.max(m.lit, cl.anchor.lit);
  // Geometry: a member joins when it sits within reach of one of the cluster's
  // MEMBERS (not the cluster's hull — a sparse cloud of flare fragments must not
  // get a free overlap). Vertical reach is relative to the smaller of the two
  // (an LED joins nothing but its own halo); horizontal reach is relative to
  // the newcomer's own size, so a speck reaches nothing and a bar reaches two
  // bar-lengths back: a '1' lights only its right bars, 72 units past the digit
  // before it, 90 past a C/E/F.
  const near = (m: Member, cl: Acc) => {
    // the cluster-relative floor (hollowed-out bar pieces) is bounded by the newcomer's own size, so a tall junk cluster cannot pull in far specks
    const floor = Math.max(flags.KEY_MERGE_FLOOR_PX, Math.min(flags.KEY_MERGE_CLUSTER_FRAC * cl.box.h, 2 * size(m)));
    // …and never beyond ¾ of the cluster's height: the longest gap in a key (90 units) is
    // ~0.6–0.7 of a digit's height, so a streak taller than the digits cannot chain outward
    const reachX = Math.max(floor, Math.min(flags.KEY_MERGE_GAP_X * Math.min(size(m), cl.maxSize), flags.KEY_MERGE_REACH_H * cl.box.h));
    for (const o of cl.members) {
      if (gapX(m, o) <= reachX && gapY(m, o) <= Math.max(floor, flags.KEY_MERGE_GAP * Math.min(size(m), size(o)))) return true;
    }
    return false;
  };
  const absorb = (home: Acc, o: Acc) => {
    home.box = union(home.box, o.box); home.n += o.n; home.parts += o.parts; home.sumDom += o.sumDom; home.members.push(...o.members);
    if (o.anchor.n > home.anchor.n) home.anchor = o.anchor;
    home.maxSize = Math.max(home.maxSize, o.maxSize); home.lit = home.sumDom / home.n;
  };
  let clusters: Acc[] = [];
  for (const { c, lit } of comps) {
    const box: Box = { x: c.x0, y: c.y0, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1 };
    const cls: KeyClass = c.cool * 2 >= c.n ? 1 : 2;
    parts?.push({ box, cls, n: c.n, lit });
    const m: Member = { ...box, lit, n: c.n };
    // of several matching clusters, join the one whose brightness is closest (a digit's bar
    // next to a flare cloud belongs with the digits), then fold the others only if they agree
    const homes = clusters.filter((cl) => cl.cls === cls && bandOk(m, cl) && near(m, cl)).sort((a, b) => Math.abs(a.anchor.lit - lit) - Math.abs(b.anchor.lit - lit));
    if (!homes.length) { clusters.push({ box, cls, n: c.n, parts: 1, sumDom: c.sumDom, lit, members: [m], anchor: m, maxSize: size(box) }); continue; }
    const home = homes[0];
    home.box = union(home.box, box); home.n += c.n; home.parts++; home.sumDom += c.sumDom; home.members.push(m);
    if (m.n > home.anchor.n) home.anchor = m;
    home.maxSize = Math.max(home.maxSize, size(box)); home.lit = home.sumDom / home.n;
    // a bridging piece unites two halves — but only halves that agree on brightness
    for (const o of homes.slice(1)) if (Math.abs(o.anchor.lit - home.anchor.lit) <= flags.KEY_MERGE_LIT_TOL * Math.max(o.anchor.lit, home.anchor.lit)) { absorb(home, o); clusters = clusters.filter((cl) => cl !== o); }
  }
  return clusters.sort((a, b) => b.box.w - a.box.w).map(({ sumDom: _s, anchor: _a, maxSize: _m, ...cl }) => cl);
}

// ---- 3. fit ----------------------------------------------------------------------
const NO = Number.NaN;
/**
 * One channel around (cx, cy): the mean over a box of half-size (hx, hy) when
 * that box spans at least a pixel, else a bilinear point sample — a far
 * segment is 2–3 px wide, and a 3x3 box centred on it straddles both edges.
 * NaN when any of it is outside the frame.
 */
function meanChan(f: Frame, chan: number, cx: number, cy: number, hx: number, hy: number): number {
  if (hx < 1 || hy < 1) {
    const px = cx - 0.5, py = cy - 0.5; // pixel i is centred on i + 0.5
    const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
    if (x0 < 0 || y0 < 0 || x0 + 1 >= f.width || y0 + 1 >= f.height) return NO;
    const o = (y0 * f.width + x0) * 4 + chan, W4 = f.width * 4;
    return (1 - fy) * ((1 - fx) * f.data[o] + fx * f.data[o + 4]) + fy * ((1 - fx) * f.data[o + W4] + fx * f.data[o + W4 + 4]);
  }
  const x0 = Math.round(cx - hx), x1 = Math.round(cx + hx), y0 = Math.round(cy - hy), y1 = Math.round(cy + hy);
  if (x0 < 0 || y0 < 0 || x1 >= f.width || y1 >= f.height) return NO;
  let s = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { s += f.data[(y * f.width + x) * 4 + chan]; n++; }
  return s / n;
}

const OFF_L = [0, KEY.t, KEY.w - KEY.t] as const;
const OFF_RUD = [0, KEY.t] as const;

interface Eval { margin: number; masks: [number, number, number]; lit: number; dark: number; contrast: number; segs: number[]; darks: number[]; why?: string }

/** Sample and threshold one grid placement. `u` = the lit extent this placement assumes. */
function evalGrid(f: Frame, chan: number, u: Box, L: number, R: number, U: number, D: number, lit: number): Eval {
  const { w: W, h: H, t: T, half: Hf, gap: G, pitch: P, span: S } = KEY;
  const sx = u.w / (S - L - R), sy = u.h / (H - U - D);
  const kx = u.x - L * sx, ky = u.y - U * sy;
  const hx = flags.KEY_SAMPLE_FRAC * T * sx, hy = flags.KEY_SAMPLE_FRAC * T * sy; // < 1 ⇒ bilinear point samples
  const fail = (why: string): Eval => ({ margin: -1, masks: [0, 0, 0], lit, dark: 0, contrast: 0, segs: [], darks: [], why });
  // always-dark spots: the two holes of every cell, the two gaps between cells
  const darks: number[] = [];
  for (let k = 0; k < 3; k++) {
    const cx = kx + (k * P + W / 2) * sx;
    darks.push(meanChan(f, chan, cx, ky + (T + Hf / 2) * sy, hx, hy), meanChan(f, chan, cx, ky + (2 * T + 1.5 * Hf) * sy, hx, hy));
  }
  for (let k = 0; k < 2; k++) darks.push(meanChan(f, chan, kx + (W + G / 2 + k * P) * sx, ky + (H / 2) * sy, hx, hy));
  if (darks.some(Number.isNaN)) return fail("dark spot outside the frame");
  let dark = darks.reduce((a, b) => a + b, 0) / 8;
  let contrast = lit - dark;
  if (contrast < flags.KEY_MIN_CONTRAST || dark > flags.KEY_DARK_MAX_FRAC * lit) return fail(`dark spots not dark: dark ${dark.toFixed(0)} vs lit ${lit.toFixed(0)}`);
  const segs: number[] = [];
  for (let k = 0; k < 3; k++) for (let s = 0; s < 7; s++) {
    const r = SEG_RECTS[s];
    segs.push(meanChan(f, chan, kx + (k * P + r[0] + r[2] / 2) * sx, ky + (r[1] + r[3] / 2) * sy, hx, hy));
  }
  if (segs.some(Number.isNaN)) return fail("segment outside the frame");
  // two passes: classify against the cluster's lit level, then re-centre the
  // references on what was actually read (the cluster mean is biased low close
  // up, where the mask keeps only the bar outlines)
  let masks: [number, number, number] = [0, 0, 0], margin = -1;
  for (let pass = 0; pass < 2; pass++) {
    masks = [0, 0, 0]; margin = Infinity;
    let litSum = 0, litN = 0, darkSum = 0, darkN = 8;
    for (const v of darks) { const t = (v - dark) / contrast; if (0.5 - t < margin) margin = 0.5 - t; darkSum += v; }
    for (let i = 0; i < 21; i++) {
      const t = (segs[i] - dark) / contrast;
      if (t >= 0.5) { masks[(i / 7) | 0] |= 1 << (i % 7); litSum += segs[i]; litN++; } else { darkSum += segs[i]; darkN++; }
      const m = Math.abs(t - 0.5); if (m < margin) margin = m;
    }
    if (litN < 6) return fail("fewer than 6 lit segments"); // every glyph lights at least 2
    if (pass === 0) {
      const l2 = litSum / litN, d2 = darkSum / darkN;
      if (l2 - d2 < flags.KEY_MIN_CONTRAST) return fail("contrast collapsed on re-centring");
      lit = l2; dark = d2; contrast = l2 - d2;
    }
  }
  return { margin, masks, lit, dark, contrast, segs, darks };
}

/**
 * Fit the digit grid to a cluster and read it. `u` = the lit extent, `lit` =
 * the lit level of the class's dominant channel. Each hypothesis about which
 * border segments are unlit is placed, then its extent is refined by
 * coordinate descent on the margin (±1 px per edge — a far segment is 2 px
 * wide, so a 1 px placement error halves the contrast). Returns the best
 * consistent reading, or null (including when two ids both fit).
 */
export function fitKey(f: Frame, u0: Box, cls: KeyClass, lit: number, trace?: string[]): KeyFit | null {
  const { w: W, h: H, t: T, span: S } = KEY;
  const chan = cls === 1 ? 1 : 0; // G carries mint, R carries rose
  let best: KeyFit | null = null, rival: KeyFit | null = null;
  for (const L of OFF_L) for (const R of OFF_RUD) for (const U of OFF_RUD) for (const D of OFF_RUD) {
    const hyp = `L${L}R${R}U${U}D${D}`;
    const why = (m: string) => { trace?.push(`${hyp}: ${m}`); };
    const ar = (u0.w / (S - L - R)) / (u0.h / (H - U - D));
    if (ar < flags.KEY_STRETCH_MIN || ar > flags.KEY_STRETCH_MAX) { why(`stretch ${ar.toFixed(2)}`); continue; }
    let u = u0, e = evalGrid(f, chan, u, L, R, U, D, lit);
    if (e.margin < flags.KEY_REFINE_FROM) { why(e.why ?? `margin ${e.margin.toFixed(2)} before refinement`); continue; }
    // refine: move one edge at a time while the margin improves — whole pixels
    // first, then half pixels (a far segment is 2–3 px wide)
    for (const step of [1, 0.5]) {
      if (step < 1 && e.margin < flags.KEY_REFINE_FINE_FROM) break;
      for (let it = 0; it < flags.KEY_REFINE_ITERS; it++) {
        let bu = u, be = e;
        for (const [dx, dy, dw, dh] of [[-1, 0, 1, 0], [1, 0, -1, 0], [0, 0, 1, 0], [0, 0, -1, 0], [0, -1, 0, 1], [0, 1, 0, -1], [0, 0, 0, 1], [0, 0, 0, -1]]) {
          const v: Box = { x: u.x + dx * step, y: u.y + dy * step, w: u.w + dw * step, h: u.h + dh * step };
          if (v.w < 4 || v.h < 4) continue;
          const ev = evalGrid(f, chan, v, L, R, U, D, lit);
          if (ev.margin > be.margin + 1e-3) { bu = v; be = ev; }
        }
        if (bu === u) break;
        u = bu; e = be;
      }
    }
    const glyphs = e.masks.map((m) => m.toString(2).padStart(7, "0")).join(" ");
    if (e.margin < flags.KEY_MARGIN) { why(`margin ${e.margin.toFixed(2)} (lit ${e.lit.toFixed(0)} dark ${e.dark.toFixed(0)}) segs [${e.segs.map((v) => v.toFixed(0)).join(",")}]`); continue; }
    // the glyphs must IMPLY this hypothesis: which border segments were unlit
    const [m0, m1, m2] = e.masks;
    const expL = m0 & (SEG_E | SEG_F) ? 0 : m0 & (SEG_A | SEG_G | SEG_D) ? T : W - T;
    if (expL !== L) { why(`glyphs ${glyphs} imply L${expL}`); continue; }
    if ((m2 & (SEG_B | SEG_C) ? 0 : T) !== R) { why(`glyphs ${glyphs} imply another R`); continue; }
    if ((e.masks.some((m) => m & SEG_A) ? 0 : T) !== U) { why(`glyphs ${glyphs} imply another U`); continue; }
    if ((e.masks.some((m) => m & SEG_D) ? 0 : T) !== D) { why(`glyphs ${glyphs} imply another D`); continue; }
    const d0 = digitFromSegments(m0), d1 = digitFromSegments(m1), d2 = digitFromSegments(m2);
    if (d0 === null || d1 === null || d2 === null) { why(`glyphs ${glyphs}: not all hex`); continue; }
    const id = unpackKey((d0 << 8) | (d1 << 4) | d2);
    if (id === null) { why(`digits ${d0.toString(16)}${d1.toString(16)}${d2.toString(16)}: CRC fails`); continue; }
    why(`OK ${hex2(id)} margin ${e.margin.toFixed(2)}`);
    const sx = u.w / (S - L - R), sy = u.h / (H - U - D);
    const fit: KeyFit = { id, optIn: cls === 1, key: { x: u.x - L * sx, y: u.y - U * sy, w: S * sx, h: H * sy }, digits: [d0, d1, d2], margin: e.margin, contrast: e.contrast, hyp };
    if (!best || fit.margin > best.margin) { if (best && best.id !== fit.id) rival = best; best = fit; }
    else if (fit.id !== best.id && (!rival || fit.margin > rival.margin)) rival = fit;
  }
  // two ids that both read cleanly ⇒ no reading (blur), never the better-looking one
  if (best && rival && rival.margin >= flags.KEY_RIVAL_FRAC * best.margin) { trace?.push(`AMBIGUOUS ${hex2(best.id)} vs ${hex2(rival.id)}`); return null; }
  return best;
}

/**
 * Fit a cluster; when the whole extent fails, peel off the members whose
 * brightness deviates most from the cluster's anchor (its largest member) one
 * at a time and retry — flare, glow and reflections stuck to the key are the
 * odd ones out in brightness, the digit segments agree to a few percent. Each
 * peel that changes the hull costs a full fit, so it is capped.
 */
export function fitCluster(f: Frame, cl: KeyCluster, trace?: string[], trim = flags.KEY_TRIM_MAX): KeyFit | null {
  const fit = fitKey(f, cl.box, cl.cls, cl.lit, trace);
  if (fit || trim <= 0 || cl.members.length < 3 || cl.members.length > 60) return fit;
  const hull = (ms: Box[]): Box => ms.slice(1).reduce(union, ms[0]);
  const anchor = cl.members.reduce((a, m) => (m.n > a.n ? m : a));
  const order = [...cl.members].sort((a, b) => Math.abs(b.lit - anchor.lit) - Math.abs(a.lit - anchor.lit));
  let rest = cl.members as Box[];
  let last = cl.box;
  for (let k = 0; k < Math.min(trim, order.length) && rest.length >= 3; k++) {
    const drop = order[k];
    if (drop === anchor) continue;
    rest = rest.filter((m) => m !== drop);
    const nb = hull(rest);
    if (nb.w === last.w && nb.h === last.h && nb.x === last.x && nb.y === last.y) continue; // that member did not shape the hull
    last = nb;
    if (nb.w < flags.KEY_MIN_W) break;
    trace?.push(`-- retry without [${drop.x},${drop.y} ${drop.w}x${drop.h} lit ${drop.lit.toFixed(0)}]`);
    const r = fitKey(f, nb, cl.cls, cl.lit, trace);
    if (r) return r;
  }
  return null;
}

// ---- 4. decoder: clusters → fits (fine crop when possible) → tracks → readings ----
type KTrack = { cx: number; cy: number; hist: { id: number; optIn: boolean; t: number }[]; lastId: number | null; lastOptIn: boolean; lastMs: number; missed: number };

const overlapFrac = (a: Box, b: Box): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w <= 0 || h <= 0 ? 0 : (w * h) / Math.min(a.w * a.h, b.w * b.h);
};

/** Top-hat half-window: ~1/140 of the frame width (9 px at 1280) — wider than a segment beyond ~40 cm, so a far segment keeps its full response. */
export const tophatWin = (frameW: number): number => Math.max(2, Math.round(frameW / flags.KEY_WIN_DIV));

export class KeyDecoder {
  private tracks: KTrack[] = [];
  debug: KeyDebug = { width: 0, height: 0, candidates: [], tracks: [], ms: 0 };

  decode(f: Frame, tMs: number, sampler?: RegionSampler): BeaconReading[] {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const dbg: KeyDebug = { width: f.width, height: f.height, candidates: [], tracks: [], ms: 0 };
    const fits: KeyFit[] = [];
    let tried = 0;
    for (const cl of locateKeys(f, tophatWin(f.width))) {
      const b = cl.box;
      let status: string;
      let fit: KeyFit | null = null;
      if (b.w < flags.KEY_MIN_W) status = `too small (${b.w} px < ${flags.KEY_MIN_W})`;
      else if (b.w / b.h < flags.KEY_ASPECT_MIN || b.w / b.h > flags.KEY_ASPECT_MAX) status = `not digit-shaped (aspect ${(b.w / b.h).toFixed(2)})`;
      else {
        // native-res crop of the cluster (with room for the unlit border segments) — many more px per segment far away
        if (sampler && b.w < flags.KEY_FINE_BELOW_PX) fit = this.fitFine(f, cl, sampler);
        if (!fit) fit = fitCluster(f, cl, undefined, tried < flags.KEY_TRIM_CANDIDATES ? flags.KEY_TRIM_MAX : 0);
        tried++;
        status = fit ? `${hex2(fit.id)} ${fit.optIn ? "OPT-IN" : "OPT-OUT"} · margin ${fit.margin.toFixed(2)}` : `${cl.cls === 1 ? "mint" : "rose"} blob, no key read (${b.w} px)`;
      }
      dbg.candidates.push({ box: b, cls: cl.cls, status, fit });
      if (fit) fits.push(fit);
    }

    // tracks: nearest centre; an id must repeat before it is trusted
    const unmatched = new Set(this.tracks);
    for (const fit of fits) {
      const cx = fit.key.x + fit.key.w / 2, cy = fit.key.y + fit.key.h / 2;
      let tr: KTrack | null = null, bd = flags.BEACON_MATCH_PX ** 2;
      for (const t of unmatched) { const d = (t.cx - cx) ** 2 + (t.cy - cy) ** 2; if (d < bd) { bd = d; tr = t; } }
      if (tr) { unmatched.delete(tr); tr.cx = cx; tr.cy = cy; tr.missed = 0; }
      else { tr = { cx, cy, hist: [], lastId: null, lastOptIn: fit.optIn, lastMs: 0, missed: 0 }; this.tracks.push(tr); }
      tr.hist = tr.hist.filter((h) => tMs - h.t < flags.BEACON_CONFIRM_MS);
      tr.hist.push({ id: fit.id, optIn: fit.optIn, t: tMs });
      if (tr.hist.filter((h) => h.id === fit.id && h.optIn === fit.optIn).length >= flags.KEY_CONFIRM_N) {
        tr.lastId = fit.id; tr.lastOptIn = fit.optIn; tr.lastMs = tMs;
      }
    }
    for (const tr of unmatched) tr.missed++;
    this.tracks = this.tracks.filter((tr) => tr.missed <= flags.BEACON_TRACK_MISS);

    const out: BeaconReading[] = [];
    for (const tr of this.tracks) {
      dbg.tracks.push({ cx: tr.cx, cy: tr.cy, lastId: tr.lastId, sinceDecodeMs: tr.lastId === null ? Infinity : tMs - tr.lastMs, missed: tr.missed });
      if (tr.lastId !== null && tMs - tr.lastMs < flags.BEACON_ID_HOLD_MS) {
        out.push({ beaconId: hex2(tr.lastId), imagePosition: { x: tr.cx / f.width, y: tr.cy / f.height }, confidence: 1, optIn: tr.lastOptIn });
      }
    }
    dbg.ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    this.debug = dbg;
    return out;
  }

  /** Re-localize and fit on a native-res crop around the cluster; the fit's box is mapped back to coarse px. */
  private fitFine(f: Frame, cl: KeyCluster, sampler: RegionSampler): KeyFit | null {
    const b = cl.box;
    // room for: an unlit left column ('1' first: w−t = 23% of the span), a trailing '1' the coarse
    // clusterer may have left out (its bars sit 72 units = 28% past the previous digit), unlit top/bottom bars (11%)
    const rx = Math.max(0, b.x - b.w * 0.3), ry = Math.max(0, b.y - b.h * 0.18);
    const rw = Math.min(f.width, b.x + b.w * 1.36) - rx, rh = Math.min(f.height, b.y + b.h * 1.18) - ry;
    const crop = sampler(rx / f.width, ry / f.height, rw / f.width, rh / f.height);
    if (!crop || crop.width < 8) return null;
    const kx = crop.width / rw, ky = crop.height / rh;
    const mapped: Box = { x: (b.x - rx) * kx, y: (b.y - ry) * ky, w: b.w * kx, h: b.h * ky };
    let pick: KeyCluster | null = null, po = 0.4;
    for (const c of locateKeys(crop, Math.max(2, Math.round(tophatWin(f.width) * kx)))) {
      if (c.cls !== cl.cls) continue;
      const o = overlapFrac(c.box, mapped);
      if (o > po) { po = o; pick = c; }
    }
    if (!pick) return null;
    const fit = fitCluster(crop, pick);
    if (!fit) return null;
    return { ...fit, key: { x: rx + fit.key.x / kx, y: ry + fit.key.y / ky, w: fit.key.w / kx, h: fit.key.h / ky } };
  }
}
