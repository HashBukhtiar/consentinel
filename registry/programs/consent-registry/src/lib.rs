//! Consentinel consent registry.
//!
//! One `ConsentAccount` PDA per HTN badge (`["consent", badge_id_le]`). The
//! record is *user-owned*: only the owner's Ed25519 key can change or delete
//! it, so consent is revocable by the person it belongs to, not by the camera
//! operator. Enforcement in the capture app reads a local cache synced from
//! these accounts (never the chain per frame); the chain is the source of
//! truth and the audit trail.
//!
//! Issuance is gated by the event organizer (the `Registry.issuer`): a badge is
//! a physical credential handed out by the organizer, so the organizer binds
//! `badge_id → owner key` once, and from then on only the owner has any say.
//! Without this gate anyone could squat an unregistered id with consent=true.
//!
//! Privacy by construction (§4.2 of the spec): nothing visual ever lands here.
//! On-chain state is limited to badge id, owner pubkey, consent flags,
//! timestamps, a rolling hash that commits to the *off-chain* film-event log
//! for tamper-evidence, and — for captures of people who had opted OUT — a
//! `CaptureNotice` per film-event: when the camera saw the badge, when that
//! was recorded, and when the person was told. No faces, no images, no names,
//! no contact details: the badge id is the only key, and the organizer's
//! off-chain directory is what turns it into a person.
//!
//! Instructions
//! - `initialize`               create the singleton `Registry` (issuer = organizer)
//! - `set_issuer`               rotate the issuer (issuer-signed)
//! - `register`                 issuer creates a badge's record; `owner` = badge key
//! - `set_consent`              owner-signed grant/revoke
//! - `set_consent_delegated`    badge-signed grant/revoke relayed by anyone:
//!                              the badge's own key signs a 49-byte message
//!                              (verified by the Ed25519 native program) and a
//!                              relayer pays the fee. Lets a badge with no SOL
//!                              and no Solana stack flip its consent by
//!                              pressing a button. Bound to the record
//!                              instance and to a deadline; single-use.
//! - `set_event_override`       per-event consent override (e.g. "opt in for
//!                              the closing ceremony only")
//! - `clear_event_override`     remove an override (rent back to owner)
//! - `close_consent`            delete the record entirely (rent back to owner);
//!                              absence ⇒ the capture app fail-safes to blur
//! - `register_camera`          a capture pipeline registers its audit log
//! - `attest_capture`           fold a commitment into the camera's rolling
//!                              hash chain (`head = H(head || commitment)`)
//! - `record_capture`           the camera files a notice that an opted-out
//!                              badge was on camera (one PDA per film-event,
//!                              keyed by the event's audit hash)
//! - `record_notice`            …and that the person was told, with the
//!                              chain clock as the timestamp (single-use)
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
/// `PREFIX(22) || badge_id u16 LE(2) || consent u8(1) || nonce u64 LE(8) || instance u64 LE(8) || expires_at i64 LE(8)`
pub const CONSENT_MSG_LEN: usize = 22 + 2 + 1 + 8 + 8 + 8;
/// A delegated signature may not be valid for longer than this.
pub const MAX_DELEGATED_TTL_SECS: i64 = 24 * 60 * 60;
pub const MAX_EVENT_ID_LEN: usize = 32;
pub const MAX_LABEL_LEN: usize = 32;

pub const REGISTRY_SEED: &[u8] = b"registry";
pub const CONSENT_SEED: &[u8] = b"consent";
pub const OVERRIDE_SEED: &[u8] = b"override";
pub const CAMERA_SEED: &[u8] = b"camera";
pub const CAPTURE_SEED: &[u8] = b"capture";
/// A camera's `filmed_at` may run ahead of the chain clock by at most this (clock skew).
pub const MAX_CAPTURE_SKEW_SECS: i64 = 5 * 60;
/// `CaptureNotice.channels` bits: how the person was told.
///
/// `record_notice` requires only that the mask is non-zero — it never checks
/// *which* bits are set — so adding a channel is a client-side change and needs
/// no program upgrade. These constants are documentation for off-chain code;
/// nothing in the program reads them.
pub const CHANNEL_EMAIL: u8 = 1;
pub const CHANNEL_BADGE_RADIO: u8 = 2;
pub const CHANNEL_VOICE: u8 = 4;
pub const CHANNEL_SMS: u8 = 8;

#[program]
pub mod consent_registry {
    use super::*;

    /// One-time setup: whoever pays becomes nothing; `issuer` is the organizer
    /// key allowed to bind badge ids to owner keys.
    pub fn initialize(ctx: Context<Initialize>, issuer: Pubkey) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        r.issuer = issuer;
        r.registrations = 0;
        r.bump = ctx.bumps.registry;
        Ok(())
    }

    pub fn set_issuer(ctx: Context<SetIssuer>, new_issuer: Pubkey) -> Result<()> {
        ctx.accounts.registry.issuer = new_issuer;
        Ok(())
    }

    /// Issuer creates the consent record for `badge_id` and binds it to the
    /// badge's key (`owner`). The issuer pays rent. From here on only `owner`
    /// can change or delete the record.
    pub fn register(ctx: Context<Register>, badge_id: u16, consent: bool) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.registry;
        r.registrations = r.registrations.checked_add(1).ok_or(ConsentError::Overflow)?;
        let c = &mut ctx.accounts.consent;
        c.badge_id = badge_id;
        c.owner = ctx.accounts.owner.key();
        c.consent = consent;
        c.revision = 0;
        c.instance = r.registrations;
        c.created_at = now;
        c.updated_at = now;
        c.bump = ctx.bumps.consent;
        emit!(ConsentChanged {
            badge_id,
            owner: c.owner,
            consent,
            revision: 0,
            instance: c.instance,
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
    /// `consent_message(badge_id, consent, nonce, instance, expires_at)`. We
    /// introspect that instruction via the Instructions sysvar and require
    /// that the verified pubkey is the record's owner and the verified message
    /// is exactly the one we expect. Single-use and unforgeable by a relayer:
    /// - `nonce` must equal the record's current `revision` (compare-and-swap);
    /// - `instance` must equal the record's `instance`, so a signature made
    ///   for a previous registration of the same badge id can never replay;
    /// - `expires_at` bounds how long a relayer can sit on a signed message.
    pub fn set_consent_delegated(
        ctx: Context<SetConsentDelegated>,
        consent: bool,
        nonce: u64,
        expires_at: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.consent;
        require!(nonce == c.revision, ConsentError::NonceMismatch);
        require!(now <= expires_at, ConsentError::SignatureExpired);
        require!(
            expires_at - now <= MAX_DELEGATED_TTL_SECS,
            ConsentError::SignatureTtlTooLong
        );
        let expected = consent_message(c.badge_id, consent, nonce, c.instance, expires_at);
        verify_ed25519_ix(&ctx.accounts.instructions, &c.owner, &expected)?;
        apply_consent(c, consent, now, true)
    }

    /// Set (or update) a per-event override for this badge. The current badge
    /// owner takes ownership of the override (also when overwriting a stale
    /// one left by a previous owner).
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
        o.owner = ctx.accounts.owner.key();
        o.event_id = event_id.clone();
        o.consent = consent;
        o.updated_at = now;
        o.bump = ctx.bumps.event_override;
        emit!(EventOverrideChanged {
            badge_id,
            owner: o.owner,
            event_id,
            consent: Some(consent),
            at: now,
        });
        Ok(())
    }

    /// Remove a per-event override; rent returns to its owner. Works even
    /// after the consent record was closed (no orphaned rent).
    pub fn clear_event_override(ctx: Context<ClearEventOverride>, event_id: String) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        emit!(EventOverrideChanged {
            badge_id: ctx.accounts.event_override.badge_id,
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

    /// Fold one commitment into the camera's rolling hash chain:
    /// `head = sha256(head || commitment)`, `count += 1`.
    ///
    /// The notify service submits one commitment per fixed interval: the hash
    /// of that interval's film-event hashes, or a zero commitment when nothing
    /// happened ("heartbeat"). So the chain carries a steady stream that
    /// proves the off-chain log is complete and unmodified, while revealing
    /// neither who was filmed nor *when* anyone was filmed. Film-event
    /// records themselves (with a random event id) never leave the operator.
    pub fn attest_capture(ctx: Context<AttestCapture>, commitment: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cam = &mut ctx.accounts.camera;
        cam.head = hashv(&[&cam.head, &commitment]).to_bytes();
        cam.count = cam.count.checked_add(1).ok_or(ConsentError::Overflow)?;
        cam.last_at = now;
        emit!(CaptureAttested {
            camera: cam.authority,
            count: cam.count,
            commitment,
            head: cam.head,
            at: now,
        });
        Ok(())
    }

    /// The camera files a notice: an opted-out badge was on camera. One
    /// `CaptureNotice` per film-event, keyed by the event's sha256 — the same
    /// hash the off-chain audit log stores for that entry and the rolling
    /// commitment covers, so the notice and the log entry name each other.
    /// `filmed_at` is the camera's clock at capture; `recorded_at` is the
    /// chain's. Only the camera's authority (a registered `CameraLog`) can
    /// write one, and it pays the rent: the record is the person's evidence,
    /// so nobody but the camera can create it and nobody can delete it.
    pub fn record_capture(
        ctx: Context<RecordCapture>,
        badge_id: u16,
        event_hash: [u8; 32],
        filmed_at: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            filmed_at > 0 && filmed_at <= now + MAX_CAPTURE_SKEW_SECS,
            ConsentError::BadTimestamp
        );
        let n = &mut ctx.accounts.notice;
        n.badge_id = badge_id;
        n.camera = ctx.accounts.authority.key();
        n.event_hash = event_hash;
        n.filmed_at = filmed_at;
        n.recorded_at = now;
        n.notified_at = 0;
        n.channels = 0;
        n.bump = ctx.bumps.notice;
        emit!(CaptureRecorded {
            badge_id,
            camera: n.camera,
            event_hash,
            filmed_at,
            recorded_at: now,
        });
        Ok(())
    }

    /// The person behind the badge was told (`channels` = which ways, see
    /// `CHANNEL_*`). Stamps the notice with the chain clock. Single-use: a
    /// notice is either pending or delivered, and "delivered" cannot be
    /// re-dated.
    pub fn record_notice(ctx: Context<RecordNotice>, channels: u8) -> Result<()> {
        require!(channels != 0, ConsentError::NoChannel);
        let now = Clock::get()?.unix_timestamp;
        let n = &mut ctx.accounts.notice;
        require!(n.notified_at == 0, ConsentError::AlreadyNotified);
        n.notified_at = now;
        n.channels = channels;
        emit!(NoticeRecorded {
            badge_id: n.badge_id,
            camera: n.camera,
            event_hash: n.event_hash,
            notified_at: now,
            channels,
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
        instance: c.instance,
        at: now,
        delegated,
    });
    Ok(())
}

/// The exact bytes a badge signs to change its consent (see the client's
/// `consentMessage` and `service/BADGE_PROTOCOL.md`).
pub fn consent_message(
    badge_id: u16,
    consent: bool,
    nonce: u64,
    instance: u64,
    expires_at: i64,
) -> [u8; CONSENT_MSG_LEN] {
    let mut m = [0u8; CONSENT_MSG_LEN];
    m[..22].copy_from_slice(CONSENT_MSG_PREFIX);
    m[22..24].copy_from_slice(&badge_id.to_le_bytes());
    m[24] = consent as u8;
    m[25..33].copy_from_slice(&nonce.to_le_bytes());
    m[33..41].copy_from_slice(&instance.to_le_bytes());
    m[41..49].copy_from_slice(&expires_at.to_le_bytes());
    m
}

/// Fixed-length PDA seed for an event id of any length ≤ MAX_EVENT_ID_LEN.
pub fn event_seed(event_id: &str) -> [u8; 32] {
    hashv(&[event_id.as_bytes()]).to_bytes()
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
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Registry::INIT_SPACE,
        seeds = [REGISTRY_SEED],
        bump,
    )]
    pub registry: Account<'info, Registry>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetIssuer<'info> {
    #[account(
        mut,
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = issuer @ ConsentError::Unauthorized,
    )]
    pub registry: Account<'info, Registry>,
    pub issuer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(badge_id: u16)]
pub struct Register<'info> {
    #[account(
        mut,
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = issuer @ ConsentError::Unauthorized,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        init,
        payer = issuer,
        space = 8 + ConsentAccount::INIT_SPACE,
        seeds = [CONSENT_SEED, &badge_id.to_le_bytes()],
        bump,
    )]
    pub consent: Account<'info, ConsentAccount>,
    /// CHECK: the badge's key. Becomes the sole authority over this record.
    /// The issuer vouches for the binding (it provisions the badge), so no
    /// signature from the badge is needed at issuance.
    pub owner: UncheckedAccount<'info>,
    /// The organizer. Authorizes issuance and pays rent.
    #[account(mut)]
    pub issuer: Signer<'info>,
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
    // `consent.has_one = owner` constraint above authorizes the signer as the
    // current badge owner (who may overwrite a stale override).
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + EventOverride::INIT_SPACE,
        seeds = [OVERRIDE_SEED, &consent.badge_id.to_le_bytes(), &event_seed(&event_id)],
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
        mut,
        close = owner,
        seeds = [OVERRIDE_SEED, &event_override.badge_id.to_le_bytes(), &event_seed(&event_id)],
        bump = event_override.bump,
        has_one = owner @ ConsentError::Unauthorized,
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

#[derive(Accounts)]
#[instruction(badge_id: u16, event_hash: [u8; 32])]
pub struct RecordCapture<'info> {
    /// The camera must be registered; its authority signs and pays.
    #[account(
        seeds = [CAMERA_SEED, authority.key().as_ref()],
        bump = camera.bump,
        has_one = authority @ ConsentError::Unauthorized,
    )]
    pub camera: Account<'info, CameraLog>,
    #[account(
        init,
        payer = authority,
        space = 8 + CaptureNotice::INIT_SPACE,
        seeds = [CAPTURE_SEED, authority.key().as_ref(), &event_hash],
        bump,
    )]
    pub notice: Account<'info, CaptureNotice>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordNotice<'info> {
    #[account(
        mut,
        seeds = [CAPTURE_SEED, authority.key().as_ref(), &notice.event_hash],
        bump = notice.bump,
        constraint = notice.camera == authority.key() @ ConsentError::Unauthorized,
    )]
    pub notice: Account<'info, CaptureNotice>,
    pub authority: Signer<'info>,
}

// ---------------------------------------------------------------------------
// state

/// Singleton. PDA seeds: `["registry"]`.
#[account]
#[derive(InitSpace)]
pub struct Registry {
    /// The organizer key allowed to bind badge ids to owner keys.
    pub issuer: Pubkey,
    /// Monotonic; gives every registration a unique `instance`.
    pub registrations: u64,
    pub bump: u8,
}

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
    /// Increments on every change; the nonce for delegated updates.
    pub revision: u64,
    /// Unique per registration; binds delegated signatures to this record.
    pub instance: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

/// Per-event override. PDA seeds: `["override", badge_id u16 LE, sha256(event_id)]`.
#[account]
#[derive(InitSpace)]
pub struct EventOverride {
    pub badge_id: u16,
    /// The badge owner who set it; may clear it even after `close_consent`.
    pub owner: Pubkey,
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
    /// Rolling hash: `head_n = sha256(head_{n-1} || commitment_n)`, `head_0 = 0`.
    pub head: [u8; 32],
    pub count: u64,
    pub first_at: i64,
    pub last_at: i64,
    pub bump: u8,
}

/// One per film-event of an opted-out badge. PDA seeds:
/// `["capture", camera authority, event_hash]`.
#[account]
#[derive(InitSpace)]
pub struct CaptureNotice {
    /// The badge that was on camera.
    pub badge_id: u16,
    /// The camera authority that filed it (a registered `CameraLog`).
    pub camera: Pubkey,
    /// sha256 of the canonical FilmEvent — the off-chain audit entry this is about.
    pub event_hash: [u8; 32],
    /// The camera's clock at capture (unix seconds).
    pub filmed_at: i64,
    /// Chain clock when the capture was filed here.
    pub recorded_at: i64,
    /// Chain clock when the person was told; 0 while pending.
    pub notified_at: i64,
    /// How they were told (`CHANNEL_*` bits); 0 while pending.
    pub channels: u8,
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
    pub instance: u64,
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
    pub commitment: [u8; 32],
    pub head: [u8; 32],
    pub at: i64,
}

#[event]
pub struct CaptureRecorded {
    pub badge_id: u16,
    pub camera: Pubkey,
    pub event_hash: [u8; 32],
    pub filmed_at: i64,
    pub recorded_at: i64,
}

#[event]
pub struct NoticeRecorded {
    pub badge_id: u16,
    pub camera: Pubkey,
    pub event_hash: [u8; 32],
    pub notified_at: i64,
    pub channels: u8,
}

// ---------------------------------------------------------------------------
// errors

#[error_code]
pub enum ConsentError {
    #[msg("Only the record owner (or the issuer, for issuance) may do this")]
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
    #[msg("Signed message has expired")]
    SignatureExpired,
    #[msg("Signed message validity exceeds the maximum TTL")]
    SignatureTtlTooLong,
    #[msg("event_id must be 1..=32 bytes")]
    EventIdTooLong,
    #[msg("label must be <= 32 bytes")]
    LabelTooLong,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Expected the Instructions sysvar")]
    BadSysvar,
    #[msg("filmed_at must be a past unix time (at most 5 minutes ahead of the chain clock)")]
    BadTimestamp,
    #[msg("channels must name at least one notification channel")]
    NoChannel,
    #[msg("This capture notice has already been marked as delivered")]
    AlreadyNotified,
}
