import { useEffect, useState } from "react";
import { consentStore } from "../stubs/consentStore";
import { chain } from "../consent/store";
import { operatorLink, type OperatorMessage } from "../events/operatorLink";
import { ChainPanel } from "./ChainPanel";
import type { FilmEvent, Track } from "../shared/schema";

// The demo surface: who's in frame, what consent says on-chain, and what was
// captured. Consent comes from the Solana-synced cache (ChainPanel); the stub
// toggles remain only for CONSENT_SOURCE="stub" (no-network fallback).
type RadioRow = Extract<OperatorMessage, { type: "radio" }>;
type SvcInfo = {
  alert?: string; provider?: string;
  attested?: { signature: string; explorer: string | null; count: number };
  notify?: "notified" | "queued"; // did the film-event reach a badge transport?
};

export function OperatorPanel({ tracks, events }: { tracks: Track[]; events: FilmEvent[] }) {
  const [, force] = useState(0);
  useEffect(() => consentStore.subscribe(() => force((x) => x + 1)), []);
  const [svc, setSvc] = useState<Map<string, SvcInfo>>(new Map());
  const [svcUp, setSvcUp] = useState(false);
  const [radio, setRadio] = useState<RadioRow[]>([]);
  const [bridges, setBridges] = useState<number | null>(null);
  // beaconId → time a CNSF frame was actually delivered over the radio bridge
  const [radioOk, setRadioOk] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    operatorLink.start();
    const t = setInterval(() => setSvcUp(operatorLink.connected), 1000);
    const off = operatorLink.subscribe((m: OperatorMessage) => {
      if (m.type === "health") { const r = (m as any).radio; if (r) { setBridges(r.bridges ?? 0); if (Array.isArray(r.recent)) setRadio(r.recent.slice(-6).reverse().map((x: any) => ({ type: "radio", ...x }))); } return; }
      if (m.type === "bridge") { setBridges(m.connected); return; }
      if (m.type === "radio") {
        setRadio((prev) => [m, ...prev].slice(0, 6));
        if (m.dir === "down" && m.frame.startsWith("CNSF") && (m.delivered ?? 0) > 0) {
          setRadioOk((prev) => new Map(prev).set(m.frame.slice(4).toUpperCase(), m.at));
        }
        return;
      }
      setSvc((prev) => {
        const next = new Map(prev);
        if (m.type === "film-event") next.set(m.entry.eventId, { ...next.get(m.entry.eventId), notify: m.delivery.delivered > 0 ? "notified" : "queued" });
        if (m.type === "alert") next.set(m.eventId, { ...next.get(m.eventId), alert: m.text, provider: m.provider });
        if (m.type === "attested") for (const id of m.eventIds) next.set(id, { ...next.get(id), attested: { signature: m.signature, explorer: m.explorer, count: m.count } });
        return next;
      });
    });
    return () => { clearInterval(t); off(); };
  }, []);

  const radioNote = (r: RadioRow): { text: string; url?: string; err?: boolean } => {
    if (r.dir === "down") return { text: r.delivered ? "→ badge via bridge" : "queued (no bridge connected)" };
    const o = r.outcome;
    if (!o) return { text: "" };
    if (o.result === "relayed") return { text: `badge-signed → on-chain ${o.consent ? "opt-in" : "opt-out"} (rev ${o.revision})`, url: o.explorer };
    if (o.result === "noop") return { text: "already on-chain; mirror re-sent" };
    if (o.result === "ignored") return { text: o.note };
    return { text: o.error, err: true };
  };

  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // Step 1, made visible: what the Solana lookup found for this badge.
  const recs = chain ? chain.records() : [];
  const onChain = (id?: string): { text: string; cls: string } => {
    if (!id) return { text: "no badge read", cls: "oc-muted" };
    if (!chain) return { text: "stub", cls: "oc-muted" };
    if (chain.stale) return { text: "cache stale", cls: "oc-warn" };
    const r = recs.find((x) => x.badgeId.toUpperCase() === id.toUpperCase());
    return r ? { text: `registered · rev ${r.revision}`, cls: "oc-ok" } : { text: "not registered", cls: "oc-no" };
  };

  // Step 2, made visible: did the notification reach the right badge?
  const notified = (e: FilmEvent): "notified" | "queued" | null => {
    const s = svc.get(e.eventId);
    const viaRadio = radioOk.get(e.beaconId.toUpperCase());
    if (s?.notify === "notified" || (viaRadio && viaRadio >= e.at - 1000)) return "notified";
    return s?.notify ?? null;
  };

  return (
    <aside className="panel">
      <h3>In frame</h3>
      {tracks.length ? (
        <table>
          <thead><tr><th>badge</th><th>on-chain</th><th>consent</th><th>shown as</th></tr></thead>
          <tbody>
            {tracks.map((t) => {
              const oc = onChain(t.beaconId);
              return (
                <tr key={t.trackId}>
                  <td>{t.beaconId ?? <span className="muted">none</span>}</td>
                  <td className={"oc " + oc.cls}>{oc.text}</td>
                  <td className={"c-" + t.consent}>{t.consent.replace("_", "-")}</td>
                  <td><span className={"state " + (t.blurred ? "blurred" : "clear")}>{t.blurred ? "blurred" : "clear"}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="empty-row">No one in frame</div>
      )}

      {chain ? (
        <ChainPanel cache={chain} />
      ) : (
        <>
          <h3>Consent <span className="muted">stub · no network</span></h3>
          {(() => {
            const stored = consentStore.all().map(([id]) => id);
            const seen = tracks.map((t) => t.beaconId).filter((x): x is string => !!x);
            const ids = [...new Set([...stored, ...seen])];
            return ids.map((id) => {
              const c = consentStore.get(id);
              return (
                <div className="row" key={id}>
                  <span className="mono">{id}{!stored.includes(id) && <em className="muted"> · new</em>}</span>
                  <button className={"toggle " + c} onClick={() => consentStore.toggle(id)}>{c.replace("_", "-")}</button>
                </div>
              );
            });
          })()}
        </>
      )}

      <h3>Recent captures <span className={"dot " + (svcUp ? "ok" : "warn")} title={svcUp ? "Notify service connected" : "Notify service offline"} /></h3>
      {events.map((e) => {
        const s = svc.get(e.eventId);
        const n = notified(e);
        return (
          <div className="event" key={e.eventId}>
            <div>
              <span className="mono">{e.beaconId}</span>
              <span className="muted">captured while opted out</span>
              {n === "notified" && <span className="tagx ok" title="the film-event reached this badge">notified</span>}
              {n === "queued" && <span className="tagx" title="no badge transport connected — frame is queued for the bridge">queued</span>}
              {s?.alert && <span className="tagx" title={s.alert}>voiced</span>}
              {s?.attested && (s.attested.explorer
                ? <a href={s.attested.explorer} target="_blank" rel="noreferrer" title={`anchored on-chain in commitment #${s.attested.count}`}>anchored ↗</a>
                : <span className="tagx" title="anchored (confirmed from on-chain state)">anchored</span>)}
            </div>
            <span>{time(e.at)}</span>
          </div>
        );
      })}
      {!events.length && <div className="empty-row">No opted-out captures yet</div>}

      <details className="debug">
        <summary>Badge radio <span className={"dot " + (bridges ? "ok" : svcUp ? "warn" : "")} title={bridges ? `${bridges} bridge(s) on the air` : "No radio bridge connected"} /></summary>
        {radio.map((r, i) => {
          const n = radioNote(r);
          return (
            <div className={"act " + (r.dir === "up" ? "push" : n.err ? "error" : "info")} key={`${r.at}-${i}`}>
              <span className="t">{time(r.at)}</span>
              <span className="x"><b>{r.dir === "down" ? "↓" : "↑"} {r.frame}</b> · {n.text}</span>
              {n.url && <a href={n.url} target="_blank" rel="noreferrer">tx ↗</a>}
            </div>
          );
        })}
        {!radio.length && <div className="empty-row">{svcUp ? "No frames yet" : "Service offline"}</div>}
      </details>
    </aside>
  );
}
