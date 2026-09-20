import { useEffect, useRef, useState } from "react";
import { Pipeline, PipelineState } from "../pipeline/loop";
import { listCameras, startCamera, startScreen } from "../sources/videoSource";
import { startSynthetic, SyntheticHandle } from "../sources/synthetic";
import { flags } from "../config/flags";
import { OperatorPanel } from "./OperatorPanel";
import { chain, startConsent } from "../consent/store";
import type { BeaconDebug } from "../decode/beacon";
import type { BeaconReading, FilmEvent, Track } from "../shared/schema";

const PROC_WIDTHS = [480, 720, 960, 1280];

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const baseRef = useRef<HTMLVideoElement>(null); // camera behind the synthetic overlay
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pipeRef = useRef<Pipeline | null>(null);
  const synthRef = useRef<SyntheticHandle | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [running, setRunning] = useState(false);
  const [fps, setFps] = useState(0);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [beacons, setBeacons] = useState<BeaconReading[]>([]);
  const [debug, setDebug] = useState<BeaconDebug | null>(null);
  const [events, setEvents] = useState<FilmEvent[]>([]);
  const [source, setSource] = useState("—");
  const [decoder, setDecoder] = useState<"stub" | "optical">(flags.BEACON_DECODER);
  const [overlay, setOverlay] = useState(flags.BEACON_DEBUG);
  const [procWidth, setProcWidth] = useState(flags.PROCESS_WIDTH);
  const [error, setError] = useState("");

  function setBeacon(mode: "stub" | "optical") { flags.BEACON_DECODER = mode; setDecoder(mode); }
  function toggleOverlay() { flags.BEACON_DEBUG = !flags.BEACON_DEBUG; setOverlay(flags.BEACON_DEBUG); }
  function setWidth(w: number) { flags.PROCESS_WIDTH = w; setProcWidth(w); } // the loop reads it every frame

  useEffect(() => { listCameras().then(setCameras).catch(() => {}); }, [running]);
  useEffect(() => { startConsent(); }, []); // chain cache runs from page load, independent of the camera
  // ?clip=<url> runs the whole pipeline on a recording (e.g. /demo/badge-4E.mp4) — the no-camera self-test
  useEffect(() => {
    const clip = new URLSearchParams(location.search).get("clip");
    if (clip) void begin(null, clip, `Clip · ${clip.split("/").pop()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startPipeline(stream: MediaStream | null, fileUrl: string | null, label: string) {
    setError("");
    const v = videoRef.current!;
    if (stream) { v.srcObject = stream; v.removeAttribute("src"); }
    else if (fileUrl) { v.srcObject = null; v.src = fileUrl; v.loop = true; }
    await v.play().catch(() => {});
    const p = new Pipeline(v, canvasRef.current!, (s: PipelineState) => { setFps(s.fps); setTracks(s.tracks); setBeacons(s.beacons); setDebug(s.debug); },
      (e) => setEvents((prev) => [e, ...prev].slice(0, 6)));
    pipeRef.current = p;
    try { await p.start(); setRunning(true); setSource(label); }
    catch (e: any) { setError("detector init failed — did you run `npm run setup`? " + e.message); }
  }

  function begin(stream: MediaStream | null, fileUrl: string | null, label: string) {
    stop();
    return startPipeline(stream, fileUrl, label);
  }

  // Overlay real-format beacon patches on the webcam and decode them live — no
  // hardware. Switches the decoder to optical for this session only.
  // Works without a camera too (dark background), so the whole optical path —
  // decode → bind → chain lookup → light-borne consent relay — runs on any machine.
  async function startSyntheticBadge() {
    stop();
    try {
      const base = baseRef.current!;
      let camera = true;
      try {
        const cam = await startCamera(deviceId || undefined);
        base.srcObject = cam;
        await base.play().catch(() => {});
      } catch { base.srcObject = null; camera = false; }
      setBeacon("optical");
      synthRef.current = startSynthetic(base);
      await startPipeline(synthRef.current.stream, null, "Synthetic badge · optical" + (camera ? "" : " · no camera"));
    } catch (e: any) { fail(e); }
  }

  function stop() {
    pipeRef.current?.stop(); pipeRef.current = null;
    synthRef.current?.stop(); synthRef.current = null;
    for (const el of [videoRef.current, baseRef.current]) {
      if (!el) continue;
      (el.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
      el.srcObject = null; el.removeAttribute("src");
    }
    setRunning(false); setTracks([]); setBeacons([]); setDebug(null); setFps(0);
  }

  const fail = (e: any) => setError(e?.message ?? String(e));

  return (
    <div className="app">
      <header>
        {/* Drop a file at capture-app/public/logo.svg and it appears here.
            Until then the mark hides itself and the wordmark stands alone. */}
        <img
          className="logo"
          src="/logo.svg"
          alt=""
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
        <h1>Consentinel <span>capture</span></h1>
        <div className="tag">fail-safe: blur unless opt-in</div>
        {chain && <div className="tag chain" title={chain.status.programId}>consent: Solana {chain.status.cluster}</div>}
      </header>

      <div className="controls">
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
          <option value="">Default camera</option>
          {cameras.map((c, i) => <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
        </select>
        <button onClick={() => startCamera(deviceId || undefined).then((s) => begin(s, null, "Camera")).catch(fail)}>Use camera</button>
        <button onClick={() => startScreen().then((s) => begin(s, null, "Screen · WhatsApp")).catch(fail)}>Share screen (WhatsApp)</button>
        <button onClick={startSyntheticBadge}>Synthetic badge</button>
        <button onClick={() => setBeacon(decoder === "optical" ? "stub" : "optical")} title="stub = fixed fake beacons · optical = decode the real badge">
          beacon: {decoder}
        </button>
        <button onClick={toggleOverlay} title="draw what the decoder sees: candidate patches (red = not confident, yellow = reading), decoded ids (green), face boxes">
          overlay: {overlay ? "on" : "off"}
        </button>
        <select value={procWidth} onChange={(e) => setWidth(Number(e.target.value))} title="decode/detect resolution — higher = badge readable from farther, costs CPU">
          {PROC_WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>)}
        </select>
        <label className="file">Load clip
          <input type="file" accept="video/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) begin(null, URL.createObjectURL(f), "Clip · fallback"); }} />
        </label>
        {running && <button className="stop" onClick={stop}>Stop</button>}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="stage">
        <canvas ref={canvasRef} className="feed" />
        <OperatorPanel fps={fps} source={source} tracks={tracks} events={events} beacons={beacons} debug={debug} decoder={decoder} />
      </div>

      <video ref={videoRef} muted playsInline style={{ display: "none" }} />
      <video ref={baseRef} muted playsInline style={{ display: "none" }} />
    </div>
  );
}
