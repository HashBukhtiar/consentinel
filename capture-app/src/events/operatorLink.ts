// Feed from the notify service (alerts spoken via ElevenLabs, on-chain
// attestations of film-events). Optional: if the service isn't running the
// app just doesn't get the extras. Reconnects with backoff. Never touches
// the render loop.
import { flags } from "../config/flags";

/**
 * The notice path for one film-event, as the service reports it at every
 * stage: filed on-chain (record_capture), the person told (email dry-run +
 * whatever else reached them), told on-chain (record_notice). Names and the
 * masked email come from the organizer's off-chain directory, never the chain.
 */
export interface NoticeMsg {
  type: "notice";
  at: number;
  stage: "queued" | "recorded" | "notified" | "unreachable" | "error";
  eventId: string;
  beaconId: string;
  eventHash: string;
  cameraId: string;
  filmedAt: number; // ms, camera clock
  person: { name: string; email?: string } | null; // email masked
  capture?: { signature: string; explorer: string; address: string; addressExplorer: string; recordedAt: number }; // unix s, chain clock
  notice?: { signature: string; explorer: string; notifiedAt: number; channels: string[] }; // unix s, chain clock
  email?: { to: string; subject: string; mode: string; at: number };
  error?: string;
}

export type OperatorMessage =
  | { type: "health"; [k: string]: unknown }
  | NoticeMsg
  | { type: "film-event"; entry: { eventId: string; beaconId: string; seq: number; hash: string }; delivery: { delivered: number; queued: boolean } }
  | { type: "alert"; beaconId: string; eventId: string; text: string; provider: string; audioUrl?: string; cached: boolean; playedLocally?: boolean }
  | { type: "alert-error"; beaconId: string; error: string }
  | { type: "attested"; batch: number; eventIds: string[]; beaconIds: string[]; heartbeat: boolean; signature: string; head: string; count: number; explorer: string | null }
  | { type: "delegated"; signature: string; explorer: string; consent: boolean; revision: number }
  // badge radio (A ↔ C): CNSF/CNSC frames going down to the badge, CNSR requests coming up
  | { type: "radio"; at: number; dir: "down" | "up"; frame: string; transport: string; delivered?: number; queued?: boolean; outcome?: RadioOutcome }
  | { type: "bridge"; connected: number; at: number };

export type RadioOutcome =
  | { result: "relayed"; signature: string; explorer: string; consent: boolean; revision: number }
  | { result: "noop"; consent: boolean; note: string }
  | { result: "ignored"; note: string }
  | { result: "error"; error: string; status?: number };

type Listener = (m: OperatorMessage) => void;

class OperatorLink {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private backoff = 1000;
  connected = false;
  playAudio = true;

  start(): void {
    if (!flags.SERVICE_WS_URL || this.ws) return;
    this.open();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private open(): void {
    try {
      const ws = new WebSocket(flags.SERVICE_WS_URL);
      this.ws = ws;
      ws.onopen = () => { this.connected = true; this.backoff = 1000; };
      ws.onmessage = (ev) => {
        let m: OperatorMessage;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "alert" && m.audioUrl && this.playAudio && !m.playedLocally) {
          // the service plays through the laptop speakers when it runs here;
          // the browser plays only when the service says it did not.
          void new Audio(this.serviceHttp(m.audioUrl)).play().catch(() => {});
        }
        this.listeners.forEach((l) => l(m));
      };
      ws.onclose = () => { this.connected = false; this.ws = null; this.retry(); };
      ws.onerror = () => { ws.close(); };
    } catch {
      this.retry();
    }
  }

  /** Resolve a service-relative path against the configured service origin. */
  serviceHttp(path: string): string {
    try { return new URL(path, flags.SERVICE_WS_URL.replace(/^ws/, "http")).toString(); } catch { return path; }
  }

  private retry(): void {
    setTimeout(() => this.open(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15_000);
  }
}

export const operatorLink = new OperatorLink();
