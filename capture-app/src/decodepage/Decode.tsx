// "Whose badge is this?" -- the smallest possible answer to that question.
//
// Camera in, badge id out. No faces, no blur, no thresholds, no funnel. The
// tuning rig (tune.html) exists to show WHY a decode failed and is the wrong
// tool when you just want to know whether it works at all.
//
// One status line, four states, so a failure still says something useful:
//   no camera / looking / seeing the badge / decoded.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { startCamera, listCameras } from "../sources/videoSource";
import { decodeBeacons, _internal } from "../decode/beacon";
import { flags } from "../config/flags";

type Status = "idle" | "looking" | "patch" | "locked";

export function Decode() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const workRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const running = useRef(false);
  const lastSeen = useRef(0);

  const [id, setId] = useState<string | null>(null);
  const [optIn, setOptIn] = useState<boolean | undefined>(undefined);
  const [status, setStatus] = useState<Status>("idle");
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [err, setErr] = useState("");

  const start = async (deviceId?: string) => {
    try {
      const stream = await startCamera(deviceId);
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      setCams(await listCameras());
      setStatus("looking");
      if (!running.current) { running.current = true; loop(); }
    } catch (e) { setErr(String(e)); }
  };

  const loop = () => {
    requestAnimationFrame(loop);
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;

    const W = flags.PROCESS_WIDTH;
    const H = Math.round((W * v.videoHeight) / v.videoWidth);
    const work = workRef.current;
    if (work.width !== W) { work.width = W; work.height = H; }
    const ctx = work.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(v, 0, 0, W, H);
    const frame = ctx.getImageData(0, 0, W, H);

    const now = performance.now();
    const readings = decodeBeacons(frame, now);

    if (readings.length) {
      setId(readings[0].beaconId);
      setOptIn(readings[0].optIn);
      setStatus("locked");
      lastSeen.current = now;
      return;
    }
    // Nothing decoded. Say whether we can at least SEE a badge-shaped patch --
    // that single bit separates "aim the camera" from "tune the decoder".
    if (now - lastSeen.current > 1500) {
      const seesPatch = _internal.locatePatches(frame).length > 0;
      setStatus(seesPatch ? "patch" : "looking");
    }
  };

  useEffect(() => () => { running.current = false; }, []);

  const msg: Record<Status, string> = {
    idle: "pick a camera to start",
    looking: "looking for a badge...",
    patch: "I can see the badge - waiting for a clean frame",
    locked: "decoded",
  };

  return (
    <div style={S.page}>
      <div style={S.bar}>
        <button style={S.btn} onClick={() => start()}>start camera</button>
        {cams.map((c, i) => (
          <button key={c.deviceId} style={S.btn} onClick={() => start(c.deviceId)}>
            cam {i}: {c.label.slice(0, 18) || "unnamed"}
          </button>
        ))}
      </div>

      {err && <div style={S.err}>{err}</div>}

      <div style={S.stage}>
        <div style={{ ...S.id, color: status === "locked" ? "#22dd55" : "#3a3a3a" }}>
          {id ?? "--"}
        </div>
        {status === "locked" && optIn !== undefined && (
          <div style={{ ...S.consent, background: optIn ? "#00ff84" : "#ff0084" }}>
            {optIn ? "OPT-IN" : "OPT-OUT"}
          </div>
        )}
        <div style={S.status}>{msg[status]}</div>
      </div>

      <video ref={videoRef} muted playsInline style={S.video} />
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  page: {
    position: "fixed", inset: 0, background: "#0b0b0b", color: "#888",
    display: "flex", flexDirection: "column", gap: 12, padding: 16,
    font: "14px ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  bar: { display: "flex", gap: 8, flexWrap: "wrap" },
  btn: {
    padding: "8px 14px", borderRadius: 8, border: "1px solid #333",
    background: "#161616", color: "#ddd", cursor: "pointer",
    font: "13px ui-monospace, monospace",
  },
  err: { color: "#ff5555" },
  stage: {
    flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", gap: 14,
  },
  id: { font: "700 clamp(90px, 28vw, 260px)/1 ui-monospace, monospace", letterSpacing: ".06em" },
  consent: {
    color: "#000", padding: "8px 22px", borderRadius: 999,
    font: "700 18px ui-monospace, monospace", letterSpacing: ".08em",
  },
  status: { opacity: 0.65 },
  video: { width: 260, alignSelf: "center", borderRadius: 8, background: "#000" },
};
