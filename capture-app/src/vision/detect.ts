import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";

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

// tMs must be strictly increasing (use performance.now()).
export function detectFaces(det: FaceDetector, src: HTMLCanvasElement, tMs: number): RawFace[] {
  const res = det.detectForVideo(src, tMs);
  const W = src.width, H = src.height;
  return res.detections.map((d) => {
    const b = d.boundingBox!;
    return { x: b.originX / W, y: b.originY / H, w: b.width / W, h: b.height / H };
  });
}
