import { useEffect, useState } from "react";
import { operatorLink, type NoticeMsg } from "../events/operatorLink";

// The popup over the feed when an opted-out person is on camera: who was
// filmed and when, then "<name> has been notified — email sent", with a link
// to each of the two on-chain records (filmed, notified) as they confirm.
// Fed by the notify service over the operator socket; one toast per
// film-event, updated in place as the stages land, gone 15 s after the last.
const LINGER_MS = 15_000;
const terminal = (n: NoticeMsg) => n.stage === "notified" || n.stage === "unreachable" || n.stage === "error";
const t = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString();

export function NoticeToasts() {
  const [items, setItems] = useState<NoticeMsg[]>([]);
  useEffect(() => operatorLink.subscribe((m) => {
    if (m.type !== "notice" || m.stage === "coalesced") return; // covered by a toast already shown
    setItems((prev) => {
      const i = prev.findIndex((x) => x.eventId === m.eventId);
      const next = i >= 0 ? prev.map((x, k) => (k === i ? m : x)) : [m, ...prev];
      return next.slice(0, 3);
    });
  }), []);
  useEffect(() => {
    const id = setInterval(() => setItems((prev) => prev.filter((n) => !terminal(n) || Date.now() - n.at < LINGER_MS)), 1000);
    return () => clearInterval(id);
  }, []);
  if (!items.length) return null;
  return (
    <div className="toasts">
      {items.map((n) => {
        const who = n.person?.name ?? `Badge ${n.beaconId}`;
        const filmed = new Date(n.filmedAt).toLocaleTimeString();
        const cls = n.stage === "notified" ? "notified" : n.stage === "error" ? "error" : "";
        const emailed = n.notice?.channels.includes("email");
        return (
          <div className={"toast " + cls} key={n.eventId} role="status">
            <div className="head">
              {n.stage === "notified" ? (
                <>
                  <span>✅</span>
                  <b>{who} has been notified</b>
                  <span>{emailed && n.person?.email ? `— email sent to ${n.person.email}` : `— alerted by ${n.notice?.channels.join(" + ")}`}</span>
                </>
              ) : n.stage === "error" ? (
                <><span>⚠️</span><b>{who} was filmed at {filmed}</b><span>— {n.error}</span></>
              ) : n.stage === "unreachable" ? (
                <><span>📷</span><b>{who} was filmed at {filmed}</b><span>— no contact on file; capture recorded, nobody to tell</span></>
              ) : (
                <><span>📷</span><b>{who} was filmed at {filmed}</b><span>{n.stage === "queued" ? "— recording on Solana…" : "— notifying…"}</span></>
              )}
              <button className="x" title="dismiss" onClick={() => setItems((prev) => prev.filter((x) => x.eventId !== n.eventId))}>×</button>
            </div>
            <div className="sub">
              <span>badge {n.beaconId} · camera {n.cameraId}</span>
              {n.capture ? (
                n.capture.explorer
                  ? <a href={n.capture.explorer} target="_blank" rel="noreferrer" title={`recorded at ${t(n.capture.recordedAt)} (chain clock) · account ${n.capture.address}`}>⛓ filmed {filmed} ↗</a>
                  : <a href={n.capture.addressExplorer} target="_blank" rel="noreferrer">⛓ filmed {filmed} ↗</a>
              ) : <span>filmed {filmed}</span>}
              {n.notice && (n.notice.explorer
                ? <a href={n.notice.explorer} target="_blank" rel="noreferrer" title={`via ${n.notice.channels.join(", ")}`}>⛓ notified {t(n.notice.notifiedAt)} ↗</a>
                : <span>⛓ notified {t(n.notice.notifiedAt)}</span>)}
              {n.capture && <a href={n.capture.addressExplorer} target="_blank" rel="noreferrer" title="the on-chain notice account (badge id + timestamps; no name, no email)">record ↗</a>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
