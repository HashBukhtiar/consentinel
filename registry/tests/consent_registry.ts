// Anchor integration tests for the consent registry.
// Run: `solana-test-validator -r &` then `anchor test --skip-build --skip-local-validator`
// (Anchor 1.2's default `anchor test` wants surfpool).
//
// Covers the properties the demo and the judges' questions depend on:
// issuer-gated issuance, ownership (only the owner can change/close),
// badge-signed delegated updates with replay/instance/expiry protection,
// per-event overrides that survive close, and the camera hash chain
// matching an off-chain recomputation.
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { createHash } from "node:crypto";
import { assert } from "chai";
import type { ConsentRegistry } from "../target/types/consent_registry";
import {
  ZERO_HEAD,
  badgeIdToU16,
  batchCommitment,
  cameraPda,
  consentMessage,
  consentPda,
  overridePda,
  registryPda,
  rollHead,
} from "../client/src/core";

describe("consent_registry", () => {
  // "confirmed" everywhere: the local validator occasionally rejects a
  // blockhash fetched at "processed" with "Blockhash not found".
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(envProvider.connection.rpcEndpoint, "confirmed"),
    envProvider.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  anchor.setProvider(provider);
  const program = anchor.workspace.consentRegistry as Program<ConsentRegistry>;
  const conn = provider.connection;
  const issuer = provider.wallet; // the organizer; also the relayer in delegated tests
  const [registry] = registryPda(program.programId);

  const owner1 = Keypair.generate(); // badge 1's key
  const owner2 = Keypair.generate(); // badge 2's key (and the "attacker")
  const camera = Keypair.generate();
  // random per run so the suite can be re-run against a persistent validator
  const BADGE1 = 0x1000 + Math.floor(Math.random() * 0xe000);
  const BADGE2 = (BADGE1 + 1) & 0xffff;
  void badgeIdToU16; // (documents the "A1B2" ⇄ u16 mapping used by the app)
  const [pda1] = consentPda(BADGE1, program.programId);
  const [pda2] = consentPda(BADGE2, program.programId);
  const now = () => Math.floor(Date.now() / 1000);

  async function airdrop(pk: PublicKey, sol = 2) {
    const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }

  // Errors surface either as an AnchorError (from `.rpc()`) or as a
  // SendTransactionError whose logs carry "Error Code: X" (from
  // `provider.sendAndConfirm`). Accept both.
  async function expectAnchorError(p: Promise<unknown>, code: string) {
    try {
      await p;
    } catch (e: any) {
      const fromAnchor = (e as anchor.AnchorError)?.error?.errorCode?.code;
      const text = [String(e?.message ?? e), ...(e?.logs ?? e?.transactionLogs ?? [])].join("\n");
      const m = text.match(/Error Code: ([A-Za-z0-9_]+)/);
      const got = fromAnchor ?? m?.[1] ?? text.slice(0, 200);
      assert.equal(got, code, `expected ${code}, got ${got}`);
      return;
    }
    assert.fail(`expected ${code}, but it succeeded`);
  }

  async function fetchConsent(pda: PublicKey) {
    return program.account.consentAccount.fetch(pda);
  }

  before(async () => {
    await Promise.all([airdrop(owner1.publicKey), airdrop(owner2.publicKey), airdrop(camera.publicKey)]);
    // initialize once (idempotent across reruns on a persistent validator)
    const existing = await program.account.registry.fetchNullable(registry);
    if (!existing) {
      await program.methods.initialize(issuer.publicKey).accountsPartial({ registry, payer: issuer.publicKey }).rpc();
    }
    const r = await program.account.registry.fetch(registry);
    assert.ok(r.issuer.equals(issuer.publicKey), "this wallet must be the issuer for the suite");
  });

  it("initialize: cannot be run twice", async () => {
    try {
      await program.methods.initialize(owner2.publicKey).accountsPartial({ registry, payer: issuer.publicKey }).rpc();
      assert.fail("second initialize should fail");
    } catch (e: any) {
      assert.match(String(e), /already in use|custom program error|0x0/i);
    }
  });

  it("register: only the issuer can bind a badge id to an owner key", async () => {
    await expectAnchorError(
      program.methods
        .register(BADGE1, true)
        .accountsPartial({ registry, consent: pda1, owner: owner1.publicKey, issuer: owner2.publicKey })
        .signers([owner2])
        .rpc(),
      "Unauthorized",
    );
  });

  it("register: issuer creates the record; owner key is the badge's; instance is unique", async () => {
    const before = await program.account.registry.fetch(registry);
    await program.methods.register(BADGE1, false).accountsPartial({ registry, consent: pda1, owner: owner1.publicKey, issuer: issuer.publicKey }).rpc();
    const c = await fetchConsent(pda1);
    assert.equal(c.badgeId, BADGE1);
    assert.ok(c.owner.equals(owner1.publicKey));
    assert.equal(c.consent, false);
    assert.equal(c.revision.toNumber(), 0);
    assert.equal(c.instance.toNumber(), before.registrations.toNumber() + 1);
    assert.ok(c.createdAt.toNumber() > 0);
    assert.equal(c.updatedAt.toNumber(), c.createdAt.toNumber());

    await program.methods.register(BADGE2, true).accountsPartial({ registry, consent: pda2, owner: owner2.publicKey, issuer: issuer.publicKey }).rpc();
    const c2 = await fetchConsent(pda2);
    assert.equal(c2.instance.toNumber(), c.instance.toNumber() + 1, "instances are monotonic");
  });

  it("register: the same badge id cannot be claimed twice", async () => {
    try {
      await program.methods.register(BADGE1, true).accountsPartial({ registry, consent: pda1, owner: owner2.publicKey, issuer: issuer.publicKey }).rpc();
      assert.fail("second register should fail");
    } catch (e: any) {
      assert.match(String(e), /already in use|custom program error|0x0/i);
    }
  });

  it("set_consent: owner grants; revision increments; ConsentChanged is emitted", async () => {
    const sig = await program.methods
      .setConsent(true)
      .accountsPartial({ consent: pda1, owner: owner1.publicKey })
      .signers([owner1])
      .rpc({ commitment: "confirmed" });
    const c = await fetchConsent(pda1);
    assert.equal(c.consent, true);
    assert.equal(c.revision.toNumber(), 1);

    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const parser = new anchor.EventParser(program.programId, program.coder);
    const events = [...parser.parseLogs(tx!.meta!.logMessages!)];
    const ev = events.find((e) => e.name.toLowerCase() === "consentchanged");
    assert.ok(ev, "ConsentChanged event present in logs");
    const d = ev!.data as any;
    assert.equal(d.badge_id ?? d.badgeId, BADGE1);
    assert.equal(d.consent, true);
    assert.equal(d.delegated, false);
    assert.equal((d.revision as BN).toNumber(), 1);
  });

  it("set_consent: a non-owner (even the issuer) is rejected (Unauthorized)", async () => {
    await expectAnchorError(
      program.methods.setConsent(false).accountsPartial({ consent: pda1, owner: owner2.publicKey }).signers([owner2]).rpc(),
      "Unauthorized",
    );
    await expectAnchorError(program.methods.setConsent(false).accountsPartial({ consent: pda1, owner: issuer.publicKey }).rpc(), "Unauthorized");
    const c = await fetchConsent(pda1);
    assert.equal(c.consent, true, "state untouched");
  });

  // --- delegated (badge-signed, relayer-paid) ------------------------------

  async function delegatedTx(
    signer: Keypair,
    badge: number,
    pda: PublicKey,
    consent: boolean,
    nonce: number,
    opts: { msgOverride?: Uint8Array; skipEd25519?: boolean; instance?: number; expiresAt?: number; ixExpiresAt?: number } = {},
  ): Promise<Transaction> {
    const rec = await fetchConsent(pda);
    const instance = opts.instance ?? rec.instance.toNumber();
    const expiresAt = opts.expiresAt ?? now() + 120;
    const msg = opts.msgOverride ?? consentMessage(badge, consent, BigInt(nonce), BigInt(instance), BigInt(expiresAt));
    const signature = nacl.sign.detached(msg, signer.secretKey);
    const ixs: TransactionInstruction[] = [];
    if (!opts.skipEd25519) {
      ixs.push(Ed25519Program.createInstructionWithPublicKey({ publicKey: signer.publicKey.toBytes(), message: msg, signature }));
    }
    const ix = await program.methods
      .setConsentDelegated(consent, new BN(nonce), new BN(opts.ixExpiresAt ?? expiresAt))
      .accountsPartial({ consent: pda, relayer: issuer.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    return new Transaction().add(...ixs, ix);
  }

  it("set_consent_delegated: badge signs, relayer pays, state flips", async () => {
    const tx = await delegatedTx(owner1, BADGE1, pda1, false, 1);
    await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
    const c = await fetchConsent(pda1);
    assert.equal(c.consent, false);
    assert.equal(c.revision.toNumber(), 2);
  });

  it("set_consent_delegated: replaying the same signed message fails (NonceMismatch)", async () => {
    const tx = await delegatedTx(owner1, BADGE1, pda1, false, 1);
    await expectAnchorError(provider.sendAndConfirm(tx, []), "NonceMismatch");
  });

  it("set_consent_delegated: a signature from another key fails (SignatureNotFromOwner)", async () => {
    const tx = await delegatedTx(owner2, BADGE1, pda1, true, 2);
    await expectAnchorError(provider.sendAndConfirm(tx, []), "SignatureNotFromOwner");
  });

  it("set_consent_delegated: signed message must match the instruction (MessageMismatch)", async () => {
    // owner signs "consent=true" but the relayer submits consent=false
    const rec = await fetchConsent(pda1);
    const exp = now() + 120;
    const signedMsg = consentMessage(BADGE1, true, BigInt(2), BigInt(rec.instance.toNumber()), BigInt(exp));
    const tx = await delegatedTx(owner1, BADGE1, pda1, false, 2, { msgOverride: signedMsg, expiresAt: exp });
    await expectAnchorError(provider.sendAndConfirm(tx, []), "MessageMismatch");
  });

  it("set_consent_delegated: a message for another record instance fails (MessageMismatch)", async () => {
    const rec = await fetchConsent(pda1);
    const tx = await delegatedTx(owner1, BADGE1, pda1, true, 2, { instance: rec.instance.toNumber() + 7 });
    await expectAnchorError(provider.sendAndConfirm(tx, []), "MessageMismatch");
  });

  it("set_consent_delegated: an expired message fails (SignatureExpired); a too-long TTL fails (SignatureTtlTooLong)", async () => {
    await expectAnchorError(provider.sendAndConfirm(await delegatedTx(owner1, BADGE1, pda1, true, 2, { expiresAt: now() - 5 }), []), "SignatureExpired");
    await expectAnchorError(
      provider.sendAndConfirm(await delegatedTx(owner1, BADGE1, pda1, true, 2, { expiresAt: now() + 48 * 3600 }), []),
      "SignatureTtlTooLong",
    );
  });

  it("set_consent_delegated: relayer cannot alter the deadline it was given (MessageMismatch)", async () => {
    const tx = await delegatedTx(owner1, BADGE1, pda1, true, 2, { expiresAt: now() + 60, ixExpiresAt: now() + 3600 });
    await expectAnchorError(provider.sendAndConfirm(tx, []), "MessageMismatch");
  });

  it("set_consent_delegated: without the Ed25519 instruction it fails (MissingSignatureInstruction)", async () => {
    const tx = await delegatedTx(owner1, BADGE1, pda1, true, 2, { skipEd25519: true });
    await expectAnchorError(provider.sendAndConfirm(tx, []), "MissingSignatureInstruction");
  });

  it("set_consent_delegated: the verified signature must reference its own instruction data", async () => {
    // Build an Ed25519 instruction whose offsets point at instruction index 0
    // explicitly (not 0xffff). The precompile still passes, but our layout
    // check rejects it — no cross-instruction data substitution allowed.
    const rec = await fetchConsent(pda1);
    const exp = now() + 120;
    const msg = consentMessage(BADGE1, true, BigInt(2), BigInt(rec.instance.toNumber()), BigInt(exp));
    const signature = nacl.sign.detached(msg, owner1.secretKey);
    const edIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: owner1.publicKey.toBytes(), message: msg, signature, instructionIndex: 0 });
    const ix = await program.methods
      .setConsentDelegated(true, new BN(2), new BN(exp))
      .accountsPartial({ consent: pda1, relayer: issuer.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    await expectAnchorError(provider.sendAndConfirm(new Transaction().add(edIx, ix), []), "BadSignatureInstruction");
  });

  it("set_consent_delegated: a fresh nonce after the flip works again", async () => {
    const tx = await delegatedTx(owner1, BADGE1, pda1, true, 2);
    await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
    const c = await fetchConsent(pda1);
    assert.equal(c.consent, true);
    assert.equal(c.revision.toNumber(), 3);
  });

  // --- per-event overrides --------------------------------------------------

  it("set_event_override / clear_event_override: owner-only, upsert, rent returns", async () => {
    const eventId = "htn2026-closing";
    const [opda] = overridePda(BADGE1, eventId, program.programId);
    await program.methods.setEventOverride(eventId, false).accountsPartial({ consent: pda1, eventOverride: opda, owner: owner1.publicKey }).signers([owner1]).rpc();
    let o = await program.account.eventOverride.fetch(opda);
    assert.equal(o.badgeId, BADGE1);
    assert.equal(o.eventId, eventId);
    assert.equal(o.consent, false);
    assert.ok(o.owner.equals(owner1.publicKey));

    // upsert flips it
    await program.methods.setEventOverride(eventId, true).accountsPartial({ consent: pda1, eventOverride: opda, owner: owner1.publicKey }).signers([owner1]).rpc();
    o = await program.account.eventOverride.fetch(opda);
    assert.equal(o.consent, true);

    // non-owner cannot touch it
    await expectAnchorError(
      program.methods.setEventOverride(eventId, false).accountsPartial({ consent: pda1, eventOverride: opda, owner: owner2.publicKey }).signers([owner2]).rpc(),
      "Unauthorized",
    );
    await expectAnchorError(
      program.methods.clearEventOverride(eventId).accountsPartial({ eventOverride: opda, owner: owner2.publicKey }).signers([owner2]).rpc(),
      "Unauthorized",
    );

    const before = await conn.getBalance(owner1.publicKey);
    await program.methods.clearEventOverride(eventId).accountsPartial({ eventOverride: opda, owner: owner1.publicKey }).signers([owner1]).rpc({ commitment: "confirmed" });
    assert.isNull(await conn.getAccountInfo(opda), "override account closed");
    assert.isAbove(await conn.getBalance(owner1.publicKey), before, "rent refunded");
  });

  it("set_event_override: event ids up to 32 bytes work (hashed seed); longer ones are rejected (EventIdTooLong)", async () => {
    const ok = "x".repeat(32);
    const [opda] = overridePda(BADGE1, ok, program.programId);
    await program.methods.setEventOverride(ok, true).accountsPartial({ consent: pda1, eventOverride: opda, owner: owner1.publicKey }).signers([owner1]).rpc();
    await program.methods.clearEventOverride(ok).accountsPartial({ eventOverride: opda, owner: owner1.publicKey }).signers([owner1]).rpc();

    const tooLong = "y".repeat(33);
    const seed = createHash("sha256").update(tooLong).digest();
    const [bad] = PublicKey.findProgramAddressSync([Buffer.from("override"), Buffer.from([BADGE1 & 0xff, BADGE1 >> 8]), seed], program.programId);
    await expectAnchorError(
      program.methods.setEventOverride(tooLong, true).accountsPartial({ consent: pda1, eventOverride: bad, owner: owner1.publicKey }).signers([owner1]).rpc(),
      "EventIdTooLong",
    );
  });

  // --- camera audit chain ---------------------------------------------------

  it("register_camera + attest_capture: on-chain head equals the off-chain recomputation (batches + heartbeat)", async () => {
    const [cpda] = cameraPda(camera.publicKey, program.programId);
    await program.methods.registerCamera("cam-1").accountsPartial({ camera: cpda, authority: camera.publicKey }).signers([camera]).rpc();
    let cam = await program.account.cameraLog.fetch(cpda);
    assert.equal(cam.label, "cam-1");
    assert.equal(cam.count.toNumber(), 0);
    assert.deepEqual(Array.from(cam.head), new Array(32).fill(0));

    const h = (e: object) => Uint8Array.from(createHash("sha256").update(JSON.stringify(e)).digest());
    const batches = [
      [h({ eventId: "e1", beaconId: "A1B2", at: 1, cameraId: "cam-1" }), h({ eventId: "e2", beaconId: "A1B2", at: 2, cameraId: "cam-1" })],
      [], // heartbeat: nothing happened this interval
      [h({ eventId: "e3", beaconId: "C3D4", at: 3, cameraId: "cam-1" })],
    ];
    let head = ZERO_HEAD;
    for (const b of batches) {
      const c = batchCommitment(b);
      await program.methods.attestCapture(Array.from(c) as any).accountsPartial({ camera: cpda, authority: camera.publicKey }).signers([camera]).rpc();
      head = rollHead(head, c);
    }
    cam = await program.account.cameraLog.fetch(cpda);
    assert.equal(cam.count.toNumber(), 3);
    assert.deepEqual(Array.from(cam.head), Array.from(head), "rolling hash matches");
  });

  it("attest_capture: only the camera authority may append", async () => {
    const [cpda] = cameraPda(camera.publicKey, program.programId);
    await expectAnchorError(
      program.methods.attestCapture(Array.from(new Uint8Array(32).fill(7)) as any).accountsPartial({ camera: cpda, authority: owner2.publicKey }).signers([owner2]).rpc(),
      "ConstraintSeeds",
    );
  });

  // --- close + re-register ----------------------------------------------------

  it("close_consent: non-owner rejected; owner closes and gets rent back; absence ⇒ fail-safe", async () => {
    await expectAnchorError(program.methods.closeConsent().accountsPartial({ consent: pda1, owner: owner2.publicKey }).signers([owner2]).rpc(), "Unauthorized");
    await expectAnchorError(program.methods.closeConsent().accountsPartial({ consent: pda1, owner: issuer.publicKey }).rpc(), "Unauthorized");
    const before = await conn.getBalance(owner1.publicKey);
    await program.methods.closeConsent().accountsPartial({ consent: pda1, owner: owner1.publicKey }).signers([owner1]).rpc({ commitment: "confirmed" });
    assert.isNull(await conn.getAccountInfo(pda1));
    assert.isAbove(await conn.getBalance(owner1.publicKey), before);
    assert.isNull(await program.account.consentAccount.fetchNullable(pda1), "no record ⇒ app treats as unknown ⇒ blur");
  });

  it("re-register after close: a delegated signature from the old instance cannot replay", async () => {
    // sign a nonce-0 grant against the OLD instance number (as an attacker who archived it would)
    const oldInstance = 1; // any previous value; the new record gets a fresh one
    const exp = now() + 120;
    const oldMsg = consentMessage(BADGE1, true, BigInt(0), BigInt(oldInstance), BigInt(exp));
    const oldSig = nacl.sign.detached(oldMsg, owner1.secretKey);

    await program.methods.register(BADGE1, false).accountsPartial({ registry, consent: pda1, owner: owner1.publicKey, issuer: issuer.publicKey }).rpc();
    const c = await fetchConsent(pda1);
    assert.equal(c.revision.toNumber(), 0);
    assert.notEqual(c.instance.toNumber(), oldInstance);

    const edIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: owner1.publicKey.toBytes(), message: oldMsg, signature: oldSig });
    const ix = await program.methods
      .setConsentDelegated(true, new BN(0), new BN(exp))
      .accountsPartial({ consent: pda1, relayer: issuer.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    await expectAnchorError(provider.sendAndConfirm(new Transaction().add(edIx, ix), []), "MessageMismatch");
    assert.equal((await fetchConsent(pda1)).consent, false, "still opted out");
  });

  it("set_issuer: only the current issuer may rotate; rotating back works", async () => {
    await expectAnchorError(program.methods.setIssuer(owner2.publicKey).accountsPartial({ registry, issuer: owner2.publicKey }).signers([owner2]).rpc(), "Unauthorized");
    await program.methods.setIssuer(owner2.publicKey).accountsPartial({ registry, issuer: issuer.publicKey }).rpc();
    assert.ok((await program.account.registry.fetch(registry)).issuer.equals(owner2.publicKey));
    await program.methods.setIssuer(issuer.publicKey).accountsPartial({ registry, issuer: owner2.publicKey }).signers([owner2]).rpc();
    assert.ok((await program.account.registry.fetch(registry)).issuer.equals(issuer.publicKey));
  });
});
