// Pure helpers shared by the program tests, the TS client, the capture app,
// the notify service and (by spec) the badge firmware. No Anchor `Program`
// here — just PDAs, byte formats and hashing, so it runs anywhere.
import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";

/** Program id (devnet + localnet). Keep in sync with `declare_id!` and Anchor.toml. */
export const CONSENT_REGISTRY_PROGRAM_ID = new PublicKey("UKoViTT9288nMeBzjeMoHBBmxHfXvbg6F1gF6pjiSW7");

export const CONSENT_SEED = "consent";
export const OVERRIDE_SEED = "override";
export const CAMERA_SEED = "camera";

/** Must equal `CONSENT_MSG_PREFIX` in the program. */
export const CONSENT_MSG_PREFIX = new TextEncoder().encode("consentinel/consent/v1");
export const CONSENT_MSG_LEN = 22 + 2 + 1 + 8;
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

export function consentPda(badgeId: number, programId: PublicKey = CONSENT_REGISTRY_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(CONSENT_SEED), u16le(badgeId)], programId);
}

export function overridePda(
  badgeId: number,
  eventId: string,
  programId: PublicKey = CONSENT_REGISTRY_PROGRAM_ID,
): [PublicKey, number] {
  const e = utf8(eventId);
  if (e.length === 0 || e.length > MAX_EVENT_ID_LEN) throw new Error("event id must be 1..=32 bytes");
  return PublicKey.findProgramAddressSync([utf8(OVERRIDE_SEED), u16le(badgeId), e], programId);
}

export function cameraPda(authority: PublicKey, programId: PublicKey = CONSENT_REGISTRY_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(CAMERA_SEED), authority.toBytes()], programId);
}

// ---- delegated consent message --------------------------------------------

/**
 * The exact 33 bytes a badge signs to change its own consent without holding
 * SOL: `"consentinel/consent/v1" || badge_id u16 LE || consent u8 || nonce u64 LE`.
 * `nonce` must equal the record's current `revision`.
 */
export function consentMessage(badgeId: number, consent: boolean, nonce: bigint): Uint8Array {
  const m = new Uint8Array(CONSENT_MSG_LEN);
  m.set(CONSENT_MSG_PREFIX, 0);
  m.set(u16le(badgeId), 22);
  m[24] = consent ? 1 : 0;
  m.set(u64le(nonce), 25);
  return m;
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

/** `head_n = sha256(head_{n-1} || event_hash_n)` — mirrors `attest_capture`. */
export function rollHead(head: Uint8Array, eventHash: Uint8Array): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(head, 0);
  buf.set(eventHash, 32);
  return sha256(buf) as Uint8Array;
}

export const ZERO_HEAD: Uint8Array = new Uint8Array(32);

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
