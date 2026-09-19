import { useEffect, useRef, useState } from "react";
import { Pipeline, PipelineState } from "../pipeline/loop";
import { listCameras, startCamera, startScreen } from "../sources/videoSource";
import { OperatorPanel } from "./OperatorPanel";
import type { FilmEvent, Track } from "../shared/schema";

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pipeRef = useRef<Pipeline | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [running, setRunning] = useState(false);
  const [fps, setFps] = useState(0);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [events, setEvents] = useState<FilmEvent[]>([]);
  const [source, setSource] = useState("—");
  const [error, setError] = useState("");

  useEffect(() => { listCameras().then(setCameras).catch(() => {}); }, [running]);

  async function begin(stream: MediaStream | null, fileUrl: string | null, label: string) {
    stop();
    setError("");
    const v = videoRef.current!;
    if (stream) { v.srcObject = stream; v.removeAttribute("src"); }
    else if (fileUrl) { v.srcObject = null; v.src = fileUrl; v.loop = true; }
    await v.play().catch(() => {});
    const p = new Pipeline(v, canvasRef.current!, (s: PipelineState) => { setFps(s.fps); setTracks(s.tracks); },
      (e) => setEvents((prev) => [e, ...prev].slice(0, 6)));
    pipeRef.current = p;
    try { await p.start(); setRunning(true); setSource(label); }
    catch (e: any) { setError("detector init failed — did you run `npm run setup`? " + e.message); }
  }

  function stop() {
    pipeRef.current?.stop();
    pipeRef.current = null;
    const v = videoRef.current;
    if (v) { (v.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop()); v.srcObject = null; v.removeAttribute("src"); }
    setRunning(false); setTracks([]); setFps(0);
  }

  const fail = (e: any) => setError(e?.message ?? String(e));

  return (
    <div className="app">
      <header>
        <h1>Consentinel <span>capture</span></h1>
        <div className="tag">fail-safe: blur unless opt-in</div>
      </header>

      <div className="controls">
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
          <option value="">Default camera</option>
          {cameras.map((c, i) => <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
        </select>
        <button onClick={() => startCamera(deviceId || undefined).then((s) => begin(s, null, "Camera")).catch(fail)}>Use camera</button>
        <button onClick={() => startScreen().then((s) => begin(s, null, "Screen · WhatsApp")).catch(fail)}>Share screen (WhatsApp)</button>
        <label className="file">Load clip
          <input type="file" accept="video/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) begin(null, URL.createObjectURL(f), "Clip · fallback"); }} />
        </label>
        {running && <button className="stop" onClick={stop}>Stop</button>}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="stage">
        <canvas ref={canvasRef} className="feed" />
        <OperatorPanel fps={fps} source={source} tracks={tracks} events={events} />
      </div>

      <video ref={videoRef} muted playsInline style={{ display: "none" }} />
    </div>
  );
}
