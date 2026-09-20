// Badge radio bridge — the A ↔ C seam.
//
// The HTN badge has no Wi-Fi/HTTP. Its only radio is `badge.radio`, a
// restricted BLE broadcast channel carrying ≤44-byte payloads, and the Lua
// app (firmware/consentinel-beacon.lua) speaks three frames on it:
//
//   CNSF<id>        service → badge   "you were filmed": red LED alarm + banner for 6 s
//   CNSC<id><0|1>   service → badge   mirror of the on-chain consent (green/red on the badge)
//   CNSR<id><0|1>   badge → service   consent-change REQUEST from the A button (unsigned)
//
// A laptop cannot emit those BLE frames itself, so a *bridge* sits between us
// and the air: an ESP32 dev board on USB serial (scripts/serial-bridge.mts
// relays lines ↔ this service), or any device with Wi-Fi that opens
// ws://laptop:8787/bridge or polls GET /bridge/pending. This module is
// transport-agnostic: it queues downlink frames, accepts uplink frames, and
// turns a CNSR request into a badge-signed on-chain update.
//
// Why CNSR is only a request: the badge holds no keypair and cannot sign.
// The *registry client* signs — here, this service, with the badge's own key
// from BADGE_KEYS_DIR (the same key `npm run seed` registered as the record's
// owner). The program still verifies that Ed25519 signature on-chain, so a
// spoofed CNSR from someone else's radio can only ask; it cannot forge.
import type { WebSocket } from "ws";
import { join } from "node:path";
import { signConsentMessage } from "../../registry/client/src/registry";
import { badgeIdToU16, toHex } from "../../registry/client/src/core";
import { config } from "./config";
import { HttpError, loadKeypair, type Chain } from "./chain";

export const RADIO_TAG = "CNS";
export const RADIO_MAX_BYTES = 44;

export interface RadioFrame {
  kind: "F" | "C" | "R";
  id: string; // two upper-case hex digits
  consent?: boolean; // C and R only
  raw: string; // canonical frame text
}

const hex2 = (id: string): string => {
  const n = badgeIdToU16(id);
  if (n > 0xff) throw new Error(`badge id ${id} does not fit the 8-bit radio format`);
  return n.toString(16).toUpperCase().padStart(2, "0");
};

export const filmFrame = (id: string): string => `${RADIO_TAG}F${hex2(id)}`;
export const consentFrame = (id: string, optIn: boolean): string => `${RADIO_TAG}C${hex2(id)}${optIn ? "1" : "0"}`;
export const requestFrame = (id: string, optIn: boolean): string => `${RADIO_TAG}R${hex2(id)}${optIn ? "1" : "0"}`;

/** Parse one frame exactly as the Lua `on_radio` does. Returns null for anything else. */
export function parseFrame(raw: unknown): RadioFrame | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length < 6 || s.length > RADIO_MAX_BYTES || !s.startsWith(RADIO_TAG)) return null;
  const kind = s[3];
  const id = s.slice(4, 6).toUpperCase();
  if (!/^[0-9A-F]{2}$/.test(id)) return null;
  if (kind === "F") return s.length === 6 ? { kind, id, raw: `${RADIO_TAG}F${id}` } : null;
  if (kind === "C" || kind === "R") {
    const c = s[6];
    if (s.length !== 7 || (c !== "0" && c !== "1")) return null;
    return { kind, id, consent: c === "1", raw: `${RADIO_TAG}${kind}${id}${c}` };
  }
  return null;
}

export type UplinkResult =
  | { result: "relayed"; signature: string; explorer: string; consent: boolean; revision: number }
  | { result: "noop"; consent: boolean; note: string }
  | { result: "ignored"; note: string }
  | { result: "error"; error: string; status?: number };

export interface RadioEvent {
  at: number;
  dir: "down" | "up";
  frame: string;
  transport: string;
  delivered?: number;
  queued?: boolean;
  outcome?: UplinkResult;
}

export interface RadioStatus {
  bridges: number;
  queued: number;
  lastSeen: number | null;
  frames: { down: number; up: number };
  keysDir: string;
  recent: RadioEvent[];
}

type Broadcast = (msg: unknown) => void;

export class RadioBridge {
  private sockets = new Set<WebSocket>();
  private queue: string[] = []; // downlink frames waiting for a poll (no live bridge)
  private lastPushed = new Map<string, boolean>(); // id → last consent mirror sent
  private recent: RadioEvent[] = [];
  private counts = { down: 0, up: 0 };
  private lastSeen: number | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private chain: Chain,
    private broadcast: Broadcast,
    private log: (m: string) => void = () => {},
  ) {}

  // ---- downlink ---------------------------------------------------------------

  /** A film-event for this badge: the badge raises its alarm. */
  filmEvent(badgeId: string): RadioEvent | null {
    let frame: string;
    try { frame = filmFrame(badgeId); } catch (e) { this.log(`radio: ${(e as Error).message}`); return null; }
    return this.send(frame, "film-event");
  }

  /**
   * Mirror the on-chain consent down to the badge. Deduplicated per badge so a
   * poll that sees the same state twice does not spam the air; `force` (bridge
   * just connected, badge may have rebooted) always sends.
   */
  consentPush(badgeId: string, optIn: boolean, opts: { force?: boolean; why?: string } = {}): RadioEvent | null {
    let frame: string;
    try { frame = consentFrame(badgeId, optIn); } catch { return null; } // 16-bit ids never reach the radio
    const id = frame.slice(4, 6);
    if (!opts.force && this.lastPushed.get(id) === optIn) return null;
    this.lastPushed.set(id, optIn);
    return this.send(frame, opts.why ?? "consent-changed");
  }

  /** Push the current consent of every registered badge (bridge connect / periodic backstop). */
  async syncAll(force: boolean, why: string): Promise<number> {
    const snap = await this.chain.reg.fetchAll();
    let n = 0;
    for (const c of snap.consents) if (this.consentPush(c.badgeId, c.consent, { force, why })) n++;
    return n;
  }

  private send(frame: string, transport: string): RadioEvent {
    let delivered = 0;
    for (const ws of this.sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      try { ws.send(frame); delivered++; } catch { /* dropped; will be queued */ }
    }
    let queued = false;
    if (!delivered) {
      this.queue.push(frame);
      if (this.queue.length > 32) this.queue.shift();
      queued = true;
    }
    this.counts.down++;
    return this.record({ at: Date.now(), dir: "down", frame, transport, delivered, queued });
  }

  /** Poll transport: hand over and clear everything queued while no bridge was live. */
  drain(): string[] {
    this.lastSeen = Date.now();
    const q = this.queue;
    this.queue = [];
    return q;
  }

  // ---- uplink -----------------------------------------------------------------

  /** A frame heard on the air. Only CNSR does anything: it becomes a badge-signed, relayed consent update. */
  async uplink(raw: unknown, transport: string): Promise<UplinkResult> {
    this.lastSeen = Date.now();
    const f = parseFrame(raw);
    if (!f) {
      const out: UplinkResult = { result: "error", error: `not a CNS frame: ${JSON.stringify(String(raw).slice(0, 44))}`, status: 400 };
      this.record({ at: Date.now(), dir: "up", frame: String(raw).trim().slice(0, 44), transport, outcome: out });
      return out;
    }
    this.counts.up++;
    let outcome: UplinkResult;
    if (f.kind !== "R") outcome = { result: "ignored", note: `${f.kind === "F" ? "CNSF" : "CNSC"} is a downlink frame (echo from the bridge?)` };
    else outcome = await this.relayRequest(f).catch((e): UplinkResult => ({ result: "error", error: (e as Error).message, status: (e as HttpError).status }));
    this.record({ at: Date.now(), dir: "up", frame: f.raw, transport, outcome });
    return outcome;
  }

  /**
   * CNSR<id><c> → sign the 49-byte delegated message with the badge's key and
   * relay it (the same path as POST /consent/delegated, so every check —
   * owner, nonce, instance, expiry, signature — applies; the program repeats
   * them on-chain). A request that matches the current state is a no-op that
   * simply re-mirrors the state down to the badge.
   */
  private async relayRequest(f: RadioFrame): Promise<UplinkResult> {
    const keyPath = join(config.BADGE_KEYS_DIR, `badge-${f.id}.json`);
    const kp = loadKeypair(keyPath);
    if (!kp) return { result: "error", error: `no signing key for badge ${f.id} (${keyPath}) — run \`npm run seed\` in registry/`, status: 404 };
    const rec = await this.chain.reg.fetchConsent(f.id);
    if (!rec) return { result: "error", error: `${f.id} is not registered on-chain`, status: 404 };
    if (rec.owner !== kp.publicKey.toBase58()) return { result: "error", error: `key file ${keyPath} is not the owner of ${f.id}'s record`, status: 403 };
    if (rec.consent === f.consent) {
      this.consentPush(f.id, rec.consent, { force: true, why: "request-matches-chain" });
      return { result: "noop", consent: rec.consent, note: "already in that state on-chain; mirror re-sent" };
    }
    const expiresAt = Math.floor(Date.now() / 1000) + 120;
    const p = { consent: f.consent!, nonce: rec.revision, instance: rec.instance, expiresAt };
    const { signature, publicKey } = signConsentMessage(kp.secretKey, f.id, p);
    const r = await this.chain.relayDelegated({ badgeId: f.id, ...p, owner: publicKey.toBase58(), signature: toHex(signature) });
    this.log(`radio: ${f.raw} → ${r.consent ? "opt_in" : "opt_out"} on-chain (rev ${r.revision}) ${r.explorer}`);
    // the ConsentChanged log subscription also pushes this; dedupe makes it one frame
    this.consentPush(f.id, r.consent, { why: "request-relayed" });
    return { result: "relayed", ...r };
  }

  // ---- transports ---------------------------------------------------------------

  /** WebSocket bridge: text frames both ways. */
  attach(ws: WebSocket, label = "ws"): void {
    this.sockets.add(ws);
    this.lastSeen = Date.now();
    this.log(`radio bridge connected (${label}); ${this.sockets.size} live`);
    ws.on("error", (e) => this.log(`radio bridge error: ${e.message}`));
    ws.on("close", () => {
      this.sockets.delete(ws);
      this.broadcast({ type: "bridge", connected: this.sockets.size, at: Date.now() });
      this.log(`radio bridge disconnected; ${this.sockets.size} live`);
    });
    ws.on("message", (data) => {
      // one frame per message; tolerate newline-joined bursts from a serial relay
      for (const line of data.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.uplink(line, label).then((r) => { try { ws.send(JSON.stringify({ ack: line.trim(), ...r })); } catch { /* gone */ } });
      }
    });
    for (const f of this.drain()) { try { ws.send(f); } catch { /* gone */ } }
    this.broadcast({ type: "bridge", connected: this.sockets.size, at: Date.now() });
    void this.syncAll(true, "bridge-connected").catch((e) => this.log(`radio: sync on connect failed: ${(e as Error).message}`));
  }

  /** Periodic backstop while a bridge is live (the log subscription is the fast path). */
  start(intervalMs: number): void {
    if (this.syncTimer || intervalMs <= 0) return;
    this.syncTimer = setInterval(() => {
      if (!this.sockets.size) return;
      void this.syncAll(false, "periodic-sync").catch(() => {});
    }, intervalMs);
    this.syncTimer.unref?.();
  }

  status(): RadioStatus {
    return {
      bridges: [...this.sockets].filter((s) => s.readyState === s.OPEN).length,
      queued: this.queue.length,
      lastSeen: this.lastSeen,
      frames: { ...this.counts },
      keysDir: config.BADGE_KEYS_DIR,
      recent: this.recent.slice(-10),
    };
  }

  private record(ev: RadioEvent): RadioEvent {
    this.recent.push(ev);
    if (this.recent.length > 50) this.recent.shift();
    this.broadcast({ type: "radio", ...ev });
    return ev;
  }
}
