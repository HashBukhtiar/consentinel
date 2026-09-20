/**
 * Consentinel optical beacon — shared wire format.
 *
 * This file is the contract between the badge transmitter
 * (`firmware/consentinel-beacon.lua`) and the capture app's decoder. The badge
 * paints the light; nothing on the camera side ever reads the Lua. If you
 * change a constant here, change it there in the same commit.
 *
 * FORMAT: one STATIC frame — a black screen carrying the 3-digit KEY as three
 * 7-segment hex digits. No blinking, no clock recovery, no multi-frame
 * assembly: a single exposure decodes.
 *
 *   +----------------------------------------+
 *   |    ###      ###                        |   SHAPE  = identity
 *   |      #        #      #                 |   COLOUR = consent
 *   |    ###      ###                        |
 *   |   #            #     #                 |   GREEN = opt-in
 *   |    ###      ###                        |   RED   = opt-out
 *   +----------------------------------------+
 *
 * Shape and colour are independent channels, so a decoder that reads one
 * badly cannot corrupt the other. Digits 1-2 are the id, digit 3 is the CRC-4
 * check digit.
 *
 * The COLOUR is RESTRICT-ONLY: a face clears only when the chain record says
 * opt-in AND the light says opt-in. Green light against an opt-out chain
 * record loses — the light can restrict, never grant.
 *
 * Three independent checks run before an id is trusted: every segment must
 * resolve lit/unlit, each digit's 7 bits must be one of 16 valid glyphs
 * (112 of 128 patterns are rejected), and the 12-bit payload must pass CRC.
 * Any of them failing means BLUR — never guess.
 *
 * LOCALIZATION NOTE: there is no white ring any more. The patch is found as a
 * cluster of saturated red OR green strokes on a dark field, and the
 * brightness reference is the strongest stroke in that cluster — see
 * `decodeFrame`, which is self-calibrating and needs no external reference.
 */

/** Lua's `//`. Every derived constant below floors exactly like the badge. */
const idiv = (a: number, b: number) => Math.floor(a / b);

// ----------------------------------------------------------------- geometry

/**
 * The physical ST7789 panel. Verified on hardware with
 * `firmware/screen-ruler.lua`: the app's root container carries 30px of
 * padding, so the badge offsets its outermost box by (-30,-30) to reach screen
 * (0,0). That offset is a badge-side concern — the camera only sees the panel.
 */
export const PANEL = { w: 320, h: 240 } as const;

/**
 * The beacon rectangle, and the ONE knob. MUST match PATCH_W/PATCH_H in
 * firmware/consentinel-beacon.lua.
 */
export const PATCH_W = 320;
export const PATCH_H = 240;

export const PATCH = {
  x: idiv(PANEL.w - PATCH_W, 2),
  y: idiv(PANEL.h - PATCH_H, 2),
  w: PATCH_W,
  h: PATCH_H,
} as const;

export const PATCH_ASPECT = PATCH.w / PATCH.h; // 1.333

/**
 * Margin keeping strokes off the bezel, where glare and viewing angle eat them
 * first. Everything inside it is digits — no frame, no stripe.
 * MUST match MARGIN in the Lua.
 */
export const MARGIN = idiv(PATCH_W, 20); // 16
export const CX = PATCH.x + MARGIN; // 16
export const CY = PATCH.y + MARGIN; // 16
export const CW = PATCH_W - 2 * MARGIN; // 288
export const CH = PATCH_H - 2 * MARGIN; // 208

// ------------------------------------------------------------ digit layout

export const D_N = 3;
export const D_GAP = idiv(CW, 24); // 12
export const D_W = idiv(CW - (D_N - 1) * D_GAP, D_N); // 88
export const D_H = CH; // 208
/** Stroke width. THE range-limiting feature: 22px = 6.9% of patch width. */
export const D_T = idiv(D_W, 4); // 22
export const D_HALF = idiv(D_H - 3 * D_T, 2); // 71
export const D_X = CX + idiv(CW - (D_N * D_W + (D_N - 1) * D_GAP), 2); // 16
export const D_Y = CY; // 16

/**
 * Segment bits, LSB first:
 *
 *      --- a(1) ---
 *     |            |
 *   f(32)        b(2)
 *     |            |
 *      --- g(64) --
 *     |            |
 *   e(16)        c(4)
 *     |            |
 *      --- d(8) ---
 *
 * Index is the nibble value. MUST match SEG in the Lua.
 */
export const SEG = [
  0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, // 0 1 2 3 4 5 6 7
  0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71, // 8 9 A b C d E F
] as const;

/** Reverse lookup: 7-bit pattern -> nibble, or undefined if not a glyph. */
const GLYPH = new Map<number, number>(SEG.map((bits, n) => [bits, n]));

/**
 * Rect of segment s (0..6) for a digit whose top-left is (x, y), in badge
 * pixels. The vertical budget is exactly 3*D_T + 2*D_HALF = D_H, so nothing
 * rounds off the bottom. MUST match seg_geom in the Lua.
 */
export function segRect(s: number, x: number, y: number) {
  const mid = y + D_T + D_HALF;
  switch (s) {
    case 0: return { x: x + D_T, y, w: D_W - 2 * D_T, h: D_T };                // a
    case 1: return { x: x + D_W - D_T, y: y + D_T, w: D_T, h: D_HALF };        // b
    case 2: return { x: x + D_W - D_T, y: mid + D_T, w: D_T, h: D_HALF };      // c
    case 3: return { x: x + D_T, y: y + D_H - D_T, w: D_W - 2 * D_T, h: D_T }; // d
    case 4: return { x, y: mid + D_T, w: D_T, h: D_HALF };                     // e
    case 5: return { x, y: y + D_T, w: D_T, h: D_HALF };                       // f
    default: return { x: x + D_T, y: mid, w: D_W - 2 * D_T, h: D_T };          // g
  }
}

/** Top-left of digit d (0 = most significant), in badge pixels. */
export const digitOrigin = (d: number) => ({ x: D_X + d * (D_W + D_GAP), y: D_Y });

/** Rect of segment s of digit d, as fractions of the whole patch bbox. */
export function segRectFrac(d: number, s: number) {
  const o = digitOrigin(d);
  const r = segRect(s, o.x, o.y);
  return {
    fx: (r.x - PATCH.x) / PATCH.w,
    fy: (r.y - PATCH.y) / PATCH.h,
    fw: r.w / PATCH.w,
    fh: r.h / PATCH.h,
  };
}

/**
 * Fraction of a segment to average over. Sample the CENTRE only: at range,
 * blur pulls the black background into a stroke's outer pixels and an edge
 * sample reads dark. The middle 50% is the part still the colour it was painted.
 */
export const SEG_SAMPLE_FRAC = 0.5;

/** Centre-inset sample window for segment s of digit d, as patch fractions. */
export function segSampleFrac(d: number, s: number) {
  const r = segRectFrac(d, s);
  const mx = (r.fw * (1 - SEG_SAMPLE_FRAC)) / 2;
  const my = (r.fh * (1 - SEG_SAMPLE_FRAC)) / 2;
  return {
    fx: r.fx + mx,
    fy: r.fy + my,
    fw: r.fw * SEG_SAMPLE_FRAC,
    fh: r.fh * SEG_SAMPLE_FRAC,
  };
}

/** Every sample window, in decode order: digit 0 a..g, digit 1 a..g, digit 2 a..g. */
export function allSampleWindows() {
  const out = [];
  for (let d = 0; d < D_N; d++) for (let s = 0; s < 7; s++) out.push(segSampleFrac(d, s));
  return out;
}

// -------------------------------------------------------------- the colours

/** Digit colour IS the consent bit. MUST match BASE_IN/BASE_OUT in the Lua. */
export const DIGIT_IN = 0x00ff00; // GREEN = opt-in
export const DIGIT_OUT = 0xff0000; // RED   = opt-out
export const UNLIT_RGB = 0x000000;

export const rgb = (hex: number) => ({
  r: (hex >> 16) & 0xff,
  g: (hex >> 8) & 0xff,
  b: hex & 0xff,
});

// ----------------------------------------------------------------- decoding

/**
 * Why every decision is relative and not a fixed threshold: the badge's
 * `dim()` scales all channels by one factor (the wearer retunes it live with
 * UP/DOWN), and the camera applies its own unknown gain on top. Absolute
 * values are meaningless; ratios within one frame are not.
 */
export const CLASSIFY = {
  /** peak channel above this x the frame's strongest stroke ⇒ LIT. */
  LIT_FRAC: 0.55,
  /** below this ⇒ UNLIT (background). */
  DARK_FRAC: 0.28,
  /** the frame's strongest stroke must clear this, or the badge isn't there. */
  MIN_PEAK: 24,
  /** |g - r| / max(g, r) below this ⇒ hue too washed out to call consent. */
  HUE_MARGIN: 0.25,
} as const;

export type Sample = { r: number; g: number; b: number };
/** true = lit, false = unlit, null = too ambiguous to call. */
export type SegRead = boolean | null;

/**
 * Classify one segment against the frame's own peak. The band between
 * DARK_FRAC and LIT_FRAC is deliberately dead: a sample landing there returns
 * null rather than guessing, which fails the glyph table and keeps the face
 * blurred.
 */
export function classifySegment(peakOfSample: number, framePeak: number): SegRead {
  if (framePeak <= 0) return null;
  const f = peakOfSample / framePeak;
  if (f >= CLASSIFY.LIT_FRAC) return true;
  if (f <= CLASSIFY.DARK_FRAC) return false;
  return null;
}

/**
 * Seven segment reads (a..g) -> nibble, or null. Null when any segment is
 * unreadable, or the pattern is not one of the 16 valid glyphs — 112 of the
 * 128 possible patterns are rejected here, before the CRC ever runs.
 */
export function decodeGlyph(segs: readonly SegRead[]): number | null {
  if (segs.length !== 7) return null;
  let bits = 0;
  for (let s = 0; s < 7; s++) {
    const v = segs[s];
    if (v === null || v === undefined) return null;
    if (v) bits |= 1 << s;
  }
  const n = GLYPH.get(bits);
  return n === undefined ? null : n;
}

/** The 7 segment states for nibble n, index 0..6 = a..g. Inverse of decodeGlyph. */
export function encodeGlyph(n: number): boolean[] {
  const bits = SEG[n & 0xf];
  return Array.from({ length: 7 }, (_, s) => ((bits >> s) & 1) === 1);
}

export type StripeRead = "opt_in" | "opt_out";

/**
 * Consent from the hue of the LIT strokes, pooled across the whole frame
 * rather than read off any single segment — pooling is what makes it survive
 * one blurred or clipped stroke.
 *
 * GREEN (0x00FF00) and RED (0xFF0000) share a zero blue channel and differ in
 * exactly one comparison, so this survives gain, dimming, and moderate
 * white-balance drift.
 *
 * FAIL-SAFE: nothing lit, or hue too close to call, returns "opt_out".
 */
export function classifyConsent(lit: readonly Sample[]): StripeRead {
  if (lit.length === 0) return "opt_out";
  let R = 0, G = 0;
  for (const s of lit) { R += s.r; G += s.g; }
  const hi = Math.max(R, G);
  if (hi <= 0 || Math.abs(G - R) / hi < CLASSIFY.HUE_MARGIN) return "opt_out";
  return G > R ? "opt_in" : "opt_out";
}

// -------------------------------------------------------------- wire format

export const ID_BITS = 8;
export const CRC_BITS = 4;
export const PAYLOAD_BITS = ID_BITS + CRC_BITS; // 12
export const NIBBLE_BITS = 4;
/** 3 digits x 4 bits = 12. Change one and this stops being true. */
export const PAYLOAD_FITS = D_N * NIBBLE_BITS === PAYLOAD_BITS;
export const SEGMENTS_PER_FRAME = D_N * 7; // 21

/** CRC-4, polynomial x^4 + x + 1 (0b10011). Mirrors `crc4` in the Lua source. */
export function crc4(value: number, nbits: number): number {
  let reg = 0;
  for (let i = nbits - 1; i >= 0; i--) {
    const bit = (value >> i) & 1;
    const top = (reg >> 3) & 1;
    reg = ((reg << 1) | bit) & 0xf;
    if (top === 1) reg ^= 0x3;
  }
  return reg & 0xf;
}

/** Pack an 8-bit beacon id into the 12-bit on-the-wire payload. */
export function packPayload(id: number): number {
  const masked = id & 0xff;
  return (masked << CRC_BITS) | crc4(masked, ID_BITS);
}

/** Unpack a 12-bit payload. Returns null when the CRC does not check out. */
export function unpackPayload(payload: number): number | null {
  const id = (payload >> CRC_BITS) & 0xff;
  const got = payload & 0xf;
  return crc4(id, ID_BITS) === got ? id : null;
}

/** The 3-digit KEY the badge prints for `id`, e.g. 0x27 -> "271". */
export function keyText(id: number): string {
  const p = packPayload(id);
  const H = "0123456789ABCDEF";
  return H[(p >> 8) & 0xf] + H[(p >> 4) & 0xf] + H[p & 0xf];
}

/** All 21 segment states the badge paints for `id`, digit 0 first, a..g. */
export function encodeSegments(id: number): boolean[] {
  const p = packPayload(id);
  const out: boolean[] = [];
  for (let d = 0; d < D_N; d++) {
    out.push(...encodeGlyph((p >> (NIBBLE_BITS * (D_N - 1 - d))) & 0xf));
  }
  return out;
}

/**
 * Assemble a beacon id from 21 segment reads, digit 0 (most significant
 * nibble) first, a..g within each digit. Null on any unreadable segment,
 * invalid glyph, or CRC failure.
 */
export function decodeSegments(segs: readonly SegRead[]): number | null {
  if (segs.length !== SEGMENTS_PER_FRAME) return null;
  let payload = 0;
  for (let d = 0; d < D_N; d++) {
    const n = decodeGlyph(segs.slice(d * 7, d * 7 + 7));
    if (n === null) return null;
    payload = (payload << NIBBLE_BITS) | n;
  }
  return unpackPayload(payload);
}

/**
 * The whole decode, from 21 averaged RGB samples in `allSampleWindows()`
 * order. Self-calibrating: the brightness reference is the frame's own
 * strongest stroke, so no white ring is needed.
 *
 * Returns null when there is no badge there, or anything fails to resolve.
 * Every failure path lands on blurred; that is the point.
 */
export function decodeFrame(samples: readonly Sample[]):
  { id: number; consent: StripeRead } | null {
  if (samples.length !== SEGMENTS_PER_FRAME) return null;
  const peak = (s: Sample) => Math.max(s.r, s.g, s.b);
  const framePeak = Math.max(...samples.map(peak));
  if (framePeak < CLASSIFY.MIN_PEAK) return null;

  const reads = samples.map((s) => classifySegment(peak(s), framePeak));
  const id = decodeSegments(reads);
  if (id === null) return null;

  const lit = samples.filter((_, i) => reads[i] === true);
  return { id, consent: classifyConsent(lit) };
}

// ------------------------------------------------------------------- radio

/**
 * BLE messages on the badge's restricted Lua channel. Payloads are at most
 * 44 bytes and every one of ours starts with this tag.
 *
 *   CNSF<id>        film event  -> badge flashes MAGENTA on the LEDs
 *   CNSC<id>0       consent mirror pushed down from the registry. The badge
 *                   honours ONLY "0" (opt-out): the id is public, so an
 *                   unsigned CNSC<id>1 would let anyone opt a wearer IN.
 *   CNSR<id><0|1>   consent-change REQUEST from the badge (unsigned; the
 *                   registry client is what actually signs and submits)
 *
 * <id> is the beacon id as two uppercase hex digits.
 */
export const RADIO_TAG = "CNS";
export const RADIO_MAX_BYTES = 44;

export const filmEvent = (id: number) => `${RADIO_TAG}F${hex2(id)}`;
/** Only the restrictive direction is honoured by the badge. */
export const consentPushOptOut = (id: number) => `${RADIO_TAG}C${hex2(id)}0`;

export function hex2(v: number): string {
  return (v & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

/**
 * Fold a provisioned `badge.me.badge_id()` string down to the 8-bit beacon id
 * (FNV-1a, XOR-folded). The badge computes this identically, so the registry
 * can derive a PDA seed from the same value.
 */
export function beaconIdFromBadgeId(badgeId: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < badgeId.length; i++) {
    h = (h ^ badgeId.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ((h >>> 24) ^ (h >>> 16) ^ (h >>> 8) ^ h) & 0xff;
}
