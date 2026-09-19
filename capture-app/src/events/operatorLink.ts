// Feed from the notify service (alerts spoken via ElevenLabs, on-chain
// attestations of film-events). Optional: if the service isn't running the
// app just doesn't get the extras. Reconnects with backoff. Never touches
// the render loop.
import { flags } from "../config/flags";

export type OperatorMessage =
  | { type: "health"; [k: string]: unknown }
  | { type: "film-event"; entry: { eventId: string; beaconId: string; seq: number; hash: string }; delivery: { delivered: number; queued: boolean } }
  | { type: "alert"; beaconId: string; eventId: string; text: string; provider: string; audioUrl?: string; cached: boolean }
  | { type: "alert-error"; beaconId: string; error: string }
  | { type: "attested"; eventId: string; beaconId: string; signature: string; head: string; count: number; explorer: string }
  | { type: "delegated"; signature: string; explorer: string; consent: boolean; revision: number };

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
        if (m.type === "alert" && m.audioUrl && this.playAudio) {
          // the service already plays locally when it runs on this laptop;
          // playing here too covers the case where it runs elsewhere.
          void new Audio(m.audioUrl).play().catch(() => {});
        }
        this.listeners.forEach((l) => l(m));
      };
      ws.onclose = () => { this.connected = false; this.ws = null; this.retry(); };
      ws.onerror = () => { ws.close(); };
    } catch {
      this.retry();
    }
  }

  private retry(): void {
    setTimeout(() => this.open(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15_000);
  }
}

export const operatorLink = new OperatorLink();
