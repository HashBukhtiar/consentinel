// Patch geometry + pixel painting for the optical beacon. Pure math + buffer
// writes (no canvas/DOM) so the browser decoder, the on-screen badge page and
// the node self-check all share one layout — a mismatch here would silently
// corrupt decodes.
//
// v2 geometry: the interior is ONE blob, not a cell grid. A symbol is the
// colour of that blob, sampled against the always-lit white ring.
import {
  PATCH, BORDER_PX, INTERIOR, SAMPLE_FRAC, SYMBOLS_PER_FRAME,
  ALPHABET, frameSymbols,
} from "@shared/beacon";
import type { RGB } from "@shared/beacon";

/** Fractional rect of the blinking interior within the patch bbox (incl. border). */
export const INTERIOR_FRAC = {
  fx: INTERIOR.x / PATCH.w,
  fy: INTERIOR.y / PATCH.h,
  fw: INTERIOR.w / PATCH.w,
  fh: INTERIOR.h / PATCH.h,
} as const;

/**
 * The centred window the decoder actually averages, as a centre + half-extents
 * in fractions of the patch bbox. The interior is centred in the patch
 * (BORDER_PX on all four sides), so its centre IS the patch centre.
 */
export const SAMPLE_BOX_FRAC = {
  fcx: 0.5,
  fcy: 0.5,
  fhw: (INTERIOR.w * SAMPLE_FRAC * 0.5) / PATCH.w,
  fhh: (INTERIOR.h * SAMPLE_FRAC * 0.5) / PATCH.h,
} as const;

/** A point on the always-lit top border — the white reference for a patch. */
export const BORDER_REF_FRAC = { fx: 0.5, fy: (BORDER_PX * 0.5) / PATCH.h } as const;

/**
 * The colours beacon `id` shows, in symbol order. This is the transmitter side
 * of the contract and `decodeFrame` is its exact inverse — the self-check
 * asserts the round trip for all 256 ids x both consents.
 */
export function symbolColors(id: number, optIn: boolean): RGB[] {
  return frameSymbols(id, optIn).map((s) => ALPHABET[s]);
}

/** The colour for symbol `s` (wraps), for painters that step a free clock. */
export function symbolColor(id: number, optIn: boolean, s: number): RGB {
  const syms = frameSymbols(id, optIn);
  const k = ((s % SYMBOLS_PER_FRAME) + SYMBOLS_PER_FRAME) % SYMBOLS_PER_FRAME;
  return ALPHABET[syms[k]];
}

export const framePeriodSymbols = SYMBOLS_PER_FRAME;

// ---- pixel painting (used by the self-check and any synthetic source) ----

type Buf = Uint8ClampedArray | number[];

function fill(
  data: Buf, W: number, H: number,
  x0: number, y0: number, w: number, h: number, c: RGB,
) {
  const x1 = Math.min(W, Math.round(x0 + w));
  const y1 = Math.min(H, Math.round(y0 + h));
  for (let y = Math.max(0, Math.round(y0)); y < y1; y++) {
    for (let x = Math.max(0, Math.round(x0)); x < x1; x++) {
      const o = (y * W + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  }
}

const WHITE: RGB = [255, 255, 255];

/** Paint one patch: white border ring, interior filled with `color`. */
export function paintPatch(
  data: Buf, W: number, H: number,
  rect: { x: number; y: number; w: number; h: number },
  color: RGB,
) {
  fill(data, W, H, rect.x, rect.y, rect.w, rect.h, WHITE);
  const bx = (BORDER_PX / PATCH.w) * rect.w, by = (BORDER_PX / PATCH.h) * rect.h;
  fill(data, W, H, rect.x + bx, rect.y + by, rect.w - 2 * bx, rect.h - 2 * by, color);
}
