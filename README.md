# Consentinel

**Your face, your rules — enforced by light and owned on-chain.**

A consent-respecting video-capture pipeline for Hack the North 2026. HTN badges
show a coded light key carrying a short id; the capture app reads the keys
from the video, associates each with the nearest face, and **blurs everyone
who has not opted in**. Each person's consent is a **signed,
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
| `glasses-relay/` | the iOS app that carries Meta glasses frames to the capture app (the glasses only talk to a phone) | B |
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

1. **Badge → camera (light).** The badge shows a STATIC key: three giant
   7-segment hex digits, `id(8) << 4 | crc4(id)` (id `27` shows `271`), MINT
   for opt-in and ROSE for opt-out, on black (the ring around the digits is
   painted black since the webcam runs: white bloomed into the last digit).
   The app's decoder (`capture-app/src/decode/key.ts`) finds the digits, fits
   the grid, reads all three, checks the CRC, and binds the id to the nearest
   face above. One clean frame is enough; nothing blinks. The status LEDs are
   filtered out by their white-cored halo, but keep them dim (LED_LEVEL 64).
2. **Camera → chain (read).** The face is clear only if the chain-synced cache
   says that id is `opt_in`. Unknown, stale, no badge ⇒ blur.
3. **Camera → service (FilmEvent).** An opted-out person on camera fires a
   FilmEvent (id + time + camera, never pixels) to `service/`: audit log →
   `CNSF` radio frame to the badge (red alarm) → ElevenLabs voice → folded into
   the next on-chain commitment → **notice**: the camera key files
   `record_capture` (when they were filmed), the person is told (email — a
   dry-run in the demo — plus the badge alarm and the voice), and
   `record_notice` stamps when and how. Both land as one on-chain record per
   film-event; the app pops "*Hashim Bukhtiar has been notified — email
   sent*" with a link to each transaction.
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

1. **Badge** — push `firmware/consentinel-beacon.lua` to the HTN badge
   (`firmware/README.md` §2), open *Consentinel*. The CONFIG screen shows the
   wearer's `KEY` (three hex digits, e.g. `271` = id `27` + CRC nibble) and
   `OPT-IN`/`OPT-OUT`; **A** toggles consent, **START arms the beacon** (the
   three giant digits; UP/DOWN dims them, any other key returns to CONFIG;
   **LEFT** turns the six LEDs off — do that if their glare lands on the
   screen; the debug HUD's `ms/frame` line shows where the frame time goes). Any badge works: the first time a camera sees an id with no
   record, the service registers it as `opt_out` (organizer key), so its card
   appears in the panel within a few seconds. No badge? **Synthetic badge** in
   the app paints a real-format `4E` key (works without a camera too).
2. **Capture app** — http://localhost:5173 → **Use camera** (decoder is
   *optical* by default; the header button flips to *stub* = fake beacons).
   Hold the badge **just below your chin, screen square to the camera**, with
   the beacon ARMED (START). The three digits must be ≥ 18 px wide in the
   processing frame; the decoder is reliable from ~32 px — roughly ≤ 1 m from
   a laptop webcam at **1280px** (the default; 720 px halves that). A lock
   takes two consecutive frames (~100 ms). With **overlay: on** the feed shows
   what the decoder sees — a red box with its verdict on every candidate
   (`mint blob, no key read (24 px)` = too small / not square to the camera),
   green `badge 27 · OPT-IN → T1` = decoded and bound to the face above it —
   and the **Beacons** panel says why nothing decodes. Then the track row
   shows the id, consent from devnet, and the face blurs (opt_out). Something
   off? **🎥 4s** records four seconds of frames to `data/diag/` and
   `npx tsx scripts/replay.ts ../data/diag/<ts>-seq` replays the real decoder
   over them, frame by frame.
3. **The on-stage beat** — press **A on the badge** (any key leaves the
   beacon; toggle, then START again). The light now carries the wearer's
   choice: an OPT-OUT blurs the face on the very next frame (restrict-only,
   no chain round-trip), and an OPT-IN is relayed by the camera as the badge's
   `CNSR` request → the service signs it with the badge's key → the program
   verifies it on-chain → the cache push clears the face, typically 2–4 s
   after the decode, with an explorer link in **Badge radio**. No wallet, no
   panel click. The other ways to flip a record still work: the panel's
   **grant/revoke**, `npm run badge-press -- 3D grant` or `npm run toggle`
   in `registry/`, or `CNSR3D1` ⏎ in `npm run bridge -- --stdin`.

   **`delete record…`** on a card really deletes the on-chain record (it asks
   first): the badge is then unregistered ⇒ always blurred until it is seen
   again and auto-registered.
4. **Film event → notice** — with an opted-out badge on camera (`271` on the
   screen = Nehad, `86D` = Hashim; the two demo contacts live in
   `data/demo/seed-consents.json`): a popup over the feed says *Nehad Shikh
   Trab was filmed at 12:01:03 — recording on Solana…*, turns into *has been
   notified — email sent to n•••@gmail.com* a few seconds later, and links
   the two transactions (`⛓ filmed ↗`, `⛓ notified ↗`) plus the notice
   account. The laptop speaks (ElevenLabs, or macOS `say` labeled as
   fallback), the **Badge radio** section shows `↓ CNSF27`, the **Filmed &
   notified** list in the consent panel shows the on-chain record (filmed /
   filed / told, straight from the cache), and within 10 s the event is also
   folded into the camera's commitment (`#n ↗`). `GET /audit/notices?badge=27`
   reads the notices back from the chain; `GET /audit/verify` proves the
   log matches the chain. The email itself is a **dry-run**: composed and
   appended to `data/audit/notices.jsonl`, never sent — the on-chain notice
   is the real artefact, and `/health` says `email dry-run`.
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
- **Capture notices** (`record_capture` / `record_notice`): for every
  film-event of an opted-out badge the camera key files a `CaptureNotice`
  PDA keyed by `(camera, sha256(FilmEvent))` — the same hash the audit log
  stores for that entry — holding `filmed_at` (camera clock), `recorded_at`
  and `notified_at` (chain clock) and the channels the person was told over.
  Only the registered camera can write it, nobody can delete it, and it is
  single-use: "told" cannot be re-dated. It is the person's evidence that a
  camera saw them without consent *and* that they were told, and it carries no
  name, email or image — the badge id is the only key, the organizer's
  directory (off-chain) turns it into a person. The constant-cadence
  commitment stream still covers the whole log; the notice is the per-person
  receipt for the one case where a receipt is owed.
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

# terminal 3 — vision sidecar: YOLOv8x-face + the badge digit model on the laptop GPU (Apple MPS)
cd vision && ./setup.sh && .venv/bin/python server.py           # ws://127.0.0.1:8765; the app falls back to in-browser BlazeFace + the classical decoder when this is down

# terminal 4 (optional) — badge radio bridge, or your keyboard standing in for it
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
if `SERVICE_TOKEN` is set) feeds the "who filmed me?" layer, and
`GET /audit/notices?badge=4E` returns the camera's on-chain notices for that
badge (filmed_at / notified_at / channels, one `getProgramAccounts`).
One camera key per running service: a second laptop attesting with a copy of
the same `keys/camera-cam-1.json` forks the two local logs from the chain
(`/audit/verify` reports it on both). Give that machine its own camera
(delete its `keys/camera-cam-1.json`, re-run `npm run seed` there), then
`npm run rebuild-audit` in `service/` re-derives this log's batch list from
the chain's own `CaptureAttested` events (keeps every local film-event; the
old file is kept as `.bak`).

### Flags

`capture-app/src/config/flags.ts` (override with `VITE_*` in `.env.local`, see
`capture-app/.env.example`): `CONSENT_SOURCE` (`chain` | `stub` — stub is the
no-network fallback), `SOLANA_CLUSTER` (the RPC URL follows unless
`VITE_SOLANA_RPC_URL` is set), `BEACON_DECODER` (`optical` | `stub`),
`CONSENT_CACHE_SYNC_MS`, `CONSENT_STALE_MS`, `EVENT_ID`, `FILM_EVENT_ENDPOINT`,
`SERVICE_TOKEN`, `SERVICE_WS_URL`, `DEFAULT_CONSENT = blur`.
Service flags: `service/.env.example` (`SERVICE_TOKEN`, `CORS_ORIGIN`,
`ATTEST_INTERVAL_MS`, `ATTEST_HEARTBEAT`, `BADGE_KEYS_DIR`, `RADIO_SYNC_MS`,
`NOTIFY_ON_CHAIN`, `CONTACTS_FILE`, `NOTICE_LOG`, `NOTICE_MIN_INTERVAL_MS` — one
on-chain notice per badge per minute; a badge that stays in frame keeps firing
film-events for the alarm, and they are covered by that notice, …).

### Judge Q&A (built in, not just pitched)

| Question | Answer |
|---|---|
| Isn't this face recognition? | No. Blur is driven by the light beacon; no face DB exists. |
| Badge occluded / out of frame? | Fail-safe: blur on uncertainty, plus a tracker that persists the blur. |
| Why blockchain? | Consent is user-owned and revocable on-chain, enforcement is tied to that record, and the live revoke→blur-flip proves it. The audit log is hash-anchored so it can't be quietly edited, and the anchoring cadence is constant so the chain reveals nothing about captures. |
| Who can register a badge? | Only the organizer (`Registry.issuer`), once per badge id — it hands out the physical badge anyway. After that only the badge's key matters. |
| The light carries OPT-IN now — so why the chain? | The light is restrict-only: it can blur you instantly but can never clear you. Clearing needs the on-chain record, which only the badge's key can change; the camera merely relays the badge's request. A replayed "OPT-IN" light therefore cannot un-blur anyone. |
| Do I have to register every badge by hand? | No. A badge seen for the first time is auto-registered as `opt_out` by the organizer service (`AUTO_REGISTER`), which can never un-blur anyone. The seed file just gives the demo badges labels and initial states. |
| Can I spoof a badge id? | The chain authenticates `badge_id → consent`, not the emitter of a blink. A replayed opt-in beacon held next to a bystander can un-blur them; a replayed opt-out can force a blur. That is the light channel's limit, stated up front; the upgrade is a rolling code (`badge_id ‖ counter`, HMAC-truncated) or the badge-signed BLE payload we already verify on-chain. |
| Does the badge need SOL / a wallet? | No. Its A button sends a radio request; the badge's key signs a 49-byte message; a relayer pays; the program verifies the signature, nonce, instance and deadline. |
| The badge has no Wi-Fi — how does it talk to the chain? | Light up (id only) and BLE radio down/up through a bridge. The service is the badge's registry client: it turns `CNSR` into the signed update and mirrors every on-chain change back as `CNSC`. |
| Doesn't the operator hold everyone's keys in the demo? | Only because the firmware isn't signing yet — see the honesty note above; `badge-press` from another process shows the same path, and a wallet that owns a record signs for itself. |
| Default for someone with no badge? | Blur. |
| How does someone who opted out know they were filmed? | The camera files it on-chain (`record_capture`: badge id + when), the service tells them (badge alarm, voice, email — a dry-run in the demo) and files that too (`record_notice`: when + how). The record is theirs to point at; it names no one. |

## Thru (Unto Labs) — the evidence ledger

Two chains, two jobs. **Solana** holds *authorization*: who consents — rare,
owner-signed, revocable (the Anchor registry above). **Thru** holds *evidence*:
what the camera did — frequent and append-only. Batching evidence to a slow
chain every 10 s means the record lags reality, so on Thru the service commits
**every film-event and every attestation checkpoint the moment it happens**,
each as its own Alphanet account (`thru uploader upload`, ~3 s), readable by
anyone on `scan.thru.org`. The checkpoint commit carries the Solana signature,
so the two ledgers cross-reference. Nothing visual is ever stored — the same
ids, hashes and timestamps the Solana attestation already carries.

Setup (once, on the demo laptop):

```bash
npm i -g thru
thru keys generate consentinel && thru account create consentinel
thru faucet withdraw consentinel 5000 --fee-payer consentinel
```

`service/src/thru.ts` auto-disables (and says why on startup) if the CLI or
funds are missing, so the hero path never depends on it. In the operator panel
each capture gets a **Thru ↗** link and the **Evidence ledger** section streams
commits. Alphanet is a developer network and this integration was written
during the event; the fee-payer key is a throwaway.

## Licenses / credits

MediaPipe (Apache-2.0), Ultralytics YOLOv8 (AGPL-3.0) and the lindevs YOLOv8-Face weights (WIDER FACE), Anchor (Apache-2.0), `@solana/web3.js` (MIT),
`@noble/hashes` (MIT), `tweetnacl` (Unlicense), `ws` (MIT), React (MIT), Vite (MIT).
ElevenLabs API for the spoken alerts.
