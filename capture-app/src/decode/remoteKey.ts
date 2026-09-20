// The sidecar's badge readings (YOLO digit glyphs grouped into CRC-valid
// keys, see vision/server.py) in the classical decoder's terms, so the same
// confirm / hold / track logic (KeyDecoder.ingest) and the same overlay apply
// whichever engine read the frame.
import type { KeyFit, KeyCandidate, Box, KeyClass } from "./key";
import type { RemoteResult } from "../vision/remote";
import { hex2 } from "@shared/beacon";

export interface RemoteKeyFrame {
  fits: KeyFit[];
  /** every glyph / key box the model saw, with its hue — the "still in view" test for the hold */
  seen: { box: Box; cls: KeyClass }[];
  candidates: KeyCandidate[];
}

export function remoteKeyFrame(r: RemoteResult, W: number, H: number): RemoteKeyFrame {
  const px = (b: { x: number; y: number; w: number; h: number }): Box => ({ x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H });
  const fits: KeyFit[] = r.keys.map((k) => ({
    id: k.id, optIn: k.optIn, key: px(k.box), digits: [k.digits[0], k.digits[1], k.digits[2]] as [number, number, number],
    margin: k.conf, contrast: 0, hyp: k.key ? "yolo+key" : "yolo",
  }));
  const seen = r.digits.map((d) => ({ box: px(d.box), cls: (d.cool ? 1 : 2) as KeyClass }));
  const candidates: KeyCandidate[] = fits.map((f) => ({
    box: f.key, cls: f.optIn ? 1 : 2, fit: f,
    status: `${hex2(f.id)} ${f.optIn ? "OPT-IN" : "OPT-OUT"} · conf ${f.margin.toFixed(2)}${f.hyp === "yolo+key" ? "" : " · no key box"}`,
  }));
  // glyphs that did not form a CRC-valid key: shown so "what does it see?" has an answer
  for (const d of r.digits) {
    if (d.cls === 16) continue;
    const b = px(d.box);
    if (fits.some((f) => b.x >= f.key.x - b.w && b.x + b.w <= f.key.x + f.key.w + b.w && b.y + b.h / 2 >= f.key.y && b.y + b.h / 2 <= f.key.y + f.key.h)) continue;
    candidates.push({ box: b, cls: d.cool ? 1 : 2, fit: null, status: `glyph ${d.cls.toString(16).toUpperCase()} ${d.conf.toFixed(2)} · no CRC-valid key` });
  }
  return { fits, seen, candidates };
}
