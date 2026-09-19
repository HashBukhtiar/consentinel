// Append-only film-event log + the batch commitments that mirror the on-chain
// CameraLog. Privacy by construction: a FilmEvent has no image data, and the
// chain only ever sees one 32-byte commitment per interval — the hash of that
// interval's event hashes, or the zero hash for an empty interval — folded
// into the camera's rolling head.
//
// Verification recomputes everything from the raw fields (never trusts a
// stored hash), so editing, reordering or deleting an event is detectable.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ZERO_HEAD, batchCommitment, bytesEqual, canonicalFilmEventJson, filmEventHash, fromHex, normalizeBadgeId, rollHead, toHex,
} from "../../registry/client/src/core";

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
  /** filled in once the batch containing this event confirms on-chain */
  batch?: number;
}

export interface Batch {
  seq: number; // 1-based, == on-chain count after this batch
  eventIds: string[]; // in log order; empty ⇒ heartbeat
  commitment: string; // hex
  head: string; // hex head after folding
  signature: string;
  at: number;
}

export interface HeadCheck {
  head: string;
  count: number;
  /** events whose recomputed hash or batch commitment differ from what was stored */
  mismatches: string[];
  /** events not covered by any confirmed batch (queued, or lost) */
  unanchored: number;
}

const ALLOWED_KEYS = new Set(["eventId", "beaconId", "at", "cameraId"]);

/** Strict allowlist: exactly the four FilmEvent fields, nothing else (no image-ish payloads by construction). */
export function isFilmEvent(x: unknown): x is FilmEvent {
  const e = x as FilmEvent;
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  if (!Object.keys(e).every((k) => ALLOWED_KEYS.has(k))) return false;
  return (
    typeof e.eventId === "string" && e.eventId.length > 0 && e.eventId.length <= 64 &&
    typeof e.beaconId === "string" && /^[0-9a-fA-F]{1,4}$/.test(e.beaconId) &&
    typeof e.at === "number" && Number.isFinite(e.at) && e.at > 0 &&
    typeof e.cameraId === "string" && e.cameraId.length > 0 && e.cameraId.length <= 32
  );
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private byId = new Map<string, AuditEntry>();
  private batches: Batch[] = [];

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.kind === "event") this.byId.set(rec.entry.eventId, rec.entry), this.entries.push(rec.entry);
          else if (rec.kind === "batch") {
            this.batches.push(rec.batch);
            for (const id of rec.batch.eventIds) {
              const e = this.byId.get(id);
              if (e) e.batch = rec.batch.seq;
            }
          }
        } catch { /* skip corrupt line */ }
      }
    }
  }

  get size(): number { return this.entries.length; }
  get batchCount(): number { return this.batches.length; }
  all(): AuditEntry[] { return this.entries.slice(); }
  allBatches(): Batch[] { return this.batches.slice(); }
  forBadge(beaconId: string): AuditEntry[] {
    const id = normalizeBadgeId(beaconId);
    return this.entries.filter((e) => e.beaconId === id);
  }
  has(eventId: string): boolean { return this.byId.has(eventId); }
  get(eventId: string): AuditEntry | undefined { return this.byId.get(eventId); }
  unanchored(): AuditEntry[] { return this.entries.filter((e) => e.batch === undefined); }

  append(ev: FilmEvent): AuditEntry {
    const clean: FilmEvent = { eventId: ev.eventId, beaconId: normalizeBadgeId(ev.beaconId), at: ev.at, cameraId: ev.cameraId };
    const entry: AuditEntry = { ...clean, hash: toHex(filmEventHash(clean)), seq: this.entries.length + 1 };
    this.entries.push(entry);
    this.byId.set(entry.eventId, entry);
    appendFileSync(this.path, JSON.stringify({ kind: "event", entry }) + "\n");
    return entry;
  }

  /** The on-chain head/count that folding `eventIds` next would produce (pure; nothing recorded). */
  nextHead(eventIds: string[]): { commitment: Uint8Array; head: Uint8Array; count: number } {
    const prev = this.batches.length ? fromHex(this.batches[this.batches.length - 1].head) : ZERO_HEAD;
    const hashes = eventIds.map((id) => {
      const e = this.byId.get(id);
      if (!e) throw new Error(`unknown event ${id}`);
      return fromHex(e.hash);
    });
    const commitment = batchCommitment(hashes);
    return { commitment, head: rollHead(prev, commitment), count: this.batches.length + 1 };
  }

  recordBatch(b: Omit<Batch, "seq">): Batch {
    const batch: Batch = { seq: this.batches.length + 1, ...b };
    this.batches.push(batch);
    for (const id of batch.eventIds) {
      const e = this.byId.get(id);
      if (e) e.batch = batch.seq;
    }
    appendFileSync(this.path, JSON.stringify({ kind: "batch", batch }) + "\n");
    return batch;
  }

  /**
   * Recompute the rolling head from raw fields — the same fold the program
   * performs — and flag anything that no longer matches what was recorded.
   */
  expectedHead(): HeadCheck {
    let head: Uint8Array = ZERO_HEAD;
    const mismatches: string[] = [];
    for (const b of this.batches) {
      const hashes: Uint8Array[] = [];
      for (const id of b.eventIds) {
        const e = this.byId.get(id);
        if (!e) { mismatches.push(id); continue; }
        const h = filmEventHash(e);
        if (toHex(h) !== e.hash) mismatches.push(id);
        hashes.push(h);
      }
      const c = batchCommitment(hashes);
      if (toHex(c) !== b.commitment) mismatches.push(`batch#${b.seq}`);
      head = rollHead(head, c);
    }
    return { head: toHex(head), count: this.batches.length, mismatches, unanchored: this.unanchored().length };
  }

  /** Compare the local recomputation to what the chain says. */
  verify(onChain: { head: string; count: number }): { ok: boolean; complete: boolean; local: HeadCheck; onChain: typeof onChain } {
    const local = this.expectedHead();
    const ok = local.count === onChain.count && bytesEqual(fromHex(local.head), fromHex(onChain.head)) && local.mismatches.length === 0;
    return { ok, complete: ok && local.unanchored === 0, local, onChain };
  }
}

export { canonicalFilmEventJson };
