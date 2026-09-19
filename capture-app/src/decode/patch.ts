// Patch geometry + pixel painting for the optical beacon. Pure math + buffer
// writes (no canvas/DOM) so both the browser decoder and the node self-check
// use the same cell layout — a mismatch here would silently corrupt decodes.
import {
  PATCH, BORDER_PX, COLS, ROWS, CELL_W, CELL_H,
  CLOCK_CELL, FRAME_CELL, DATA_CELLS, LANES, PAYLOAD_BITS, SYMBOLS_PER_FRAME,
  packPayload,
} from "@shared/beacon";
import type { SymbolSample } from "@shared/beacon";

/** Fractional rect of cell i (1-based) within the whole patch bbox (incl. border). */
export function cellRectFrac(i: number) {
  const col = (i - 1) % COLS;
  const row = Math.floor((i - 1) / COLS);
  return {
    fx: (BORDER_PX + col * CELL_W) / PATCH.w,
    fy: (BORDER_PX + row * CELL_H) / PATCH.h,
    fw: CELL_W / PATCH.w,
    fh: CELL_H / PATCH.h,
  };
}

/** A point on the always-lit top border — the brightness reference for a patch. */
export const BORDER_REF_FRAC = { fx: 0.5, fy: (BORDER_PX * 0.5) / PATCH.h } as const;

/**
 * The six cell states for beacon `id` at symbol `s` (0..2). This is the exact
 * inverse of `decodeFrame` in shared/beacon.ts — the self-check asserts the
 * round-trip, which is how we stay honest against A's wire format.
 * Index 0..5 = reading order [clock, frame, d3, d2, d1, d0].
 */
export function symbolCells(id: number, s: number): boolean[] {
  const payload = packPayload(id);
  const cells = [false, false, false, false, false, false];
  cells[CLOCK_CELL - 1] = (s & 1) === 1; // square wave, one flip per symbol
  cells[FRAME_CELL - 1] = s === 0; // frame marker lit only on symbol 0
  DATA_CELLS.forEach((cell, k) => {
    const bitPos = s * LANES + k; // 0..11 from MSB
    cells[cell - 1] = ((payload >> (PAYLOAD_BITS - 1 - bitPos)) & 1) === 1;
  });
  return cells;
}

export const framePeriodSymbols = SYMBOLS_PER_FRAME;

// ---- pixel painting (used by the self-check and any synthetic source) ----

type Buf = Uint8ClampedArray | number[];

function fill(data: Buf, W: number, H: number, x0: number, y0: number, w: number, h: number, v: number) {
  const x1 = Math.min(W, Math.round(x0 + w));
  const y1 = Math.min(H, Math.round(y0 + h));
  for (let y = Math.max(0, Math.round(y0)); y < y1; y++) {
    for (let x = Math.max(0, Math.round(x0)); x < x1; x++) {
      const o = (y * W + x) * 4;
      data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
    }
  }
}

/** Paint one patch (white border, black interior, white lit cells) into an RGBA buffer. */
export function paintPatch(
  data: Buf, W: number, H: number,
  rect: { x: number; y: number; w: number; h: number },
  cells: SymbolSample,
) {
  fill(data, W, H, rect.x, rect.y, rect.w, rect.h, 255); // border + fill white
  const bx = (BORDER_PX / PATCH.w) * rect.w, by = (BORDER_PX / PATCH.h) * rect.h;
  fill(data, W, H, rect.x + bx, rect.y + by, rect.w - 2 * bx, rect.h - 2 * by, 0); // interior black
  for (let i = 1; i <= COLS * ROWS; i++) {
    if (!cells[i - 1]) continue;
    const r = cellRectFrac(i);
    fill(data, W, H, rect.x + r.fx * rect.w, rect.y + r.fy * rect.h, r.fw * rect.w, r.fh * rect.h, 255);
  }
}
