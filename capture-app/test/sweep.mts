// Offline beacon robustness sweep — no camera, no badge, no browser.
//
// Renders the real patch through a model of what a webcam does to it (scale
// loss, defocus/motion blur, a screen that isn't paper-white, sensor noise,
// glare washing out the blacks), runs the REAL decoder over the result, and
// reports where it stops working.
//
// Two things it answers before you ever point a camera at the badge:
//   1. how small can the patch get and still decode  ⇒ how far away the badge
//      can be, in metres, for a given camera FOV;
//   2. which thresholds survive the widest range of conditions ⇒ where to
//      start tuning instead of guessing.
//
//   npm run sweep            summary matrix
//   npm run sweep -- --tune  also sweep the thresholds themselves
import { paintPatch, symbolColors } from "../src/decode/patch";
import { createDecoder } from "../src/decode/beacon";
import { flags } from "../src/config/flags";
import { hex2, PATCH, SYMBOLS_PER_FRAME } from "@shared/beacon";

type Frame = { data: Uint8ClampedArray; width: number; height: number };

// ---------------------------------------------------------------- camera model
interface Conditions {
  patchW: number; // patch width in px within the processed frame
  blur: number; // box-blur radius, px — defocus + motion
  screen: number; // peak luma of the badge's white, 0-255 (a dim screen, or far)
  ambient: number; // background luma the badge sits against
  glare: number; // luma added everywhere — washes out the blacks
  noise: number; // +/- uniform sensor noise
}

const BASE: Conditions = { patchW: 120, blur: 0, screen: 235, ambient: 26, glare: 0, noise: 0 };

function render(c: Conditions, id: number, symbol: number, W = 720): Frame {
  const H = Math.round((W * 9) / 16);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    data[o] = data[o + 1] = data[o + 2] = c.ambient;
    data[o + 3] = 255;
  }
  // paint the true panel colour into a scratch buffer, then model the screen:
  // each channel scales by the screen's peak luma, and no channel goes fully
  // dark (a real LCD's black still leaks). Colour MUST survive this step —
  // the classifier has nothing else to work with.
  const pw = Math.round(c.patchW), ph = Math.round(pw / (PATCH.w / PATCH.h)); // real badge aspect
  const patch = new Uint8ClampedArray(pw * ph * 4);
  paintPatch(patch, pw, ph, { x: 0, y: 0, w: pw, h: ph }, symbolColors(id, true)[symbol]);
  const black = Math.min(c.screen * 0.06, c.ambient);
  const px = Math.round((W - pw) / 2), py = Math.round(H * 0.6);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const src = (y * pw + x) * 4;
      const dst = ((py + y) * W + px + x) * 4;
      for (let k = 0; k < 3; k++) {
        data[dst + k] = Math.max(black, (patch[src + k] / 255) * c.screen);
      }
    }
  }
  if (c.blur > 0) boxBlur(data, W, H, Math.round(c.blur));
  if (c.glare || c.noise) {
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      const n = c.noise ? (Math.random() * 2 - 1) * c.noise : 0;
      data[o] += c.glare + n;
      data[o + 1] += c.glare + n;
      data[o + 2] += c.glare + n;
    }
  }
  return { data, width: W, height: H };
}

function boxBlur(data: Uint8ClampedArray, W: number, H: number, r: number): void {
  const src = Uint8ClampedArray.from(data);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const so = (yy * W + xx) * 4;
          sr += src[so]; sg += src[so + 1]; sb += src[so + 2];
          n++;
        }
      }
      const o = (y * W + x) * 4;
      data[o] = sr / n; data[o + 1] = sg / n; data[o + 2] = sb / n;
    }
  }
}

// ------------------------------------------------------------------- one trial
// Feed whole frames the way the pipeline does: each symbol is held for a couple
// of camera frames, and an id must decode twice before the decoder trusts it.
function decodes(c: Conditions, id = 0x4e): boolean {
  const decode = createDecoder();
  let t = 0;
  for (let rep = 0; rep < 3; rep++) {
    for (let s = 0; s < SYMBOLS_PER_FRAME; s++) {
      const f = render(c, id, s);
      for (let hold = 0; hold < 2; hold++) {
        const out = decode(f as unknown as ImageData, (t += 33));
        if (out.some((r) => r.beaconId === hex2(id))) return true;
      }
    }
  }
  return false;
}

// -------------------------------------------------------------------- sweeping
function limit(name: keyof Conditions, values: number[], worseIsHigher: boolean): string {
  let last: number | null = null;
  for (const v of values) {
    if (decodes({ ...BASE, [name]: v })) last = v;
    else if (last !== null) break;
  }
  return last === null ? "FAILS EVEN AT BASELINE" : `${worseIsHigher ? "up to" : "down to"} ${last}`;
}

// --terse: two numbers for the geometry experiment harness
if (process.argv.includes("--terse")) {
  const minW = [120, 100, 80, 70, 60, 50, 44, 38, 34, 30, 26, 22, 18, 14]
    .filter((v) => decodes({ ...BASE, patchW: v })).pop() ?? 0;
  const maxBlur = [0, 1, 2, 3, 4, 5, 6, 8].filter((v) => decodes({ ...BASE, blur: v, patchW: 90 })).shift() === 0
    ? [0, 1, 2, 3, 4, 5, 6, 8].reduce((acc, v) => (decodes({ ...BASE, blur: v, patchW: 90 }) ? v : acc), 0) : 0;
  console.log(`${minW},${maxBlur}`);
  process.exit(0);
}

const rows: [string, string, string][] = [];

rows.push([
  "patch width (px)",
  limit("patchW", [120, 100, 80, 70, 60, 50, 44, 38, 34, 30, 26, 22, 18, 14], false),
  "smallest patch that still decodes",
]);
rows.push(["defocus / motion blur (px)", limit("blur", [0, 1, 2, 3, 4, 5, 6, 8], true), "box-blur radius tolerated"]);
rows.push(["screen brightness (luma)", limit("screen", [235, 210, 190, 170, 150, 130, 110, 95, 80], false), "dimmest badge white that works"]);
rows.push(["glare / washed blacks", limit("glare", [0, 10, 20, 30, 45, 60, 80, 100], true), "luma added everywhere"]);
rows.push(["sensor noise (+/- luma)", limit("noise", [0, 5, 10, 20, 30, 45, 60], true), "uniform noise tolerated"]);
rows.push(["bright background", limit("ambient", [26, 60, 100, 140, 170, 200], true), "how bright the room behind can be"]);

console.log(`\nbeacon robustness sweep — PROCESS_WIDTH ${flags.PROCESS_WIDTH}, one variable at a time\n`);
const w = Math.max(...rows.map((r) => r[0].length));
for (const [k, v, note] of rows) console.log(`  ${k.padEnd(w)}  ${v.padEnd(26)} ${note}`);

// patch width → real-world distance. The patch is now the WHOLE 320 px screen
// across a ~35 mm wide display, so it subtends the full 35 mm.
const minW = Number(/\d+/.exec(rows[0][1])?.[0] ?? 0);
if (minW) {
  const PATCH_MM = 33;
  for (const fovDeg of [60, 78]) {
    const frameMmAt1m = 2 * 1000 * Math.tan((fovDeg * Math.PI) / 360);
    const metres = (flags.PROCESS_WIDTH / minW) * (PATCH_MM / frameMmAt1m);
    console.log(`\n  at ${fovDeg}° FOV: badge decodes out to ~${metres.toFixed(1)} m`);
  }
}

// ------------------------------------------------------- threshold exploration
if (process.argv.includes("--tune")) {
  console.log("\nthreshold sweep — score = conditions passed out of 7 (higher is better)\n");
  const HARD: Conditions[] = [
    BASE,
    { ...BASE, patchW: 40 },
    { ...BASE, patchW: 30 },
    { ...BASE, blur: 3 },
    { ...BASE, screen: 140 },
    { ...BASE, glare: 45, ambient: 80 },
    { ...BASE, noise: 30, blur: 2 },
  ];
  const score = () => HARD.filter((c) => decodes(c)).length;

  for (const [key, values] of [
    ["BEACON_BRIGHT_T", [110, 130, 150, 175, 200]],
    ["BEACON_MIN_BORDER", [80, 95, 110, 130, 160]],
    ["BEACON_SYMBOL_MARGIN", [1.05, 1.15, 1.3, 1.5, 1.8]],
    ["BEACON_MIN_W", [14, 18, 22, 30]],
  ] as [keyof typeof flags, number[]][]) {
    const original = flags[key];
    const line = values.map((v) => {
      (flags as Record<string, unknown>)[key] = v;
      return `${v}:${score()}`;
    });
    (flags as Record<string, unknown>)[key] = original;
    console.log(`  ${String(key).padEnd(22)} ${line.join("  ")}   (current ${original})`);
  }
}
console.log();
