import { useEffect, useState } from "react";
import { consentStore } from "../stubs/consentStore";
import type { FilmEvent, Track } from "../shared/schema";

// The demo surface: what the operator sees. The consent toggles drive the stub
// cache today; C swaps them for on-chain reads and the live revoke→blur-flip
// beat works the same way.
export function OperatorPanel({ fps, source, tracks, events }: {
  fps: number; source: string; tracks: Track[]; events: FilmEvent[];
}) {
  const [, force] = useState(0);
  useEffect(() => consentStore.subscribe(() => force((x) => x + 1)), []);
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

      <h3>Consent <span className="muted">stub → Solana cache</span></h3>
      {consentStore.all().map(([id, c]) => (
        <div className="row" key={id}>
          <span>{id}</span>
          <button className={"toggle " + c} onClick={() => consentStore.toggle(id)}>{c}</button>
        </div>
      ))}

      <h3>Film events <span className="muted">→ badge buzz + ElevenLabs</span></h3>
      {events.map((e) => (
        <div className="event" key={e.eventId}>📳 {e.beaconId}<span>{new Date(e.at).toLocaleTimeString()}</span></div>
      ))}
      {!events.length && <div className="muted">none yet</div>}
    </aside>
  );
}
