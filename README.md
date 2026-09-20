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
| `firmware/` | the badge: Lua app that blinks the optical beacon, mirrors consent, raises the alarm, sends `CNSR` on the A button | A |
| `shared/beacon.ts` | the optical + radio wire format (badge ↔ capture app ↔ service) | A |
| `capture-app/` | the CV core (web/TS): camera → detect → decode → associate → blur → FilmEvent, plus the operator panel | A (beacon decode) + B (vision) |
| `registry/` | **Solana**: Anchor program (`consent_registry`), tests, TS client, demo scripts | C |
| `service/` | notify + audit service: FilmEvent → badge radio alarm + ElevenLabs + on-chain attestation; badge radio bridge; badge-signed consent relay | C |
| `data/demo/` | seed consents for the demo | C |
| `scripts/` | `preflight.sh` (is this laptop ready?), `dev.sh` (run everything), `stop.sh` | all |

## How the parts connect

```
                 light (optical beacon, id only)                    BLE radio (CNS* frames)
  HTN badge  ═══════════════════════════════▶  capture app        badge ◀════════▶ bridge ◀═══▶ service
  firmware/consentinel-beacon.lua              capture-app/                    (ESP32 dev board   service/src/radio.ts
                                                  │                             or --stdin)
   decode (A) → face track (B) → getConsent (C)   │ FilmEvent (no image)            ▲
                      ▲                            ▼                                │ CNSF (alarm)  CNSC (mirror)
              consent cache ◀── ws push + poll ── Solana consent_registry ◀── relay ── CNSR (A button, badge-signed by the service)
                                                   ▲
                                        attest_capture every 10 s (hash of the film-event log, or heartbeat)
```

1. **Badge → camera (light).** The badge blinks its 8-bit id (`4E`). The app's
   optical decoder (`capture-app/src/decode/beacon.ts`) finds the patch, decodes
   the id with A's `decodeFrame`, and binds it to the nearest face above.
2. **Camera → chain (read).** The face is clear only if the chain-synced cache
   says that id is `opt_in`. Unknown, stale, no badge ⇒ blur.
3. **Camera → service (FilmEvent).** An opted-out person on camera fires a
   FilmEvent (id + time + camera, never pixels) to `service/`: audit log →
   `CNSF` radio frame to the badge (red alarm) → ElevenLabs voice → folded into
   the next on-chain commitment.
4. **Badge → chain (write).** The badge's A button sends `CNSR<id><0|1>` over
   radio. The service signs the 49-byte delegated message with that badge's
   key and relays it; the program verifies the Ed25519 signature on-chain; the
   app's cache gets the push and the blur flips; the service mirrors the new
   state back down as `CNSC`.
5. **Chain → badge (mirror).** Every on-chain consent change reaches the badge
   screen as `CNSC`, whichever path changed it (badge button, operator panel,
   `npm run toggle`, a wallet).

The badge radio needs a bridge for the last metre of air (`service/BADGE_PROTOCOL.md`
§2): an ESP32 dev board on USB (`npm run bridge -- --port …`) or, with no
hardware, `npm run bridge -- --stdin` where your keyboard plays the badge. The
hero path (light → blur → on-chain flip) needs no radio at all.

## Run everything

```bash
scripts/preflight.sh          # ✓/✗ per check, with the fix for each ✗
scripts/dev.sh                # service (:8787) + capture app (:5173), Ctrl+C stops both
```

Then, in order:

1. **Badge** — install `firmware/consentinel-beacon.lua` on the HTN badge
   (`firmware/README.md` §2), open *Consentinel*; it shows `ID 4E` and blinks.
   No badge? The app's **Synthetic badge** button overlays a real-format `4E`
   beacon on your webcam.
2. **Capture app** — http://localhost:5173 → **Use camera** (decoder is
   *optical* by default; the header button flips to *stub* = fake beacons).
   Hold the badge **just below your chin, screen square to the camera, close**:
   the patch must be ≥ 40 px wide in the processing frame, which at the default
   720 px is within ~50 cm of a laptop webcam (pick **1280px** in the header to
   roughly double that). With **overlay: on** the feed shows what the decoder
   sees — red box = patch found but too small/dim/blurred, yellow = reading,
   green `badge 4E → T1` = decoded and bound to the face above it — and the
   **Beacons** panel says why nothing decodes. Then the track row shows `4E`,
   consent from devnet, and the face blurs (seeded `opt_out`).
   No badge at hand? `http://localhost:5173/?clip=/demo/badge-4E.mp4` runs the
   whole pipeline on Maaz's badge recording (put any H.264 clip in
   `capture-app/public/demo/`).
3. **The on-stage beat** — flip `4E` on-chain any of these ways and watch the
   blur clear within the sync interval (~1 s push, ≤3 s poll):
   - badge A button (needs the radio bridge), or `CNSR4E1` ⏎ in `npm run bridge -- --stdin`
   - operator panel → **grant** (badge-signed + relayed by default)
   - `cd registry && npm run badge-press -- 4E grant` (the button, from another process)
   - `cd registry && npm run toggle -- 4E grant` (owner-signed)

   The badge's own **A button only changes the badge's local mirror** and sends
   a `CNSR` radio request; without the bridge that request never reaches the
   chain, so the blur does not change. **`delete record…`** on a card really
   deletes the on-chain record (it asks first): the badge is then unregistered
   ⇒ always blurred and grant/revoke vanish until `npm run seed` re-registers it.
4. **Film event** — with `4E` opted out and on camera: the panel lists the
   event, the laptop speaks (ElevenLabs, or macOS `say` labeled as fallback),
   the **Badge radio** section shows `↓ CNSF4E`, and within 10 s the event is
   anchored (`⛓ #n ↗` links to the transaction). `GET /audit/verify` proves
   the log matches the chain.
5. **Smoke test without a camera** — `cd service && npm run smoke` drives
   FilmEvent → CNSF, CNSR → badge-signed relay → on-chain flip → CNSC, and
   waits for the attestation. Run it before going on stage.

Localnet instead of devnet (no SOL needed): start the validator and seed as in
the *Localnet* section below, then `scripts/dev.sh localnet`.

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

`scripts/dev.sh` does both of these; by hand:

```bash
# terminal 1 — notify + audit service (FilmEvent → badge radio + voice + on-chain commitments)
cd service && cp .env.example .env   # add ELEVENLABS_API_KEY; without it macOS `say` is used and labeled as fallback
npm install && npm run dev            # http://localhost:8787/health

# terminal 2 — capture app
cd capture-app && npm install && npm run setup && npm run dev   # http://localhost:5173

# terminal 3 (optional) — badge radio bridge, or your keyboard standing in for it
cd service && npm run bridge -- --port /dev/cu.usbserial-XXXX     # ESP32 dev board
cd service && npm run bridge -- --stdin                            # type CNSR4E1 ⏎ = badge A button
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
npm run toggle -- 4E revoke              # owner-signed, deployer pays the fee
npm run toggle -- 4E grant --delegated   # badge-signed, relayed
npm run badge-press -- 4E toggle         # what the ESP32 button does (through the service)
npm run watch                              # tail events from a second terminal
```

Audit: `GET http://localhost:8787/audit/verify` recomputes the local hash
chain from raw fields and compares it to the on-chain head (reports
`mismatches` and `unanchored`). `GET /audit/events?badge=4E` (bearer token
if `SERVICE_TOKEN` is set) feeds the "who filmed me?" layer.

### Flags

`capture-app/src/config/flags.ts` (override with `VITE_*` in `.env.local`, see
`capture-app/.env.example`): `CONSENT_SOURCE` (`chain` | `stub` — stub is the
no-network fallback), `SOLANA_CLUSTER` (the RPC URL follows unless
`VITE_SOLANA_RPC_URL` is set), `BEACON_DECODER` (`optical` | `stub`),
`CONSENT_CACHE_SYNC_MS`, `CONSENT_STALE_MS`, `EVENT_ID`, `FILM_EVENT_ENDPOINT`,
`SERVICE_TOKEN`, `SERVICE_WS_URL`, `DEFAULT_CONSENT = blur`.
Service flags: `service/.env.example` (`SERVICE_TOKEN`, `CORS_ORIGIN`,
`ATTEST_INTERVAL_MS`, `ATTEST_HEARTBEAT`, `BADGE_KEYS_DIR`, `RADIO_SYNC_MS`, …).

### Judge Q&A (built in, not just pitched)

| Question | Answer |
|---|---|
| Isn't this face recognition? | No. Blur is driven by the light beacon; no face DB exists. |
| Badge occluded / out of frame? | Fail-safe: blur on uncertainty, plus a tracker that persists the blur. |
| Why blockchain? | Consent is user-owned and revocable on-chain, enforcement is tied to that record, and the live revoke→blur-flip proves it. The audit log is hash-anchored so it can't be quietly edited, and the anchoring cadence is constant so the chain reveals nothing about captures. |
| Who can register a badge? | Only the organizer (`Registry.issuer`), once per badge id — it hands out the physical badge anyway. After that only the badge's key matters. |
| Can I spoof a badge id? | The chain authenticates `badge_id → consent`, not the emitter of a blink. A replayed opt-in beacon held next to a bystander can un-blur them; a replayed opt-out can force a blur. That is the light channel's limit, stated up front; the upgrade is a rolling code (`badge_id ‖ counter`, HMAC-truncated) or the badge-signed BLE payload we already verify on-chain. |
| Does the badge need SOL / a wallet? | No. Its A button sends a radio request; the badge's key signs a 49-byte message; a relayer pays; the program verifies the signature, nonce, instance and deadline. |
| The badge has no Wi-Fi — how does it talk to the chain? | Light up (id only) and BLE radio down/up through a bridge. The service is the badge's registry client: it turns `CNSR` into the signed update and mirrors every on-chain change back as `CNSC`. |
| Doesn't the operator hold everyone's keys in the demo? | Only because the firmware isn't signing yet — see the honesty note above; `badge-press` from another process shows the same path, and a wallet that owns a record signs for itself. |
| Default for someone with no badge? | Blur. |

## Licenses / credits

MediaPipe (Apache-2.0), Anchor (Apache-2.0), `@solana/web3.js` (MIT),
`@noble/hashes` (MIT), `tweetnacl` (Unlicense), `ws` (MIT), React (MIT), Vite (MIT).
ElevenLabs API for the spoken alerts.
