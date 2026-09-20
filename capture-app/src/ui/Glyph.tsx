import { SEG7 } from "@shared/beacon";

// A badge id drawn the way the badge itself draws it: seven-segment hex glyphs
// on the black display, inside the white ring the decoder localizes on. Lit
// segments take the consent colour the badge would show; unlit ones stay as the
// faint ghosts of a real display. Geometry is the firmware's cell (10 x 18, t=2).
const W = 10, H = 18, T = 2, HALF = (H - 3 * T) / 2;
const RECTS: [number, number, number, number][] = [
  [T, 0, W - 2 * T, T],          // a  top
  [W - T, T, T, HALF],           // b  top-right
  [W - T, T + HALF + T, T, HALF],// c  bottom-right
  [T, H - T, W - 2 * T, T],      // d  bottom
  [0, T + HALF + T, T, HALF],    // e  bottom-left
  [0, T, T, HALF],               // f  top-left
  [T, T + HALF, W - 2 * T, T],   // g  middle
];
const PAD = 3, GAP = 2;

export type GlyphTone = "opt_in" | "opt_out" | "unknown" | "none";

export function Glyph({ id, tone = "unknown", size = 28, title }: { id?: string; tone?: GlyphTone; size?: number; title?: string }) {
  const digits = (id ?? "").toUpperCase().slice(0, 2).padStart(2, " ").split("");
  const vw = PAD * 2 + W * 2 + GAP, vh = PAD * 2 + H;
  return (
    <svg className={"glyph tone-" + tone} viewBox={`0 0 ${vw} ${vh}`} height={size} width={(size * vw) / vh}
      role="img" aria-label={title ?? (id ? `badge ${id}` : "no badge")}>
      <rect className="disp" x="0.5" y="0.5" width={vw - 1} height={vh - 1} rx="1.5" />
      {digits.map((ch, i) => {
        const n = parseInt(ch, 16);
        const mask = Number.isNaN(n) ? 0 : SEG7[n];
        const ox = PAD + i * (W + GAP);
        return RECTS.map(([x, y, w, h], s) => (
          <rect key={`${i}-${s}`} className={mask & (1 << s) ? "lit" : "off"} x={ox + x} y={PAD + y} width={w} height={h} rx="0.35" />
        ));
      })}
    </svg>
  );
}
