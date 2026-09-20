// The service's Solana side:
//  1. Attestation. Every ATTEST_INTERVAL_MS exactly one `attest_capture` is
//     submitted: the commitment of that interval's film-events, or a zero
//     "heartbeat" commitment when nothing happened. A constant cadence means
//     the public chain carries no signal about when (or whether) anyone was
//     filmed — only a commitment stream that proves the operator's off-chain
//     log is complete and unmodified.
//  2. Relay. Badge-signed consent updates are checked off-chain (for a useful
//     error) and submitted with the relayer paying the fee; the program
//     re-verifies everything on-chain.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import nacl from "tweetnacl";
import { ConsentRegistryClient, anchorErrorCode, keypairSigner, type CameraView } from "../../registry/client/src/registry";
import { MAX_DELEGATED_TTL_SECS, badgeIdToU16, capturePda, consentMessage, explorerUrl, fromHex, normalizeBadgeId, toHex } from "../../registry/client/src/core";
import { config } from "./config";
import type { AuditEntry, AuditLog, Batch } from "./audit";

export function loadKeypair(path: string): Keypair | null {
  if (!existsSync(path)) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export interface AttestStatus {
  enabled: boolean;
  intervalMs: number;
  heartbeat: boolean;
  camera: string | null;
  cameraRegistered: boolean;
  pending: number;
  inFlight: boolean;
  batches: number;
  failures: number;
  consecutiveFailures: number;
  pausedUntil: number | null;
  dropped: number;
  lastSignature: string | null;
  lastError: string | null;
  onChain: CameraView | null;
}

export class Chain {
  readonly conn: Connection;
  readonly reg: ConsentRegistryClient;
  readonly camera: Keypair | null;
  readonly relayer: Keypair | null;
  private pending: AuditEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  private failures = 0;
  private dropped = 0;
  private lastSignature: string | null = null;
  private lastError: string | null = null;
  private cameraView: CameraView | null = null;
  private relayLocks = new Map<string, Promise<unknown>>();

  constructor(
    private audit: AuditLog,
    private onBatch: (b: Batch, entries: AuditEntry[]) => void,
    private log: (m: string) => void = console.log,
  ) {
    this.conn = new Connection(config.SOLANA_RPC_URL, "confirmed");
    this.reg = new ConsentRegistryClient(this.conn);
    this.camera = loadKeypair(config.CAMERA_KEYPAIR);
    this.relayer = loadKeypair(config.RELAYER_KEYPAIR);
  }

  async init(): Promise<void> {
    if (!this.camera) {
      this.lastError = `no camera keypair at ${config.CAMERA_KEYPAIR} — run \`npm run seed\` in registry/`;
      return;
    }
    try {
      this.cameraView = await this.reg.fetchCamera(this.camera.publicKey);
      if (!this.cameraView) {
        this.lastError = "camera not registered on-chain — run `npm run seed` in registry/";
        return;
      }
      // reconcile the reloaded log with the chain before touching it: batches
      // that landed while the previous process was dying are re-derived and
      // recorded, so a Ctrl+C mid-confirmation never forks the local log.
      const recovered = this.audit.recover({ head: this.cameraView.head, count: this.cameraView.count });
      if (recovered) this.log(`recovered ${recovered} batch(es) that landed on-chain before the last shutdown`);
      const v = this.audit.verify({ head: this.cameraView.head, count: this.cameraView.count });
      if (!v.ok) this.lastError = `local audit log does not match on-chain head (local count ${v.local.count}, chain ${v.onChain.count}, mismatches ${v.local.mismatches.length})`;
      const backlog = this.audit.unanchored();
      if (backlog.length) {
        this.log(`re-queueing ${backlog.length} unanchored film-event(s) from a previous run`);
        this.pending.push(...backlog);
      }
    } catch (e) {
      this.lastError = (e as Error).message;
    }
    if (this.enabled && !this.timer) {
      this.timer = setInterval(() => void this.tick(), config.ATTEST_INTERVAL_MS);
    }
  }

  get enabled(): boolean {
    return config.ATTEST_ON_CHAIN && !!this.camera && !!this.cameraView;
  }

  /** Queue an entry for the next interval's commitment. */
  enqueue(entry: AuditEntry): void {
    if (!this.enabled) return;
    if (this.pending.length >= config.MAX_PENDING_EVENTS) {
      this.pending.shift();
      this.dropped++;
    }
    this.pending.push(entry);
  }

  private async tick(): Promise<void> {
    if (this.inFlight || Date.now() < this.pausedUntil) return;
    if (!this.pending.length && !config.ATTEST_HEARTBEAT) return;
    const entries = this.pending.splice(0);
    this.inFlight = true;
    try {
      await this.submitBatch(entries);
    } finally {
      this.inFlight = false;
    }
  }

  private async submitBatch(entries: AuditEntry[]): Promise<void> {
    const ids = entries.map((e) => e.eventId);
    const next = this.audit.nextHead(ids);
    const expectedHead = toHex(next.head);
    let signature: string;
    try {
      signature = await this.reg.attestCapture(keypairSigner(this.camera!), next.commitment);
    } catch (e) {
      // The tx may have landed even though confirmation threw (blockhash
      // expiry, RPC timeout). Check the chain before deciding it failed —
      // folding the same commitment twice would fork the chain for good.
      const cam = await this.reg.fetchCamera(this.camera!.publicKey).catch(() => null);
      if (cam && cam.head === expectedHead && cam.count === next.count) {
        signature = "(landed; confirmed by on-chain state)";
      } else {
        this.failures++;
        this.consecutiveFailures++;
        this.lastError = (e as Error).message.split("\n")[0];
        this.pending.unshift(...entries); // keep order; retry next interval
        if (this.consecutiveFailures >= 3) {
          this.pausedUntil = Date.now() + 15_000;
          this.log(`attestation paused 15s after ${this.consecutiveFailures} failures: ${this.lastError}`);
        }
        return;
      }
    }
    const batch = this.audit.recordBatch({ eventIds: ids, commitment: toHex(next.commitment), head: expectedHead, signature, at: Date.now() });
    this.consecutiveFailures = 0;
    this.lastSignature = signature;
    this.lastError = null;
    // best-effort refresh; a lagging RPC may still show the previous head
    const cam = await this.reg.fetchCamera(this.camera!.publicKey).catch(() => null);
    if (cam) this.cameraView = cam;
    if (cam && cam.head !== expectedHead) this.lastError = `RPC re-read lags behind (chain ${cam.count}, local ${batch.seq}); will reconcile`;
    this.onBatch(batch, entries);
  }

  // ---- capture notices (filmed / notified) ------------------------------------

  /**
   * `record_capture` for one audit entry: the notice PDA is keyed by the
   * entry's hash, `filmed_at` is the camera's clock (FilmEvent.at) in seconds.
   * If the send throws after the transaction landed (blockhash expiry, RPC
   * timeout) the account is there — read it back instead of failing.
   */
  async recordCapture(entry: AuditEntry): Promise<{ signature: string; explorer: string; address: string; recordedAt: number }> {
    if (!this.camera) throw new Error(`no camera keypair at ${config.CAMERA_KEYPAIR}`);
    const hash = fromHex(entry.hash);
    const [pda] = capturePda(this.camera.publicKey, hash, this.reg.programId);
    const filmedAt = Math.floor(entry.at / 1000);
    let signature: string;
    try {
      signature = await this.reg.recordCapture(keypairSigner(this.camera), entry.beaconId, hash, filmedAt);
    } catch (e) {
      const existing = await this.reg.fetchCapture(this.camera.publicKey, hash).catch(() => null);
      if (!existing) throw e;
      signature = "(landed; confirmed by on-chain state)";
    }
    const view = await this.reg.fetchCapture(this.camera.publicKey, hash).catch(() => null);
    return { signature, explorer: signature.startsWith("(") ? "" : explorerUrl("tx", signature, config.SOLANA_CLUSTER), address: pda.toBase58(), recordedAt: view?.recordedAt ?? Math.floor(Date.now() / 1000) };
  }

  /** `record_notice`: the person was told over `channels` (CHANNEL_* bits); the chain clock stamps it. */
  async recordNotice(entry: AuditEntry, channels: number): Promise<{ signature: string; explorer: string; notifiedAt: number }> {
    if (!this.camera) throw new Error(`no camera keypair at ${config.CAMERA_KEYPAIR}`);
    const hash = fromHex(entry.hash);
    let signature: string;
    try {
      signature = await this.reg.recordNotice(keypairSigner(this.camera), hash, channels);
    } catch (e) {
      const existing = await this.reg.fetchCapture(this.camera.publicKey, hash).catch(() => null);
      if (!existing?.notifiedAt) throw e;
      signature = "(landed; confirmed by on-chain state)";
    }
    const view = await this.reg.fetchCapture(this.camera.publicKey, hash).catch(() => null);
    return { signature, explorer: signature.startsWith("(") ? "" : explorerUrl("tx", signature, config.SOLANA_CLUSTER), notifiedAt: view?.notifiedAt ?? Math.floor(Date.now() / 1000) };
  }

  /** Every notice this camera has filed, newest first (one getProgramAccounts). */
  async fetchNotices(badgeId?: string) {
    if (!this.camera) return [];
    return this.reg.fetchCaptures({ camera: this.camera.publicKey, badgeId });
  }

  async refreshCamera(): Promise<CameraView | null> {
    if (!this.camera) return null;
    this.cameraView = await this.reg.fetchCamera(this.camera.publicKey);
    return this.cameraView;
  }

  status(): AttestStatus {
    return {
      enabled: this.enabled,
      intervalMs: config.ATTEST_INTERVAL_MS,
      heartbeat: config.ATTEST_HEARTBEAT,
      camera: this.camera?.publicKey.toBase58() ?? null,
      cameraRegistered: !!this.cameraView,
      pending: this.pending.length,
      inFlight: this.inFlight,
      batches: this.audit.batchCount,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      pausedUntil: this.pausedUntil > Date.now() ? this.pausedUntil : null,
      dropped: this.dropped,
      lastSignature: this.lastSignature,
      lastError: this.lastError,
      onChain: this.cameraView,
    };
  }

  // ---- delegated consent relay --------------------------------------------------

  /**
   * Body from the badge (or `npm run badge-press`):
   * `{ badgeId, consent, nonce, instance, expiresAt, owner (base58), signature (hex, 64 bytes) }`.
   * Pre-checked off-chain for a useful error; the program re-verifies on-chain.
   * Requests for the same badge are serialized so a bouncing button gets a
   * clean 409 instead of a race.
   */
  relayDelegated(body: any): Promise<{ signature: string; explorer: string; consent: boolean; revision: number }> {
    let badgeId: string;
    try {
      badgeId = normalizeBadgeId(String(body?.badgeId ?? ""));
    } catch {
      throw new HttpError(400, "badgeId must be 1..4 hex characters");
    }
    const prev = this.relayLocks.get(badgeId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.relayDelegatedNow(badgeId, body));
    this.relayLocks.set(badgeId, run);
    run.finally(() => { if (this.relayLocks.get(badgeId) === run) this.relayLocks.delete(badgeId); }).catch(() => {});
    return run;
  }

  private async relayDelegatedNow(badgeId: string, body: any) {
    if (!this.relayer) throw new HttpError(503, `relayer keypair missing (${config.RELAYER_KEYPAIR})`);
    const consent = body?.consent;
    const nonce = Number(body?.nonce);
    const instance = Number(body?.instance);
    const expiresAt = Number(body?.expiresAt);
    const now = Math.floor(Date.now() / 1000);
    if (typeof consent !== "boolean") throw new HttpError(400, "consent must be a boolean");
    if (!Number.isInteger(nonce) || nonce < 0) throw new HttpError(400, "nonce must be a non-negative integer");
    if (!Number.isInteger(instance) || instance < 0) throw new HttpError(400, "instance must be a non-negative integer");
    if (!Number.isInteger(expiresAt)) throw new HttpError(400, "expiresAt must be unix seconds");
    if (expiresAt < now) throw new HttpError(410, "signed message has expired");
    if (expiresAt - now > MAX_DELEGATED_TTL_SECS) throw new HttpError(400, "expiresAt too far in the future (max 24h)");
    let owner: PublicKey, sig: Uint8Array;
    try {
      owner = new PublicKey(String(body?.owner));
      sig = fromHex(String(body?.signature));
      if (sig.length !== 64) throw new Error();
    } catch {
      throw new HttpError(400, "owner must be base58 and signature 64-byte hex");
    }
    const rec = await this.reg.fetchConsent(badgeId);
    if (!rec) throw new HttpError(404, `${badgeId} is not registered`);
    if (rec.owner !== owner.toBase58()) throw new HttpError(403, "signature key is not this badge's owner");
    if (rec.instance !== instance) throw new HttpError(409, `stale instance: record instance is ${rec.instance}`);
    if (rec.revision !== nonce) throw new HttpError(409, `stale nonce: record is at revision ${rec.revision}`);
    const msg = consentMessage(badgeIdToU16(badgeId), consent, BigInt(nonce), BigInt(instance), BigInt(expiresAt));
    if (!nacl.sign.detached.verify(msg, sig, owner.toBytes())) throw new HttpError(400, "bad signature");
    let signature: string;
    try {
      signature = await this.reg.setConsentDelegated(keypairSigner(this.relayer), badgeId, { consent, nonce, instance, expiresAt }, owner, sig);
    } catch (e) {
      const code = anchorErrorCode(e);
      if (code === "NonceMismatch") throw new HttpError(409, "stale nonce (changed while relaying)");
      if (code === "SignatureExpired") throw new HttpError(410, "signed message expired while relaying");
      throw new HttpError(502, `relay failed: ${code ?? (e as Error).message.split("\n")[0]}`);
    }
    const after = await this.reg.fetchConsent(badgeId).catch(() => null);
    return {
      signature,
      explorer: explorerUrl("tx", signature, config.SOLANA_CLUSTER),
      consent: after?.consent ?? consent,
      revision: after?.revision ?? nonce + 1,
    };
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
