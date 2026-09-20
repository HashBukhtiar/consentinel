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

if (flags.BEACON_OPTICAL_MODE === "key") {
  // the static-key engine: per frame, the largest candidates with the decoder's own verdict
  console.log(`${index.frames.length} frames, stored ${index.width}px wide, decoding at ${procW}x${procH} · engine key · MIN_W=${flags.KEY_MIN_W} MARGIN=${flags.KEY_MARGIN} CONFIRM_N=${flags.KEY_CONFIRM_N}`);
  const dec = _internal.newKeyDecoder();
  const seen = new Map<string, number>();
  let firstAt = -1, ms = 0;
  for (const fr of index.frames) {
    const f = load(fr.file, procW, procH);
    const out = dec.decode(f, fr.tMs);
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
