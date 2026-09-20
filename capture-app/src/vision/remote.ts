// Client for the vision sidecar (vision/server.py): YOLOv8x-face + the badge
// digit model on the laptop's GPU, over a local WebSocket. One frame in flight
// at a time — while the sidecar works on a frame, newer ones are dropped, so
// the queue never grows and a result is at most one round trip stale.
// Nothing here can un-blur anyone: the loop falls back to the in-browser
// detector + classical decoder whenever the socket is down.
import { flags } from "../config/flags";

export interface RemoteBox { x: number; y: number; w: number; h: number } // normalized to the sent frame
export interface RemoteFace extends RemoteBox { conf: number }
export interface RemoteKey { id: number; hex: string; optIn: boolean; digits: number[]; box: RemoteBox; conf: number; key: boolean }
export interface RemoteDigit { cls: number; cool: boolean; box: RemoteBox; conf: number }
export interface RemoteResult {
  tMs: number; // the client clock stamp the frame was sent with
  w: number; h: number;
  faces: RemoteFace[];
  keys: RemoteKey[];
  digits: RemoteDigit[];
  ms: Record<string, number>;
  receivedMs: number; // client clock when the result arrived
}

export class RemoteVision {
  private ws: WebSocket | null = null;
  private inFlight = false;
  private sentAt = 0;
  private retryTimer = 0;
  private closed = false;
  connected = false;
  latest: RemoteResult | null = null;
  /** smoothed round trip (encode + transfer + inference), ms */
  rttMs = 0;
  frames = 0;

  constructor(private url = flags.VISION_URL) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch { this.retry(); return; }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { this.connected = true; this.inFlight = false; };
    ws.onmessage = (ev) => {
      this.inFlight = false;
      try {
        const r = JSON.parse(ev.data as string) as RemoteResult & { error?: string };
        if (r.error) return;
        r.receivedMs = performance.now();
        this.latest = r;
        this.frames++;
        const rtt = r.receivedMs - this.sentAt;
        this.rttMs = this.rttMs ? this.rttMs * 0.8 + rtt * 0.2 : rtt;
      } catch { /* malformed: ignore */ }
    };
    ws.onclose = ws.onerror = () => {
      if (this.ws !== ws) return;
      this.connected = false; this.inFlight = false; this.latest = null; this.ws = null;
      this.retry();
    };
    this.ws = ws;
  }

  private retry(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = window.setTimeout(() => { this.retryTimer = 0; this.connect(); }, 1500);
  }

  /** Offer this frame. Sent only when nothing is in flight; otherwise dropped. */
  submit(canvas: HTMLCanvasElement, tMs: number): void {
    if (!this.connected || this.inFlight || !this.ws) return;
    this.inFlight = true;
    this.sentAt = performance.now();
    canvas.toBlob((blob) => {
      if (!blob || !this.ws || this.ws.readyState !== WebSocket.OPEN) { this.inFlight = false; return; }
      blob.arrayBuffer().then((jpeg) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this.inFlight = false; return; }
        const buf = new ArrayBuffer(8 + jpeg.byteLength);
        new DataView(buf).setFloat64(0, tMs, true);
        new Uint8Array(buf, 8).set(new Uint8Array(jpeg));
        this.ws.send(buf);
      }).catch(() => { this.inFlight = false; });
    }, "image/jpeg", flags.VISION_JPEG_QUALITY);
  }

  /** The newest result not yet consumed by the loop (each result is handed out once). */
  take(): RemoteResult | null {
    const r = this.latest;
    this.latest = null;
    return r;
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }
}
