// Beacon threshold tuning rig. Separate entry point (tune.html) so none of
// this can touch the hero path.
//
// The decoder gives up silently at seven different stages. This shows which
// one you're dying at, live, with sliders for every threshold — then prints
// the tuned values to paste into config/flags.ts.
import { useEffect, useRef, useState } from "react";
import { startCamera, startScreen, listCameras } from "../sources/videoSource";
import { _internal, rejectReason, decoderStats, decodeBeacons } from "../decode/beacon";
import type { Component, Sampled } from "../decode/beacon";
import { cellRectFrac } from "../decode/patch";
import { flags } from "../config/flags";
import { CLOCK_CELL, FRAME_CELL, DATA_CELLS } from "@shared/beacon";

type Knob = { key: keyof typeof flags; min: number; max: number; step: number; help: string };

const KNOBS: Knob[] = [
  { key: "BEACON_BRIGHT_T", min: 60, max: 250, step: 1, help: "luma above this counts as 'lit' for finding the patch. Too high: badge never found. Too low: the whole room is one blob." },
  { key: "BEACON_MIN_W", min: 8, max: 120, step: 1, help: "smallest patch width in px. Raise to reject noise, lower to decode from farther." },
  { key: "BEACON_ASPECT_MIN", min: 0.8, max: 2.5, step: 0.05, help: "patch is 304x132 ⇒ aspect 2.3. Widen if the badge is tilted." },
  { key: "BEACON_ASPECT_MAX", min: 2.0, max: 6, step: 0.05, help: "upper aspect bound." },
  { key: "BEACON_MIN_BORDER", min: 60, max: 255, step: 1, help: "min border brightness to trust a read. A real screen reads ~190-210." },
  { key: "BEACON_CELL_LIT_FRAC", min: 0.2, max: 0.9, step: 0.01, help: "a cell is lit if luma > this x border luma." },
  { key: "BEACON_CONTRAST_FRAC", min: 0.02, max: 0.4, step: 0.01, help: "every cell must clear the threshold by this much. Lower = more reads accepted, more CRC failures." },
  { key: "BEACON_MATCH_PX", min: 8, max: 200, step: 1, help: "how far a patch may move between frames and still be the same badge." },
  { key: "BEACON_TRACK_MISS", min: 0, max: 90, step: 1, help: "frames a patch survives without a confident read." },
  { key: "BEACON_CONFIRM_MS", min: 200, max: 6000, step: 50, help: "an id must decode twice inside this window to be trusted." },
  { key: "BEACON_ID_HOLD_MS", min: 200, max: 6000, step: 50, help: "how long a decoded id keeps being reported after the last decode." },
  { key: "PROCESS_WIDTH", min: 320, max: 1280, step: 40, help: "decode input width. Higher = decode from farther, costs CPU." },
];

const CELL_NAME = (i: number) =>
  i === CLOCK_CELL ? "clk" : i === FRAME_CELL ? "frm" : `d${3 - DATA_CELLS.indexOf(i as 3 | 4 | 5 | 6)}`;

interface Shot {
  comps: { c: Component; reason: string | null; s?: Sampled }[];
  accepted: number;
  fps: number;
}

export function Tune() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const [shot, setShot] = useState<Shot>({ comps: [], accepted: 0, fps: 0 });
  const [ids, setIds] = useState<string[]>([]);
  const [stats, setStats] = useState({ ...decoderStats });
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [err, setErr] = useState("");
  const [, force] = useState(0);
  const running = useRef(false);
  const lastT = useRef(0);
  const fps = useRef(0);

  const attach = async (get: () => Promise<MediaStream>) => {
    try {
      const stream = await get();
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      setCams(await listCameras());
      if (!running.current) { running.current = true; loop(); }
    } catch (e) { setErr(String(e)); }
  };

  const loop = () => {
    requestAnimationFrame(loop);
    const v = videoRef.current, cv = canvasRef.current;
    if (!v || !cv || !v.videoWidth) return;

    const W = flags.PROCESS_WIDTH;
    const H = Math.round((W * v.videoHeight) / v.videoWidth);
    const work = workRef.current;
    if (work.width !== W) { work.width = W; work.height = H; }
    const wctx = work.getContext("2d", { willReadFrequently: true })!;
    wctx.drawImage(v, 0, 0, W, H);
    const frame = wctx.getImageData(0, 0, W, H);

    // run the REAL decoder so the funnel counters reflect production behaviour
    const readings = decodeBeacons(frame, performance.now());

    // and separately scan components so we can show what was rejected and why
    const comps = _internal
      .scanComponents(frame)
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .slice(0, 24)
      .map((c) => {
        const reason = rejectReason(c, W);
        return { c, reason, s: reason === null ? _internal.sampleCells(frame, c) : undefined };
      });

    // overlay
    if (cv.width !== W) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(work, 0, 0);
    for (const { c, reason, s } of comps) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = reason ? "#ff4444" : s?.confident ? "#22dd55" : "#ffcc00";
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(reason ?? (s?.confident ? "OK" : "low contrast"), c.x, Math.max(10, c.y - 3));
      if (s) {
        for (let i = 1; i <= 6; i++) {
          const r = cellRectFrac(i);
          const cx = c.x + (r.fx + r.fw / 2) * c.w, cy = c.y + (r.fy + r.fh / 2) * c.h;
          const hw = r.fw * c.w * 0.3, hh = r.fh * c.h * 0.3;
          ctx.strokeStyle = s.bits[i - 1] ? "#ffffff" : "#3366ff";
          ctx.lineWidth = 1;
          ctx.strokeRect(cx - hw, cy - hh, hw * 2, hh * 2);
        }
      }
    }

    const now = performance.now();
    fps.current = fps.current * 0.9 + (1000 / Math.max(1, now - lastT.current)) * 0.1;
    lastT.current = now;

    if ((decoderStats.symbols + Math.round(now / 100)) % 3 === 0) {
      setShot({ comps, accepted: comps.filter((x) => !x.reason).length, fps: Math.round(fps.current) });
      setStats({ ...decoderStats });
      setIds(readings.map((r) => r.beaconId));
    }
  };

  useEffect(() => () => { running.current = false; }, []);

  const best = shot.comps.find((x) => !x.reason) ?? shot.comps[0];
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

  const dump = KNOBS.map((k) => `  ${k.key}: ${flags[k.key]},`).join("\n");

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 400px", gap: 16, padding: 16, font: "13px ui-monospace, monospace" }}>
      <div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <button onClick={() => attach(() => startCamera())}>webcam</button>
          <button onClick={() => attach(() => startScreen())}>screen share</button>
          {cams.map((c, i) => (
            <button key={c.deviceId} onClick={() => attach(() => startCamera(c.deviceId))}>
              cam {i}: {c.label.slice(0, 22) || "unnamed"}
            </button>
          ))}
          <button onClick={() => { decoderStats.reset(); force((n) => n + 1); }}>reset counters</button>
        </div>
        {err && <div style={{ color: "#ff5555" }}>{err}</div>}
        <video ref={videoRef} muted playsInline style={{ display: "none" }} />
        <canvas ref={canvasRef} style={{ width: "100%", background: "#111", borderRadius: 6 }} />
        <div style={{ marginTop: 6, opacity: 0.7 }}>
          {shot.fps} fps · {shot.comps.length} bright blobs · {shot.accepted} look like a badge ·{" "}
          <span style={{ color: "#22dd55" }}>green = confident read</span> ·{" "}
          <span style={{ color: "#ffcc00" }}>yellow = found but not trusted</span> ·{" "}
          <span style={{ color: "#ff4444" }}>red = rejected</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: "95vh", overflowY: "auto" }}>
        <section>
          <h3 style={{ margin: "0 0 6px" }}>decoded right now</h3>
          <div style={{ fontSize: 26, color: ids.length ? "#22dd55" : "#888" }}>{ids.length ? ids.join("  ") : "nothing"}</div>
        </section>

        <section>
          <h3 style={{ margin: "0 0 6px" }}>where it's dying</h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {[
                ["1. bright blobs found", shot.comps.length, "raise BEACON_BRIGHT_T if this is huge"],
                ["2. shaped like a patch", shot.accepted, "size/aspect — widen if 0 but you can see the badge"],
                ["3. confident reads", shot.comps.filter((x) => x.s?.confident).length, "BEACON_MIN_BORDER / CONTRAST_FRAC"],
                ["4. symbol changes", stats.symbols, "0 ⇒ patch found but not changing: wrong app or frozen"],
                ["5. frame anchors", stats.anchors, "0 ⇒ never seeing symbol 0"],
                ["6. 3-symbol groups", stats.assembled, ""],
                ["7. CRC passed", `${stats.crcOk} / ${stats.assembled} (${pct(stats.crcOk, stats.assembled)})`, "low ⇒ sampling wrong cells or dropping symbols"],
                ["8. ids confirmed", stats.confirmed, "needs 2 matching decodes inside BEACON_CONFIRM_MS"],
              ].map(([label, val, hint]) => (
                <tr key={String(label)}>
                  <td style={{ padding: "2px 6px 2px 0", whiteSpace: "nowrap" }}>{label}</td>
                  <td style={{ padding: "2px 6px", textAlign: "right", color: Number(val) === 0 && String(val) === "0" ? "#ff4444" : "#22dd55" }}>{String(val)}</td>
                  <td style={{ padding: "2px 0", opacity: 0.55, fontSize: 11 }}>{hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {best?.s && (
          <section>
            <h3 style={{ margin: "0 0 6px" }}>cell sample (largest patch)</h3>
            <div>border luma <b>{best.s.borderLum.toFixed(0)}</b> (need &gt; {flags.BEACON_MIN_BORDER}) · lit threshold <b>{best.s.thr.toFixed(0)}</b></div>
            <div>min margin <b>{best.s.minMargin.toFixed(1)}</b> (need &gt; {(best.s.borderLum * flags.BEACON_CONTRAST_FRAC).toFixed(1)})</div>
            <table style={{ marginTop: 4 }}>
              <tbody>
                <tr>{[1, 2, 3, 4, 5, 6].map((i) => <td key={i} style={{ padding: "1px 7px 1px 0", opacity: 0.6 }}>{CELL_NAME(i)}</td>)}</tr>
                <tr>{best.s.lums.map((l, i) => <td key={i} style={{ padding: "1px 7px 1px 0", color: best.s!.bits[i] ? "#fff" : "#6688ff" }}>{l.toFixed(0)}</td>)}</tr>
              </tbody>
            </table>
          </section>
        )}

        <section>
          <h3 style={{ margin: "0 0 6px" }}>thresholds</h3>
          {KNOBS.map((k) => (
            <div key={k.key} style={{ marginBottom: 8 }}>
              <label style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{k.key}</span><b>{String(flags[k.key])}</b>
              </label>
              <input
                type="range" min={k.min} max={k.max} step={k.step} value={Number(flags[k.key])}
                style={{ width: "100%" }}
                onChange={(e) => { (flags as Record<string, unknown>)[k.key] = Number(e.target.value); force((n) => n + 1); }}
              />
              <div style={{ opacity: 0.5, fontSize: 11 }}>{k.help}</div>
            </div>
          ))}
        </section>

        <section>
          <h3 style={{ margin: "0 0 6px" }}>paste into config/flags.ts</h3>
          <textarea readOnly value={dump} rows={13} style={{ width: "100%", font: "12px ui-monospace, monospace" }} />
        </section>
      </div>
    </div>
  );
}
