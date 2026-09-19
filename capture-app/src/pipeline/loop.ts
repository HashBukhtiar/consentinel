import { FaceDetector } from "@mediapipe/tasks-vision";
import { createDetector, detectFaces } from "../vision/detect";
import { Tracker } from "../vision/track";
import { associate } from "../vision/associate";
import { pixelate } from "../vision/blur";
import { decide } from "../consent/decide";
import { FilmEmitter } from "../events/filmEvent";
import { decodeBeacons as stubDecode } from "../stubs/decodeBeacons";
import { decodeBeacons as opticalDecode } from "../decode/beacon";
import { getConsent } from "../consent/store";
import { flags } from "../config/flags";
import { obsEnabled, traceFrame, traceStage, logConsent } from "../obs/sentry";
import type { FilmEvent, Track } from "../shared/schema";

// stub (fixed beacons) vs optical (real decode) — read live so a UI/source can
// flip flags.BEACON_DECODER at runtime (e.g. synthetic-badge mode).
const decodeBeacons = (frame: ImageData, tMs: number) =>
  (flags.BEACON_DECODER === "optical" ? opticalDecode : stubDecode)(frame, tMs);

export interface PipelineState { fps: number; tracks: Track[] }

// The hot loop. Order: draw → detect → track → decode beacons → associate →
// decide (fail-safe) → blur/composite → emit FilmEvents. Never awaits network
// or chain; the only async is one-time detector init.
export class Pipeline {
  private detector!: FaceDetector;
  private tracker = new Tracker();
  private emitter: FilmEmitter;
  private detectCanvas = document.createElement("canvas");
  private running = false;
  private raf = 0;
  private lastT = 0;
  private fps = 0;
  private tick = 0;
  private frameN = 0;
  private lastLogged = new Map<string, string>(); // trackId → last-logged decision

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
    const pctx = this.detectCanvas.getContext("2d")!;
    dctx.drawImage(v, 0, 0, dispW, dispH);
    pctx.drawImage(v, 0, 0, procW, procH);

    const tMs = performance.now();
    // trace ~once/sec: a span tree over the stages, never every frame (120fps)
    const doTrace = obsEnabled() && this.frameN++ % 60 === 0;

    const runStages = (): Track[] => {
      const faces = traceStage("detect", () => detectFaces(this.detector, this.detectCanvas, tMs));
      const tracks = traceStage("track", () => this.tracker.update(faces));
      const imageData = pctx.getImageData(0, 0, procW, procH); // A's decoder reads this
      const beacons = traceStage("decode", () => decodeBeacons(imageData, tMs));
      traceStage("associate", () => associate(tracks, beacons));
      traceStage("decide", () => decide(tracks, getConsent)); // sync read of the Solana-synced cache
      traceStage("blur+notify", () => {
        for (const t of tracks) {
          if (t.blurred) {
            const px = clampBox(t.bbox, dispW, dispH, flags.BLUR_PAD);
            pixelate(dctx, px.x, px.y, px.w, px.h, flags.PIXELATE_SIZE);
          }
          if (t.beaconId && t.consent === "opt_out") this.emitter.maybeEmit(t.beaconId);
        }
      });
      return tracks;
    };

    const tracks = doTrace ? traceFrame(runStages) : runStages();
    this.logDecisions(tracks);

    const now = performance.now();
    const dt = now - this.lastT; this.lastT = now;
    this.fps = this.fps * 0.9 + (1000 / Math.max(1, dt)) * 0.1;
    if (this.tick++ % 6 === 0) {
      this.onState({ fps: Math.round(this.fps), tracks: tracks.map((t) => ({ ...t })) });
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

// normalized bbox → padded, clamped device-px box
function clampBox(b: Track["bbox"], W: number, H: number, pad: number) {
  let x = (b.x - (b.w * pad) / 2) * W;
  let y = (b.y - (b.h * pad) / 2) * H;
  let w = b.w * (1 + pad) * W;
  let h = b.h * (1 + pad) * H;
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(w, W - x); h = Math.min(h, H - y);
  return { x, y, w, h };
}
