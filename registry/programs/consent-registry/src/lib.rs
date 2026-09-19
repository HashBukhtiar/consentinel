//! Consentinel consent registry.
//!
//! One `ConsentAccount` PDA per HTN badge (`["consent", badge_id_le]`). The
//! record is *user-owned*: only the owner's Ed25519 key can change or delete
//! it, so consent is revocable by the person it belongs to, not by the camera
//! operator. Enforcement in the capture app reads a local cache synced from
//! these accounts (never the chain per frame); the chain is the source of
//! truth and the audit trail.
//!
//! Privacy by construction (§4.2 of the spec): nothing visual ever lands here.
//! On-chain state is limited to badge id, owner pubkey, consent flags,
//! timestamps, and a rolling hash that commits to the *off-chain* film-event
//! log for tamper-evidence. No faces, no images, no "who was where" feed.
//!
//! Instructions
//! - `register`                 create the record; signer becomes owner
//! - `set_consent`              owner-signed grant/revoke
//! - `set_consent_delegated`    badge-signed grant/revoke relayed by anyone:
//!                              the badge's own key signs a 33-byte message
//!                              (verified by the Ed25519 native program) and a
//!                              relayer pays the fee. Lets a badge with no SOL
//!                              and no Solana stack flip its consent by
//!                              pressing a button.
//! - `set_event_override`       per-event consent override (e.g. "opt in for
//!                              the closing ceremony only")
//! - `clear_event_override`     remove an override (rent back to owner)
//! - `close_consent`            delete the record entirely (rent back to owner);
//!                              absence ⇒ the capture app fail-safes to blur
//! - `register_camera`          a capture pipeline registers its audit log
//! - `attest_capture`           anchor sha256(film_event) into the camera's
//!                              rolling hash chain (`head = H(head || event)`)
#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};
use solana_sdk_ids::ed25519_program;
use solana_sha256_hasher::hashv;

declare_id!("UKoViTT9288nMeBzjeMoHBBmxHfXvbg6F1gF6pjiSW7");

/// Domain-separation prefix for badge-signed consent messages.
pub const CONSENT_MSG_PREFIX: &[u8] = b"consentinel/consent/v1";
/// `CONSENT_MSG_PREFIX(22) || badge_id u16 LE(2) || consent u8(1) || nonce u64 LE(8)`
pub const CONSENT_MSG_LEN: usize = 22 + 2 + 1 + 8;
pub const MAX_EVENT_ID_LEN: usize = 32;
pub const MAX_LABEL_LEN: usize = 32;

pub const CONSENT_SEED: &[u8] = b"consent";
pub const OVERRIDE_SEED: &[u8] = b"override";
pub const CAMERA_SEED: &[u8] = b"camera";

#[program]
pub mod consent_registry {
    use super::*;

    /// Create the consent record for `badge_id`. `owner` becomes the only key
    /// that can change it; `payer` funds rent (may be the same key, or an
    /// organizer sponsoring badges that hold no SOL).
    pub fn register(ctx: Context<Register>, badge_id: u16, consent: bool) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.consent;
        c.badge_id = badge_id;
        c.owner = ctx.accounts.owner.key();
        c.consent = consent;
        c.revision = 0;
        c.created_at = now;
        c.updated_at = now;
        c.bump = ctx.bumps.consent;
        emit!(ConsentChanged {
            badge_id,
            owner: c.owner,
            consent,
            revision: 0,
            at: now,
            delegated: false,
        });
        Ok(())
    }

    /// Owner-signed grant (`true`) or revoke (`false`).
    pub fn set_consent(ctx: Context<SetConsent>, consent: bool) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.consent;
        apply_consent(c, consent, now, false)
    }

    /// Badge-signed grant/revoke, relayed by anyone.
    ///
    /// The transaction must contain, immediately before this instruction, an
    /// Ed25519 native-program instruction verifying the owner's signature over
    /// `consent_message(badge_id, consent, nonce)`. We introspect that
    /// instruction via the Instructions sysvar and require that the verified
    /// pubkey is the record's owner and the verified message is exactly the
    /// one we expect. `nonce` must equal the record's current `revision`, so
    /// every signed message is single-use (compare-and-swap ⇒ no replay).
    pub fn set_consent_delegated(
        ctx: Context<SetConsentDelegated>,
        consent: bool,
        nonce: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.consent;
        require!(nonce == c.revision, ConsentError::NonceMismatch);
        let expected = consent_message(c.badge_id, consent, nonce);
        verify_ed25519_ix(&ctx.accounts.instructions, &c.owner, &expected)?;
        apply_consent(c, consent, now, true)
    }

    /// Set (or update) a per-event override for this badge.
    pub fn set_event_override(
        ctx: Context<SetEventOverride>,
        event_id: String,
        consent: bool,
    ) -> Result<()> {
        require!(
            !event_id.is_empty() && event_id.len() <= MAX_EVENT_ID_LEN,
            ConsentError::EventIdTooLong
        );
        let now = Clock::get()?.unix_timestamp;
        let badge_id = ctx.accounts.consent.badge_id;
        let o = &mut ctx.accounts.event_override;
        o.badge_id = badge_id;
        o.event_id = event_id.clone();
        o.consent = consent;
        o.updated_at = now;
        o.bump = ctx.bumps.event_override;
        emit!(EventOverrideChanged {
            badge_id,
            owner: ctx.accounts.owner.key(),
            event_id,
            consent: Some(consent),
            at: now,
        });
        Ok(())
    }

    /// Remove a per-event override; rent returns to the owner.
    pub fn clear_event_override(ctx: Context<ClearEventOverride>, event_id: String) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        emit!(EventOverrideChanged {
            badge_id: ctx.accounts.consent.badge_id,
            owner: ctx.accounts.owner.key(),
            event_id,
            consent: None,
            at: now,
        });
        Ok(())
    }

    /// Delete the record. Rent returns to the owner. With no record the
    /// capture app's fail-safe treats the badge as "unknown" ⇒ blur.
    pub fn close_consent(ctx: Context<CloseConsent>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        emit!(ConsentClosed {
            badge_id: ctx.accounts.consent.badge_id,
            owner: ctx.accounts.owner.key(),
            at: now,
        });
        Ok(())
    }

    /// A capture pipeline (camera) registers its tamper-evidence log.
    pub fn register_camera(ctx: Context<RegisterCamera>, label: String) -> Result<()> {
        require!(label.len() <= MAX_LABEL_LEN, ConsentError::LabelTooLong);
        let now = Clock::get()?.unix_timestamp;
        let cam = &mut ctx.accounts.camera;
        cam.authority = ctx.accounts.authority.key();
        cam.label = label;
        cam.head = [0u8; 32];
        cam.count = 0;
        cam.first_at = now;
        cam.last_at = now;
        cam.bump = ctx.bumps.camera;
        Ok(())
    }

    /// Commit one film-event to the camera's rolling hash chain:
    /// `head = sha256(head || event_hash)`, `count += 1`.
    ///
    /// Only a 32-byte hash of the off-chain `FilmEvent` record lands on-chain
    /// (the record carries a random event id, so the hash is not guessable).
    /// Anyone holding the off-chain log can recompute the chain and prove the
    /// log is complete and unmodified; nobody can learn from the chain alone
    /// who was filmed.
    pub fn attest_capture(ctx: Context<AttestCapture>, event_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cam = &mut ctx.accounts.camera;
        cam.head = hashv(&[&cam.head, &event_hash]).to_bytes();
        cam.count = cam.count.checked_add(1).ok_or(ConsentError::Overflow)?;
        cam.last_at = now;
        emit!(CaptureAttested {
            camera: cam.authority,
            count: cam.count,
            event_hash,
            head: cam.head,
            at: now,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// helpers

fn apply_consent(c: &mut ConsentAccount, consent: bool, now: i64, delegated: bool) -> Result<()> {
    c.consent = consent;
    c.revision = c.revision.checked_add(1).ok_or(ConsentError::Overflow)?;
    c.updated_at = now;
    emit!(ConsentChanged {
        badge_id: c.badge_id,
        owner: c.owner,
        consent,
        revision: c.revision,
        at: now,
        delegated,
    });
    Ok(())
}

/// The exact bytes a badge signs to change its consent (see the client's
/// `consentMessage` and the firmware's `notify.cpp`).
pub fn consent_message(badge_id: u16, consent: bool, nonce: u64) -> [u8; CONSENT_MSG_LEN] {
    let mut m = [0u8; CONSENT_MSG_LEN];
    m[..22].copy_from_slice(CONSENT_MSG_PREFIX);
    m[22..24].copy_from_slice(&badge_id.to_le_bytes());
    m[24] = consent as u8;
    m[25..33].copy_from_slice(&nonce.to_le_bytes());
    m
}

/// Require that the instruction immediately preceding the current one is an
/// Ed25519 native-program instruction that verified exactly one signature by
/// `expected_pubkey` over exactly `expected_msg`, with all data inline.
///
/// Instruction-data layout (as produced by web3.js
/// `Ed25519Program.createInstructionWithPublicKey`):
/// ```text
/// [0]      num_signatures = 1
/// [1]      padding
/// [2..16]  Ed25519SignatureOffsets (7 × u16 LE):
///          signature_offset(48) signature_ix_index(0xffff)
///          public_key_offset(16) public_key_ix_index(0xffff)
///          message_data_offset(112) message_data_size(len) message_ix_index(0xffff)
/// [16..48] public key
/// [48..112] signature
/// [112..]  message
/// ```
/// `0xffff` means "this instruction", so the precompile verified the pubkey,
/// signature and message that we read back here — no other instruction's
/// data can be substituted.
fn verify_ed25519_ix(
    ix_sysvar: &AccountInfo,
    expected_pubkey: &Pubkey,
    expected_msg: &[u8],
) -> Result<()> {
    const PK_OFF: usize = 16;
    const SIG_OFF: usize = 48;
    const MSG_OFF: usize = 112;

    let current = load_current_index_checked(ix_sysvar)
        .map_err(|_| ConsentError::MissingSignatureInstruction)? as usize;
    require!(current > 0, ConsentError::MissingSignatureInstruction);
    let ix = load_instruction_at_checked(current - 1, ix_sysvar)
        .map_err(|_| ConsentError::MissingSignatureInstruction)?;
    require!(
        ix.program_id.to_bytes() == ed25519_program::ID.to_bytes(),
        ConsentError::MissingSignatureInstruction
    );
    require!(ix.accounts.is_empty(), ConsentError::BadSignatureInstruction);

    let d = &ix.data;
    require!(
        d.len() == MSG_OFF + expected_msg.len(),
        ConsentError::BadSignatureInstruction
    );
    require!(d[0] == 1 && d[1] == 0, ConsentError::BadSignatureInstruction);
    let u16_at = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]);
    require!(u16_at(2) == SIG_OFF as u16, ConsentError::BadSignatureInstruction);
    require!(u16_at(4) == u16::MAX, ConsentError::BadSignatureInstruction);
    require!(u16_at(6) == PK_OFF as u16, ConsentError::BadSignatureInstruction);
    require!(u16_at(8) == u16::MAX, ConsentError::BadSignatureInstruction);
    require!(u16_at(10) == MSG_OFF as u16, ConsentError::BadSignatureInstruction);
    require!(
        u16_at(12) as usize == expected_msg.len(),
        ConsentError::BadSignatureInstruction
    );
    require!(u16_at(14) == u16::MAX, ConsentError::BadSignatureInstruction);

    require!(
        d[PK_OFF..PK_OFF + 32] == expected_pubkey.to_bytes(),
        ConsentError::SignatureNotFromOwner
    );
    require!(&d[MSG_OFF..] == expected_msg, ConsentError::MessageMismatch);
    Ok(())
}

// ---------------------------------------------------------------------------
// accounts

#[derive(Accounts)]
#[instruction(badge_id: u16)]
pub struct Register<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + ConsentAccount::INIT_SPACE,
        seeds = [CONSENT_SEED, &badge_id.to_le_bytes()],
        bump,
    )]
    pub consent: Account<'info, ConsentAccount>,
    /// The badge's key. Becomes the sole authority over this record.
    pub owner: Signer<'info>,
    /// Funds rent. Usually the owner; may be a sponsor.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConsent<'info> {
    #[account(
        mut,
        seeds = [CONSENT_SEED, &consent.badge_id.to_le_bytes()],
        bump = consent.bump,
        has_one = owner @ ConsentError::Unauthorized,
    )]
    pub consent: Account<'info, ConsentAccount>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetConsentDelegated<'info> {
    #[account(
        mut,
        seeds = [CONSENT_SEED, &consent.badge_id.to_le_bytes()],
        bump = consent.bump,
    )]
    pub consent: Account<'info, ConsentAccount>,
    /// Pays the fee. Any key — authority comes from the badge's signature.
    pub relayer: Signer<'info>,
    /// CHECK: the Instructions sysvar, address-checked below; read via
    /// `load_instruction_at_checked`.
    #[account(
        constraint = instructions.key().to_bytes() == INSTRUCTIONS_SYSVAR_ID.to_bytes()
            @ ConsentError::BadSysvar
    )]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(event_id: String)]
pub struct SetEventOverride<'info> {
    #[account(
        seeds = [CONSENT_SEED, &consent.badge_id.to_le_bytes()],
        bump = consent.bump,
        has_one = owner @ ConsentError::Unauthorized,
    )]
    pub consent: Account<'info, ConsentAccount>,
    // init_if_needed is safe here: the PDA is fully determined by
    // (badge_id, event_id), the discriminator is checked on re-entry, and the
    // `consent.has_one = owner` constraint above authorizes the signer.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + EventOverride::INIT_SPACE,
        seeds = [OVERRIDE_SEED, &consent.badge_id.to_le_bytes(), event_id.as_bytes()],
        bump,
    )]
    pub event_override: Account<'info, EventOverride>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(event_id: String)]
pub struct ClearEventOverride<'info> {
    #[account(
        seeds = [CONSENT_SEED, &consent.badge_id.to_le_bytes()],
        bump = consent.bump,
        has_one = owner @ ConsentError::Unauthorized,
    )]
    pub consent: Account<'info, ConsentAccount>,
    #[account(
        mut,
        close = owner,
        seeds = [OVERRIDE_SEED, &consent.badge_id.to_le_bytes(), event_id.as_bytes()],
        bump = event_override.bump,
    )]
    pub event_override: Account<'info, EventOverride>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseConsent<'info> {
    #[account(
        mut,
        close = owner,
        seeds = [CONSENT_SEED, &consent.badge_id.to_le_bytes()],
        bump = consent.bump,
        has_one = owner @ ConsentError::Unauthorized,
    )]
    pub consent: Account<'info, ConsentAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct RegisterCamera<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + CameraLog::INIT_SPACE,
        seeds = [CAMERA_SEED, authority.key().as_ref()],
        bump,
    )]
    pub camera: Account<'info, CameraLog>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AttestCapture<'info> {
    #[account(
        mut,
        seeds = [CAMERA_SEED, authority.key().as_ref()],
        bump = camera.bump,
        has_one = authority @ ConsentError::Unauthorized,
    )]
    pub camera: Account<'info, CameraLog>,
    pub authority: Signer<'info>,
}

// ---------------------------------------------------------------------------
// state

/// One per badge. PDA seeds: `["consent", badge_id u16 LE]`.
#[account]
#[derive(InitSpace)]
pub struct ConsentAccount {
    /// The short id the badge blinks (8–16 bits).
    pub badge_id: u16,
    /// The only key allowed to change or delete this record.
    pub owner: Pubkey,
    /// `true` = opted in to being recorded. Absent record or `false` ⇒ blur.
    pub consent: bool,
    /// Increments on every change; doubles as the nonce for delegated updates.
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

/// Per-event override. PDA seeds: `["override", badge_id u16 LE, event_id]`.
#[account]
#[derive(InitSpace)]
pub struct EventOverride {
    pub badge_id: u16,
    #[max_len(32)]
    pub event_id: String,
    pub consent: bool,
    pub updated_at: i64,
    pub bump: u8,
}

/// A capture pipeline's tamper-evidence log. PDA seeds: `["camera", authority]`.
#[account]
#[derive(InitSpace)]
pub struct CameraLog {
    pub authority: Pubkey,
    #[max_len(32)]
    pub label: String,
    /// Rolling hash: `head_n = sha256(head_{n-1} || event_hash_n)`, `head_0 = 0`.
    pub head: [u8; 32],
    pub count: u64,
    pub first_at: i64,
    pub last_at: i64,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// events

#[event]
pub struct ConsentChanged {
    pub badge_id: u16,
    pub owner: Pubkey,
    pub consent: bool,
    pub revision: u64,
    pub at: i64,
    pub delegated: bool,
}

#[event]
pub struct ConsentClosed {
    pub badge_id: u16,
    pub owner: Pubkey,
    pub at: i64,
}

#[event]
pub struct EventOverrideChanged {
    pub badge_id: u16,
    pub owner: Pubkey,
    pub event_id: String,
    /// `None` ⇒ override cleared.
    pub consent: Option<bool>,
    pub at: i64,
}

#[event]
pub struct CaptureAttested {
    pub camera: Pubkey,
    pub count: u64,
    pub event_hash: [u8; 32],
    pub head: [u8; 32],
    pub at: i64,
}

// ---------------------------------------------------------------------------
// errors

#[error_code]
pub enum ConsentError {
    #[msg("Only the record owner may do this")]
    Unauthorized,
    #[msg("Nonce must equal the record's current revision")]
    NonceMismatch,
    #[msg("Expected an Ed25519 native-program instruction immediately before this one")]
    MissingSignatureInstruction,
    #[msg("Ed25519 instruction has an unexpected layout")]
    BadSignatureInstruction,
    #[msg("Signature was not made by the record owner")]
    SignatureNotFromOwner,
    #[msg("Signed message does not match this consent update")]
    MessageMismatch,
    #[msg("event_id must be 1..=32 bytes")]
    EventIdTooLong,
    #[msg("label must be <= 32 bytes")]
    LabelTooLong,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Expected the Instructions sysvar")]
    BadSysvar,
}
