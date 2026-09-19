// Badge transport. The ESP32 either keeps a WebSocket open
// (ws://host:8787/badge?id=A1B2) or polls GET /badge/A1B2/pending. Messages
// are small JSON objects; the firmware only needs `type` and `buzzMs`.
// Sockets are pinged every 5 s; one that doesn't pong is terminated so a badge
// that walked out of Wi-Fi range falls back to the poll queue instead of
// swallowing its buzz.
import type { WebSocket } from "ws";

export interface BadgeMessage {
  type: "filmed" | "consent" | "hello";
  beaconId: string;
  at: number;
  cameraId?: string;
  buzzMs?: number;
  say?: string;
  consent?: boolean;
  revision?: number;
}

type LiveSocket = WebSocket & { alive?: boolean };

export class BadgeHub {
  private sockets = new Map<string, Set<LiveSocket>>();
  private pending = new Map<string, BadgeMessage[]>();
  private lastSeen = new Map<string, number>();
  private timer: ReturnType<typeof setInterval>;

  constructor(private log: (m: string) => void = () => {}) {
    this.timer = setInterval(() => this.heartbeat(), 5000);
    this.timer.unref?.();
  }

  attach(beaconId: string, ws: LiveSocket): void {
    const id = norm(beaconId);
    ws.on("error", (e) => this.log(`badge ${id} socket error: ${e.message}`));
    if (!this.sockets.has(id)) this.sockets.set(id, new Set());
    this.sockets.get(id)!.add(ws);
    this.lastSeen.set(id, Date.now());
    ws.alive = true;
    ws.on("pong", () => { ws.alive = true; this.lastSeen.set(id, Date.now()); });
    ws.on("close", () => this.sockets.get(id)?.delete(ws));
    ws.on("message", () => this.lastSeen.set(id, Date.now()));
    this.safeSend(ws, { type: "hello", beaconId: id, at: Date.now() });
    // flush anything queued while it was offline
    for (const m of this.drain(id)) this.safeSend(ws, m);
  }

  /** Deliver now over any live socket; otherwise queue for the next poll (bounded). */
  send(beaconId: string, msg: BadgeMessage): { delivered: number; queued: boolean } {
    const id = norm(beaconId);
    const socks = [...(this.sockets.get(id) ?? [])].filter((s) => s.readyState === s.OPEN && s.alive !== false);
    let delivered = 0;
    for (const s of socks) if (this.safeSend(s, msg)) delivered++;
    if (delivered) return { delivered, queued: false };
    const q = this.pending.get(id) ?? [];
    q.push(msg);
    this.pending.set(id, q.slice(-10));
    return { delivered: 0, queued: true };
  }

  drain(beaconId: string): BadgeMessage[] {
    const id = norm(beaconId);
    this.lastSeen.set(id, Date.now());
    const q = this.pending.get(id) ?? [];
    this.pending.delete(id);
    return q;
  }

  status(): Record<string, { online: boolean; queued: number; lastSeen: number | null }> {
    const ids = new Set([...this.sockets.keys(), ...this.pending.keys(), ...this.lastSeen.keys()]);
    const out: ReturnType<BadgeHub["status"]> = {};
    for (const id of ids) {
      out[id] = {
        online: [...(this.sockets.get(id) ?? [])].some((s) => s.readyState === s.OPEN && s.alive !== false),
        queued: this.pending.get(id)?.length ?? 0,
        lastSeen: this.lastSeen.get(id) ?? null,
      };
    }
    return out;
  }

  private heartbeat(): void {
    for (const set of this.sockets.values()) {
      for (const ws of set) {
        if (ws.readyState !== ws.OPEN) continue;
        if (ws.alive === false) { ws.terminate(); set.delete(ws); continue; }
        ws.alive = false;
        try { ws.ping(); } catch { /* terminated next round */ }
      }
    }
  }

  private safeSend(ws: WebSocket, msg: BadgeMessage): boolean {
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
}

export function norm(id: string): string {
  return id.toUpperCase().padStart(4, "0");
}
