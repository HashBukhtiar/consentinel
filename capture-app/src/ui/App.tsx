import { useEffect, useRef, useState } from "react";
import { Pipeline, PipelineState } from "../pipeline/loop";
import { listCameras, startCamera, startScreen, startGlasses } from "../sources/videoSource";
import { flags } from "../config/flags";
import { OperatorPanel } from "./OperatorPanel";
import { chain, startConsent } from "../consent/store";
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
  const [source, setSource] = useState("");
  const [decoder, setDecoder] = useState<"stub" | "optical">(flags.BEACON_DECODER);
  const [error, setError] = useState("");
  // The relay app prints this address on the phone; remembered so it's typed once.
  const [glasses, setGlasses] = useState(() => localStorage.getItem("consentinel.glasses") ?? "");

  function setBeacon(mode: "stub" | "optical") { flags.BEACON_DECODER = mode; setDecoder(mode); }
  const [privacyBlur, setPrivacyBlur] = useState(flags.PRIVACY_BLUR);
  const [composite, setComposite] = useState(flags.COMPOSITE);
  const [unknownPolicy, setUnknownPolicy] = useState(flags.DEFAULT_CONSENT);
  function toggleUnknown() { flags.DEFAULT_CONSENT = flags.DEFAULT_CONSENT === "blur" ? "clear" : "blur"; setUnknownPolicy(flags.DEFAULT_CONSENT); }
  // frame = default-deny (whole frame pixelated, clear windows punched for opt-ins);
  // faces = pixelate only the faces we decided to blur. faces makes the pipeline's
  // state legible while setting up — frame is the one that is actually fail-safe.
  function toggleComposite() { flags.COMPOSITE = flags.COMPOSITE === "frame" ? "faces" : "frame"; setComposite(flags.COMPOSITE); }
  function toggleBlur() { flags.PRIVACY_BLUR = !flags.PRIVACY_BLUR; setPrivacyBlur(flags.PRIVACY_BLUR); }

  useEffect(() => { listCameras().then(setCameras).catch(() => {}); }, [running]);
  useEffect(() => { startConsent(); }, []); // chain cache runs from page load, independent of the camera

  async function begin(stream: MediaStream, label: string) {
    stop();
    setError("");
    const v = videoRef.current!;
    v.srcObject = stream;
    await v.play().catch(() => {});
    const p = new Pipeline(v, canvasRef.current!, (s: PipelineState) => { setFps(s.fps); setTracks(s.tracks); },
      (e) => setEvents((prev) => [e, ...prev].slice(0, 8)));
    pipeRef.current = p;
    try { await p.start(); setRunning(true); setSource(label); }
    catch (e: any) { setError("The face detector couldn't start. Run `npm run setup`, then reload. (" + e.message + ")"); }
  }

  function stop() {
    pipeRef.current?.stop(); pipeRef.current = null;
    const v = videoRef.current;
    if (v) { (v.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop()); v.srcObject = null; }
    setRunning(false); setTracks([]); setFps(0); setSource("");
  }

  const fail = (e: any) => setError(e?.message ?? String(e));
  const blurred = tracks.filter((t) => t.blurred).length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Consentinel</h1>
          <span>consent-respecting capture</span>
        </div>
        <div className="badges">
          <span className={"chip live" + (running ? " on" : "")}>{running ? `Live · ${source}` : "Idle"}</span>
          {chain && <span className="chip chain-chip" title={chain.status.programId}>Solana {chain.status.cluster}</span>}
        </div>
      </header>

      <div className="stage">
        <section className="feedcol">
          <div className="feedwrap">
            <canvas ref={canvasRef} className="feed" />
            {running ? (
              <div className="hud" aria-live="polite">
                <span><b>{tracks.length}</b> in frame</span>
                <span className={blurred ? "hot" : ""}><b>{blurred}</b> blurred</span>
                <span className="dim"><b>{fps}</b> fps</span>
              </div>
            ) : (
              <div className="empty">
                <p>Nothing on camera yet</p>
                <p className="muted">Start a camera or share your screen. Every face stays blurred unless its badge has opted in on-chain.</p>
              </div>
            )}
          </div>

          <div className="controls">
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} aria-label="Camera">
              <option value="">Default camera</option>
              {cameras.map((c, i) => <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
            </select>
            <button className="primary" onClick={() => startCamera(deviceId || undefined).then((s) => begin(s, "camera")).catch(fail)}>Use camera</button>
            <button onClick={() => startScreen().then((s) => begin(s, "screen")).catch(fail)}>Share screen</button>
            <input className="glasses" value={glasses} placeholder="ws://phone-ip:8080" aria-label="Glasses relay address"
              onChange={(e) => { setGlasses(e.target.value); localStorage.setItem("consentinel.glasses", e.target.value); }} />
            <button disabled={!glasses} onClick={() => startGlasses(glasses).then((s) => begin(s, "glasses")).catch(fail)}>Glasses</button>
            <button className={"seg " + decoder} onClick={() => setBeacon(decoder === "optical" ? "stub" : "optical")}
              title="stub = fixed demo beacons · optical = decode the real badge">
              Beacon · {decoder}
            </button>
            <button className={"seg " + (privacyBlur ? "optical" : "")} onClick={toggleBlur}
              title="on = pixelate everyone without an opt-in badge · off = show the raw feed (setup only)">
              Blur · {privacyBlur ? "on" : "off"}
            </button>
            <button className={"seg " + (composite === "frame" ? "optical" : "")} onClick={toggleComposite}
              title="frame = default-deny, whole frame blurred except opt-ins · faces = blur only the faces judged non-consenting (setup/debug)">
              Cover · {composite}
            </button>
            <button className={"seg " + (unknownPolicy === "blur" ? "optical" : "")} onClick={toggleUnknown}
              title="what a face with no usable consent record gets · blur = default-deny (fail-safe) · clear = only recognized opt-outs are blurred">
              Unknown · {unknownPolicy}
            </button>
            <div className="spacer" />
            {running && <button className="stop" onClick={stop}>Stop</button>}
          </div>

          {error && <div className="error">{error}</div>}
        </section>

        <OperatorPanel tracks={tracks} events={events} />
      </div>

      <video ref={videoRef} muted playsInline style={{ display: "none" }} />
    </div>
  );
}
