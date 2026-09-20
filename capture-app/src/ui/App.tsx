import { useEffect, useRef, useState } from "react";
import { Pipeline, PipelineState } from "../pipeline/loop";
import { listCameras, startCamera, startScreen, startGlasses } from "../sources/videoSource";
import { flags } from "../config/flags";
import { setMaskImage } from "../vision/blur";
import { OperatorPanel } from "./OperatorPanel";
import { NoticeToasts } from "./NoticeToast";
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

  // Icon mask: drop any image on the feed (or pick one) and it covers blurred
  // faces instead of pixelation. Kept in localStorage so it survives a reload.
  const [mask, setMask] = useState(flags.MASK);
  const [iconUrl, setIconUrl] = useState<string | null>(() => localStorage.getItem("consentinel.mask"));
  const [dropping, setDropping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!iconUrl) { setMaskImage(null); return; }
    const img = new Image();
    img.onload = () => setMaskImage(img);
    img.src = iconUrl;
  }, [iconUrl]);
  function loadIcon(file: File | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      try { localStorage.setItem("consentinel.mask", url); } catch { /* too big for storage: still works this session */ }
      setIconUrl(url);
      flags.MASK = "icon"; setMask("icon");
    };
    r.readAsDataURL(file);
  }
  function toggleMask() { flags.MASK = flags.MASK === "blur" ? "icon" : "blur"; setMask(flags.MASK); }
  function clearIcon() { localStorage.removeItem("consentinel.mask"); setIconUrl(null); flags.MASK = "blur"; setMask("blur"); }

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
          <span className={"chip live" + (running ? " on" : "")}>{running ? <>Live<i>{source}</i></> : "Idle"}</span>
          {chain && <span className="chip chain-chip" title={chain.status.programId}>Solana {chain.status.cluster}</span>}
        </div>
      </header>

      <div className="stage">
        <section className="feedcol">
          <div className={"feedwrap" + (dropping ? " dropping" : "")}
            onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
            onDragLeave={() => setDropping(false)}
            onDrop={(e) => { e.preventDefault(); setDropping(false); loadIcon(e.dataTransfer.files[0]); }}>
            {running && <button className="stop float" onClick={stop} title="Stop capture">Stop</button>}
            <canvas ref={canvasRef} className="feed" />
            <NoticeToasts />
            {running ? (
              <div className="hud" aria-live="polite">
                <span><b>{tracks.length}</b> in frame</span>
                <span className={blurred ? "hot" : ""}><b>{blurred}</b> blurred</span>
                <span className="dim"><b>{fps}</b> fps</span>
              </div>
            ) : (
              <div className="empty">
                <p>Put the glasses on</p>
                <p className="muted">Start the relay app on the phone and press Start glasses. A webcam works too. Every face stays blurred unless its badge has opted in on-chain.</p>
              </div>
            )}
          </div>

          <div className="controls">
            <input className="glasses" value={glasses} placeholder="ws://phone-ip:8080" aria-label="Glasses relay address"
              onChange={(e) => { setGlasses(e.target.value); localStorage.setItem("consentinel.glasses", e.target.value); }} />
            <button className="primary" disabled={!glasses} onClick={() => startGlasses(glasses).then((s) => begin(s, "glasses")).catch(fail)}>
              Start glasses
            </button>
            <span className="or">or</span>
            <select className="quiet" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} aria-label="Webcam">
              <option value="">Webcam</option>
              {cameras.map((c, i) => <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
            </select>
            <button className="quiet" onClick={() => startCamera(deviceId || undefined).then((s) => begin(s, "camera")).catch(fail)}>Use webcam</button>
            <span className="maskgroup">
            <button className={"seg " + (mask === "icon" ? "optical" : "")} onClick={iconUrl ? toggleMask : () => fileRef.current?.click()}
              title={iconUrl ? "blur = pixelate covered faces · icon = paint your image over them (same box, same coverage)" : "drop an image on the feed, or click to pick one"}>
              <span className="k">Mask</span><span className="v">{iconUrl ? mask : "drop an icon"}</span>
            </button>
            {iconUrl && <img className="maskpreview" src={iconUrl} alt="" title="click to remove" onClick={clearIcon} />}
            </span>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => loadIcon(e.target.files?.[0])} />
          </div>
            <details className="debug setup">
              <summary>Setup</summary>
              <div className="controls">
            <button onClick={() => startScreen().then((s) => begin(s, "screen")).catch(fail)}>Share screen</button>
            <button className={"seg " + decoder} onClick={() => setBeacon(decoder === "optical" ? "stub" : "optical")}
              title="stub = fixed demo beacons · optical = decode the real badge">
              <span className="k">Beacon</span><span className="v">{decoder}</span>
            </button>
            <button className={"seg " + (privacyBlur ? "optical" : "")} onClick={toggleBlur}
              title="on = pixelate everyone without an opt-in badge · off = show the raw feed (setup only)">
              <span className="k">Blur</span><span className="v">{privacyBlur ? "on" : "off"}</span>
            </button>
            <button className={"seg " + (composite === "frame" ? "optical" : "")} onClick={toggleComposite}
              title="frame = default-deny, whole frame blurred except opt-ins · faces = blur only the faces judged non-consenting (setup/debug)">
              <span className="k">Cover</span><span className="v">{composite}</span>
            </button>
            <button className={"seg " + (unknownPolicy === "blur" ? "optical" : "")} onClick={toggleUnknown}
              title="what a face with no usable consent record gets · blur = default-deny (fail-safe) · clear = only recognized opt-outs are blurred">
              <span className="k">Unknown</span><span className="v">{unknownPolicy}</span>
            </button>
              </div>
            </details>

          {error && <div className="error">{error}</div>}
        </section>

        <OperatorPanel tracks={tracks} events={events} />
      </div>

      <video ref={videoRef} muted playsInline style={{ display: "none" }} />
    </div>
  );
}
