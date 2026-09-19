// Isomorphic TypeScript client for the consent registry. Used by the capture
// app (browser), the notify service (node) and the demo scripts.
//
// Design notes
// - Reads are plain RPC (`getProgramAccounts` / `getAccountInfo`) decoded with
//   the Anchor coder; writes build instructions with the Anchor `Program`
//   and sign with a `TxSigner` (a Keypair, or a browser wallet like Phantom
//   that exposes `publicKey` + `signTransaction`).
// - The capture app never calls the chain from its render loop; it calls
//   `fetchAll()` on a timer and `onLogs()` for push updates, feeding a local
//   cache (see capture-app/src/consent/chainCache.ts).
// - The raw BorshCoder returns fields under their IDL (snake_case) names;
//   `Program.account.*.fetch` camelCases them. Decoders accept either.
import { BN, BorshCoder, EventParser, Program, type Idl, type Provider } from "@anchor-lang/core";
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  type Commitment,
  type TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import idlJson from "../idl/consent_registry.json";
import type { ConsentRegistry } from "../idl/consent_registry";
import {
  CONSENT_REGISTRY_PROGRAM_ID,
  badgeIdToU16,
  bytesEqual,
  cameraPda,
  consentMessage,
  consentPda,
  defaultExpiresAt,
  normalizeBadgeId,
  overridePda,
  registryPda,
  toHex,
  u16ToBadgeId,
} from "./core";

export const IDL = idlJson as unknown as ConsentRegistry;

// ---- views (what callers get back; plain data, no BN) ----------------------

export interface RegistryView {
  issuer: string;
  registrations: number;
  address: string;
}

export interface ConsentView {
  badgeId: string; // "A1B2"
  badgeIdNum: number;
  owner: string; // base58
  consent: boolean;
  revision: number;
  instance: number;
  createdAt: number; // unix seconds
  updatedAt: number;
  address: string; // PDA base58
}

export interface OverrideView {
  badgeId: string;
  owner: string;
  eventId: string;
  consent: boolean;
  updatedAt: number;
  address: string;
}

export interface CameraView {
  authority: string;
  label: string;
  head: string; // hex
  count: number;
  firstAt: number;
  lastAt: number;
  address: string;
}

export interface RegistrySnapshot {
  registry: RegistryView | null;
  consents: ConsentView[];
  overrides: OverrideView[];
  cameras: CameraView[];
  slot: number;
}

export type RegistryEvent =
  | { name: "ConsentChanged"; badgeId: string; owner: string; consent: boolean; revision: number; instance: number; at: number; delegated: boolean }
  | { name: "ConsentClosed"; badgeId: string; owner: string; at: number }
  | { name: "EventOverrideChanged"; badgeId: string; owner: string; eventId: string; consent: boolean | null; at: number }
  | { name: "CaptureAttested"; camera: string; count: number; commitment: string; head: string; at: number };

export interface LogNotification {
  signature: string;
  slot: number;
  err: unknown | null;
  events: RegistryEvent[];
}

// ---- signing abstraction ---------------------------------------------------

/** Anything that can sign a transaction: a Keypair, or a wallet (Phantom, Solflare…). */
export interface TxSigner {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

export function keypairSigner(kp: Keypair): TxSigner {
  return {
    publicKey: kp.publicKey,
    async signTransaction(tx) {
      tx.partialSign(kp);
      return tx;
    },
  };
}

export interface DelegatedParams {
  consent: boolean;
  nonce: number | bigint; // = record.revision
  instance: number | bigint; // = record.instance
  expiresAt: number | bigint; // unix seconds
}

/** Sign the 49-byte delegated-consent message with the badge's own key (off-chain, no SOL needed). */
export function signConsentMessage(badgeSecretKey: Uint8Array, badgeId: string, p: DelegatedParams): {
  message: Uint8Array;
  signature: Uint8Array;
  publicKey: PublicKey;
} {
  const kp = Keypair.fromSecretKey(badgeSecretKey);
  const message = consentMessage(badgeIdToU16(badgeId), p.consent, BigInt(p.nonce), BigInt(p.instance), BigInt(p.expiresAt));
  const signature = nacl.sign.detached(message, kp.secretKey);
  return { message, signature, publicKey: kp.publicKey };
}

// ---- client ------------------------------------------------------------------

export interface ClientOptions {
  programId?: PublicKey;
  commitment?: Commitment;
}

export class ConsentRegistryClient {
  readonly program: Program<ConsentRegistry>;
  readonly programId: PublicKey;
  readonly commitment: Commitment;
  private readonly coder: BorshCoder;
  private readonly eventParser: EventParser;
  private readonly disc: { registry: Uint8Array; consent: Uint8Array; override: Uint8Array; camera: Uint8Array };

  constructor(readonly connection: Connection, opts: ClientOptions = {}) {
    this.programId = opts.programId ?? CONSENT_REGISTRY_PROGRAM_ID;
    this.commitment = opts.commitment ?? "confirmed";
    const idl = { ...(IDL as unknown as Idl), address: this.programId.toBase58() } as Idl;
    // A provider with only a connection is enough to build instructions and read.
    const provider = { connection } as unknown as Provider;
    this.program = new Program<ConsentRegistry>(idl as ConsentRegistry, provider);
    this.coder = new BorshCoder(idl);
    this.eventParser = new EventParser(this.programId, this.coder);
    const find = (n: string) => {
      const a = idl.accounts?.find((x) => x.name === n);
      if (!a) throw new Error(`IDL missing account ${n}`);
      return Uint8Array.from(a.discriminator);
    };
    this.disc = { registry: find("Registry"), consent: find("ConsentAccount"), override: find("EventOverride"), camera: find("CameraLog") };
  }

  // ---- reads ---------------------------------------------------------------

  /** Is the program deployed on this cluster? */
  async isDeployed(): Promise<boolean> {
    const info = await this.connection.getAccountInfo(this.programId, this.commitment);
    return !!info && info.executable;
  }

  async fetchRegistry(): Promise<RegistryView | null> {
    const [pda] = registryPda(this.programId);
    const info = await this.connection.getAccountInfo(pda, this.commitment);
    return info ? this.decodeRegistry(pda, info.data) : null;
  }

  async fetchConsent(badgeId: string): Promise<ConsentView | null> {
    return (await this.fetchConsentWithSlot(badgeId)).view;
  }

  /** Same as fetchConsent, plus the slot the read was served at (for slot-ordered caches). */
  async fetchConsentWithSlot(badgeId: string): Promise<{ view: ConsentView | null; slot: number }> {
    const [pda] = consentPda(badgeIdToU16(badgeId), this.programId);
    const res = await this.connection.getAccountInfoAndContext(pda, this.commitment);
    return { view: res.value ? this.decodeConsent(pda, res.value.data) : null, slot: res.context.slot };
  }

  async fetchCamera(authority: PublicKey): Promise<CameraView | null> {
    const [pda] = cameraPda(authority, this.programId);
    const info = await this.connection.getAccountInfo(pda, this.commitment);
    if (!info) return null;
    return this.decodeCamera(pda, info.data);
  }

  /** One RPC call: every account this program owns, decoded by discriminator, with the slot it was read at. */
  async fetchAll(): Promise<RegistrySnapshot> {
    const res = await this.connection.getProgramAccounts(this.programId, { commitment: this.commitment, withContext: true });
    const snap: RegistrySnapshot = { registry: null, consents: [], overrides: [], cameras: [], slot: res.context.slot };
    for (const { pubkey, account } of res.value) {
      const d = account.data.subarray(0, 8);
      if (bytesEqual(d, this.disc.consent)) snap.consents.push(this.decodeConsent(pubkey, account.data));
      else if (bytesEqual(d, this.disc.override)) snap.overrides.push(this.decodeOverride(pubkey, account.data));
      else if (bytesEqual(d, this.disc.camera)) snap.cameras.push(this.decodeCamera(pubkey, account.data));
      else if (bytesEqual(d, this.disc.registry)) snap.registry = this.decodeRegistry(pubkey, account.data);
    }
    return snap;
  }

  decodeRegistry(address: PublicKey, data: Buffer): RegistryView {
    const r = this.coder.accounts.decode("Registry", data);
    return { issuer: (r.issuer as PublicKey).toBase58(), registrations: num(r.registrations), address: address.toBase58() };
  }

  decodeConsent(address: PublicKey, data: Buffer): ConsentView {
    const c = this.coder.accounts.decode("ConsentAccount", data);
    const badgeId = num(f(c, "badge_id", "badgeId"));
    return {
      badgeId: u16ToBadgeId(badgeId),
      badgeIdNum: badgeId,
      owner: (c.owner as PublicKey).toBase58(),
      consent: !!c.consent,
      revision: num(c.revision),
      instance: num(c.instance),
      createdAt: num(f(c, "created_at", "createdAt")),
      updatedAt: num(f(c, "updated_at", "updatedAt")),
      address: address.toBase58(),
    };
  }

  decodeOverride(address: PublicKey, data: Buffer): OverrideView {
    const o = this.coder.accounts.decode("EventOverride", data);
    return {
      badgeId: u16ToBadgeId(num(f(o, "badge_id", "badgeId"))),
      owner: (o.owner as PublicKey).toBase58(),
      eventId: String(f(o, "event_id", "eventId")),
      consent: !!o.consent,
      updatedAt: num(f(o, "updated_at", "updatedAt")),
      address: address.toBase58(),
    };
  }

  decodeCamera(address: PublicKey, data: Buffer): CameraView {
    const c = this.coder.accounts.decode("CameraLog", data);
    return {
      authority: (c.authority as PublicKey).toBase58(),
      label: String(c.label),
      head: toHex(c.head as number[]),
      count: num(c.count),
      firstAt: num(f(c, "first_at", "firstAt")),
      lastAt: num(f(c, "last_at", "lastAt")),
      address: address.toBase58(),
    };
  }

  /** Decode this program's Anchor events out of a transaction's log lines. */
  parseEvents(logs: string[]): RegistryEvent[] {
    const out: RegistryEvent[] = [];
    for (const ev of this.eventParser.parseLogs(logs)) {
      const d = ev.data as any;
      const badgeId = () => u16ToBadgeId(num(f(d, "badge_id", "badgeId")));
      switch (ev.name.replace(/[^a-z]/gi, "").toLowerCase()) {
        case "consentchanged":
          out.push({
            name: "ConsentChanged",
            badgeId: badgeId(),
            owner: d.owner.toBase58(),
            consent: !!d.consent,
            revision: num(d.revision),
            instance: num(d.instance),
            at: num(d.at),
            delegated: !!d.delegated,
          });
          break;
        case "consentclosed":
          out.push({ name: "ConsentClosed", badgeId: badgeId(), owner: d.owner.toBase58(), at: num(d.at) });
          break;
        case "eventoverridechanged":
          out.push({
            name: "EventOverrideChanged",
            badgeId: badgeId(),
            owner: d.owner.toBase58(),
            eventId: String(f(d, "event_id", "eventId")),
            consent: d.consent === null || d.consent === undefined ? null : !!d.consent,
            at: num(d.at),
          });
          break;
        case "captureattested":
          out.push({
            name: "CaptureAttested",
            camera: d.camera.toBase58(),
            count: num(d.count),
            commitment: toHex(d.commitment),
            head: toHex(d.head),
            at: num(d.at),
          });
          break;
      }
    }
    return out;
  }

  /** Push updates: every confirmed transaction that touched this program, with its decoded events. */
  onLogs(cb: (n: LogNotification) => void, commitment: Commitment = this.commitment): () => void {
    const id = this.connection.onLogs(
      this.programId,
      (l, ctx) => cb({ signature: l.signature, slot: ctx.slot, err: l.err, events: this.parseEvents(l.logs) }),
      commitment,
    );
    return () => {
      this.connection.removeOnLogsListener(id).catch(() => {});
    };
  }

  // ---- writes ------------------------------------------------------------------
  // Every write takes an optional `feePayer` so badge keys never need SOL.

  async initialize(payer: TxSigner, issuer: PublicKey): Promise<string> {
    const [pda] = registryPda(this.programId);
    const ix = await this.program.methods.initialize(issuer).accountsPartial({ registry: pda, payer: payer.publicKey }).instruction();
    return this.send([ix], payer, []);
  }

  async setIssuer(issuer: TxSigner, newIssuer: PublicKey, feePayer: TxSigner = issuer): Promise<string> {
    const [pda] = registryPda(this.programId);
    const ix = await this.program.methods.setIssuer(newIssuer).accountsPartial({ registry: pda, issuer: issuer.publicKey }).instruction();
    return this.send([ix], feePayer, extra(feePayer, issuer));
  }

  /** Issuer binds `badgeId` to `owner` (the badge's key) and pays rent. */
  async register(issuer: TxSigner, badgeId: string, owner: PublicKey, consent: boolean): Promise<string> {
    const id = badgeIdToU16(badgeId);
    const [rpda] = registryPda(this.programId);
    const [pda] = consentPda(id, this.programId);
    const ix = await this.program.methods
      .register(id, consent)
      .accountsPartial({ registry: rpda, consent: pda, owner, issuer: issuer.publicKey })
      .instruction();
    return this.send([ix], issuer, []);
  }

  async setConsent(owner: TxSigner, badgeId: string, consent: boolean, feePayer: TxSigner = owner): Promise<string> {
    const [pda] = consentPda(badgeIdToU16(badgeId), this.programId);
    const ix = await this.program.methods.setConsent(consent).accountsPartial({ consent: pda, owner: owner.publicKey }).instruction();
    return this.send([ix], feePayer, extra(feePayer, owner));
  }

  /**
   * Relay a badge-signed consent change. `signature` is Ed25519 over
   * `consentMessage(badgeId, consent, nonce, instance, expiresAt)` by
   * `ownerPubkey`; the relayer pays the fee. The program verifies the
   * signature via the Ed25519 native program and rejects stale nonces,
   * wrong instances and expired messages.
   */
  async setConsentDelegated(relayer: TxSigner, badgeId: string, p: DelegatedParams, ownerPubkey: PublicKey, signature: Uint8Array): Promise<string> {
    const id = badgeIdToU16(badgeId);
    const [pda] = consentPda(id, this.programId);
    const message = consentMessage(id, p.consent, BigInt(p.nonce), BigInt(p.instance), BigInt(p.expiresAt));
    const edIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: ownerPubkey.toBytes(), message, signature });
    const ix = await this.program.methods
      .setConsentDelegated(p.consent, new BN(p.nonce.toString()), new BN(p.expiresAt.toString()))
      .accountsPartial({ consent: pda, relayer: relayer.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    return this.send([edIx, ix], relayer, []);
  }

  /** Convenience: sign with the badge key locally and relay in one step (demo keys / scripts). */
  async setConsentAsBadge(relayer: TxSigner, badgeSecretKey: Uint8Array, badgeId: string, consent: boolean, ttlSecs?: number): Promise<string> {
    const rec = await this.fetchConsent(badgeId);
    if (!rec) throw new Error(`${badgeId} is not registered`);
    const p: DelegatedParams = { consent, nonce: rec.revision, instance: rec.instance, expiresAt: defaultExpiresAt(Date.now(), ttlSecs) };
    const { signature, publicKey } = signConsentMessage(badgeSecretKey, badgeId, p);
    if (publicKey.toBase58() !== rec.owner) throw new Error("that key does not own this badge's record");
    return this.setConsentDelegated(relayer, badgeId, p, publicKey, signature);
  }

  async setEventOverride(owner: TxSigner, badgeId: string, eventId: string, consent: boolean, feePayer: TxSigner = owner): Promise<string> {
    const id = badgeIdToU16(badgeId);
    const [pda] = consentPda(id, this.programId);
    const [opda] = overridePda(id, eventId, this.programId);
    const ix = await this.program.methods
      .setEventOverride(eventId, consent)
      .accountsPartial({ consent: pda, eventOverride: opda, owner: owner.publicKey })
      .instruction();
    return this.send([ix], feePayer, extra(feePayer, owner));
  }

  async clearEventOverride(owner: TxSigner, badgeId: string, eventId: string, feePayer: TxSigner = owner): Promise<string> {
    const [opda] = overridePda(badgeIdToU16(badgeId), eventId, this.programId);
    const ix = await this.program.methods.clearEventOverride(eventId).accountsPartial({ eventOverride: opda, owner: owner.publicKey }).instruction();
    return this.send([ix], feePayer, extra(feePayer, owner));
  }

  async closeConsent(owner: TxSigner, badgeId: string, feePayer: TxSigner = owner): Promise<string> {
    const [pda] = consentPda(badgeIdToU16(badgeId), this.programId);
    const ix = await this.program.methods.closeConsent().accountsPartial({ consent: pda, owner: owner.publicKey }).instruction();
    return this.send([ix], feePayer, extra(feePayer, owner));
  }

  async registerCamera(authority: TxSigner, label: string, feePayer: TxSigner = authority): Promise<string> {
    const [pda] = cameraPda(authority.publicKey, this.programId);
    const ix = await this.program.methods.registerCamera(label).accountsPartial({ camera: pda, authority: authority.publicKey }).instruction();
    return this.send([ix], feePayer, extra(feePayer, authority));
  }

  async attestCapture(authority: TxSigner, commitment: Uint8Array, feePayer: TxSigner = authority): Promise<string> {
    if (commitment.length !== 32) throw new Error("commitment must be 32 bytes");
    const [pda] = cameraPda(authority.publicKey, this.programId);
    const ix = await this.program.methods
      .attestCapture(Array.from(commitment))
      .accountsPartial({ camera: pda, authority: authority.publicKey })
      .instruction();
    return this.send([ix], feePayer, extra(feePayer, authority));
  }

  // ---- plumbing ---------------------------------------------------------------

  private async send(ixs: TransactionInstruction[], feePayer: TxSigner, extraSigners: TxSigner[]): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(this.commitment);
    let tx = new Transaction({ feePayer: feePayer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    for (const s of extraSigners) tx = await s.signTransaction(tx);
    tx = await feePayer.signTransaction(tx);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), { preflightCommitment: this.commitment });
    const conf = await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, this.commitment);
    if (conf.value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(conf.value.err)}`);
    return signature;
  }
}

export { normalizeBadgeId };

/** Extra signers = the authority, unless it is also the fee payer. */
function extra(feePayer: TxSigner, authority: TxSigner): TxSigner[] {
  return feePayer.publicKey.equals(authority.publicKey) ? [] : [authority];
}

function f(o: any, snake: string, camel: string): any {
  return o[snake] !== undefined ? o[snake] : o[camel];
}
function num(v: any): number {
  if (v === undefined || v === null) throw new Error("missing numeric field in decoded account");
  return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : (v as BN).toNumber();
}

/** Extract an Anchor error code name (e.g. "NonceMismatch") from any thrown error, if present. */
export function anchorErrorCode(e: unknown): string | null {
  const any = e as any;
  const fromAnchor = any?.error?.errorCode?.code;
  if (fromAnchor) return String(fromAnchor);
  const text = [String(any?.message ?? any), ...(any?.logs ?? any?.transactionLogs ?? [])].join("\n");
  return text.match(/Error Code: ([A-Za-z0-9_]+)/)?.[1] ?? null;
}
