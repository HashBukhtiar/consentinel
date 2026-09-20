# Badge ↔ service protocol

Two layers, because the HTN badge cannot reach this service directly:

```
 HTN badge (Lua app)  ──badge.radio (BLE, ≤44 B)──  bridge  ──serial / Wi-Fi──  notify service :8787  ──Solana
 firmware/consentinel-beacon.lua                    ESP32 dev board            service/src/radio.ts        consent_registry
```

The badge has **no Wi-Fi, no HTTP, no buzzer** (see `firmware/README.md` §1).
Its only radio is `badge.radio`, a restricted BLE broadcast channel with
`LUA1`-prefixed, 44-byte payloads. The service therefore speaks the badge's
three radio frames and leaves the last metre of air to a **bridge**.

## 1. Radio frames (the contract with the Lua app)

`<id>` is the beacon id as **two upper-case hex digits** — the same id the
badge blinks and the capture app decodes (`hex2()` in `shared/beacon.ts`).

| frame | direction | badge behaviour | service behaviour |
|---|---|---|---|
| `CNSF<id>` | service → badge | red LED breathing alarm + `YOU WERE FILMED` banner for 6 s | sent for every accepted `POST /film-event` |
| `CNSC<id><0\|1>` | service → badge | sets the on-screen consent mirror (`OPT-IN` green / `OPT-OUT` red) and stores it | sent on every on-chain `ConsentChanged` / `ConsentClosed` (log subscription), on bridge connect for every registered badge, and every `RADIO_SYNC_MS` while a bridge is live (deduplicated) |
| `CNSR<id><0\|1>` | badge → service | the **A button**: an unsigned consent-change *request* | the service signs the 49-byte delegated message with the badge's key from `BADGE_KEYS_DIR/badge-<id>.json` and relays it (§3). A request matching the current on-chain state is a no-op that re-sends `CNSC`. |

`CNSR` is a request, not an update: the badge holds no keypair and cannot
sign. The *registry client* signs — in the demo that is this service, holding
the same key `npm run seed` registered as the record's owner. The program
still verifies that Ed25519 signature, nonce, instance and deadline on-chain,
so a spoofed `CNSR` from someone else's radio can only *ask*. `service/test/radio.test.ts`
pins the byte format; `firmware/consentinel-beacon.lua` `on_radio` is the other side.

## 2. Bridge transports

Any device that can hear/emit the badge's `LUA1` frames and reach the laptop
can be the bridge. The service does not care which:

**WebSocket (preferred)** — `ws://<laptop-ip>:8787/bridge`. Text frames both
ways: the service sends `CNSF4E` / `CNSC4E1` as they happen; the bridge sends
every `CNS*` frame it hears (one per message, or newline-joined). Each uplink
gets a JSON ack `{"ack":"CNSR4E1","result":"relayed",...}` (see §3 results).
Frames produced while no bridge is connected are queued (last 32).

**HTTP poll** — `GET /bridge/pending` → `{"frames":["CNSF4E","CNSC4E0"]}`
(drained on read); `POST /bridge/uplink` with `{"frame":"CNSR4E1"}` or the
bare text `CNSR4E1` → the same result object as the ack. Fine for a dev board
that only has an HTTP client.

**USB serial via the laptop** — `npm run bridge -- --port /dev/cu.usbserial-XXXX`
opens the tty at 115200 8N1 and relays **one frame per line** to the
WebSocket. The ESP32 sketch only has to: read a line → broadcast it as a
`LUA1` frame; hear a `CNS*` frame → `Serial.println` it. Anything else it
prints is shown as a log line. (Sniff one `badge.radio.send()` first to copy
the advertising layout — `firmware/README.md` §5.)

**No hardware** — `npm run bridge -- --stdin`: your keyboard is the board.
Type `CNSR4E1` ⏎ to do what the badge's A button does; downlink frames print
instead of going on the air. The operator panel's **Badge radio** section
shows every frame either way, and `GET /health` → `radio` has the counters.

## 3. The badge-signed consent update (`POST /consent/delegated`)

This is the path a `CNSR` request takes inside the service, and the path a
future badge (or any device holding the badge's key) can call directly. The
badge's Ed25519 key is the *owner* of its on-chain record (the organizer
registers it once). To change consent, sign a 49-byte message and POST it;
the service relays it in a Solana transaction (paying the fee) and the
program verifies the signature on-chain via the Ed25519 native program. No
SOL, no Solana stack on the badge.

Read the current values first: `GET /badge/4E/consent` →

```json
{"registered":true,"beaconId":"4E","consent":false,"nonce":3,"instance":7,
 "owner":"<base58>","updatedAt":1758300000,"serverTime":1758300100}
```

An unregistered badge gets `{"registered":false,...}` ⇒ the capture app blurs
it (fail-safe). The capture app reports such ids to `POST /badge/<id>/seen`,
and the service (holding the organizer/issuer key, `AUTO_REGISTER=true`)
registers them as opt_out — so a badge only has to be seen once.

Message bytes (little-endian):

| offset | len | field |
|---|---|---|
| 0 | 22 | ASCII `consentinel/consent/v1` |
| 22 | 2 | `badge_id` as u16 (e.g. `0x4E` → bytes `4E 00`) |
| 24 | 1 | `consent`: `1` = opt in, `0` = opt out |
| 25 | 8 | `nonce` as u64 — must equal `nonce` above (the record's revision) |
| 33 | 8 | `instance` as u64 — must equal `instance` above (unique per registration) |
| 41 | 8 | `expires_at` as i64 unix seconds — e.g. `serverTime + 120`; max 24 h out |

Sign with `crypto_sign_detached` (libsodium; the 64-byte secret key format is
what `registry/keys/badge-4E.json` holds). Then:

```
POST /consent/delegated
{"badgeId":"4E","consent":true,"nonce":3,"instance":7,"expiresAt":1758300220,
 "owner":"<base58 pubkey>","signature":"<64 bytes hex>"}
```

| status | meaning | what to do |
|---|---|---|
| `200 {"signature":"<tx>","explorer":"...","consent":true,"revision":4}` | landed | mirror follows via `CNSC` |
| `400` | malformed body or bad signature | fix the message bytes |
| `403` | signing key is not this badge's owner | wrong keypair |
| `404` | badge not registered | ask the organizer |
| `409` | stale `nonce` or `instance` (record changed meanwhile, or a bounced button) | re-read, sign again |
| `410` | `expires_at` already passed | re-read (use `serverTime`), sign again |
| `502` / `503` | relay/RPC trouble, or relayer key missing on the laptop | retry later |

Each signed message is single-use: the program requires `nonce == revision`
and increments the revision, `instance` ties it to this registration of the
badge id (nothing replays after a close + re-register), and `expires_at`
bounds how long anyone can hold a signed message before submitting it.

Reference signer (ESP-IDF, libsodium):

```cpp
#include <sodium.h>
void sign_consent(uint16_t badge_id, bool consent, uint64_t nonce, uint64_t instance,
                  int64_t expires_at, const unsigned char sk[64], unsigned char sig_out[64]) {
  unsigned char m[49];
  memcpy(m, "consentinel/consent/v1", 22);
  m[22] = badge_id & 0xff; m[23] = badge_id >> 8;
  m[24] = consent ? 1 : 0;
  for (int i = 0; i < 8; i++) m[25 + i] = (nonce >> (8 * i)) & 0xff;
  for (int i = 0; i < 8; i++) m[33 + i] = (instance >> (8 * i)) & 0xff;
  for (int i = 0; i < 8; i++) m[41 + i] = ((uint64_t)expires_at >> (8 * i)) & 0xff;
  crypto_sign_detached(sig_out, NULL, m, sizeof m, sk);
}
```

`npm run badge-press -- 4E toggle` (in `registry/`) does exactly this from
the laptop; `npm run smoke` (here) drives the whole radio path.

## 4. JSON transport for a Wi-Fi dev board (optional)

A bridge that has Wi-Fi can also take the "filmed" notification as JSON
instead of a radio frame: `ws://<laptop-ip>:8787/badge?id=4E` (pushed,
pinged every 5 s) or `GET /badge/4E/pending` (polled, drained on read):

```json
{"type":"filmed","beaconId":"4E","at":1758300012345,"cameraId":"cam-1","buzzMs":600,"say":"Heads up: badge 4 E, ..."}
```

Both transports fire for every film-event; use whichever the board finds
easier. The `say` text is what ElevenLabs speaks on the laptop.
