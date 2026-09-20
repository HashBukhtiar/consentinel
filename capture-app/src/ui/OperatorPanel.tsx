import { useEffect, useState } from "react";
import { consentStore } from "../stubs/consentStore";
import { chain } from "../consent/store";
import { operatorLink, type OperatorMessage } from "../events/operatorLink";
import { ChainPanel } from "./ChainPanel";
import type { BeaconDebug } from "../decode/beacon";
import { flags } from "../config/flags";
import type { BeaconReading, FilmEvent, Track } from "../shared/schema";

// The demo surface: what the operator sees. Consent comes from the
// Solana-synced cache (ChainPanel) — the stub toggles remain only for
// CONSENT_SOURCE="stub" (no-network fallback).
type RadioRow = Extract<OperatorMessage, { type: "radio" }>;

export function OperatorPanel({ fps, source, tracks, events, beacons, debug, decoder }: {
  fps: number; source: string; tracks: Track[]; events: FilmEvent[];
  beacons: BeaconReading[]; debug: BeaconDebug | null; decoder: "stub" | "optical";
}) {
  const [, force] = useState(0);
  useEffect(() => consentStore.subscribe(() => force((x) => x + 1)), []);
  const [svc, setSvc] = useState<Map<string, { alert?: string; provider?: string; attested?: { signature: string; explorer: string | null; count: number } }>>(new Map());
  const [svcUp, setSvcUp] = useState(false);
  const [radio, setRadio] = useState<RadioRow[]>([]);
  const [bridges, setBridges] = useState<number | null>(null);
  useEffect(() => {
    operatorLink.start();
    const t = setInterval(() => setSvcUp(operatorLink.connected), 1000);
    const off = operatorLink.subscribe((m: OperatorMessage) => {
      if (m.type === "health") { const r = (m as any).radio; if (r) { setBridges(r.bridges ?? 0); if (Array.isArray(r.recent)) setRadio(r.recent.slice(-6).reverse().map((x: any) => ({ type: "radio", ...x }))); } return; }
      if (m.type === "bridge") { setBridges(m.connected); return; }
      if (m.type === "radio") { setRadio((prev) => [m, ...prev].slice(0, 6)); return; }
      setSvc((prev) => {
        const next = new Map(prev);
        if (m.type === "alert") next.set(m.eventId, { ...next.get(m.eventId), alert: m.text, provider: m.provider });
        if (m.type === "attested") for (const id of m.eventIds) next.set(id, { ...next.get(id), attested: { signature: m.signature, explorer: m.explorer, count: m.count } });
        return next;
      });
    });
    return () => { clearInterval(t); off(); };
  }, []);

  const radioNote = (r: RadioRow): { text: string; url?: string; err?: boolean } => {
    if (r.dir === "down") return { text: r.delivered ? `→ badge via bridge` : "queued (no bridge connected)" };
    const o = r.outcome;
    if (!o) return { text: "" };
    if (o.result === "relayed") return { text: `badge-signed → on-chain ${o.consent ? "opt_in" : "opt_out"} (rev ${o.revision})`, url: o.explorer };
    if (o.result === "noop") return { text: "already on-chain; mirror re-sent" };
    if (o.result === "ignored") return { text: o.note };
    return { text: o.error, err: true };
  };
  const blurred = tracks.filter((t) => t.blurred).length;

  // Why is nothing decoding? Derived from the decoder's own diagnostics.
  const beaconHint = (): string | null => {
    if (decoder === "stub" || beacons.length || !debug || !debug.width) return null;
    const cands = debug.candidates;
    if (!cands.length) {
      return debug.bright < 0.002
        ? "no bright patch in frame — bring the badge closer (patch ≥ 40 px here), turn the screen to the camera, dim the room"
        : "bright areas but none shaped like the badge patch (2.3:1 with a white border) — face the screen squarely to the camera, avoid glare";
    }
    const best = cands.reduce((a, b) => (b.box.w > a.box.w ? b : a));
    if (!cands.some((c) => c.confident)) {
      if (best.box.w < flags.BEACON_MIN_W * 1.8) return `patch found but only ${Math.round(best.box.w)} px wide — move closer or raise the decode resolution`;
      if (best.borderLum <= flags.BEACON_MIN_BORDER) return `patch found (${Math.round(best.box.w)} px) but its white border reads ${Math.round(best.borderLum)}/255 — too dim: badge brightness up, room lights down`;
      return `patch found (${Math.round(best.box.w)} px, border ${Math.round(best.borderLum)}) but cell contrast is low — hold still, square to the camera`;
    }
    return "patch read cleanly — decoding (an id must repeat twice within 1.5 s; hold still ~1 s)";
  };
  const hint = beaconHint();

  return (
    <aside className="panel">
      <div className="stats">
        <div className="stat"><b>{fps}</b><span>fps</span></div>
        <div className="stat"><b>{tracks.length}</b><span>faces</span></div>
        <div className="stat"><b>{blurred}</b><span>blurred</span></div>
      </div>
      <div className="row"><span>source</span><b>{source}</b></div>

      <h3>Beacons <span className="muted">· {decoder === "stub" ? "stub (fake A1/C3)" : `optical · ${debug?.width ?? flags.PROCESS_WIDTH}px`}</span></h3>
      {beacons.map((b) => {
        const bound = tracks.find((t) => t.beaconId === b.beaconId);
        return (
          <div className="row" key={b.beaconId}>
            <span><b className="c-opt_in">{b.beaconId}</b> at {Math.round(b.imagePosition.x * 100)}%,{Math.round(b.imagePosition.y * 100)}%</span>
            <b className={bound ? "" : "muted"}>{bound ? `→ ${bound.trackId}` : "no face above it"}</b>
          </div>
        );
      })}
      {!beacons.length && <div className="muted">{hint ?? (decoder === "stub" ? "" : "none decoded")}</div>}

      <h3>Tracks</h3>
      <table>
        <thead><tr><th>track</th><th>beacon</th><th>consent</th><th>state</th></tr></thead>
        <tbody>
          {tracks.map((t) => (
            <tr key={t.trackId}>
              <td>{t.trackId}</td>
              <td>{t.beaconId ?? "—"}</td>
              <td className={"c-" + t.consent}>{t.consent}</td>
              <td>{t.blurred ? "🟥 blurred" : "🟩 clear"}</td>
            </tr>
          ))}
          {!tracks.length && <tr><td colSpan={4} className="muted">no faces</td></tr>}
        </tbody>
      </table>

      {chain ? (
        <ChainPanel cache={chain} />
      ) : (
        <>
        <h3>Consent <span className="muted">stub (no network)</span></h3>
        {(() => {
          const stored = consentStore.all().map(([id]) => id);
          const seen = tracks.map((t) => t.beaconId).filter((x): x is string => !!x);
          const ids = [...new Set([...stored, ...seen])];
          return ids.map((id) => {
            const c = consentStore.get(id); // "unknown" if a freshly-decoded badge
            return (
              <div className="row" key={id}>
                <span>{id}{!stored.includes(id) && <em className="muted"> · new</em>}</span>
                <button className={"toggle " + c} onClick={() => consentStore.toggle(id)}>{c}</button>
              </div>
            );
          });
        })()}
        </>
      )}

      <h3>Film events <span className="muted">→ badge alarm + ElevenLabs + on-chain hash</span> <span className={"dot " + (svcUp ? "ok" : "warn")} title={svcUp ? "notify service connected" : "notify service not connected"} /></h3>
      {events.map((e) => {
        const s = svc.get(e.eventId);
        return (
          <div className="event" key={e.eventId}>
            <div>📳 {e.beaconId}
              {s?.alert && <span className="muted" title={s.alert}> · 🔊 {s.provider}</span>}
              {s?.attested && (s.attested.explorer
                ? <a href={s.attested.explorer} target="_blank" rel="noreferrer" title={`anchored in commitment #${s.attested.count}`}> · ⛓ #{s.attested.count} ↗</a>
                : <span className="muted" title="anchored (confirmed from on-chain state)"> · ⛓ #{s.attested.count}</span>)}
            </div>
            <span>{new Date(e.at).toLocaleTimeString()}</span>
          </div>
        );
      })}
      {!events.length && <div className="muted">none yet</div>}

      <h3>Badge radio <span className="muted">· CNS frames ↕ bridge</span> <span className={"dot " + (bridges ? "ok" : svcUp ? "warn" : "")} title={bridges ? `${bridges} radio bridge(s) on the air` : "no radio bridge connected — frames queue for GET /bridge/pending"} /></h3>
      {radio.map((r, i) => {
        const n = radioNote(r);
        return (
          <div className={"act " + (r.dir === "up" ? "push" : n.err ? "error" : "info")} key={`${r.at}-${i}`}>
            <span className="t">{new Date(r.at).toLocaleTimeString()}</span>
            <span className="x"><b>{r.dir === "down" ? "↓" : "↑"} {r.frame}</b> · {n.text}</span>
            {n.url && <a href={n.url} target="_blank" rel="noreferrer">tx ↗</a>}
          </div>
        );
      })}
      {!radio.length && <div className="muted">{svcUp ? "no frames yet — a film-event sends CNSF, a consent change sends CNSC, the badge's A button sends CNSR" : "service offline"}</div>}
    </aside>
  );
}
