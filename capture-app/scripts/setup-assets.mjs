// Fetch MediaPipe assets into public/ so the app runs offline at the venue.
// Copies the version-matched wasm from node_modules and downloads the model.
import { cp, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";

const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

await mkdir("public/wasm", { recursive: true });
await mkdir("public/models", { recursive: true });

await cp("node_modules/@mediapipe/tasks-vision/wasm", "public/wasm", { recursive: true });
console.log("copied wasm → public/wasm");

const res = await fetch(MODEL);
if (!res.ok) throw new Error(`model download failed: ${res.status}`);
await new Promise((ok, no) =>
  Readable.fromWeb(res.body).pipe(createWriteStream("public/models/blaze_face_short_range.tflite"))
    .on("finish", ok).on("error", no),
);
console.log("downloaded model → public/models/blaze_face_short_range.tflite");
console.log("assets ready.");
