# Badge ↔ service protocol (for `firmware/src/notify.cpp`)

The notify service runs on the demo laptop (`http://<laptop-ip>:8787`). The
badge needs Wi-Fi and either a WebSocket client or plain HTTP polling.

## 1. Receiving "you were filmed"

**Option A — WebSocket (push):** connect to `ws://<laptop-ip>:8787/badge?id=A1B2`
(`id` = the hex id this badge blinks). The service sends one JSON object per
message:

```json
{"type":"hello","beaconId":"A1B2","at":1758300000000}
{"type":"filmed","beaconId":"A1B2","at":1758300012345,"cameraId":"cam-1","buzzMs":600,"say":"Heads up: badge A 1 B 2, you were just recorded by camera cam-1. ..."}
```

On `filmed`: buzz the haptic/buzzer for `buzzMs`, flash the LEDs red. The
`say` text is what ElevenLabs speaks on the laptop; the badge can ignore it.

**Option B — HTTP poll (simplest on ESP32):** `GET /badge/A1B2/pending` every
~1 s. Response `{"beaconId":"A1B2","pending":[ ...messages... ]}`; the queue is
drained on read, so each message is delivered once.

## 2. Showing consent status (optional)

`GET /badge/A1B2/consent` →

```json
{"registered":true,"beaconId":"A1B2","consent":false,"nonce":3,"owner":"<base58>","updatedAt":1758300000}
```

Green LED = `consent:true` (clear), red = `false` (blurred). `nonce` is the
value to sign in §3.

## 3. Flipping consent from the badge (the badge-signed path)

The badge holds its own Ed25519 keypair (the *owner* of its on-chain consent
record). To change consent it signs a 33-byte message and POSTs it; the
service relays it in a Solana transaction (paying the fee) and the program
verifies the signature on-chain via the Ed25519 native program. No SOL, no
Solana stack on the badge.

Message bytes (little-endian):

| offset | len | field |
|---|---|---|
| 0 | 22 | ASCII `consentinel/consent/v1` |
| 22 | 2 | `badge_id` as u16 (e.g. `0xA1B2` → bytes `B2 A1`) |
| 24 | 1 | `consent`: `1` = opt in, `0` = opt out |
| 25 | 8 | `nonce` as u64 — must equal the record's current `nonce` from §2 |

Sign with `crypto_sign_detached` (libsodium, available in ESP-IDF as the
`libsodium` component; the key format is the standard 64-byte libsodium
secret key — the same format as `registry/keys/badge-A1B2.json`). Then:

```
POST /consent/delegated
{"badgeId":"A1B2","consent":true,"nonce":3,"owner":"<base58 pubkey>","signature":"<64 bytes hex>"}
```

Responses: `200 {"signature":"<tx>","explorer":"...","consent":true,"revision":4}`;
`409` stale nonce (re-read §2 and sign again); `403` key is not the owner;
`400` bad signature.

Each signed message is single-use: the program requires `nonce == revision`
and increments the revision, so a captured message cannot be replayed.

### Reference (Arduino / ESP-IDF, libsodium)

```cpp
#include <sodium.h>
// sk: 64-byte libsodium secret key (from the badge's keypair file)
void sign_consent(uint16_t badge_id, bool consent, uint64_t nonce,
                  const unsigned char sk[64], unsigned char sig_out[64]) {
  unsigned char m[33];
  memcpy(m, "consentinel/consent/v1", 22);
  m[22] = badge_id & 0xff; m[23] = badge_id >> 8;
  m[24] = consent ? 1 : 0;
  for (int i = 0; i < 8; i++) m[25 + i] = (nonce >> (8 * i)) & 0xff;
  crypto_sign_detached(sig_out, NULL, m, sizeof m, sk);
}
```

`npm run badge-press -- A1B2 toggle` (in `registry/`) does exactly this from
the laptop, so the flow can be demoed before the firmware lands.
