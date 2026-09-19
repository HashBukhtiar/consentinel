# Consentinel

**Your face, your rules — enforced by light and owned on-chain.**

A consent-respecting video-capture pipeline for Hack the North 2026. HTN badges
blink a coded light beacon carrying a short id; the capture app decodes the
beacons from the video, associates each with the nearest face, and **blurs
everyone who has not opted in**. Each person's consent is a **signed,
revocable record they own on Solana**. When an opted-out person is captured,
their badge buzzes and an ElevenLabs voice tells them.

Honest scope: Consentinel governs video shot **through its own capture
pipeline** (an event photographer's app, a venue camera). It is a consent layer
with a **fail-safe-blur default**, not universal phone-proofing.

Privacy by construction: **no face database, no identity matching** (blur is
driven by the beacon, not by who you are); **nothing visual ever touches the
chain** (on-chain: badge id, owner key, consent flags, timestamps, and a hash
that commits to the off-chain film-event log).

## Repo

| dir | what | owner |
|---|---|---|
| `capture-app/` | the CV core (web/TS): camera → detect → decode → associate → blur → FilmEvent | A (beacon decode) + B (vision) |
| `registry/` | **Solana**: Anchor program (`consent_registry`), tests, TS client, demo scripts | C |
| `service/` | notify + audit service: FilmEvent → badge buzz + ElevenLabs + on-chain attestation; badge-signed consent relay | C |
| `data/demo/` | seed consents for the demo | C |
| `shared` types | `capture-app/src/shared/schema.ts` | all |

## Part C — the consent registry on Solana

### Why the chain is load-bearing

- **User-owned, revocable consent.** One PDA per badge (`["consent", badge_id]`)
  holding `{ badge_id, owner, consent, revision, instance, created_at, updated_at }`.
  Only the owner's Ed25519 key can change or delete it. The camera operator
  cannot.
- **Organizer-gated issuance.** A badge is a physical credential handed out by
  the organizer, so the organizer (`Registry.issuer`) binds `badge_id → owner
  key` exactly once (`register`). Without this gate anyone could squat an
  unregistered id with `consent = true` and un-blur a bystander. After
  issuance the organizer has no power over the record.
- **Enforcement reads a cache, never the chain per frame.** The capture app
  keeps a local `beaconId → consent` map fed by a websocket subscription to the
  program's logs (push, ~1 s) plus a `getProgramAccounts` poll every 3 s
  (backstop). Both are slot-ordered so a late poll never overwrites a newer
  push. Unknown ids are "unknown" ⇒ blur until resolved, and if no sync has
  landed for 60 s the whole cache stops being authoritative ⇒ everything blurs.
- **Badge-signed updates without SOL** (`set_consent_delegated`). The badge
  signs a 49-byte message with its own key; anyone relays it; the program
  introspects the Ed25519 native-program instruction in the same transaction
  and checks pubkey + message. `nonce == revision` makes every signed message
  single-use, `instance` ties it to this registration (no replay after a close
  + re-register), and `expires_at` bounds how long a relayer can sit on it.
  This is what lets a button on an ESP32 flip an on-chain record.
- **Tamper-evident audit log that leaks nothing** (`register_camera` /
  `attest_capture`). The notify service folds one commitment per 10 s
  interval into the camera's on-chain rolling hash — the hash of that
  interval's film-event hashes, or the zero hash as a heartbeat. Constant
  cadence ⇒ the public chain carries no signal about when or whether anyone was
  filmed; anyone holding the off-chain log can still prove it is complete and
  unmodified (`GET /audit/verify` recomputes from raw fields).
- **Per-event overrides** (`set_event_override`): "blur me everywhere except
  the closing ceremony" is a second PDA keyed by `(badge, sha256(event_id))`,
  owned by the badge owner and clearable even after the record is closed.
- **Delete** (`close_consent`): rent back to the owner; absence ⇒ fail-safe blur.

Program id (devnet + localnet): `UKoViTT9288nMeBzjeMoHBBmxHfXvbg6F1gF6pjiSW7`.
The operator panel links every confirmed transaction to Solana Explorer.

### Setup (once)

Toolchain: Rust, Solana CLI (Agave 4.x), Anchor 1.2 (`avm install latest`), Node 20+.
The program keypair for that id lives in `registry/keys/program-keypair.json`
(not in git — get it from C, or run `anchor keys sync` to adopt a new id in
`lib.rs`, `Anchor.toml` and `registry/client/src/core.ts`). `npm run build`
restores it into `target/deploy/` and fails if the built id differs.

```bash
# devnet wallet + SOL (https://faucet.solana.com with a GitHub login is the reliable way)
solana-keygen new -o ~/.config/solana/id.json
solana config set -u devnet
solana airdrop 2

cd registry && npm install
npm run build                 # anchor build --arch v0 + id check + copy IDL into client/idl
anchor deploy --provider.cluster devnet
npm run seed                  # registry init (issuer = this wallet), badge records, camera log, relayer;
                              # writes capture-app/public/demo/badges.json
npm run status                # sanity check
```

Note on `--arch v0`: the SBPF v0 artifact deploys on devnet and on any
validator where SIMD-0500 is inactive; Anchor 1.2's default (v3) is rejected
by older validators.

### Localnet (no devnet SOL needed)

```bash
solana-test-validator -r --quiet --deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g &
   # (SIMD-0500 off, so the v0 artifact deploys exactly as on devnet)
cd registry && solana airdrop 10 -u localhost && anchor test --skip-build --skip-local-validator   # deploys + 23 tests
SOLANA_CLUSTER=localnet npm run seed
cd ../service && cp .env.localnet .env && npm run dev
cd ../capture-app && echo 'VITE_SOLANA_CLUSTER=localnet' > .env.local && npm run dev
```

(`anchor test` alone on Anchor 1.2 expects `surfpool`; the external-validator
flow above avoids it.)

### Run the demo (devnet)

```bash
# terminal 1 — notify + audit service (FilmEvent → buzz + voice + on-chain commitments)
cd service && cp .env.example .env   # add ELEVENLABS_API_KEY; without it macOS `say` is used and labeled as fallback
npm install && npm run dev            # http://localhost:8787/health

# terminal 2 — capture app
cd capture-app && npm install && npm run setup && npm run dev   # http://localhost:5173
```

In the operator panel, the **Consent · Solana devnet** section shows every
record straight from the cache. **grant / revoke** default to the
**badge-signed + relayed** path: the badge's key signs the 49-byte message,
the funded demo relayer submits it, the program verifies the Ed25519 signature
on-chain. Untick to sign the transaction directly as the owner instead;
**close** deletes the record. A connected Phantom/Solflare that owns a record
signs for itself. The face's blur flips as soon as the websocket push lands
(typically ~1 s, always within the 3 s poll).

Honesty note: during the demo the badge keys are loaded from
`capture-app/public/demo/badges.json` (written by `npm run seed`, Vite serves
it on localhost only) because the ESP32 firmware does not sign yet. It is the
same key and the same on-chain verification the badge will use; to show the
flip coming from a *separate* actor run, from `registry/`:

```bash
npm run toggle -- A1B2 revoke              # owner-signed, deployer pays the fee
npm run toggle -- A1B2 grant --delegated   # badge-signed, relayed
npm run badge-press -- A1B2 toggle         # what the ESP32 button does (through the service)
npm run watch                              # tail events from a second terminal
```

Audit: `GET http://localhost:8787/audit/verify` recomputes the local hash
chain from raw fields and compares it to the on-chain head (reports
`mismatches` and `unanchored`). `GET /audit/events?badge=A1B2` (bearer token
if `SERVICE_TOKEN` is set) feeds the "who filmed me?" layer.

### Flags

`capture-app/src/config/flags.ts` (override with `VITE_*` in `.env.local`):
`CONSENT_SOURCE` (`chain` | `stub` — stub is the no-network fallback),
`SOLANA_CLUSTER` (the RPC URL follows unless `VITE_SOLANA_RPC_URL` is set),
`CONSENT_CACHE_SYNC_MS`, `CONSENT_STALE_MS`, `EVENT_ID`, `FILM_EVENT_ENDPOINT`,
`SERVICE_TOKEN`, `SERVICE_WS_URL`, `DEFAULT_CONSENT = blur`.
Service flags: `service/.env.example` (`SERVICE_TOKEN`, `CORS_ORIGIN`,
`ATTEST_INTERVAL_MS`, `ATTEST_HEARTBEAT`, …).

### Judge Q&A (built in, not just pitched)

| Question | Answer |
|---|---|
| Isn't this face recognition? | No. Blur is driven by the light beacon; no face DB exists. |
| Badge occluded / out of frame? | Fail-safe: blur on uncertainty, plus a tracker that persists the blur. |
| Why blockchain? | Consent is user-owned and revocable on-chain, enforcement is tied to that record, and the live revoke→blur-flip proves it. The audit log is hash-anchored so it can't be quietly edited, and the anchoring cadence is constant so the chain reveals nothing about captures. |
| Who can register a badge? | Only the organizer (`Registry.issuer`), once per badge id — it hands out the physical badge anyway. After that only the badge's key matters. |
| Can I spoof a badge id? | The chain authenticates `badge_id → consent`, not the emitter of a blink. A replayed opt-in beacon held next to a bystander can un-blur them; a replayed opt-out can force a blur. That is the light channel's limit, stated up front; the upgrade is a rolling code (`badge_id ‖ counter`, HMAC-truncated) or the badge-signed BLE payload we already verify on-chain. |
| Does the badge need SOL / a wallet? | No. It signs a 49-byte message; a relayer pays; the program verifies the signature, nonce, instance and deadline. |
| Doesn't the operator hold everyone's keys in the demo? | Only because the firmware isn't signing yet — see the honesty note above; `badge-press` from another process shows the same path, and a wallet that owns a record signs for itself. |
| Default for someone with no badge? | Blur. |

## Licenses / credits

MediaPipe (Apache-2.0), Anchor (Apache-2.0), `@solana/web3.js` (MIT),
`@noble/hashes` (MIT), `tweetnacl` (Unlicense), `ws` (MIT), React (MIT), Vite (MIT).
ElevenLabs API for the spoken alerts.
