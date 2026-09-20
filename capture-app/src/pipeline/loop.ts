import { FaceDetector } from "@mediapipe/tasks-vision";
import { createDetector, detectFaces } from "../vision/detect";
import { Tracker } from "../vision/track";
import { associate } from "../vision/associate";
import { pixelateAll, clearWindow } from "../vision/blur";
import { decide } from "../consent/decide";
import { guardBeacons } from "../consent/antiSpoof";
import { FilmEmitter } from "../events/filmEvent";
import { decodeBeacons as stubDecode } from "../stubs/decodeBeacons";
import { decodeBeacons as opticalDecode } from "../decode/beacon";
import { getConsent } from "../consent/store";
import { flags } from "../config/flags";
import { obsEnabled, traceFrame, traceStage, logConsent } from "../obs/sentry";
import type { FilmEvent, Track } from "../shared/schema";

export interface PipelineState { fps: number; tracks: Track[] }

// The hot loop. Order: draw → detect → track → decode beacons → associate →
// decide (fail-safe) → blur/composite → emit FilmEvents. Never awaits network
// or chain; the only async is one-time detector init.
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

    // native-res crop of a normalized region — the optical decoder localizes on
    // the coarse procW frame but samples cells from this (many more px/cell far away)
    const sctx = this.sampleCanvas.getContext("2d")!;
    const sampleRegion = (nx: number, ny: number, nw: number, nh: number): ImageData | null => {
      const vW = v.videoWidth, vH = v.videoHeight;
      const sw = Math.round(nw * vW), sh = Math.round(nh * vH);
      if (sw < 8 || sh < 4) return null;
      const dw = Math.min(320, sw), dh = Math.min(200, sh);
      this.sampleCanvas.width = dw; this.sampleCanvas.height = dh;
      sctx.drawImage(v, nx * vW, ny * vH, sw, sh, 0, 0, dw, dh);
      return sctx.getImageData(0, 0, dw, dh);
    };

    const runStages = (): Track[] => {
      const faces = traceStage("detect", () => detectFaces(this.detector, this.detectCanvas, tMs));
      const tracks = traceStage("track", () => this.tracker.update(faces));
      const imageData = pctx.getImageData(0, 0, procW, procH); // A's decoder reads this
      const decoded = traceStage("decode", () =>
        flags.BEACON_DECODER === "optical"
          ? opticalDecode(imageData, tMs, sampleRegion)
          : stubDecode(imageData, tMs));
      // A decoded id is not yet a believed id: the patch is forgeable, so drop
      // readings that behave like a screen being cycled rather than a badge.
      const beacons = traceStage("anti-spoof", () => guardBeacons(decoded, tMs));
      traceStage("associate", () => associate(tracks, beacons, tMs));
      traceStage("decide", () => decide(tracks, getConsent, tMs)); // sync read of the Solana-synced cache
      traceStage("blur+notify", () => {
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
