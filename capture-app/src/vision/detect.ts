import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { flags } from "../config/flags";

// MediaPipe BlazeFace (short-range). Detection only — NO identity matching,
// NO face DB (§4.2). Assets are served locally from /public (run `npm run setup`)
// so the demo never depends on venue wifi.
export async function createDetector(): Promise<FaceDetector> {
  const fileset = await FilesetResolver.forVisionTasks("/wasm");
  const opts = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: "/models/blaze_face_short_range.tflite", delegate },
    runningMode: "VIDEO" as const,
    minDetectionConfidence: 0.5,
  });
  try {
    return await FaceDetector.createFromOptions(fileset, opts("GPU"));
  } catch {
    return await FaceDetector.createFromOptions(fileset, opts("CPU"));
  }
}

export interface RawFace { x: number; y: number; w: number; h: number } // normalized

// The short-range model sees a 128 px letterbox of whatever it is given, so a
// small face needs a bigger share of the picture: a second pass on one 60%
// quadrant per frame (rotating) makes a face 2 m behind the wearer 1.7x bigger.
const TILE = 0.6;
const TILES: readonly (readonly [number, number])[] = [[0, 0], [1 - TILE, 0], [0, 1 - TILE], [1 - TILE, 1 - TILE]];
let tileCanvas: HTMLCanvasElement | null = null;
let frameN = 0;

const iou = (a: RawFace, b: RawFace): number => {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
};

// tMs must be strictly increasing (use performance.now()); the tile pass uses tMs + 0.5.
export function detectFaces(det: FaceDetector, src: HTMLCanvasElement, tMs: number): RawFace[] {
  const W = src.width, H = src.height;
  const faces: RawFace[] = det.detectForVideo(src, tMs).detections.map((d) => {
    const b = d.boundingBox!;
    return { x: b.originX / W, y: b.originY / H, w: b.width / W, h: b.height / H };
  });
  if (!flags.DETECT_TILES) return faces;
  const [fx, fy] = TILES[frameN++ % TILES.length];
  const rx = Math.round(fx * W), ry = Math.round(fy * H), rw = Math.round(TILE * W), rh = Math.round(TILE * H);
  tileCanvas ??= document.createElement("canvas");
  if (tileCanvas.width !== rw || tileCanvas.height !== rh) { tileCanvas.width = rw; tileCanvas.height = rh; }
  tileCanvas.getContext("2d")!.drawImage(src, rx, ry, rw, rh, 0, 0, rw, rh);
  for (const d of det.detectForVideo(tileCanvas, tMs + 0.5).detections) {
    const b = d.boundingBox!;
    const f: RawFace = { x: (rx + b.originX) / W, y: (ry + b.originY) / H, w: b.width / W, h: b.height / H };
    if (!faces.some((g) => iou(f, g) > 0.4)) faces.push(f); // the full-frame pass already has it
  }
  return faces;
}
