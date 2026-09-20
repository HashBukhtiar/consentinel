/**
 * Consentinel optical beacon — shared wire format.
 *
 * This file is the contract between the badge transmitter
 * (`firmware/consentinel-beacon.lua`) and the capture app's decoder.
 * If you change a constant here, change it there in the same commit.
 *
 * The beacon carries an IDENTIFIER ONLY. It never carries consent state:
 * consent is an owner-signed record on Solana, so a spoofed beacon can
 * mislabel a blob but can never flip anyone's consent.
 */

// ----------------------------------------------------------------- geometry

/** Patch position and size on the badge's 320x240 screen. */
export const PATCH = { x: 8, y: 6, w: 304, h: 132 } as const;

/**
 * Always-lit white frame around the patch — the localization anchor, and the
 * first thing to fail as the badge gets further away: a thin border is barely
 * one camera pixel after downscaling, blurs into the background, and the
 * decoder never finds the patch at all.
 *
 * 5 -> 14 took the smallest decodable patch from 70px to 22px and blur
 * tolerance from 0 to 2 (capture-app/test/sweep.mts). MUST match BORDER in
 * firmware/consentinel-beacon.lua.
 */
export const BORDER_PX = 14;

export const COLS = 3;
export const ROWS = 2;

/** Cell size inside the border, in badge pixels. */
export const CELL_W = Math.floor((PATCH.w - 2 * BORDER_PX) / COLS);
export const CELL_H = Math.floor((PATCH.h - 2 * BORDER_PX) / ROWS);

/**
 * Cell roles, in reading order (left→right, top→bottom), 1-based to match
 * the Lua source:
 *
 *   [1 clock][2 frame][3 d3]
 *   [4 d2   ][5 d1   ][6 d0]
 */
export const CLOCK_CELL = 1;
export const FRAME_CELL = 2;
/** Most significant data lane first. */
export const DATA_CELLS = [3, 4, 5, 6] as const;

// -------------------------------------------------------------- wire format

export const ID_BITS = 8;
export const CRC_BITS = 4;
export const PAYLOAD_BITS = ID_BITS + CRC_BITS; // 12
export const LANES = DATA_CELLS.length; // 4
export const SYMBOLS_PER_FRAME = PAYLOAD_BITS / LANES; // 3

/** Manchester violation used as the MODE S frame marker. */
export const SYNC_RUN = 3;

/** Symbol periods the badge can be cycled through with B. Default is 100 ms. */
export const TIMING_MS = [80, 100, 120, 150] as const;
export const DEFAULT_TIMING_MS = 100;

/**
 * Frame duration in MODE P, at the default rate: 3 symbols x 100 ms = 300 ms.
 * Expect first lock inside ~1 s including acquisition.
 */
export const FRAME_MS_PARALLEL = SYMBOLS_PER_FRAME * DEFAULT_TIMING_MS;

// --------------------------------------------------------------------- crc

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

// ----------------------------------------------------------------- decoding

/**
 * One sampled symbol: the boolean state of each of the six cells, indexed
 * 0..5 in reading order (so cell N from the tables above is index N-1).
 */
export type SymbolSample = readonly boolean[];

/**
 * Assemble a beacon id from exactly SYMBOLS_PER_FRAME consecutive symbols,
 * the first of which must have the frame lane lit.
 *
 * Returns null if the frame is misaligned or the CRC fails — the caller
 * should then keep the face blurred (DEFAULT_CONSENT = blur).
 */
export function decodeFrame(symbols: readonly SymbolSample[]): number | null {
  if (symbols.length !== SYMBOLS_PER_FRAME) return null;
  if (!symbols[0][FRAME_CELL - 1]) return null;

  let payload = 0;
  for (const sym of symbols) {
    for (const cell of DATA_CELLS) {
      payload = (payload << 1) | (sym[cell - 1] ? 1 : 0);
    }
  }
  return unpackPayload(payload);
}

// --------------------------------------------------------------- static key
//
// v0.4 firmware: the key is STATIC — a white ring around three giant
// 7-segment hex digits spelling the same 12-bit payload (id<<4 | crc4). One
// frame decodes; no clock, no timing. The digit COLOUR is a restrict-only
// consent hint (mint = opt-in, rose = opt-out): it can make a face stricter,
// never clear one — the chain record still has to say opt-in.
// MUST match the geometry block in firmware/consentinel-beacon.lua.

/** The whole panel is the key; the ring is its outer KEY_BORDER px. */
export const KEY = { w: 320, h: 240 } as const;
export const KEY_BORDER = 24;
export const DIGITS = 3;
export const DIGIT = { w: 76, h: 160, t: 18, gap: 14 } as const;
export const DIGIT_HALF = Math.floor((DIGIT.h - 3 * DIGIT.t) / 2); // 53
const KEY_IN_W = KEY.w - 2 * KEY_BORDER, KEY_IN_H = KEY.h - 2 * KEY_BORDER; // 272 x 192
export const DIGIT_X0 = KEY_BORDER + Math.floor((KEY_IN_W - (DIGITS * DIGIT.w + (DIGITS - 1) * DIGIT.gap)) / 2); // 32
export const DIGIT_Y0 = KEY_BORDER + Math.floor((KEY_IN_H - DIGIT.h) / 2); // 40

/** 7-segment glyphs 0-F. Bit s-1 = segment s: 1 a(top) 2 b 4 c 8 d(bottom) 16 e 32 f 64 g(middle). */
export const SEG = [
  0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07,
  0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71,
] as const;
export const SEG_TO_NIBBLE: ReadonlyMap<number, number> = new Map(SEG.map((m, i) => [m, i]));

/** Segment s (1..7) of digit d (0 = most significant), in key pixels. Mirrors `seg_geom`. */
export function segRect(d: number, s: number): { x: number; y: number; w: number; h: number } {
  const { w: W, t: T } = DIGIT, H = DIGIT.h, Hf = DIGIT_HALF;
  const dx = DIGIT_X0 + d * (W + DIGIT.gap), y0 = DIGIT_Y0;
  switch (s) {
    case 1: return { x: dx + T, y: y0, w: W - 2 * T, h: T };
    case 2: return { x: dx + W - T, y: y0 + T, w: T, h: Hf };
    case 3: return { x: dx + W - T, y: y0 + 2 * T + Hf, w: T, h: Hf };
    case 4: return { x: dx + T, y: y0 + H - T, w: W - 2 * T, h: T };
    case 5: return { x: dx, y: y0 + 2 * T + Hf, w: T, h: Hf };
    case 6: return { x: dx, y: y0 + T, w: T, h: Hf };
    default: return { x: dx + T, y: y0 + T + Hf, w: W - 2 * T, h: T };
  }
}

export const KEY_COLOR = { optIn: 0x00ff84, optOut: 0xff0084 } as const; // MINT / ROSE

/** Three hex nibbles (most significant first) → beacon id, or null on CRC failure ⇒ blur. */
export function decodeKey(nibbles: readonly number[]): number | null {
  if (nibbles.length !== DIGITS) return null;
  return unpackPayload((nibbles[0] << 8) | (nibbles[1] << 4) | nibbles[2]);
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
