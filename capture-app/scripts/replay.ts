// Replay the REAL optical decoder over a 🎥 diag sequence recorded by the
// capture app (data/diag/<ts>-seq/, see src/diag/snapshot.ts), frame by frame
// with the original timestamps, and print what it would have decoded.
//   npx tsx scripts/replay.ts ../data/diag/<ts>-seq [processWidth]
// Needs ffmpeg on PATH (JPEG → raw RGBA). Prints per frame: accepted
// candidates with their classified symbol, then the decoder's readings and
// funnel counters — the same numbers tune.html shows, on a reproducible input.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _internal, rejectReason, decoderStats } from "../src/decode/beacon";
import { flags } from "../src/config/flags";
import { ALPHABET_NAMES, lumaOf } from "@shared/beacon";
import { remoteKeyFrame } from "../src/decode/remoteKey";
import type { RemoteResult } from "../src/vision/remote";

const dir = process.argv[2];
if (!dir || !existsSync(join(dir, "index.json"))) { console.error("usage: tsx scripts/replay.ts <data/diag/<ts>-seq> [processWidth]"); process.exit(2); }
const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { video: { w: number; h: number }; width: number; frames: { tMs: number; file: string }[] };
const procW = Number(process.argv[3] ?? flags.PROCESS_WIDTH);
const procH = Math.round((procW * index.video.h) / index.video.w);
const tmp = join(tmpdir(), "consentinel-replay.raw");
const load = (file: string, w: number, h: number): ImageData => {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(dir, file), "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgba", tmp]);
  return { data: new Uint8ClampedArray(readFileSync(tmp).buffer.slice(0)), width: w, height: h } as unknown as ImageData;
};
// A recording stored wider than procW (the 🎥 button keeps the camera's native width) also
// feeds the decoder's fine sampler: the same native-res crop the live loop hands it,
// area-averaged down with the loop's aspect-preserving cap (480x320).
const nativeH = Math.round((index.width * index.video.h) / index.video.w);
const makeSampler = (native: ImageData) => (nx: number, ny: number, nw: number, nh: number): ImageData | null => {
  const vW = native.width, vH = native.height;
  const sx = Math.round(nx * vW), sy = Math.round(ny * vH), sw = Math.round(nw * vW), sh = Math.round(nh * vH);
  if (sw < 8 || sh < 4) return null;
  const k = Math.min(1, 480 / sw, 320 / sh);
  const dw = Math.max(1, Math.round(sw * k)), dh = Math.max(1, Math.round(sh * k));
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const x0 = sx + Math.floor((x * sw) / dw), x1 = sx + Math.max(Math.floor(((x + 1) * sw) / dw), Math.floor((x * sw) / dw) + 1);
    const y0 = sy + Math.floor((y * sh) / dh), y1 = sy + Math.max(Math.floor(((y + 1) * sh) / dh), Math.floor((y * sh) / dh) + 1);
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < Math.min(vH, y1); yy++) for (let xx = x0; xx < Math.min(vW, x1); xx++) { const o = (yy * vW + xx) * 4; r += native.data[o]; g += native.data[o + 1]; b += native.data[o + 2]; n++; }
    const o = (y * dw + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
  }
  return { data: out, width: dw, height: dh } as unknown as ImageData;
};
const fine = process.env.REPLAY_FINE !== "0" && index.width > procW;

// REPLAY_REMOTE=1: the frames go to the vision sidecar (vision/server.py, YOLO) instead
// of the classical engine, and its readings run through the same confirm/hold logic.
if (process.env.REPLAY_REMOTE === "1") {
  const url = process.env.VISION_URL ?? "ws://127.0.0.1:8765";
  const ws = new WebSocket(url);
  await new Promise<void>((ok, bad) => { ws.onopen = () => ok(); ws.onerror = () => bad(new Error(`cannot reach ${url} — start vision/server.py`)); });
  const ask = (jpeg: Buffer, tMs: number): Promise<RemoteResult> => new Promise((ok) => {
    ws.onmessage = (ev) => { const r = JSON.parse(String(ev.data)) as RemoteResult; r.receivedMs = 0; ok(r); };
    const buf = new ArrayBuffer(8 + jpeg.byteLength);
    new DataView(buf).setFloat64(0, tMs, true);
    new Uint8Array(buf, 8).set(jpeg);
    ws.send(buf);
  });
  console.log(`${index.frames.length} frames, stored ${index.width}px wide → sidecar ${url} · CONFIRM_N=${flags.KEY_CONFIRM_N}`);
  const dec = _internal.newKeyDecoder();
  const seen = new Map<string, number>();
  let firstAt = -1, ms = 0, faces = 0, wrong = 0;
  for (const fr of index.frames) {
    const r = await ask(readFileSync(join(dir, fr.file)), fr.tMs);
    const kf = remoteKeyFrame(r, r.w, r.h);
    const out = dec.ingest(kf.fits, kf.seen, r.w, r.h, fr.tMs, kf.candidates, r.ms.keys);
    ms += r.ms.total; faces += r.faces.length;
    for (const o of out) { seen.set(o.beaconId, (seen.get(o.beaconId) ?? 0) + 1); if (firstAt < 0) firstAt = fr.tMs; }
    const desc = kf.candidates.slice(0, 3).map((c) => `${Math.round(c.box.w)}x${Math.round(c.box.h)} ${c.status}`);
    console.log(`t=${String(fr.tMs).padStart(5)}  faces=${r.faces.length} ${desc.join(" | ") || "-"}${out.length ? "   ⇒ " + out.map((o) => `${o.beaconId} ${o.optIn ? "OPT-IN" : "OPT-OUT"}`).join(",") : ""}`);
  }
  ws.close();
  console.log(`\nreadings: ${[...seen.entries()].map(([id, n]) => `${id}×${n}`).join(", ") || "NONE"}${firstAt >= 0 ? ` (first at ${firstAt} ms)` : ""} · avg sidecar ${(ms / index.frames.length).toFixed(1)} ms · avg faces ${(faces / index.frames.length).toFixed(1)}`);
  process.exit(0);
}

if (flags.BEACON_OPTICAL_MODE === "key") {
  // the static-key engine: per frame, the largest candidates with the decoder's own verdict
  console.log(`${index.frames.length} frames, stored ${index.width}px wide, decoding at ${procW}x${procH}${fine ? ` + fine sampler from ${index.width}px` : ""} · engine key · MIN_W=${flags.KEY_MIN_W} MARGIN=${flags.KEY_MARGIN} CONFIRM_N=${flags.KEY_CONFIRM_N}`);
  const dec = _internal.newKeyDecoder();
  const seen = new Map<string, number>();
  let firstAt = -1, ms = 0;
  for (const fr of index.frames) {
    const f = load(fr.file, procW, procH);
    const sampler = fine ? makeSampler(load(fr.file, index.width, nativeH)) : undefined;
    const out = dec.decode(f, fr.tMs, sampler);
    ms += dec.debug.ms;
    for (const r of out) { seen.set(r.beaconId, (seen.get(r.beaconId) ?? 0) + 1); if (firstAt < 0) firstAt = fr.tMs; }
    const desc = dec.debug.candidates.filter((c) => !c.status.startsWith("too small")).slice(0, 3).map((c) => `${c.box.w}x${c.box.h} ${c.status}`);
    console.log(`t=${String(fr.tMs).padStart(5)}  ${desc.join(" | ") || "-"}${out.length ? "   ⇒ " + out.map((r) => `${r.beaconId} ${r.optIn ? "OPT-IN" : "OPT-OUT"}`).join(",") : ""}`);
  }
  console.log(`\nreadings: ${[...seen.entries()].map(([id, n]) => `${id}×${n}`).join(", ") || "NONE"}${firstAt >= 0 ? ` (first at ${firstAt} ms)` : ""} · avg decode ${(ms / index.frames.length).toFixed(1)} ms`);
  process.exit(0);
}
console.log(`${index.frames.length} frames, stored ${index.width}px wide, decoding at ${procW}x${procH} · WHITE_T=${flags.BEACON_WHITE_T} MIN_BORDER=${flags.BEACON_MIN_BORDER} MARGIN=${flags.BEACON_SYMBOL_MARGIN} CONFIRM_MS=${flags.BEACON_CONFIRM_MS}`);
decoderStats.reset();
const dec = _internal.newDecoder();
const seen = new Map<string, number>();
let firstAt = -1;
for (const fr of index.frames) {
  const f = load(fr.file, procW, procH);
  const comps = _internal.scanComponents(f);
  const acc = comps.filter((c) => rejectReason(c, procW) === null);
  const desc = acc.map((c) => {
    const s = _internal.sampleSymbol(f, c, c.ref);
    return `${c.w}x${c.h} ring${Math.round(lumaOf(c.ref))} ${s.symbol === null ? "·" : ALPHABET_NAMES[s.symbol]}${s.confident ? "" : "?"}`;
  }).filter((d) => !d.endsWith("·?")); // hide the junk that classifies to nothing
  const out = dec.decode(f, fr.tMs);
  for (const r of out) { seen.set(r.beaconId, (seen.get(r.beaconId) ?? 0) + 1); if (firstAt < 0) firstAt = fr.tMs; }
  console.log(`t=${String(fr.tMs).padStart(5)}  comps=${String(comps.length).padStart(3)} ${desc.join(" | ") || "-"}${out.length ? "   ⇒ " + out.map((r) => `${r.beaconId} ${r.optIn ? "OPT-IN" : "OPT-OUT"}`).join(",") : ""}`);
}
console.log(`\nfunnel: ${JSON.stringify({ symbols: decoderStats.symbols, anchors: decoderStats.anchors, assembled: decoderStats.assembled, crcOk: decoderStats.crcOk, crcFail: decoderStats.crcFail, confirmed: decoderStats.confirmed })}`);
console.log(`readings: ${[...seen.entries()].map(([id, n]) => `${id}×${n}`).join(", ") || "NONE"}${firstAt >= 0 ? ` (first at ${firstAt} ms)` : ""}`);
