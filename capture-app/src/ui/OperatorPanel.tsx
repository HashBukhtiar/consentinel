import { useEffect, useState } from "react";
import { consentStore } from "../stubs/consentStore";
import { chain } from "../consent/store";
import { operatorLink, type OperatorMessage } from "../events/operatorLink";
import { ChainPanel } from "./ChainPanel";
import type { FilmEvent, Track } from "../shared/schema";

// The demo surface: what the operator sees. Consent comes from the
// Solana-synced cache (ChainPanel) — the stub toggles remain only for
// CONSENT_SOURCE="stub" (no-network fallback).
export function OperatorPanel({ fps, source, tracks, events }: {
  fps: number; source: string; tracks: Track[]; events: FilmEvent[];
}) {
  const [, force] = useState(0);
  useEffect(() => consentStore.subscribe(() => force((x) => x + 1)), []);
  const [svc, setSvc] = useState<Map<string, { alert?: string; provider?: string; attested?: { signature: string; explorer: string; count: number } }>>(new Map());
  const [svcUp, setSvcUp] = useState(false);
  useEffect(() => {
    operatorLink.start();
    const t = setInterval(() => setSvcUp(operatorLink.connected), 1000);
    const off = operatorLink.subscribe((m: OperatorMessage) => {
      setSvc((prev) => {
        const next = new Map(prev);
        if (m.type === "alert") next.set(m.eventId, { ...next.get(m.eventId), alert: m.text, provider: m.provider });
        if (m.type === "attested") next.set(m.eventId, { ...next.get(m.eventId), attested: { signature: m.signature, explorer: m.explorer, count: m.count } });
        return next;
      });
    });
    return () => { clearInterval(t); off(); };
  }, []);
  const blurred = tracks.filter((t) => t.blurred).length;

  return (
    <aside className="panel">
      <div className="stats">
        <div className="stat"><b>{fps}</b><span>fps</span></div>
        <div className="stat"><b>{tracks.length}</b><span>faces</span></div>
        <div className="stat"><b>{blurred}</b><span>blurred</span></div>
      </div>
      <div className="row"><span>source</span><b>{source}</b></div>

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
          {consentStore.all().map(([id, c]) => (
            <div className="row" key={id}>
              <span>{id}</span>
              <button className={"toggle " + c} onClick={() => consentStore.toggle(id)}>{c}</button>
            </div>
          ))}
        </>
      )}

      <h3>Film events <span className="muted">→ badge buzz + ElevenLabs + on-chain hash</span> <span className={"dot " + (svcUp ? "ok" : "warn")} title={svcUp ? "notify service connected" : "notify service not connected"} /></h3>
      {events.map((e) => {
        const s = svc.get(e.eventId);
        return (
          <div className="event" key={e.eventId}>
            <div>📳 {e.beaconId}
              {s?.alert && <span className="muted" title={s.alert}> · 🔊 {s.provider}</span>}
              {s?.attested && <a href={s.attested.explorer} target="_blank" rel="noreferrer" title={`capture #${s.attested.count} anchored`}> · ⛓ #{s.attested.count} ↗</a>}
            </div>
            <span>{new Date(e.at).toLocaleTimeString()}</span>
          </div>
        );
      })}
      {!events.length && <div className="muted">none yet</div>}
    </aside>
  );
}
