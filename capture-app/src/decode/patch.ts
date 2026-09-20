// Static-key geometry + pixel painting for the optical beacon (firmware v0.4:
// white ring + three 7-segment hex digits). Pure math + buffer writes, no
// canvas/DOM, so the browser decoder and the node self-check share one segment
// layout — a mismatch here would silently corrupt every decode.
import {
  KEY, KEY_BORDER, DIGITS, SEG, KEY_COLOR, segRect, packPayload,
  // legacy v0.3 animated-grid layout — kept only so offline tooling typechecks
  PATCH, BORDER_PX, COLS, ROWS, CELL_W, CELL_H, CLOCK_CELL, FRAME_CELL, DATA_CELLS, LANES, PAYLOAD_BITS,
} from "@shared/beacon";
import type { SymbolSample } from "@shared/beacon";

export const SEGS = 7;

/** Fractional rect of segment s (1..7) of digit d (0 = MSB) over the whole key bbox (ring included). */
export function segRectFrac(d: number, s: number) {
  const r = segRect(d, s);
  return { fx: r.x / KEY.w, fy: r.y / KEY.h, fw: r.w / KEY.w, fh: r.h / KEY.h };
}

/** Mid-ring reference points (top, bottom, left, right) — the white the decoder normalizes by. */
export const RING_REF_FRACS = [
  [0.5, (KEY_BORDER / 2) / KEY.h],
  [0.5, (KEY.h - KEY_BORDER / 2) / KEY.h],
  [(KEY_BORDER / 2) / KEY.w, 0.5],
  [(KEY.w - KEY_BORDER / 2) / KEY.w, 0.5],
] as const;

/** The three glyph masks the badge lights for `id` (most significant digit first). */
export function keyMasks(id: number): number[] {
  const p = packPayload(id);
  return [(p >> 8) & 0xf, (p >> 4) & 0xf, p & 0xf].map((n) => SEG[n]);
}

/** All 21 segment states, digit-major, segment 1..7 — exactly what sampleCells reads back. */
export function keyBits(id: number): boolean[] {
  return keyMasks(id).flatMap((m) => Array.from({ length: SEGS }, (_, i) => ((m >> i) & 1) === 1));
}

// ---- pixel painting (self-check + any synthetic source) ---------------------
type Buf = Uint8ClampedArray | number[];

function fill(data: Buf, W: number, H: number, x0: number, y0: number, w: number, h: number, r: number, g: number, b: number) {
  const x1 = Math.min(W, Math.round(x0 + w)), y1 = Math.min(H, Math.round(y0 + h));
  for (let y = Math.max(0, Math.round(y0)); y < y1; y++) {
    for (let x = Math.max(0, Math.round(x0)); x < x1; x++) {
      const o = (y * W + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
}
const rgb = (c: number): [number, number, number] => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];

/** Paint one static key: white ring, black interior, lit segments in mint (opt-in) or rose (opt-out). */
export function paintKey(
  data: Buf, W: number, H: number,
  rect: { x: number; y: number; w: number; h: number },
  id: number, optIn: boolean,
  litSegments = true,
) {
  fill(data, W, H, rect.x, rect.y, rect.w, rect.h, 255, 255, 255);
  const bx = (KEY_BORDER / KEY.w) * rect.w, by = (KEY_BORDER / KEY.h) * rect.h;
  fill(data, W, H, rect.x + bx, rect.y + by, rect.w - 2 * bx, rect.h - 2 * by, 0, 0, 0);
  if (!litSegments) return;
  const [r, g, b] = rgb(optIn ? KEY_COLOR.optIn : KEY_COLOR.optOut);
  const masks = keyMasks(id);
  for (let d = 0; d < DIGITS; d++) {
    for (let s = 1; s <= SEGS; s++) {
      if (!((masks[d] >> (s - 1)) & 1)) continue;
      const f = segRectFrac(d, s);
      fill(data, W, H, rect.x + f.fx * rect.w, rect.y + f.fy * rect.h, f.fw * rect.w, f.fh * rect.h, r, g, b);
    }
  }
}

// ---- legacy v0.3 animated grid (offline tooling only; the badge no longer draws this) ----
export function cellRectFrac(i: number) {
  const col = (i - 1) % COLS, row = Math.floor((i - 1) / COLS);
  return { fx: (BORDER_PX + col * CELL_W) / PATCH.w, fy: (BORDER_PX + row * CELL_H) / PATCH.h, fw: CELL_W / PATCH.w, fh: CELL_H / PATCH.h };
}
export const BORDER_REF_FRAC = { fx: 0.5, fy: (BORDER_PX * 0.5) / PATCH.h } as const;
export function symbolCells(id: number, s: number): boolean[] {
  const payload = packPayload(id);
  const cells = [false, false, false, false, false, false];
  cells[CLOCK_CELL - 1] = (s & 1) === 1;
  cells[FRAME_CELL - 1] = s === 0;
  DATA_CELLS.forEach((cell, k) => { cells[cell - 1] = ((payload >> (PAYLOAD_BITS - 1 - (s * LANES + k))) & 1) === 1; });
  return cells;
}
export function paintPatch(data: Buf, W: number, H: number, rect: { x: number; y: number; w: number; h: number }, cells: SymbolSample) {
  fill(data, W, H, rect.x, rect.y, rect.w, rect.h, 255, 255, 255);
  const bx = (BORDER_PX / PATCH.w) * rect.w, by = (BORDER_PX / PATCH.h) * rect.h;
  fill(data, W, H, rect.x + bx, rect.y + by, rect.w - 2 * bx, rect.h - 2 * by, 0, 0, 0);
  for (let i = 1; i <= COLS * ROWS; i++) {
    if (!cells[i - 1]) continue;
    const r = cellRectFrac(i);
    fill(data, W, H, rect.x + r.fx * rect.w, rect.y + r.fy * rect.h, r.fw * rect.w, r.fh * rect.h, 255, 255, 255);
  }
}
