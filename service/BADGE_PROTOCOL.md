# Badge ↔ service protocol (for `firmware/src/notify.cpp`)

The notify service runs on the demo laptop (`http://<laptop-ip>:8787`). The
badge needs Wi-Fi and either a WebSocket client or plain HTTP polling. None
of the badge endpoints need a token.

## 1. Receiving "you were filmed"

**Option A — WebSocket (push):** connect to `ws://<laptop-ip>:8787/badge?id=4E`
(`id` = the hex id this badge blinks). The service sends one JSON object per
message and pings every 5 s (answer pongs, or it assumes you dropped off and
falls back to the poll queue):

```json
{"type":"hello","beaconId":"4E","at":1758300000000}
{"type":"filmed","beaconId":"4E","at":1758300012345,"cameraId":"cam-1","buzzMs":600,"say":"Heads up: badge 4 E, you were just recorded by camera cam-1. ..."}
```

On `filmed`: buzz the haptic/buzzer for `buzzMs`, flash the LEDs red. The
`say` text is what ElevenLabs speaks on the laptop; the badge can ignore it.

**Option B — HTTP poll (simplest on ESP32):** `GET /badge/4E/pending` every
~1 s. Response `{"beaconId":"4E","pending":[ ...messages... ]}`; the queue is
drained on read, so each message is delivered once (at most 10 are kept).

## 2. Reading your consent status

`GET /badge/4E/consent` →

```json
{"registered":true,"beaconId":"4E","consent":false,"nonce":3,"instance":7,
 "owner":"<base58>","updatedAt":1758300000,"serverTime":1758300100}
```

Green LED = `consent:true` (clear), red = `false` (blurred). `nonce`,
`instance` and `serverTime` are the values to sign in §3.

An unregistered badge gets `{"registered":false,"beaconId":"4E","consent":null,
"serverTime":...,"note":"..."}` ⇒ red LED; the capture app blurs it
(fail-safe). Do not attempt §3 until the organizer has registered the badge.

## 3. Flipping consent from the badge (the badge-signed path)

The badge holds its own Ed25519 keypair (the *owner* of its on-chain consent
record; the organizer provisions it and registers the badge once). To change
consent it signs a 49-byte message and POSTs it; the service relays it in a
Solana transaction (paying the fee) and the program verifies the signature
on-chain via the Ed25519 native program. No SOL, no Solana stack on the badge.

Message bytes (little-endian):

| offset | len | field |
|---|---|---|
| 0 | 22 | ASCII `consentinel/consent/v1` |
| 22 | 2 | `badge_id` as u16 (e.g. `0x4E` → bytes `B2 A1`) |
| 24 | 1 | `consent`: `1` = opt in, `0` = opt out |
| 25 | 8 | `nonce` as u64 — must equal `nonce` from §2 (the record's revision) |
| 33 | 8 | `instance` as u64 — must equal `instance` from §2 (unique per registration) |
| 41 | 8 | `expires_at` as i64 unix seconds — e.g. `serverTime + 120`; max 24 h out |

Sign with `crypto_sign_detached` (libsodium, available in ESP-IDF as the
`libsodium` component; the key format is the standard 64-byte libsodium
secret key — the same format as `registry/keys/badge-4E.json`). Then:

```
POST /consent/delegated
{"badgeId":"4E","consent":true,"nonce":3,"instance":7,"expiresAt":1758300220,
 "owner":"<base58 pubkey>","signature":"<64 bytes hex>"}
```

Responses:

| status | meaning | what to do |
|---|---|---|
| `200 {"signature":"<tx>","explorer":"...","consent":true,"revision":4}` | landed | green/red LED per `consent` |
| `400` | malformed body or bad signature | fix the message bytes |
| `403` | signing key is not this badge's owner | wrong keypair on the badge |
| `404` | badge not registered | ask the organizer |
| `409` | stale `nonce` or `instance` (record changed meanwhile, or a bounced button) | re-read §2, sign again |
| `410` | `expires_at` already passed | re-read §2 (use `serverTime`), sign again |
| `502` / `503` | relay/RPC trouble, or relayer key missing on the laptop | retry later |

Each signed message is single-use: the program requires `nonce == revision`
and increments the revision, `instance` ties it to this registration of the
badge id (so nothing replays after a close + re-register), and `expires_at`
bounds how long anyone can hold a signed message before submitting it.

### Reference (Arduino / ESP-IDF, libsodium)

```cpp
#include <sodium.h>
// sk: 64-byte libsodium secret key (from the badge's keypair file)
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
the laptop, so the flow can be demoed before the firmware lands.
