// The service's Solana side: (1) attest every film-event into the camera's
// on-chain hash chain, serialized so heads never race; (2) relay badge-signed
// consent updates (the badge signs, the relayer pays, the program verifies).
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { ConsentRegistryClient, keypairSigner, type CameraView } from "../../registry/client/src/registry";
import { badgeIdToU16, consentMessage, explorerUrl, fromHex } from "../../registry/client/src/core";
import nacl from "tweetnacl";
import { config } from "./config";
import type { AuditEntry, AuditLog } from "./audit";

export function loadKeypair(path: string): Keypair | null {
  if (!existsSync(path)) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export interface AttestStatus {
  enabled: boolean;
  camera: string | null;
  cameraRegistered: boolean;
  queued: number;
  inFlight: boolean;
  attested: number;
  failed: number;
  lastSignature: string | null;
  lastError: string | null;
  onChain: CameraView | null;
}

export class Chain {
  readonly conn: Connection;
  readonly reg: ConsentRegistryClient;
  readonly camera: Keypair | null;
  readonly relayer: Keypair | null;
  private queue: AuditEntry[] = [];
  private inFlight = false;
  private attested = 0;
  private failed = 0;
  private lastSignature: string | null = null;
  private lastError: string | null = null;
  private cameraView: CameraView | null = null;

  constructor(private audit: AuditLog, private onAttested: (e: AuditEntry) => void) {
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
      if (!this.cameraView) this.lastError = "camera not registered on-chain — run `npm run seed` in registry/";
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }

  get enabled(): boolean {
    return config.ATTEST_ON_CHAIN && !!this.camera && !!this.cameraView;
  }

  /** Queue an entry for on-chain attestation; processed strictly in order. */
  enqueue(entry: AuditEntry): void {
    if (!this.enabled) return;
    this.queue.push(entry);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.queue.length) {
        const entry = this.queue[0];
        try {
          const sig = await this.reg.attestCapture(keypairSigner(this.camera!), fromHex(entry.hash));
          this.cameraView = await this.reg.fetchCamera(this.camera!.publicKey);
          const attest = { signature: sig, head: this.cameraView?.head ?? "", count: this.cameraView?.count ?? 0, at: Date.now() };
          this.audit.recordAttestation(entry.eventId, attest);
          entry.attest = attest;
          this.attested++;
          this.lastSignature = sig;
          this.lastError = null;
          this.queue.shift();
          this.onAttested(entry);
        } catch (e) {
          this.failed++;
          this.lastError = (e as Error).message;
          // keep order; retry this entry after a short pause, give up after 3 tries
          (entry as any)._tries = ((entry as any)._tries ?? 0) + 1;
          if ((entry as any)._tries >= 3) this.queue.shift();
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  async refreshCamera(): Promise<CameraView | null> {
    if (!this.camera) return null;
    this.cameraView = await this.reg.fetchCamera(this.camera.publicKey);
    return this.cameraView;
  }

  status(): AttestStatus {
    return {
      enabled: this.enabled,
      camera: this.camera?.publicKey.toBase58() ?? null,
      cameraRegistered: !!this.cameraView,
      queued: this.queue.length,
      inFlight: this.inFlight,
      attested: this.attested,
      failed: this.failed,
      lastSignature: this.lastSignature,
      lastError: this.lastError,
      onChain: this.cameraView,
    };
  }

  // ---- delegated consent relay --------------------------------------------------

  /**
   * Body from the badge (or `npm run badge-press`):
   * `{ badgeId, consent, nonce, owner (base58), signature (hex, 64 bytes) }`.
   * We pre-check the signature and nonce off-chain to give a useful error,
   * then submit; the program re-verifies everything on-chain.
   */
  async relayDelegated(body: any): Promise<{ signature: string; explorer: string; consent: boolean; revision: number }> {
    if (!this.relayer) throw new HttpError(503, `relayer keypair missing (${config.RELAYER_KEYPAIR})`);
    const badgeId = String(body?.badgeId ?? "");
    const consent = body?.consent;
    const nonce = Number(body?.nonce);
    if (typeof consent !== "boolean") throw new HttpError(400, "consent must be a boolean");
    if (!Number.isInteger(nonce) || nonce < 0) throw new HttpError(400, "nonce must be a non-negative integer");
    let owner: PublicKey, sig: Uint8Array;
    try {
      owner = new PublicKey(String(body?.owner));
      sig = fromHex(String(body?.signature));
      if (sig.length !== 64) throw new Error();
    } catch {
      throw new HttpError(400, "owner must be base58 and signature 64-byte hex");
    }
    badgeIdToU16(badgeId); // validates
    const rec = await this.reg.fetchConsent(badgeId);
    if (!rec) throw new HttpError(404, `${badgeId} is not registered`);
    if (rec.owner !== owner.toBase58()) throw new HttpError(403, "signature key is not this badge's owner");
    if (rec.revision !== nonce) throw new HttpError(409, `stale nonce: record is at revision ${rec.revision}`);
    const msg = consentMessage(badgeIdToU16(badgeId), consent, BigInt(nonce));
    if (!nacl.sign.detached.verify(msg, sig, owner.toBytes())) throw new HttpError(400, "bad signature");
    const signature = await this.reg.setConsentDelegated(keypairSigner(this.relayer), badgeId, consent, nonce, owner, sig);
    const after = await this.reg.fetchConsent(badgeId);
    return { signature, explorer: explorerUrl("tx", signature, config.SOLANA_CLUSTER), consent: after?.consent ?? consent, revision: after?.revision ?? nonce + 1 };
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
