// Append-only film-event log + the rolling hash that mirrors the on-chain
// CameraLog. Privacy by construction: a FilmEvent has no image data, and the
// chain only ever sees sha256(event) folded into the head.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ZERO_HEAD, bytesEqual, canonicalFilmEventJson, filmEventHash, fromHex, rollHead, toHex } from "../../registry/client/src/core";

export interface FilmEvent {
  eventId: string;
  beaconId: string;
  at: number;
  cameraId: string;
}

export interface AuditEntry extends FilmEvent {
  /** hex sha256(canonical JSON of the FilmEvent) */
  hash: string;
  /** sequence number in this log (1-based) */
  seq: number;
  /** on-chain attestation, filled in once the tx confirms */
  attest?: { signature: string; head: string; count: number; at: number };
}

export function isFilmEvent(x: unknown): x is FilmEvent {
  const e = x as FilmEvent;
  return (
    !!e && typeof e === "object" &&
    typeof e.eventId === "string" && e.eventId.length > 0 && e.eventId.length <= 64 &&
    typeof e.beaconId === "string" && /^[0-9a-fA-F]{1,4}$/.test(e.beaconId) &&
    typeof e.at === "number" && Number.isFinite(e.at) &&
    typeof e.cameraId === "string" && e.cameraId.length <= 32 &&
    // privacy guard: refuse anything that smuggles image-ish payloads
    !("image" in e) && !("frame" in e) && !("faces" in e) && !("data" in e)
  );
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private byId = new Map<string, AuditEntry>();

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.kind === "event") this.byId.set(rec.entry.eventId, rec.entry), this.entries.push(rec.entry);
          else if (rec.kind === "attest") {
            const e = this.byId.get(rec.eventId);
            if (e) e.attest = rec.attest;
          }
        } catch { /* skip corrupt line */ }
      }
    }
  }

  get size(): number { return this.entries.length; }
  all(): AuditEntry[] { return this.entries.slice(); }
  forBadge(beaconId: string): AuditEntry[] {
    const id = beaconId.toUpperCase().padStart(4, "0");
    return this.entries.filter((e) => e.beaconId.toUpperCase().padStart(4, "0") === id);
  }
  has(eventId: string): boolean { return this.byId.has(eventId); }

  append(ev: FilmEvent): AuditEntry {
    const clean: FilmEvent = { eventId: ev.eventId, beaconId: ev.beaconId.toUpperCase(), at: ev.at, cameraId: ev.cameraId };
    const entry: AuditEntry = { ...clean, hash: toHex(filmEventHash(clean)), seq: this.entries.length + 1 };
    this.entries.push(entry);
    this.byId.set(entry.eventId, entry);
    appendFileSync(this.path, JSON.stringify({ kind: "event", entry }) + "\n");
    return entry;
  }

  recordAttestation(eventId: string, attest: NonNullable<AuditEntry["attest"]>): void {
    const e = this.byId.get(eventId);
    if (!e) return;
    e.attest = attest;
    appendFileSync(this.path, JSON.stringify({ kind: "attest", eventId, attest }) + "\n");
  }

  /** Recompute the rolling head over the attested entries in order — must equal the on-chain head. */
  expectedHead(): { head: string; count: number } {
    let head: Uint8Array = ZERO_HEAD;
    let count = 0;
    for (const e of this.entries) {
      if (!e.attest) continue;
      head = rollHead(head, fromHex(e.hash));
      count++;
    }
    return { head: toHex(head), count };
  }

  /** Compare the local recomputation to what the chain says. */
  verify(onChain: { head: string; count: number }): { ok: boolean; local: { head: string; count: number }; onChain: typeof onChain } {
    const local = this.expectedHead();
    return { ok: local.count === onChain.count && bytesEqual(fromHex(local.head), fromHex(onChain.head)), local, onChain };
  }
}

export { canonicalFilmEventJson };
