// Auto-label the badge key in every 🎥 diag recording with the classical decoder:
// per frame, the fitted 3-cell grid → one box per digit cell (+ the digit it
// shows) and the whole-key box. The output feeds vision/badgekey/dataset.py,
// which mixes these REAL frames (the badge's own LED halos, bloom and ring)
// with synthetic renders to train the YOLO digit model.
//   npx tsx scripts/keylabels.ts ../data/diag > ../data/diag/keylabels.json
// A frame the classical decoder cannot read gets no label (the dataset builder
// covers its badge with a synthetic one so no real digit goes unlabelled).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _internal } from "../src/decode/beacon";
import { KEY, hex2 } from "@shared/beacon";

const root = process.argv[2] ?? "../data/diag";
const tmp = join(tmpdir(), "consentinel-keylabels.raw");
const load = (file: string, w: number, h: number): ImageData => {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgba", tmp]);
  return { data: new Uint8ClampedArray(readFileSync(tmp).buffer.slice(0)), width: w, height: h } as unknown as ImageData;
};

type Cell = { x: number; y: number; w: number; h: number; digit: number };
type Label = { file: string; width: number; height: number; tMs: number; id: string; optIn: boolean; key: { x: number; y: number; w: number; h: number }; cells: Cell[] };
const out: { clips: { dir: string; width: number; height: number; frames: { file: string; tMs: number; label: Label | null }[] }[] } = { clips: [] };

for (const name of readdirSync(root).filter((n) => n.endsWith("-seq")).sort()) {
  const dir = join(root, name);
  if (!existsSync(join(dir, "index.json"))) continue;
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { video: { w: number; h: number }; width: number; frames: { tMs: number; file: string }[] };
  const W = index.width, H = Math.round((W * index.video.h) / index.video.w);
  const dec = _internal.newKeyDecoder();
  const clip = { dir: name, width: W, height: H, frames: [] as { file: string; tMs: number; label: Label | null }[] };
  let labelled = 0;
  for (const fr of index.frames) {
    const f = load(join(dir, fr.file), W, H);
    dec.decode(f, fr.tMs);
    // the best fit this frame (largest margin) — the grid box maps to the three cells
    const fits = dec.debug.candidates.map((c) => c.fit).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.margin - a.margin);
    let label: Label | null = null;
    if (fits.length) {
      const fit = fits[0];
      const sx = fit.key.w / KEY.span;
      const cells: Cell[] = fit.digits.map((d, k) => ({ x: fit.key.x + k * KEY.pitch * sx, y: fit.key.y, w: KEY.w * sx, h: fit.key.h, digit: d }));
      label = { file: fr.file, width: W, height: H, tMs: fr.tMs, id: hex2(fit.id), optIn: fit.optIn, key: fit.key, cells };
      labelled++;
    }
    clip.frames.push({ file: fr.file, tMs: fr.tMs, label });
  }
  console.error(`${name}: ${labelled}/${index.frames.length} frames labelled`);
  out.clips.push(clip);
}
console.log(JSON.stringify(out));
