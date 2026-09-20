// One-click diagnostic: what does the camera ACTUALLY see? Captures the full
// native frame, then for ~1.2 s samples the coarse (PROCESS_WIDTH) frame every
// 100 ms, runs the real localizer + classifier on the largest candidates, and
// keeps a native-res crop of each with every number the classifier used
// (ring RGB, interior RGB, feature vector, distance to each alphabet colour,
// margin). POSTed to the notify service, which writes it to data/diag/ so a
// teammate (or an agent) can open the images and re-run the decoder offline.
// Nothing here touches the hero path; it only runs when the button is pressed.
import { _internal, rejectReason, decoderStats, lastDebug, type Sampled } from "../decode/beacon";
import { ALPHABET_NAMES, ALPHABET_REFS, beaconFeature, lumaOf } from "@shared/beacon";
import { flags } from "../config/flags";
import type { BeaconReading, Track } from "../shared/schema";

export interface ClassifierDetail {
  symbol: string | null;
  confident: boolean;
  ringLuma: number;
  ref: number[]; // ring RGB (white reference)
  px: number[]; // interior RGB
  feature: number[];
  nearest: { name: string; d: number }[]; // 3 closest alphabet colours
  margin: number; // runner-up / nearest (must be ≥ flags.BEACON_SYMBOL_MARGIN)
}

export interface DiagCandidate {
  box: { x: number; y: number; w: number; h: number };
  aspect: number;
  fill: number;
  reject: string | null;
  coarse: ClassifierDetail;
  fine: ClassifierDetail;
  cropPng?: string; // data URL; the service turns it into a file
}

export interface DiagPayload {
  at: string;
  userAgent: string;
  video: { w: number; h: number };
  procW: number;
  flags: Record<string, unknown>;
  decoderStats: Record<string, number>;
  lastDebug: unknown;
  beacons: BeaconReading[];
  tracks: Track[];
  samples: { tMs: number; components: number; candidates: DiagCandidate[] }[];
  frameJpeg?: string;
}

function detail(s: Sampled): ClassifierDetail {
  const f = beaconFeature(s.px, s.ref);
  const ds = ALPHABET_REFS.map((r, i) => ({ name: ALPHABET_NAMES[i], d: Math.hypot(f[0] - r[0], f[1] - r[1], f[2] - r[2]) })).sort((a, b) => a.d - b.d);
  return {
    symbol: s.symbol === null ? null : ALPHABET_NAMES[s.symbol],
    confident: s.confident,
    ringLuma: Math.round(lumaOf(s.ref)),
    ref: s.ref.map(Math.round),
    px: s.px.map(Math.round),
    feature: f.map((x) => +x.toFixed(3)),
    nearest: ds.slice(0, 3).map((x) => ({ name: x.name, d: +x.d.toFixed(3) })),
    margin: +(ds[1].d / Math.max(1e-9, ds[0].d)).toFixed(2),
  };
}

export async function captureDiagnostic(video: HTMLVideoElement, procW: number, beacons: BeaconReading[], tracks: Track[]): Promise<DiagPayload> {
  const vW = video.videoWidth, vH = video.videoHeight;
  if (!vW) throw new Error("no video frame yet");
  const full = document.createElement("canvas");
  full.width = vW; full.height = vH;
  full.getContext("2d")!.drawImage(video, 0, 0);
  const frameJpeg = full.toDataURL("image/jpeg", 0.88);

  const procH = Math.round((procW * vH) / vW);
  const coarse = document.createElement("canvas");
  coarse.width = procW; coarse.height = procH;
  const cctx = coarse.getContext("2d", { willReadFrequently: true })!;
  const crop = document.createElement("canvas");
  const crctx = crop.getContext("2d", { willReadFrequently: true })!;

  const samples: DiagPayload["samples"] = [];
  const t0 = performance.now();
  for (let k = 0; k < 12; k++) {
    cctx.drawImage(video, 0, 0, procW, procH);
    const img = cctx.getImageData(0, 0, procW, procH);
    const comps = _internal.scanComponents(img).sort((a, b) => b.w - a.w);
    const candidates: DiagCandidate[] = comps.slice(0, 2).map((c) => {
      const nx = c.x / procW, ny = c.y / procH, nw = c.w / procW, nh = c.h / procH;
      const sw = Math.max(1, Math.round(nw * vW)), sh = Math.max(1, Math.round(nh * vH));
      const dw = Math.min(240, sw), dh = Math.max(1, Math.round((dw * sh) / sw));
      crop.width = dw; crop.height = dh;
      crctx.drawImage(video, nx * vW, ny * vH, sw, sh, 0, 0, dw, dh);
      const fine = crctx.getImageData(0, 0, dw, dh);
      return {
        box: { x: c.x, y: c.y, w: c.w, h: c.h },
        aspect: +c.aspect.toFixed(2),
        fill: +c.fill.toFixed(3),
        reject: rejectReason(c, procW),
        coarse: detail(_internal.sampleSymbol(img, { x: c.x, y: c.y, w: c.w, h: c.h })),
        fine: detail(_internal.sampleSymbol(fine, { x: 0, y: 0, w: dw, h: dh })),
        cropPng: k % 2 === 0 ? crop.toDataURL("image/png") : undefined, // every other sample keeps the payload small
      };
    });
    samples.push({ tMs: Math.round(performance.now() - t0), components: comps.length, candidates });
    await new Promise((r) => setTimeout(r, 100));
  }

  const pick = Object.fromEntries(Object.entries(flags).filter(([k]) => /^(BEACON_|PROCESS_WIDTH|BIND_|COMPOSITE)/.test(k)));
  return {
    at: new Date().toISOString(),
    userAgent: navigator.userAgent,
    video: { w: vW, h: vH },
    procW,
    flags: pick,
    decoderStats: { symbols: decoderStats.symbols, anchors: decoderStats.anchors, assembled: decoderStats.assembled, crcOk: decoderStats.crcOk, crcFail: decoderStats.crcFail, confirmed: decoderStats.confirmed },
    lastDebug,
    beacons,
    tracks,
    samples,
    frameJpeg,
  };
}

/** POST to the notify service; returns its one-line summary. */
export async function sendDiagnostic(payload: DiagPayload): Promise<string> {
  let base: string;
  try { base = new URL(flags.SERVICE_WS_URL.replace(/^ws/, "http")).origin; } catch { throw new Error("SERVICE_WS_URL is not set"); }
  const r = await fetch(`${base}/diag`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(flags.SERVICE_TOKEN ? { authorization: `Bearer ${flags.SERVICE_TOKEN}` } : {}) },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return `saved ${j.files} files → ${j.json?.split("/").pop()} · symbols: ${j.symbols}`;
}
