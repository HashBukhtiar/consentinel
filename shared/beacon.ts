/**
 * Consentinel optical beacon — shared wire format.
 *
 * This file is the contract between the badge transmitter
 * (`firmware/consentinel-beacon.lua`) and the capture app's decoder.
 * If you change a constant here, change it there in the same commit. A
 * one-value disagreement does not degrade gracefully: every frame fails CRC
 * and every face stays blurred forever.
 *
 * WHAT CHANGED (v2, full-screen colour blink). v1 was a 304x132 patch with a
 * 3x2 grid of lit/dark cells, 12 bits carried in parallel across 3 symbols.
 * Measured, it died at 22 px of patch width — not because the localizer lost
 * the patch (it found it down to 13 px) but because at 22 px each cell is ~7
 * processed pixels and blur crosstalk between neighbouring cells destroys the
 * bits. Space ran out before time did.
 *
 * v2 spends the whole screen on ONE symbol and pays for the bits in TIME:
 *
 *   - the patch is the entire 320x240 screen, so the interior is one giant
 *     uniform blob and cell crosstalk cannot exist;
 *   - each symbol is one of 5 COLOURS, not one of 2 brightnesses, so a symbol
 *     carries 2 bits instead of 1 without asking the camera to resolve any
 *     extra spatial structure (measured 2.7x faster than mono for the same
 *     payload, at the same range);
 *   - symbols are DIFFERENTIAL (each colour encodes the step to the next), so
 *     consecutive symbols can never be equal and the decoder gets a guaranteed
 *     transition at every symbol boundary — no clock lane, no Manchester, no
 *     clock recovery at all;
 *   - two colours outside the data ring mark the start of a frame AND carry
 *     consent, so framing is unambiguous and a printed photo of a badge (which
 *     shows one static colour forever) can never assemble a frame.
 *
 * The beacon now carries identity AND consent. The consent bit is
 * RESTRICT-ONLY in the capture app: clear requires chain-opt_in AND
 * light-opt_in (see capture-app/src/consent/decide.ts). Light can subtract
 * permission, never add it, so a spoofed or misread beacon can only ever BLUR
 * someone — which is why it is safe to trust a 16-bit unsigned payload at all.
 */

// ----------------------------------------------------------------- geometry

/**
 * Patch position and size on the badge's 320x240 screen: the WHOLE screen.
 *
 * The beacon screen has zero text by design. At 60 degrees FOV and
 * PROCESS_WIDTH 1280, one processed pixel is ~0.9 mm at 1 m, so the whole
 * 35 mm display is ~39 processed pixels wide and a 24 px label would be ~2.8
 * of them tall. Text is for the wearer at arm's length; the camera gets
 * geometry and colour.
 */
export const PATCH = { x: 0, y: 0, w: 320, h: 240 } as const;

/**
 * Always-lit white frame around the interior. It does two jobs and both are
 * load-bearing:
 *
 *   1. LOCALIZATION ANCHOR. During a BLACK symbol the ring is the only lit
 *      thing on the badge, so the connected-component scan finds the ring or
 *      it finds nothing.
 *   2. WHITE REFERENCE. Every term of beaconFeature() divides the interior by
 *      this ring, which is what makes the classifier immune to exposure and
 *      white balance (measured: residual drift is 6% of the palette spacing,
 *      versus 158% for raw RGB — exposure alone moves a raw colour past its
 *      neighbour).
 *
 * Measured on full-screen geometry, each +4 px of border buys ~+0.17 m of
 * range at 60 degrees FOV for ~5% of interior area, with no saturation before
 * 32 px. Interior area is free now (it is one blob, not six cells), so the
 * border is sized for range rather than for bits; 24 px is the value-for-money
 * point at 68% interior.
 *
 * MUST match BORDER in firmware/consentinel-beacon.lua.
 */
export const BORDER_PX = 24;

/** The blinking interior, in badge pixels. 272x192 = 52 224 px. */
export const INTERIOR = {
  x: BORDER_PX, y: BORDER_PX,
  w: PATCH.w - 2 * BORDER_PX, h: PATCH.h - 2 * BORDER_PX,
} as const;

/**
 * Fraction of the interior the decoder actually averages, centred. 40% linear
 * (16% of the area) keeps the sample clear of the border even after a box
 * blur of r=4 at 30 px patch width, where the border is ~2.3 camera pixels and
 * bleeds inward by about that much.
 */
export const SAMPLE_FRAC = 0.4;

// ------------------------------------------------------------------ palette

export type RGB = readonly [number, number, number];

/**
 * The five DATA colours, in symbol-index order 0..4.
 *
 * Every entry is an exact RGB565 value, so the panel shows precisely what we
 * asked for and the decoder's reference table is the truth rather than an
 * approximation. (R and B have only 32 exact 8-bit levels, G has 64.)
 *
 * These are the HALF-LEVEL hues, not the cube corners, and that is deliberate:
 * in chromaticity the R/G/B primaries sit twice as far from neutral as the
 * Y/C/M secondaries, so a corner palette is lopsided and the secondaries are
 * the first thing to die under desaturation. Measured symbol error for this
 * family is 0.00% down to 16 px with the margin reject on.
 *
 * Note there is NO WHITE here. The interior can never match the border, so a
 * solid white rectangle in the room is never a valid symbol and localization
 * stays unambiguous.
 *
 *   0 BLACK  #000000      3 AMBER  #FF8200
 *   1 AZURE  #0082FF      4 BLUE   #0000FF
 *   2 LIME   #84FF00
 */
export const DATA_COLORS: readonly RGB[] = [
  [0x00, 0x00, 0x00], // 0 BLACK
  [0x00, 0x82, 0xff], // 1 AZURE
  [0x84, 0xff, 0x00], // 2 LIME
  [0xff, 0x82, 0x00], // 3 AMBER
  [0x00, 0x00, 0xff], // 4 BLUE
];

/** Size of the differential ring. The data alphabet is exactly DATA_COLORS. */
export const RADIX = 5;

/**
 * The two FRAME MARKERS. They live outside the differential ring, so seeing
 * one is unambiguously "a frame starts here" — the decoder needs no clock, no
 * preamble correlation and no symbol counter to re-acquire.
 *
 * They also ARE the consent bit, duplicated from payload bit 7. Two reasons:
 *
 *   - consent then reads on the FIRST camera frame that resolves a colour, not
 *     900 ms later when a frame completes, which is what makes "press A and be
 *     blurred by the next frame" true rather than aspirational;
 *   - marker and payload must agree or decodeFrame() returns null, so a
 *     corruption that flips consent has to flip it in two places at once.
 *
 * MINT and ROSE are the widest-separated pair in the whole alphabet (1.4366 in
 * feature space) and differ in both chroma and luma, so they are the last
 * thing to become confusable off-axis — and a human across the room can read
 * green-vs-pink with no decoding at all (locked decision 6).
 */
export const MARK_OPT_IN: RGB = [0x00, 0xff, 0x84]; // MINT
export const MARK_OPT_OUT: RGB = [0xff, 0x00, 0x84]; // ROSE
export const MARK_IN_INDEX = 5;
export const MARK_OUT_INDEX = 6;

/** Full 7-entry alphabet: data ring 0..4, then the two markers. */
export const ALPHABET: readonly RGB[] = [...DATA_COLORS, MARK_OPT_IN, MARK_OPT_OUT];

/** Human-readable names, index-aligned with ALPHABET (for tune.html + logs). */
export const ALPHABET_NAMES = ["BLACK", "AZURE", "LIME", "AMBER", "BLUE", "MINT", "ROSE"] as const;

// --------------------------------------------------------------- classifier

/**
 * Weight on the two chromaticity axes versus relative luma. Chromaticity alone
 * is perfectly exposure- and AWB-invariant but throws luma away, which
 * collapses black, grey and white onto the same point (measured 46-50% symbol
 * error with a luma-free classifier). Luma alone is what the v1 decoder used
 * and it is destroyed by border bleed at small widths. 1.6 is the measured
 * balance between the two failure modes.
 */
export const KC = 1.6;

/**
 * Added to each normalized channel before the chromaticity divide. A nearly
 * black patch has a NEUTRAL chroma, not an undefined one: without this, 8-bit
 * quantization noise on a value of 2 swings the hue across the whole gamut.
 */
export const EPS = 0.03;

/**
 * Reject threshold: a symbol counts only if the nearest reference is this many
 * times closer than the runner-up. Measured cost 2-3% of reads at 40-120 px,
 * 5% at 30 px, 11% at 22 px. Measured benefit: it takes the wrong-id rate to
 * ZERO at every width from 12 to 80 px over 500 000 frames per cell. This is
 * the default-deny rule for the symbol layer — below the threshold there is no
 * symbol, and no symbol kills the frame in progress rather than guessing it.
 */
export const SYMBOL_MARGIN = 1.3;

/**
 * A reference this dark is not a lit white border, so nothing sampled against
 * it means anything. Physically unreachable in a working read (the decoder's
 * flags.BEACON_MIN_BORDER gate sits at 80 and is the real tunable), but the
 * classifier must be safe standing alone: with a pure-black "reference",
 * max(1, ref) makes a pure-black interior land exactly on the BLACK reference
 * with infinite margin, and a dark frame would hand out a free symbol.
 */
export const MIN_REF_LUMA = 32;

/** Rec.601 luma of an RGB triple. */
export function lumaOf(c: RGB): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

/**
 * Feature: per-channel white-balance against the border ring, then chroma and
 * luma. Both arguments must come from the SAME camera frame — the whole point
 * is that whatever the sensor did to the interior it also did to the ring.
 */
export function beaconFeature(px: RGB, ref: RGB): [number, number, number] {
  const rn = px[0] / Math.max(1, ref[0]) + EPS;
  const gn = px[1] / Math.max(1, ref[1]) + EPS;
  const bn = px[2] / Math.max(1, ref[2]) + EPS;
  const s = Math.max(1e-6, rn + gn + bn);
  return [KC * (rn / s), KC * (gn / s), 0.299 * rn + 0.587 * gn + 0.114 * bn];
}

/** Each alphabet colour as an ideal camera would read it against pure white. */
export const ALPHABET_REFS: readonly [number, number, number][] =
  ALPHABET.map((c) => beaconFeature(c, [255, 255, 255]));

/**
 * Nearest alphabet entry, or null when it is not CLEARLY nearest.
 *
 * A UNIFORM BLOB — a laptop screen, a lamp, a sheet of paper, a photograph of
 * a badge — normalizes to the same point whatever its colour, because px and
 * ref are then identical. That point sits 1.14x from LIME and 1.14x from
 * AMBER, well under the 1.30 threshold, so uniform blobs reject STRUCTURALLY
 * rather than by a tuned brightness rule. This is what replaced v1's `anyDark`
 * check, which a one-cell interior can no longer satisfy.
 */
export function classifySymbol(px: RGB, ref: RGB, margin: number): number | null {
  if (lumaOf(ref) < MIN_REF_LUMA) return null;
  const f = beaconFeature(px, ref);
  let best = -1, d1 = Infinity, d2 = Infinity;
  for (let i = 0; i < ALPHABET_REFS.length; i++) {
    const dr = f[0] - ALPHABET_REFS[i][0];
    const dg = f[1] - ALPHABET_REFS[i][1];
    const dl = f[2] - ALPHABET_REFS[i][2];
    const d = Math.sqrt(dr * dr + dg * dg + dl * dl);
    if (d < d1) { d2 = d1; d1 = d; best = i; } else if (d < d2) { d2 = d; }
  }
  return d2 / Math.max(1e-9, d1) >= margin ? best : null;
}

// -------------------------------------------------------------- wire format

export const ID_BITS = 8;
/** id(8) | consent(1) | reserved(1). The reserved bit is transmitted as 0 and
 *  checked as 0 on receipt — a free extra bit of "this is really our frame". */
export const MSG_BITS = 10;
export const CRC_BITS = 6;
export const PAYLOAD_BITS = MSG_BITS + CRC_BITS; // 16

export const BITS_PER_SYMBOL = 2;
export const DATA_SYMBOLS = PAYLOAD_BITS / BITS_PER_SYMBOL; // 8
/** 1 marker + 8 data symbols. */
export const SYMBOLS_PER_FRAME = 1 + DATA_SYMBOLS; // 9

/** Symbol periods the badge can be cycled through with B. Default is 100 ms. */
export const TIMING_MS = [80, 100, 120, 150] as const;
export const DEFAULT_TIMING_MS = 100;

/**
 * Frame duration at the default rate: 9 symbols x 100 ms. Two matching frames
 * are needed before an id is trusted, so first lock is ~1.8-2.7 s including
 * acquisition — which is why flags.BEACON_CONFIRM_MS had to go 1500 -> 4000.
 * At 1500 a 900 ms frame could NEVER confirm and every badge stayed blurred.
 */
export const FRAME_MS = SYMBOLS_PER_FRAME * DEFAULT_TIMING_MS; // 900

// --------------------------------------------------------------------- crc

/**
 * CRC-6, polynomial x^6 + x + 1 (0b1000011, tap 0x03). Mirrors `crc6` in the
 * Lua source.
 *
 * Call it AUGMENTED — crc6(msg << CRC_BITS, PAYLOAD_BITS), never
 * crc6(msg, MSG_BITS). v1 used the non-augmented form, which loses the
 * burst-detection guarantee: measured at degree 6 over a 10-bit message it
 * degenerates almost to the identity and 78% of two-symbol-error frames
 * slipped through, versus ~1/64 for the augmented form.
 *
 * Why degree 6 and not v1's degree 4: a differential symbol error corrupts two
 * adjacent payload dibits, i.e. a burst of at most 4 bits, and a degree-r CRC
 * with a nonzero constant term detects EVERY burst of length <= r. Degree 4
 * measured a wrong id on 0.0076% of frames at 22 px — one every two hours per
 * badge. Degree 6 measured zero in 500 000 frames at every width down to 12 px.
 * The two extra bits were otherwise going to be reserved zeros, which measured
 * almost nothing.
 *
 * 32-BIT NOTE for the Lua side: the largest intermediate here is msg << 6 =
 * 0xFFC0, so nothing in this path can exceed 2147483647 and silently become a
 * float (which would then fail every bitwise operator).
 */
export function crc6(value: number, nbits: number): number {
  let reg = 0;
  for (let i = nbits - 1; i >= 0; i--) {
    const bit = (value >> i) & 1;
    const top = (reg >> 5) & 1;
    reg = ((reg << 1) | bit) & 0x3f;
    if (top === 1) reg ^= 0x03;
  }
  return reg & 0x3f;
}

/** Pack id + consent into the 16-bit on-the-wire payload. */
export function packPayload(id: number, optIn: boolean): number {
  const msg = ((id & 0xff) << 2) | (optIn ? 2 : 0); // reserved bit stays 0
  return (msg << CRC_BITS) | crc6(msg << CRC_BITS, PAYLOAD_BITS);
}

/** Unpack a 16-bit payload. null = reserved bit set or CRC mismatch ⇒ blur. */
export function unpackPayload(payload: number): { id: number; optIn: boolean } | null {
  const msg = (payload >> CRC_BITS) & 0x3ff;
  if ((msg & 1) !== 0) return null; // reserved must be 0
  if (crc6(msg << CRC_BITS, PAYLOAD_BITS) !== (payload & 0x3f)) return null;
  return { id: (msg >> 2) & 0xff, optIn: ((msg >> 1) & 1) === 1 };
}

/**
 * The 9 alphabet indices the badge shows, in order. This is the transmitter,
 * and `decodeFrame` is its exact inverse — the self-check asserts the round
 * trip for all 256 ids x both consents, which is how the two lanes stay honest.
 *
 * Symbol 0 is the marker. Each data symbol then steps the previous colour
 * forward by 1 + b around the 5-ring, where b is the next 2 payload bits, MSB
 * first. The +1 is the whole trick: the step is never 0, so the colour ALWAYS
 * changes and a frame-differencing segmenter can never miss a symbol boundary.
 */
export function frameSymbols(id: number, optIn: boolean): number[] {
  const payload = packPayload(id, optIn);
  const out = [optIn ? MARK_IN_INDEX : MARK_OUT_INDEX];
  let prev = 0;
  for (let k = 0; k < DATA_SYMBOLS; k++) {
    const b = (payload >> (PAYLOAD_BITS - BITS_PER_SYMBOL * (k + 1))) & 0b11;
    prev = (prev + 1 + b) % RADIX;
    out.push(prev);
  }
  return out;
}

/**
 * Assemble one frame from exactly SYMBOLS_PER_FRAME alphabet indices, the
 * first of which must be a marker.
 *
 * Five independent ways to return null, and every one of them means "keep the
 * face blurred" (DEFAULT_CONSENT = blur):
 *   1. wrong number of symbols;
 *   2. symbol 0 is not a marker — not a frame boundary;
 *   3. a marker appears inside the data run — a frame boundary landed where
 *      data should be, so the stream is misaligned;
 *   4. a zero step — impossible by construction, so the read is corrupt;
 *   5. marker and payload consent disagree, or the CRC/reserved check fails.
 */
export function decodeFrame(sym: readonly number[]): { id: number; optIn: boolean } | null {
  if (sym.length !== SYMBOLS_PER_FRAME) return null;
  const m = sym[0];
  if (m !== MARK_IN_INDEX && m !== MARK_OUT_INDEX) return null;
  let payload = 0, prev = 0;
  for (let k = 1; k <= DATA_SYMBOLS; k++) {
    const cur = sym[k];
    if (cur < 0 || cur >= RADIX) return null; // a marker inside the data run
    const d = (cur - prev + RADIX) % RADIX;
    if (d === 0) return null; // impossible by construction
    payload = (payload << BITS_PER_SYMBOL) | (d - 1);
    prev = cur;
  }
  const out = unpackPayload(payload);
  if (out === null) return null;
  if (out.optIn !== (m === MARK_IN_INDEX)) return null; // marker must agree
  return out;
}

// ------------------------------------------------------------------- radio

/**
 * BLE messages on the badge's restricted Lua channel. Payloads are at most
 * 44 bytes and every one of ours starts with this tag.
 *
 *   CNSF<id>        film event  -> badge raises the red alert
 *   CNSC<id><0|1>   consent mirror pushed down from the registry
 *   CNSR<id><0|1>   consent-change REQUEST from the badge (unsigned; the
 *                   registry client is what actually signs and submits)
 *
 * <id> is the beacon id as two uppercase hex digits.
 *
 * The radio is NO LONGER ON THE CRITICAL PATH. Consent travels in the light
 * now, restrict-only, so "press A -> blurred" works with zero radio (bounded
 * at BEACON_ID_HOLD_MS + BIND_TTL_MS = 2.8 s). This is convenience telemetry.
 */
export const RADIO_TAG = "CNS";
export const RADIO_MAX_BYTES = 44;

export const filmEvent = (id: number) => `${RADIO_TAG}F${hex2(id)}`;
export const consentPush = (id: number, optIn: boolean) =>
  `${RADIO_TAG}C${hex2(id)}${optIn ? "1" : "0"}`;

export function hex2(v: number): string {
  return (v & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

/**
 * Fold a provisioned `badge.me.badge_id()` string down to the 8-bit beacon
 * id (FNV-1a, XOR-folded). The badge computes this identically, so the
 * registry can derive a PDA seed from the same value.
 */
export function beaconIdFromBadgeId(badgeId: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < badgeId.length; i++) {
    h = (h ^ badgeId.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ((h >>> 24) ^ (h >>> 16) ^ (h >>> 8) ^ h) & 0xff;
}
