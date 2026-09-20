import { FaceDetector } from "@mediapipe/tasks-vision";
import { createDetector, detectFaces, type RawFace } from "../vision/detect";
import { RemoteVision } from "../vision/remote";
import { Tracker } from "../vision/track";
import { associate } from "../vision/associate";
import { pixelate, pixelateAll, clearWindow } from "../vision/blur";
import { decide } from "../consent/decide";
import { FilmEmitter } from "../events/filmEvent";
import { consentRequester } from "../events/consentRequest";
import { decodeBeacons as stubDecode } from "../stubs/decodeBeacons";
import { decodeBeacons as opticalDecode, decodeBeaconsRemote, heldBeacons, lastDebug, type BeaconDebug } from "../decode/beacon";
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
  stageMs: Record<string, number>; // smoothed per-stage cost of the last frames (grab, detect, decode, blur, total)
  vision: string; // which engines are looking at the frame right now (sidecar YOLO, or in-browser fallback)
}

// The hot loop. Order: draw → detect → track → decode beacons → associate →
// decide (fail-safe) → request → blur/composite → emit FilmEvents. Never awaits
// network or chain; the only async is one-time detector init.
export class Pipeline {
  private detector!: FaceDetector;
  private remote: RemoteVision | null = null; // the YOLO sidecar, when enabled (falls back per frame when it is down)
  private tracker = new Tracker();
  private emitter: FilmEmitter;
  private detectCanvas = document.createElement("canvas");
  private sampleCanvas = document.createElement("canvas"); // native-res crop for fine beacon sampling
  private sendCanvas = document.createElement("canvas"); // the frame the sidecar gets, when VISION_WIDTH differs from PROCESS_WIDTH
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
  // exponentially smoothed per-stage cost, ms — shown in the debug HUD
  private stageMs: Record<string, number> = {};
  private timed<T>(name: string, fn: () => T): T {
    const t0 = performance.now();
    const r = traceStage(name, fn);
    const ms = performance.now() - t0;
    this.stageMs[name] = (this.stageMs[name] ?? ms) * 0.8 + ms * 0.2;
    return r;
  }

  constructor(
    private video: HTMLVideoElement,
    private display: HTMLCanvasElement,
    private onState: (s: PipelineState) => void,
    onFilm: (e: FilmEvent) => void,
  ) {
    this.emitter = new FilmEmitter(onFilm);
  }

  async start(): Promise<void> {
    this.detector = await createDetector(); // the in-browser fallback stays loaded even with the sidecar up
    if (flags.VISION_REMOTE) this.remote = new RemoteVision();
    this.running = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.remote?.close();
    this.remote = null;
  }

  private visionLabel(remote: RemoteVision | null): string {
    if (remote) return `sidecar yolov8x-face + badge-key · rtt ${remote.rttMs.toFixed(0)} ms`;
    if (this.remote) return `sidecar down (${flags.VISION_URL}) → in-browser blazeface + classical`;
    return "in-browser blazeface + classical";
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
    const tGrab = performance.now();
    pctx.drawImage(v, 0, 0, procW, procH);
    const imageData = pctx.getImageData(0, 0, procW, procH); // A's decoder reads this
    const fp = fingerprint(imageData);
    const tMs = performance.now();
    if (fp === this.lastFingerprint && tMs - this.lastRunAt < 500) return; // same video frame: keep the composite
    this.lastFingerprint = fp;
    this.lastRunAt = tMs;
    this.stageMs.grab = (this.stageMs.grab ?? 0) * 0.8 + (tMs - tGrab) * 0.2;
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
      // cap the crop, keeping its aspect (a stretched crop would mis-place every segment sample)
      const k = Math.min(1, 480 / sw, 320 / sh);
      const dw = Math.max(1, Math.round(sw * k)), dh = Math.max(1, Math.round(sh * k));
      this.sampleCanvas.width = dw; this.sampleCanvas.height = dh;
      sctx.drawImage(v, nx * vW, ny * vH, sw, sh, 0, 0, dw, dh);
      return sctx.getImageData(0, 0, dw, dh);
    };

    const optical = flags.BEACON_DECODER === "optical";
    // The sidecar: offer it this frame (dropped if one is still in flight) and take
    // whatever result has come back. Between results the tracks stand as they are
    // (≤ one round trip, ~2 frames, stale) and the decoder's holds keep ticking.
    const remote = this.remote?.connected ? this.remote : null;
    if (remote) {
      const sendW = flags.VISION_WIDTH ? Math.min(flags.VISION_WIDTH, v.videoWidth) : procW;
      let canvas = this.detectCanvas;
      if (sendW !== procW) {
        const sendH = Math.round((sendW * v.videoHeight) / v.videoWidth);
        if (this.sendCanvas.width !== sendW || this.sendCanvas.height !== sendH) { this.sendCanvas.width = sendW; this.sendCanvas.height = sendH; }
        this.sendCanvas.getContext("2d")!.drawImage(v, 0, 0, sendW, sendH);
        canvas = this.sendCanvas;
      }
      remote.submit(canvas, tMs);
    }
    const res = remote ? remote.take() : null;
    if (remote) { this.stageMs.sidecar = remote.rttMs; delete this.stageMs.detect; } else delete this.stageMs.sidecar; // the HUD shows only what runs
    let beacons: BeaconReading[] = [];
    const runStages = (): Track[] => {
      let faces: RawFace[] | null = null;
      if (remote) { if (res) faces = res.faces.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h })); }
      else faces = this.timed("detect", () => detectFaces(this.detector, this.detectCanvas, tMs));
      const tracks = traceStage("track", () => (faces ? this.tracker.update(faces) : this.tracker.current()));
      beacons = this.timed("decode", () => (
        !optical ? stubDecode(imageData, tMs)
          : remote ? (res ? decodeBeaconsRemote(res, procW, procH, tMs) : heldBeacons(procW, procH, tMs))
            : opticalDecode(imageData, tMs, sampleRegion)));
      traceStage("associate", () => associate(tracks, beacons, tMs));
      traceStage("decide", () => decide(tracks, getConsent, tMs)); // sync read of the Solana-synced cache
      // the badge's A button, over light: relay a consent bit that disagrees with the chain (debounced, fire-and-forget)
      traceStage("request", () => { for (const b of beacons) if (b.optIn !== undefined) consentRequester.observe(b.beaconId, b.optIn, getConsent(b.beaconId)); });
      this.timed("blur", () => {
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
    const now = performance.now();
    this.stageMs.total = (this.stageMs.total ?? 0) * 0.8 + (now - tGrab) * 0.2;
    drawOverlay(dctx, dispW, dispH, tracks, beacons, optical ? lastDebug : null, flags.BEACON_DEBUG, this.stageMs, this.visionLabel(remote));

    const dt = now - this.lastT; this.lastT = now;
    this.fps = this.fps * 0.9 + (1000 / Math.max(1, dt)) * 0.1;
    if (this.tick++ % 6 === 0) {
      this.onState({ fps: Math.round(this.fps), tracks: tracks.map((t) => ({ ...t })), beacons, debug: optical ? lastDebug : null, procWidth: procW, stageMs: { ...this.stageMs }, vision: this.visionLabel(remote) });
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
  tracks: Track[], beacons: BeaconReading[], dbg: BeaconDebug | null, debug: boolean, stageMs: Record<string, number> = {}, vision = "",
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
      const why = c.label !== undefined
        ? c.label
        : c.confident
          ? ALPHABET_NAMES[c.symbol!]
          : c.borderLum <= flags.BEACON_MIN_BORDER ? "ring too dim" : c.borderLum >= 250 ? "clipped to white — lower badge BRIGHT / room light" : "no clear symbol";
      label(b.x * sx, b.y * sy, c.label !== undefined ? `${Math.round(b.w)}px · ${why}` : `${Math.round(b.w)}px · ring ${Math.round(c.borderLum)} · ${why}`, c.confident ? "#f5b942" : "#ff5c72");
    }
    for (const t of dbg.tracks) {
      if (t.lastId === null) label(t.cx * sx - 30, t.cy * sy + 18, "reading…", "#f5b942");
    }
    const mode = flags.BEACON_OPTICAL_MODE;
    const n = dbg.candidates.length;
    const noun = mode === "key" ? "key candidate" : "blinking region";
    const none = mode === "key" ? " — no badge key in frame: START the beacon (three big digits), face the camera, closer"
      : mode === "seq" ? " — nothing blinking: START the beacon, hold it still, closer"
        : (dbg.bright < 0.002 ? " — no bright ring: closer / START the beacon / dimmer room" : " — bright blobs but none 4:3 with a white ring");
    const hud = `decode ${dbg.width}px · ${mode} · ${n} ${noun}${n === 1 ? "" : "s"}${n === 0 ? none : ""}${dbg.ms !== undefined ? ` · ${dbg.ms.toFixed(0)} ms` : ""}`;
    label(8, H - 8, hud, "#e6ebf5");
    // where the frame time goes (smoothed): the answer to "why is it slow?"
    const cost = ["grab", "detect", "decode", "blur", "total", "sidecar"].filter((k) => stageMs[k] !== undefined).map((k) => `${k} ${stageMs[k].toFixed(0)}`).join(" · ");
    if (cost) label(8, H - 26, `ms/frame: ${cost}`, "#e6ebf5");
    if (vision) label(8, H - 44, `vision: ${vision}`, vision.startsWith("sidecar yolo") ? "#37d67a" : "#f5b942");
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
