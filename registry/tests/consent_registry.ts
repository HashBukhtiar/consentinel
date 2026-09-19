// Anchor integration tests for the consent registry (run: `anchor test`).
// Covers the properties the demo and the judges' questions depend on:
//   ownership (only the owner can change/close), badge-signed delegated
//   updates with replay protection, per-event overrides, and the camera
//   audit hash chain matching an off-chain recomputation.
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
  badgeIdToU16,
  cameraPda,
  consentMessage,
  consentPda,
  overridePda,
  rollHead,
  u16le,
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
  const relayer = provider.wallet; // pays fees for delegated updates

  const owner1 = Keypair.generate(); // badge A1B2's key
  const owner2 = Keypair.generate(); // badge C3D4's key (and the "attacker")
  const camera = Keypair.generate();
  // random per run so the suite can be re-run against a persistent validator
  const BADGE1 = 0x1000 + Math.floor(Math.random() * 0xe000);
  const BADGE2 = (BADGE1 + 1) & 0xffff;
  void badgeIdToU16; // (kept: documents the "A1B2" ⇄ u16 mapping used by the app)
  const [pda1] = consentPda(BADGE1, program.programId);
  const [pda2] = consentPda(BADGE2, program.programId);

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

  before(async () => {
    await Promise.all([airdrop(owner1.publicKey), airdrop(owner2.publicKey), airdrop(camera.publicKey)]);
  });

  it("register: signer becomes owner; record mirrors the schema", async () => {
    await program.methods
      .register(BADGE1, false)
      .accountsPartial({ consent: pda1, owner: owner1.publicKey, payer: owner1.publicKey })
      .signers([owner1])
      .rpc();
    const c = await program.account.consentAccount.fetch(pda1);
    assert.equal(c.badgeId, BADGE1);
    assert.ok(c.owner.equals(owner1.publicKey));
    assert.equal(c.consent, false);
    assert.equal(c.revision.toNumber(), 0);
    assert.ok(c.createdAt.toNumber() > 0);
    assert.equal(c.updatedAt.toNumber(), c.createdAt.toNumber());
  });

  it("register: a sponsor may pay rent while the badge key stays the owner", async () => {
    await program.methods
      .register(BADGE2, true)
      .accountsPartial({ consent: pda2, owner: owner2.publicKey, payer: relayer.publicKey })
      .signers([owner2])
      .rpc();
    const c = await program.account.consentAccount.fetch(pda2);
    assert.ok(c.owner.equals(owner2.publicKey));
    assert.equal(c.consent, true);
  });

  it("register: the same badge id cannot be claimed twice", async () => {
    try {
      await program.methods
        .register(BADGE1, true)
        .accountsPartial({ consent: pda1, owner: owner2.publicKey, payer: owner2.publicKey })
        .signers([owner2])
        .rpc();
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
    const c = await program.account.consentAccount.fetch(pda1);
    assert.equal(c.consent, true);
    assert.equal(c.revision.toNumber(), 1);

    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const parser = new anchor.EventParser(program.programId, program.coder);
    const events = [...parser.parseLogs(tx!.meta!.logMessages!)];
    const ev = events.find((e) => e.name.toLowerCase() === "consentchanged");
    assert.ok(ev, "ConsentChanged event present in logs");
    assert.equal(ev!.data.badgeId, BADGE1);
    assert.equal(ev!.data.consent, true);
    assert.equal(ev!.data.delegated, false);
    assert.equal((ev!.data.revision as BN).toNumber(), 1);
  });

  it("set_consent: a non-owner is rejected (Unauthorized)", async () => {
    await expectAnchorError(
      program.methods
        .setConsent(false)
        .accountsPartial({ consent: pda1, owner: owner2.publicKey })
        .signers([owner2])
        .rpc(),
      "Unauthorized",
    );
    const c = await program.account.consentAccount.fetch(pda1);
    assert.equal(c.consent, true, "state untouched");
  });

  // --- delegated (badge-signed, relayer-paid) ------------------------------

  function delegatedTx(
    signer: Keypair,
    badge: number,
    pda: PublicKey,
    consent: boolean,
    nonce: number,
    opts: { msgOverride?: Uint8Array; skipEd25519?: boolean } = {},
  ): Promise<Transaction> {
    const msg = opts.msgOverride ?? consentMessage(badge, consent, BigInt(nonce));
    const signature = nacl.sign.detached(msg, signer.secretKey);
    const ixs: TransactionInstruction[] = [];
    if (!opts.skipEd25519) {
      ixs.push(
        Ed25519Program.createInstructionWithPublicKey({
          publicKey: signer.publicKey.toBytes(),
          message: msg,
          signature,
        }),
      );
    }
    return program.methods
      .setConsentDelegated(consent, new BN(nonce))
      .accountsPartial({ consent: pda, relayer: relayer.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction()
      .then((ix) => new Transaction().add(...ixs, ix));
  }

  it("set_consent_delegated: badge signs, relayer pays, state flips", async () => {
    const tx = await delegatedTx(owner1, BADGE1, pda1, false, 1);
    await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
    const c = await program.account.consentAccount.fetch(pda1);
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
    // owner signs "consent=true, nonce=2" but the relayer submits consent=false
    const signedMsg = consentMessage(BADGE1, true, BigInt(2));
    const tx = await delegatedTx(owner1, BADGE1, pda1, false, 2, { msgOverride: signedMsg });
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
    const msg = consentMessage(BADGE1, true, BigInt(2));
    const signature = nacl.sign.detached(msg, owner1.secretKey);
    const edIx = Ed25519Program.createInstructionWithPublicKey({
      publicKey: owner1.publicKey.toBytes(),
      message: msg,
      signature,
      instructionIndex: 0,
    });
    const ix = await program.methods
      .setConsentDelegated(true, new BN(2))
      .accountsPartial({ consent: pda1, relayer: relayer.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    await expectAnchorError(provider.sendAndConfirm(new Transaction().add(edIx, ix), []), "BadSignatureInstruction");
  });

  it("set_consent_delegated: a fresh nonce after the flip works again", async () => {
    const tx = await delegatedTx(owner1, BADGE1, pda1, true, 2);
    await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
    const c = await program.account.consentAccount.fetch(pda1);
    assert.equal(c.consent, true);
    assert.equal(c.revision.toNumber(), 3);
  });

  // --- per-event overrides --------------------------------------------------

  it("set_event_override / clear_event_override: owner-only, upsert, rent returns", async () => {
    const eventId = "htn2026-closing";
    const [opda] = overridePda(BADGE1, eventId, program.programId);
    await program.methods
      .setEventOverride(eventId, false)
      .accountsPartial({ consent: pda1, eventOverride: opda, owner: owner1.publicKey })
      .signers([owner1])
      .rpc();
    let o = await program.account.eventOverride.fetch(opda);
    assert.equal(o.badgeId, BADGE1);
    assert.equal(o.eventId, eventId);
    assert.equal(o.consent, false);

    // upsert flips it
    await program.methods
      .setEventOverride(eventId, true)
      .accountsPartial({ consent: pda1, eventOverride: opda, owner: owner1.publicKey })
      .signers([owner1])
      .rpc();
    o = await program.account.eventOverride.fetch(opda);
    assert.equal(o.consent, true);

    // non-owner cannot touch it
    await expectAnchorError(
      program.methods
        .setEventOverride(eventId, false)
        .accountsPartial({ consent: pda1, eventOverride: opda, owner: owner2.publicKey })
        .signers([owner2])
        .rpc(),
      "Unauthorized",
    );

    const before = await conn.getBalance(owner1.publicKey);
    await program.methods
      .clearEventOverride(eventId)
      .accountsPartial({ consent: pda1, eventOverride: opda, owner: owner1.publicKey })
      .signers([owner1])
      .rpc({ commitment: "confirmed" });
    assert.isNull(await conn.getAccountInfo(opda), "override account closed");
    assert.isAbove(await conn.getBalance(owner1.publicKey), before, "rent refunded");
  });

  it("set_event_override: rejects an over-long event id", async () => {
    const eventId = "x".repeat(33);
    // PDA seed would exceed max seed len (32) — the program's own check runs
    // first only if the seed derivation succeeds; either way it must fail.
    let failed = false;
    try {
      const seed = Buffer.from(eventId).subarray(0, 32);
      const [opda] = PublicKey.findProgramAddressSync(
        [Buffer.from("override"), u16le(BADGE1), seed],
        program.programId,
      );
      await program.methods
        .setEventOverride(eventId, true)
        .accountsPartial({ consent: pda1, eventOverride: opda, owner: owner1.publicKey })
        .signers([owner1])
        .rpc();
    } catch {
      failed = true;
    }
    assert.ok(failed);
  });

  // --- camera audit chain ---------------------------------------------------

  it("register_camera + attest_capture: on-chain head equals the off-chain recomputation", async () => {
    const [cpda] = cameraPda(camera.publicKey, program.programId);
    await program.methods
      .registerCamera("cam-1")
      .accountsPartial({ camera: cpda, authority: camera.publicKey })
      .signers([camera])
      .rpc();
    let cam = await program.account.cameraLog.fetch(cpda);
    assert.equal(cam.label, "cam-1");
    assert.equal(cam.count.toNumber(), 0);
    assert.deepEqual(Array.from(cam.head), new Array(32).fill(0));

    const events = [
      { eventId: "e1", beaconId: "A1B2", at: 1, cameraId: "cam-1" },
      { eventId: "e2", beaconId: "A1B2", at: 2, cameraId: "cam-1" },
    ];
    let head = new Uint8Array(32);
    for (const ev of events) {
      const h = createHash("sha256").update(JSON.stringify(ev)).digest();
      await program.methods
        .attestCapture(Array.from(h) as any)
        .accountsPartial({ camera: cpda, authority: camera.publicKey })
        .signers([camera])
        .rpc();
      head = rollHead(head, h);
    }
    cam = await program.account.cameraLog.fetch(cpda);
    assert.equal(cam.count.toNumber(), 2);
    assert.deepEqual(Array.from(cam.head), Array.from(head), "rolling hash matches");
  });

  it("attest_capture: only the camera authority may append", async () => {
    const [cpda] = cameraPda(camera.publicKey, program.programId);
    await expectAnchorError(
      program.methods
        .attestCapture(Array.from(new Uint8Array(32).fill(7)) as any)
        .accountsPartial({ camera: cpda, authority: owner2.publicKey })
        .signers([owner2])
        .rpc(),
      "ConstraintSeeds",
    );
  });

  // --- close ----------------------------------------------------------------

  it("close_consent: non-owner rejected; owner closes and gets rent back; absence ⇒ fail-safe", async () => {
    await expectAnchorError(
      program.methods
        .closeConsent()
        .accountsPartial({ consent: pda1, owner: owner2.publicKey })
        .signers([owner2])
        .rpc(),
      "Unauthorized",
    );
    const before = await conn.getBalance(owner1.publicKey);
    await program.methods
      .closeConsent()
      .accountsPartial({ consent: pda1, owner: owner1.publicKey })
      .signers([owner1])
      .rpc({ commitment: "confirmed" });
    assert.isNull(await conn.getAccountInfo(pda1));
    assert.isAbove(await conn.getBalance(owner1.publicKey), before);
    assert.isNull(await program.account.consentAccount.fetchNullable(pda1), "no record ⇒ app treats as unknown ⇒ blur");
  });
});
