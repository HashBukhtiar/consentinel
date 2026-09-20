import { paintPatch, symbolColor, framePeriodSymbols } from "../decode/patch";

// Synthetic badge source: overlays REAL-format animated beacon patches onto a
// base video (your webcam) and returns a MediaStream, so the optical decoder
// can be exercised live with zero hardware. Uses the exact painter the decoder
// expects, so a successful decode here proves the whole pixel path.
//
// Symbol period is intentionally slower than the badge default — the decoder
// segments on colour CHANGE rather than a clock, so any period works, and
// slower means the pipeline reliably samples every symbol at typical FPS.
const SYNTH_SYMBOL_MS = 150;

// Synthetic badges advertise opt-in, so the happy path (a decoded id that
// resolves to a clear face) is what you see with zero hardware.
const SYNTH_OPT_IN = true;

export interface SyntheticHandle {
  stream: MediaStream;
  stop: () => void;
}

export function startSynthetic(base: HTMLVideoElement, ids: number[] = [0x4e]): SyntheticHandle {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const t0 = performance.now();
  let raf = 0;
  // captureStream(0) + an explicit requestFrame() after every paint: an
  // automatic-rate capture of an off-DOM canvas feeding a hidden <video> can
  // drop to ~1 fps (measured: 4 frames in 3 s), which makes the beacon look
  // like it changes colour once a second and every frame fails CRC.
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const pushFrame = () => { try { (track.requestFrame ?? (stream as MediaStream & { requestFrame?: () => void }).requestFrame)?.call(track.requestFrame ? track : stream); } catch { /* auto-rate fallback */ } };

  const xs = ids.length === 1 ? [0.5] : ids.map((_, i) => 0.5 + (i - (ids.length - 1) / 2) * 0.33);

  const draw = () => {
    raf = requestAnimationFrame(draw);
    const w = base.videoWidth || 640, h = base.videoHeight || 360;
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
    if (base.videoWidth) ctx.drawImage(base, 0, 0, w, h);
    else { ctx.fillStyle = "#111"; ctx.fillRect(0, 0, w, h); }

    const s = Math.floor((performance.now() - t0) / SYNTH_SYMBOL_MS) % framePeriodSymbols;
    const pw = Math.round(w * 0.22), ph = Math.round((pw * 3) / 4); // aspect = 4:3
    ids.forEach((id, i) => {
      const px = Math.round(xs[i] * w - pw / 2), py = Math.round(h * 0.68);
      const img = ctx.createImageData(pw, ph);
      paintPatch(img.data, pw, ph, { x: 0, y: 0, w: pw, h: ph }, symbolColor(id, SYNTH_OPT_IN, s));
      ctx.putImageData(img, px, py);
    });
    pushFrame();
  };
  draw();

  return {
    stream,
    stop: () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); },
  };
}
