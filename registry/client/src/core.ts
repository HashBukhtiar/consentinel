// Pure helpers shared by the program tests, the TS client, the capture app,
// the notify service and (by spec) the badge firmware. No Anchor `Program`
// here — just PDAs, byte formats and hashing, so it runs anywhere.
import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";

/** Program id (devnet + localnet). Keep in sync with `declare_id!` and Anchor.toml. */
export const CONSENT_REGISTRY_PROGRAM_ID = new PublicKey("UKoViTT9288nMeBzjeMoHBBmxHfXvbg6F1gF6pjiSW7");

export const REGISTRY_SEED = "registry";
export const CONSENT_SEED = "consent";
export const OVERRIDE_SEED = "override";
export const CAMERA_SEED = "camera";

/** Must equal `CONSENT_MSG_PREFIX` in the program. */
export const CONSENT_MSG_PREFIX = new TextEncoder().encode("consentinel/consent/v1");
export const CONSENT_MSG_LEN = 22 + 2 + 1 + 8 + 8 + 8;
/** Program rejects delegated signatures valid for longer than this. */
export const MAX_DELEGATED_TTL_SECS = 24 * 60 * 60;
/** What the badge/operator uses by default: enough for a slow relay, not enough to hoard. */
export const DEFAULT_DELEGATED_TTL_SECS = 120;
export const MAX_EVENT_ID_LEN = 32;

// ---- badge ids -------------------------------------------------------------
// The beacon blinks 8–16 bits; the capture app carries it as an upper-case hex
// string ("A1B2"); on-chain it is a u16.

export function badgeIdToU16(id: string): number {
  const s = id.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,4}$/.test(s)) throw new Error(`bad badge id: ${JSON.stringify(id)}`);
  return parseInt(s, 16);
}

export function u16ToBadgeId(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error(`bad badge id number: ${n}`);
  return n.toString(16).toUpperCase().padStart(4, "0");
}

/** Canonical form of a beacon id as the capture app sees it: 4 upper-case hex chars. */
export function normalizeBadgeId(id: string): string {
  return u16ToBadgeId(badgeIdToU16(id));
}

export function u16le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}

export function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt.asUintN(64, n);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

// ---- PDAs -----------------------------------------------------------------

export function registryPda(programId: PublicKey = CONSENT_REGISTRY_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(REGISTRY_SEED)], programId);
}

export function consentPda(badgeId: number, programId: PublicKey = CONSENT_REGISTRY_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(CONSENT_SEED), u16le(badgeId)], programId);
}

/** Fixed-length seed for any event id: sha256(utf8(event_id)) — mirrors `event_seed` in the program. */
export function eventSeed(eventId: string): Uint8Array {
  return sha256(utf8(eventId)) as Uint8Array;
}

export function overridePda(
  badgeId: number,
  eventId: string,
  programId: PublicKey = CONSENT_REGISTRY_PROGRAM_ID,
): [PublicKey, number] {
  const e = utf8(eventId);
  if (e.length === 0 || e.length > MAX_EVENT_ID_LEN) throw new Error("event id must be 1..=32 bytes");
  return PublicKey.findProgramAddressSync([utf8(OVERRIDE_SEED), u16le(badgeId), eventSeed(eventId)], programId);
}

export function cameraPda(authority: PublicKey, programId: PublicKey = CONSENT_REGISTRY_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(CAMERA_SEED), authority.toBytes()], programId);
}

// ---- delegated consent message --------------------------------------------

/**
 * The exact 49 bytes a badge signs to change its own consent without holding
 * SOL: `"consentinel/consent/v1" || badge_id u16 LE || consent u8 || nonce u64 LE
 * || instance u64 LE || expires_at i64 LE`.
 * `nonce` must equal the record's current `revision`, `instance` the record's
 * `instance` (unique per registration, so nothing replays across a close +
 * re-register), and `expires_at` is a unix-seconds deadline (≤ 24h out).
 */
export function consentMessage(badgeId: number, consent: boolean, nonce: bigint, instance: bigint, expiresAt: bigint): Uint8Array {
  const m = new Uint8Array(CONSENT_MSG_LEN);
  m.set(CONSENT_MSG_PREFIX, 0);
  m.set(u16le(badgeId), 22);
  m[24] = consent ? 1 : 0;
  m.set(u64le(nonce), 25);
  m.set(u64le(instance), 33);
  m.set(u64le(BigInt.asUintN(64, expiresAt)), 41);
  return m;
}

/** Default deadline for a freshly signed message. */
export function defaultExpiresAt(nowMs: number = Date.now(), ttlSecs: number = DEFAULT_DELEGATED_TTL_SECS): number {
  return Math.floor(nowMs / 1000) + ttlSecs;
}

// ---- audit hash chain ------------------------------------------------------

/** sha256 of the canonical JSON of a FilmEvent (no image data by construction). */
export function filmEventHash(e: { eventId: string; beaconId: string; at: number; cameraId: string }): Uint8Array {
  return sha256(new TextEncoder().encode(canonicalFilmEventJson(e))) as Uint8Array;
}

/** Field order is fixed so every party hashes identical bytes. */
export function canonicalFilmEventJson(e: { eventId: string; beaconId: string; at: number; cameraId: string }): string {
  return JSON.stringify({ eventId: e.eventId, beaconId: e.beaconId, at: e.at, cameraId: e.cameraId });
}

/** `head_n = sha256(head_{n-1} || commitment_n)` — mirrors `attest_capture`. */
export function rollHead(head: Uint8Array, commitment: Uint8Array): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(head, 0);
  buf.set(commitment, 32);
  return sha256(buf) as Uint8Array;
}

export const ZERO_HEAD: Uint8Array = new Uint8Array(32);
/** A heartbeat interval with no film-events commits the zero hash. */
export const HEARTBEAT_COMMITMENT: Uint8Array = new Uint8Array(32);

/**
 * Commitment for one attestation interval: sha256 of the interval's film-event
 * hashes concatenated in log order, or the zero hash if there were none.
 */
export function batchCommitment(eventHashes: Uint8Array[]): Uint8Array {
  if (eventHashes.length === 0) return HEARTBEAT_COMMITMENT;
  const buf = new Uint8Array(32 * eventHashes.length);
  eventHashes.forEach((h, i) => buf.set(h, 32 * i));
  return sha256(buf) as Uint8Array;
}

export function toHex(b: Uint8Array | number[]): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(h: string): Uint8Array {
  const s = h.replace(/^0x/, "");
  if (s.length % 2) throw new Error("odd hex length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array | number[], b: Uint8Array | number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- explorer links --------------------------------------------------------

export type Cluster = "devnet" | "localnet" | "testnet" | "mainnet-beta";

export function explorerUrl(kind: "tx" | "address", id: string, cluster: Cluster = "devnet"): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  if (cluster === "mainnet-beta") return base;
  if (cluster === "localnet") return `${base}?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899`;
  return `${base}?cluster=${cluster}`;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
