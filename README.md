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
  holding `{ badge_id, owner, consent, revision, created_at, updated_at }`.
  Only the owner's Ed25519 key can change or delete it. The camera operator
  cannot.
- **Enforcement reads a cache, never the chain per frame.** The capture app
  keeps a local `beaconId → consent` map fed by a websocket subscription to the
  program's logs (push, ~1 s) plus a `getProgramAccounts` poll every 3 s
  (backstop). Both are slot-ordered so a late poll never overwrites a newer
  push. Unknown ids are "unknown" ⇒ blur until resolved.
- **Badge-signed updates without SOL** (`set_consent_delegated`). The badge
  signs a 33-byte message with its own key; anyone relays it; the program
  introspects the Ed25519 native-program instruction in the same transaction
  and checks pubkey + message. `nonce == revision` makes every signed message
  single-use (no replay). This is what lets a button on an ESP32 flip an
  on-chain record.
- **Tamper-evident audit log** (`register_camera` / `attest_capture`). Each
  film-event is hashed off-chain and folded into the camera's on-chain rolling
  hash (`head = sha256(head ‖ event_hash)`). Anyone with the log can prove it
  is complete and unmodified; nobody can learn from the chain who was filmed.
- **Per-event overrides** (`set_event_override`): "blur me everywhere except
  the closing ceremony" is a second PDA keyed by `(badge, event_id)`.
- **Delete** (`close_consent`): rent back to the owner; absence ⇒ fail-safe blur.

Program id (devnet): see `registry/Anchor.toml`. The operator panel links every
confirmed transaction to Solana Explorer.

### Setup (once)

Toolchain: Rust, Solana CLI (Agave), Anchor 1.2 (`avm install latest`), Node 20+.

```bash
# devnet wallet + SOL (the web faucet https://faucet.solana.com is the reliable one)
solana-keygen new -o ~/.config/solana/id.json
solana config set -u devnet
solana airdrop 2

cd registry && npm install
npm run build                 # anchor build + copy IDL into client/idl
anchor deploy --provider.cluster devnet
npm run seed                  # badge keys + consent records + camera log; writes capture-app/public/demo/badges.json
npm run status                # sanity check
```

Local tests (`anchor test` on Anchor 1.2 expects `surfpool`; with
`solana-test-validator` instead):

```bash
solana-test-validator -r --quiet &
cd registry && solana airdrop 10 -u localhost && anchor test --skip-local-validator
```

### Run the demo

```bash
# terminal 1 — notify + audit service (FilmEvent → buzz + voice + on-chain hash)
cd service && cp .env.example .env   # add ELEVENLABS_API_KEY; without it macOS `say` is used and labeled as fallback
npm install && npm run dev            # http://localhost:8787/health

# terminal 2 — capture app
cd capture-app && npm install && npm run setup && npm run dev   # http://localhost:5173
```

In the operator panel, the **Consent · Solana devnet** section shows every
record straight from the cache. **grant / revoke / close** send a real
owner-signed transaction (the demo badge keys from `npm run seed`; or connect
Phantom if its key owns a record). Tick **badge-signed + relayed** to use the
Ed25519-verified delegated path instead. The face's blur flips as soon as the
websocket push lands (typically ~1 s, always within the 3 s poll).

CLI equivalents for the on-stage beat (from `registry/`):

```bash
npm run toggle -- A1B2 revoke              # owner-signed
npm run toggle -- A1B2 grant --delegated   # badge-signed, relayed
npm run badge-press -- A1B2 toggle         # what the ESP32 button will do (via the service)
npm run watch                              # tail events from a second terminal
```

Audit: `GET http://localhost:8787/audit/verify` recomputes the local hash
chain and compares it to the on-chain head. `GET /audit/events?badge=A1B2`
feeds the "who filmed me?" layer.

### Flags

`capture-app/src/config/flags.ts` (override with `VITE_*` in `.env.local`):
`CONSENT_SOURCE` (`chain` | `stub` — stub is the no-network fallback),
`SOLANA_CLUSTER`, `SOLANA_RPC_URL`, `CONSENT_CACHE_SYNC_MS`, `EVENT_ID`,
`FILM_EVENT_ENDPOINT`, `SERVICE_WS_URL`, `DEFAULT_CONSENT = blur`.
Service flags: `service/.env.example`.

### Judge Q&A (built in, not just pitched)

| Question | Answer |
|---|---|
| Isn't this face recognition? | No. Blur is driven by the light beacon; no face DB exists. |
| Badge occluded / out of frame? | Fail-safe: blur on uncertainty, plus a tracker that persists the blur. |
| Why blockchain? | Consent is user-owned and revocable on-chain, enforcement is tied to that record, and the live revoke→blur-flip proves it. The audit log is hash-anchored so it can't be quietly edited. |
| Can I spoof a badge id? | It mislabels a beacon (griefing) but can't alter the on-chain truth — only the owner's key can. Upgrade path: LED for localization + the badge-signed BLE/Wi-Fi payload we already verify on-chain. |
| Does the badge need SOL / a wallet? | No. It signs a 33-byte message; a relayer pays; the program verifies the signature. |
| Default for someone with no badge? | Blur. |

## Licenses / credits

MediaPipe (Apache-2.0), Anchor (Apache-2.0), `@solana/web3.js` (MIT),
`@noble/hashes` (MIT), `tweetnacl` (Unlicense), `ws` (MIT), React (MIT), Vite (MIT).
ElevenLabs API for the spoken alerts.
