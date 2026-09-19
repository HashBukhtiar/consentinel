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
  normalizeBadgeId,
  overridePda,
  toHex,
  u16ToBadgeId,
} from "./core";

export const IDL = idlJson as unknown as ConsentRegistry;

// ---- views (what callers get back; plain data, no BN) ----------------------

export interface ConsentView {
  badgeId: string; // "A1B2"
  badgeIdNum: number;
  owner: string; // base58
  consent: boolean;
  revision: number;
  createdAt: number; // unix seconds
  updatedAt: number;
  address: string; // PDA base58
}

export interface OverrideView {
  badgeId: string;
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
  consents: ConsentView[];
  overrides: OverrideView[];
  cameras: CameraView[];
  slot: number;
}

export type RegistryEvent =
  | { name: "ConsentChanged"; badgeId: string; owner: string; consent: boolean; revision: number; at: number; delegated: boolean }
  | { name: "ConsentClosed"; badgeId: string; owner: string; at: number }
  | { name: "EventOverrideChanged"; badgeId: string; owner: string; eventId: string; consent: boolean | null; at: number }
  | { name: "CaptureAttested"; camera: string; count: number; eventHash: string; head: string; at: number };

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

/** Sign the 33-byte delegated-consent message with the badge's own key (off-chain, no SOL needed). */
export function signConsentMessage(badgeSecretKey: Uint8Array, badgeId: string, consent: boolean, nonce: number | bigint): {
  message: Uint8Array;
  signature: Uint8Array;
  publicKey: PublicKey;
} {
  const kp = Keypair.fromSecretKey(badgeSecretKey);
  const message = consentMessage(badgeIdToU16(badgeId), consent, BigInt(nonce));
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
  private readonly disc: { consent: Uint8Array; override: Uint8Array; camera: Uint8Array };

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
    this.disc = { consent: find("ConsentAccount"), override: find("EventOverride"), camera: find("CameraLog") };
  }

  // ---- reads ---------------------------------------------------------------

  async fetchConsent(badgeId: string): Promise<ConsentView | null> {
    const [pda] = consentPda(badgeIdToU16(badgeId), this.programId);
    const info = await this.connection.getAccountInfo(pda, this.commitment);
    if (!info) return null;
    return this.decodeConsent(pda, info.data);
  }

  async fetchCamera(authority: PublicKey): Promise<CameraView | null> {
    const [pda] = cameraPda(authority, this.programId);
    const info = await this.connection.getAccountInfo(pda, this.commitment);
    if (!info) return null;
    return this.decodeCamera(pda, info.data);
  }

  /** One RPC call: every account this program owns, decoded by discriminator. */
  async fetchAll(): Promise<RegistrySnapshot> {
    const res = await this.connection.getProgramAccounts(this.programId, { commitment: this.commitment });
    const slot = await this.connection.getSlot(this.commitment);
    const snap: RegistrySnapshot = { consents: [], overrides: [], cameras: [], slot };
    for (const { pubkey, account } of res) {
      const d = account.data.subarray(0, 8);
      if (bytesEqual(d, this.disc.consent)) snap.consents.push(this.decodeConsent(pubkey, account.data));
      else if (bytesEqual(d, this.disc.override)) snap.overrides.push(this.decodeOverride(pubkey, account.data));
      else if (bytesEqual(d, this.disc.camera)) snap.cameras.push(this.decodeCamera(pubkey, account.data));
    }
    return snap;
  }

  // The raw BorshCoder returns fields under their IDL (snake_case) names;
  // `Program.account.*.fetch` camelCases them. Accept either.
  decodeConsent(address: PublicKey, data: Buffer): ConsentView {
    const c = this.coder.accounts.decode("ConsentAccount", data);
    const badgeId = num(f(c, "badge_id", "badgeId"));
    return {
      badgeId: u16ToBadgeId(badgeId),
      badgeIdNum: badgeId,
      owner: (c.owner as PublicKey).toBase58(),
      consent: !!c.consent,
      revision: num(c.revision),
      createdAt: num(f(c, "created_at", "createdAt")),
      updatedAt: num(f(c, "updated_at", "updatedAt")),
      address: address.toBase58(),
    };
  }

  decodeOverride(address: PublicKey, data: Buffer): OverrideView {
    const o = this.coder.accounts.decode("EventOverride", data);
    return {
      badgeId: u16ToBadgeId(num(f(o, "badge_id", "badgeId"))),
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
            eventHash: toHex(f(d, "event_hash", "eventHash")),
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

  async register(owner: TxSigner, badgeId: string, consent: boolean, payer: TxSigner = owner): Promise<string> {
    const id = badgeIdToU16(badgeId);
    const [pda] = consentPda(id, this.programId);
    const ix = await this.program.methods
      .register(id, consent)
      .accountsPartial({ consent: pda, owner: owner.publicKey, payer: payer.publicKey })
      .instruction();
    return this.send([ix], payer, payer.publicKey.equals(owner.publicKey) ? [] : [owner]);
  }

  async setConsent(owner: TxSigner, badgeId: string, consent: boolean, feePayer: TxSigner = owner): Promise<string> {
    const [pda] = consentPda(badgeIdToU16(badgeId), this.programId);
    const ix = await this.program.methods.setConsent(consent).accountsPartial({ consent: pda, owner: owner.publicKey }).instruction();
    return this.send([ix], feePayer, feePayer.publicKey.equals(owner.publicKey) ? [] : [owner]);
  }

  /**
   * Relay a badge-signed consent change. `signature` is Ed25519 over
   * `consentMessage(badgeId, consent, nonce)` by `ownerPubkey`; the relayer
   * pays the fee. The program verifies the signature via the Ed25519 native
   * program and rejects stale nonces.
   */
  async setConsentDelegated(
    relayer: TxSigner,
    badgeId: string,
    consent: boolean,
    nonce: number | bigint,
    ownerPubkey: PublicKey,
    signature: Uint8Array,
  ): Promise<string> {
    const id = badgeIdToU16(badgeId);
    const [pda] = consentPda(id, this.programId);
    const message = consentMessage(id, consent, BigInt(nonce));
    const edIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: ownerPubkey.toBytes(), message, signature });
    const ix = await this.program.methods
      .setConsentDelegated(consent, new BN(nonce.toString()))
      .accountsPartial({ consent: pda, relayer: relayer.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    return this.send([edIx, ix], relayer, []);
  }

  async setEventOverride(owner: TxSigner, badgeId: string, eventId: string, consent: boolean): Promise<string> {
    const id = badgeIdToU16(badgeId);
    const [pda] = consentPda(id, this.programId);
    const [opda] = overridePda(id, eventId, this.programId);
    const ix = await this.program.methods
      .setEventOverride(eventId, consent)
      .accountsPartial({ consent: pda, eventOverride: opda, owner: owner.publicKey })
      .instruction();
    return this.send([ix], owner, []);
  }

  async clearEventOverride(owner: TxSigner, badgeId: string, eventId: string): Promise<string> {
    const id = badgeIdToU16(badgeId);
    const [pda] = consentPda(id, this.programId);
    const [opda] = overridePda(id, eventId, this.programId);
    const ix = await this.program.methods
      .clearEventOverride(eventId)
      .accountsPartial({ consent: pda, eventOverride: opda, owner: owner.publicKey })
      .instruction();
    return this.send([ix], owner, []);
  }

  async closeConsent(owner: TxSigner, badgeId: string): Promise<string> {
    const [pda] = consentPda(badgeIdToU16(badgeId), this.programId);
    const ix = await this.program.methods.closeConsent().accountsPartial({ consent: pda, owner: owner.publicKey }).instruction();
    return this.send([ix], owner, []);
  }

  async registerCamera(authority: TxSigner, label: string): Promise<string> {
    const [pda] = cameraPda(authority.publicKey, this.programId);
    const ix = await this.program.methods.registerCamera(label).accountsPartial({ camera: pda, authority: authority.publicKey }).instruction();
    return this.send([ix], authority, []);
  }

  async attestCapture(authority: TxSigner, eventHash: Uint8Array): Promise<string> {
    if (eventHash.length !== 32) throw new Error("event hash must be 32 bytes");
    const [pda] = cameraPda(authority.publicKey, this.programId);
    const ix = await this.program.methods
      .attestCapture(Array.from(eventHash))
      .accountsPartial({ camera: pda, authority: authority.publicKey })
      .instruction();
    return this.send([ix], authority, []);
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

function f(o: any, snake: string, camel: string): any {
  return o[snake] !== undefined ? o[snake] : o[camel];
}
function num(v: any): number {
  if (v === undefined || v === null) throw new Error("missing numeric field in decoded account");
  return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : (v as BN).toNumber();
}
