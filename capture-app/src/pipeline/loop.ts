import { FaceDetector } from "@mediapipe/tasks-vision";
import { createDetector, detectFaces } from "../vision/detect";
import { Tracker } from "../vision/track";
import { associate } from "../vision/associate";
import { pixelate, pixelateAll, clearWindow } from "../vision/blur";
import { decide } from "../consent/decide";
import { FilmEmitter } from "../events/filmEvent";
import { consentRequester } from "../events/consentRequest";
import { decodeBeacons as stubDecode } from "../stubs/decodeBeacons";
import { decodeBeacons as opticalDecode, lastDebug, type BeaconDebug } from "../decode/beacon";
import { getConsent } from "../consent/store";
import { flags } from "../config/flags";
import { obsEnabled, traceFrame, traceStage, logConsent } from "../obs/sentry";
import { ALPHABET_NAMES } from "@shared/beacon";
import type { BeaconReading, FilmEvent, Track } from "../shared/schema";

export interface PipelineState {
  fps: number;
  tracks: Track[];
  beacons: BeaconReading[]; // decoded this frame (confirmed ids), before association
  debug: BeaconDebug | null; // optical decoder diagnostics (null for the stub)
  procWidth: number;
}

// The hot loop. Order: draw → detect → track → decode beacons → associate →
// decide (fail-safe) → request → blur/composite → emit FilmEvents. Never awaits
// network or chain; the only async is one-time detector init.
export class Pipeline {
  private detector!: FaceDetector;
  private tracker = new Tracker();
  private emitter: FilmEmitter;
  private detectCanvas = document.createElement("canvas");
  private sampleCanvas = document.createElement("canvas"); // native-res crop for fine beacon sampling
  private running = false;
  private raf = 0;
  private lastT = 0;
  private fps = 0;
  private tick = 0;
  private frameN = 0;
  private lastLogged = new Map<string, string>(); // trackId → last-logged decision
  // Run the stages once per *video* frame, not per display refresh: a 90 fps
  // rAF loop over a 30 fps camera/clip would feed the decoder every frame three
  // times, which burns CPU and makes its per-frame miss counters (tuned at the
  // video rate, same as scripts/tune.ts) expire three times too fast. Neither
  // requestVideoFrameCallback nor getVideoPlaybackQuality is reliable for a
  // hidden <video>, so we fingerprint the pixels we grab anyway: same bytes ⇒
  // same frame ⇒ skip. A 500 ms valve guarantees the loop never stalls.
  private lastFingerprint = -1;
  private lastRunAt = 0;

  constructor(
    private video: HTMLVideoElement,
    private display: HTMLCanvasElement,
    private onState: (s: PipelineState) => void,
    onFilm: (e: FilmEvent) => void,
  ) {
    this.emitter = new FilmEmitter(onFilm);
  }

  async start(): Promise<void> {
    this.detector = await createDetector();
    this.running = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private loop = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const v = this.video;
    if (!v.videoWidth) return; // not ready yet

    const dispW = Math.min(flags.DISPLAY_MAX_WIDTH, v.videoWidth);
    const dispH = Math.round((dispW * v.videoHeight) / v.videoWidth);
    if (this.display.width !== dispW) { this.display.width = dispW; this.display.height = dispH; }

    const procW = flags.PROCESS_WIDTH;
    const procH = Math.round((procW * v.videoHeight) / v.videoWidth);
    if (this.detectCanvas.width !== procW) { this.detectCanvas.width = procW; this.detectCanvas.height = procH; }

    const dctx = this.display.getContext("2d")!;
    const pctx = this.detectCanvas.getContext("2d", { willReadFrequently: true })!; // getImageData every frame
    pctx.drawImage(v, 0, 0, procW, procH);
    const imageData = pctx.getImageData(0, 0, procW, procH); // A's decoder reads this
    const fp = fingerprint(imageData);
    const tMs = performance.now();
    if (fp === this.lastFingerprint && tMs - this.lastRunAt < 500) return; // same video frame: keep the composite
    this.lastFingerprint = fp;
    this.lastRunAt = tMs;
    dctx.drawImage(v, 0, 0, dispW, dispH);

    // trace ~once/sec: a span tree over the stages, never every frame (120fps)
    const doTrace = obsEnabled() && this.frameN++ % 60 === 0;

    // native-res crop of a normalized region — the optical decoder localizes on
    // the coarse procW frame but samples the symbol from this (many more px far away)
    const sctx = this.sampleCanvas.getContext("2d", { willReadFrequently: true })!;
    const sampleRegion = (nx: number, ny: number, nw: number, nh: number): ImageData | null => {
      const vW = v.videoWidth, vH = v.videoHeight;
      const sw = Math.round(nw * vW), sh = Math.round(nh * vH);
      if (sw < 8 || sh < 4) return null;
      const dw = Math.min(320, sw), dh = Math.min(200, sh);
      this.sampleCanvas.width = dw; this.sampleCanvas.height = dh;
      sctx.drawImage(v, nx * vW, ny * vH, sw, sh, 0, 0, dw, dh);
      return sctx.getImageData(0, 0, dw, dh);
    };

    const optical = flags.BEACON_DECODER === "optical";
    let beacons: BeaconReading[] = [];
    const runStages = (): Track[] => {
      const faces = traceStage("detect", () => detectFaces(this.detector, this.detectCanvas, tMs));
      const tracks = traceStage("track", () => this.tracker.update(faces));
      beacons = traceStage("decode", () => (optical ? opticalDecode(imageData, tMs, sampleRegion) : stubDecode(imageData, tMs)));
      traceStage("associate", () => associate(tracks, beacons, tMs));
      traceStage("decide", () => decide(tracks, getConsent, tMs)); // sync read of the Solana-synced cache
      // the badge's A button, over light: relay a consent bit that disagrees with the chain (debounced, fire-and-forget)
      traceStage("request", () => { for (const b of beacons) if (b.optIn !== undefined) consentRequester.observe(b.beaconId, b.optIn, getConsent(b.beaconId)); });
      traceStage("blur+notify", () => {
        if (flags.COMPOSITE === "frame") {
          // DEFAULT DENY, as a composite: pixelate the WHOLE frame, then punch
          // clear windows only for faces with an explicit opt_in. A face the
          // detector never found (profile, motion blur, far, dark) therefore
          // stays covered instead of rendering in full clarity.
          pixelateAll(dctx, flags.PIXELATE_SIZE);
          for (const t of tracks) {
            // missed > 0 ⇒ this bbox is a stale guess carried from an earlier
            // frame. Clearing there could reveal whoever has moved into it, so
            // a track we lost sight of this frame gets no window.
            if (!t.blurred && t.missed === 0) {
              clearWindow(dctx, v, v.videoWidth, v.videoHeight, t.bbox, flags.CLEAR_INSET);
            }
          }
        } else {
          // FACES ONLY: the classic look — pixelate each detected face that is
          // not opt_in, padded outward. Faces the detector misses are shown.
          for (const t of tracks) {
            if (!t.blurred) continue;
            const px = clampBox(t.bbox, dispW, dispH, flags.BLUR_PAD);
            pixelate(dctx, px.x, px.y, px.w, px.h, flags.PIXELATE_SIZE);
          }
        }
        for (const t of tracks) if (t.beaconId && t.consent === "opt_out") this.emitter.maybeEmit(t.beaconId);
      });
      return tracks;
    };

    const tracks = doTrace ? traceFrame(runStages) : runStages();
    this.logDecisions(tracks);
    drawOverlay(dctx, dispW, dispH, tracks, beacons, optical ? lastDebug : null, flags.BEACON_DEBUG);

    const now = performance.now();
    const dt = now - this.lastT; this.lastT = now;
    this.fps = this.fps * 0.9 + (1000 / Math.max(1, dt)) * 0.1;
    if (this.tick++ % 6 === 0) {
      this.onState({ fps: Math.round(this.fps), tracks: tracks.map((t) => ({ ...t })), beacons, debug: optical ? lastDebug : null, procWidth: procW });
    }
  };

  // Log a consent decision only when a track's outcome changes — meaningful,
  // low-volume (not once per frame). Cleans up entries for dropped tracks.
  private logDecisions(tracks: Track[]): void {
    if (!obsEnabled()) return;
    const live = new Set<string>();
    for (const t of tracks) {
      live.add(t.trackId);
      const key = `${t.beaconId ?? "-"}:${t.consent}:${t.blurred}`;
      if (this.lastLogged.get(t.trackId) !== key) {
        logConsent(t.trackId, t.beaconId, t.consent, t.blurred);
        this.lastLogged.set(t.trackId, key);
      }
    }
    for (const id of [...this.lastLogged.keys()]) if (!live.has(id)) this.lastLogged.delete(id);
  }
}

// normalized bbox → padded, clamped device-px box ("faces" composite)
function clampBox(b: Track["bbox"], W: number, H: number, pad: number) {
  let x = (b.x - (b.w * pad) / 2) * W;
  let y = (b.y - (b.h * pad) / 2) * H;
  let w = b.w * (1 + pad) * W;
  let h = b.h * (1 + pad) * H;
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(w, W - x); h = Math.min(h, H - y);
  return { x, y, w, h };
}

// ~1k pixels sampled on a stride, folded into a 32-bit hash. Identical bytes for
// an unchanged frame; camera noise alone changes it for a new one.
function fingerprint(img: ImageData): number {
  const d = img.data;
  const step = Math.max(4, (d.length >> 10) & ~3);
  let h = 2166136261;
  for (let i = 0; i < d.length; i += step) {
    h = Math.imul(h ^ d[i], 16777619);
    h = Math.imul(h ^ d[i + 1], 16777619);
  }
  return h >>> 0;
}

// What the operator sees on the feed: a green box + id on every decoded badge
// (always — "it sees the badge" is the demo), and in debug mode every
// candidate patch with its ring brightness / classified colour, so "why doesn't
// it decode?" is answered on screen: red = ring found but no clear symbol (too
// small, too dim, clipped to white, off-axis), yellow = reading, green = id.
// Drawn AFTER the default-deny composite so it is visible on top of the blur.
function drawOverlay(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  tracks: Track[], beacons: BeaconReading[], dbg: BeaconDebug | null, debug: boolean,
): void {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.font = "bold 13px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "bottom";
  const label = (x: number, y: number, text: string, color: string) => {
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = "rgba(0,0,0,.7)"; ctx.fillRect(x, y - 16, w, 16);
    ctx.fillStyle = color; ctx.fillText(text, x + 4, y - 2);
  };
  if (debug && dbg && dbg.width) {
    const sx = W / dbg.width, sy = H / dbg.height;
    for (const c of dbg.candidates) {
      const b = c.box;
      ctx.strokeStyle = c.confident ? "#f5b942" : "#ff5c72";
      ctx.strokeRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
      const why = c.confident
        ? ALPHABET_NAMES[c.symbol!]
        : c.borderLum <= flags.BEACON_MIN_BORDER ? "ring too dim" : c.borderLum >= 250 ? "clipped to white — lower badge BRIGHT / room light" : "no clear symbol";
      label(b.x * sx, b.y * sy, `${Math.round(b.w)}px · ring ${Math.round(c.borderLum)} · ${why}`, c.confident ? "#f5b942" : "#ff5c72");
    }
    for (const t of dbg.tracks) {
      if (t.lastId === null) label(t.cx * sx - 30, t.cy * sy + 18, "reading…", "#f5b942");
    }
    const hud = `decode ${dbg.width}px · ${dbg.candidates.length} candidate${dbg.candidates.length === 1 ? "" : "s"} · bright ${(dbg.bright * 100).toFixed(1)}%` +
      (dbg.candidates.length === 0 ? (dbg.bright < 0.002 ? " — no bright ring: closer / START the beacon / dimmer room" : " — bright blobs but none 4:3 with a white ring: face the screen to the camera") : "");
    label(8, H - 8, hud, "#e6ebf5");
  }
  if (dbg && dbg.width) {
    const sx = W / dbg.width, sy = H / dbg.height;
    for (const b of beacons) {
      const bound = tracks.find((t) => t.beaconId === b.beaconId);
      const cx = b.imagePosition.x * W, cy = b.imagePosition.y * H;
      const cand = dbg.candidates.find((c) => Math.abs((c.box.x + c.box.w / 2) * sx - cx) < 40 && Math.abs((c.box.y + c.box.h / 2) * sy - cy) < 40);
      ctx.strokeStyle = "#37d67a";
      if (cand) ctx.strokeRect(cand.box.x * sx - 3, cand.box.y * sy - 3, cand.box.w * sx + 6, cand.box.h * sy + 6);
      else ctx.strokeRect(cx - 24, cy - 12, 48, 24);
      const flag = b.optIn === undefined ? "" : b.optIn ? " · OPT-IN" : " · OPT-OUT";
      label(cand ? cand.box.x * sx - 3 : cx - 24, (cand ? cand.box.y * sy - 3 : cy - 12) - 2, `badge ${b.beaconId}${flag}${bound ? " → " + bound.trackId : " · no face above it"}`, "#37d67a");
    }
  }
  if (debug) {
    for (const t of tracks) {
      ctx.strokeStyle = t.blurred ? "#ff5c72" : "#37d67a";
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(t.bbox.x * W, t.bbox.y * H, t.bbox.w * W, t.bbox.h * H);
      ctx.setLineDash([]);
      label(t.bbox.x * W, t.bbox.y * H, `${t.trackId} ${t.beaconId ?? "no badge"} · ${t.consent}`, t.blurred ? "#ff5c72" : "#37d67a");
    }
  }
  ctx.restore();
}
