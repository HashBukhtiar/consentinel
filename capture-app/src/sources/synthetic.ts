import { paintPatch, symbolCells } from "../decode/patch";

// Synthetic badge source: overlays REAL-format animated beacon patches onto a
// base video (your webcam) and returns a MediaStream, so the optical decoder
// can be exercised live with zero hardware. Uses the exact painter the decoder
// expects, so a successful decode here proves the whole pixel path.
//
// Symbol period is intentionally slower than the badge default — the decoder
// recovers the clock from the clock lane, so any period works, and slower means
// the pipeline reliably samples every symbol at typical FPS.
const SYNTH_SYMBOL_MS = 150;

export interface SyntheticHandle {
  stream: MediaStream;
  stop: () => void;
}

export function startSynthetic(base: HTMLVideoElement, ids: number[] = [0x4e]): SyntheticHandle {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const t0 = performance.now();
  let raf = 0;

  const xs = ids.length === 1 ? [0.5] : ids.map((_, i) => 0.5 + (i - (ids.length - 1) / 2) * 0.33);

  const draw = () => {
    raf = requestAnimationFrame(draw);
    const w = base.videoWidth || 640, h = base.videoHeight || 360;
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
    if (base.videoWidth) ctx.drawImage(base, 0, 0, w, h);
    else { ctx.fillStyle = "#111"; ctx.fillRect(0, 0, w, h); }

    const s = Math.floor((performance.now() - t0) / SYNTH_SYMBOL_MS) % 3; // current symbol
    const pw = Math.round(w * 0.22), ph = Math.round(pw / 2.3); // aspect ≈ 2.3
    ids.forEach((id, i) => {
      const px = Math.round(xs[i] * w - pw / 2), py = Math.round(h * 0.68);
      const img = ctx.createImageData(pw, ph);
      paintPatch(img.data, pw, ph, { x: 0, y: 0, w: pw, h: ph }, symbolCells(id, s));
      ctx.putImageData(img, px, py);
    });
  };
  draw();

  const stream = canvas.captureStream(30);
  return {
    stream,
    stop: () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); },
  };
}
