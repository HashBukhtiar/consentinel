// Badge transport. The ESP32 either keeps a WebSocket open
// (ws://host:8787/badge?id=A1B2) or polls GET /badge/A1B2/pending. Messages
// are small JSON objects; the firmware only needs `type` and `buzzMs`.
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

export class BadgeHub {
  private sockets = new Map<string, Set<WebSocket>>();
  private pending = new Map<string, BadgeMessage[]>();
  private lastSeen = new Map<string, number>();

  attach(beaconId: string, ws: WebSocket): void {
    const id = norm(beaconId);
    if (!this.sockets.has(id)) this.sockets.set(id, new Set());
    this.sockets.get(id)!.add(ws);
    this.lastSeen.set(id, Date.now());
    ws.on("close", () => this.sockets.get(id)?.delete(ws));
    ws.on("message", () => this.lastSeen.set(id, Date.now()));
    ws.send(JSON.stringify({ type: "hello", beaconId: id, at: Date.now() } satisfies BadgeMessage));
    // flush anything queued while it was offline
    for (const m of this.drain(id)) ws.send(JSON.stringify(m));
  }

  /** Deliver now over any open socket; otherwise queue for the next poll (bounded). */
  send(beaconId: string, msg: BadgeMessage): { delivered: number; queued: boolean } {
    const id = norm(beaconId);
    const socks = [...(this.sockets.get(id) ?? [])].filter((s) => s.readyState === s.OPEN);
    for (const s of socks) s.send(JSON.stringify(msg));
    if (socks.length) return { delivered: socks.length, queued: false };
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
        online: [...(this.sockets.get(id) ?? [])].some((s) => s.readyState === s.OPEN),
        queued: this.pending.get(id)?.length ?? 0,
        lastSeen: this.lastSeen.get(id) ?? null,
      };
    }
    return out;
  }
}

export function norm(id: string): string {
  return id.toUpperCase().padStart(4, "0");
}
