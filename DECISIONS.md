# Consentinel — decisions, answers, and open items

Written so all three of us give the **same answer** to the same question, and so
nothing here has to be re-derived at 4am.

Lanes: **Maaz** badge/optics · **Hashim** capture + CV · **Nehad** chain + service.

---

## 1. The core safety property

> **DEFAULT DENY.** Every person in frame is blurred unless affirmatively matched
> to a valid consent record. Every failure path — no badge, occluded badge,
> dropped packet, bad lighting, agent down, network down — must fail to
> **BLURRED**. Never expose someone by accident.

Everything below follows from this. If a decision is ever ambiguous, pick the
option that blurs more.

**No face recognition anywhere. No biometric database. No face data on-chain.**
Identity comes only from the badge.

---

## 2. Architecture decisions

### 2.1 Consent has two halves, and they use different channels

| Half | Question it answers | Mechanism | Can it expose someone? |
|---|---|---|---|
| **Declaration** | "Alice consents" | Signed Solana record | No — it's just a lookup value |
| **Binding** | "*that* face, right now, is Alice" | **Optical beacon on the badge** | **Yes — this is the only thing that can unblur** |

A form, a waiver, or a database row can only ever do the *declaration*. Between
a signed record and a blurred video there is a gap, and only two things bridge
it: face recognition, or a live signal from the person's body. We refuse the
first.

### 2.2 Light grants, radio restricts

- **Light** (badge screen) answers *which face is this badge*. Must be visible.
  **Can only ever unblur.**
- **Radio** (BLE) answers *what does this badge want*. Doesn't need to be
  visible. **Can only ever blur.**

Consequence: losing sight of a badge can never expose someone, only blur them.
A spoofed radio packet can restrict but never grant.

### 2.3 The badge is a heartbeat, not a login

Nothing about a person is stored. Three separate things, only one of which
persists:

| Thing | Example | Lives in | Survives leaving frame? |
|---|---|---|---|
| Consent record | `1A = yes` | Solana / cache | **Yes, forever** |
| Binding | `track #3 = 1A` | RAM | No — dies with the track |
| Track | `#3 = this rectangle` | RAM | No — dies after `TRACK_MAX_MISSED` |

Walk out of frame and back and you return as a stranger: new track, `consent:
"unknown"`, **blurred**, until the light re-binds you (~300ms). That flicker is
the price of storing nothing, and it fails in the safe direction.

### 2.4 Chain as permission ceiling

The on-chain record is the **maximum** permission. Radio can only restrict
downward from it. This makes Solana load-bearing rather than decorative, and it
neutralises radio spoofing.

### 2.5 The badge cannot sign — the owner's device signs

The badge holds no keypair and has no crypto in the Lua sandbox. `CNSR` is
deliberately a **request**, not an update. The registry client (phone/laptop)
holds the Ed25519 key, signs, and submits. The on-chain verification is
unchanged; only the signing device differs. See §5.

### 2.6 Default-deny replaces most of the CV problem

If the whole frame is blurred by default and clear windows are punched out only
for explicitly consented faces, **detection failures stop mattering** for
everyone except the person who opted in — and that person is cooperating
(facing the camera, badge lit). This converts "reliably detect every human" into
"detect the two people actively trying to be found."

This is why we do **not** need a person detector, segmentation, or a better
model tonight. Fix the composite instead.

---

## 3. Answers to the questions judges will ask

### "BlazeFace does the work — do you even need the badge?"

> BlazeFace finds faces. It cannot find consent. **No vision model can** — that
> information isn't in the image, it's in the person's head. The badge is how it
> gets out.

Delete the badge and you get N rectangles and zero knowledge about any of them.
Default-deny blurs all N. You've built a blur button.

Alternatives considered:

| Alternative | Why not |
|---|---|
| Face recognition vs. an opt-out list | Builds a biometric database of exactly the people who said *don't record me*. Failure mode is backwards: no match → exposed. |
| Phone app broadcasting BLE | This is the real product; the badge is this year's form factor. But a phone in a pocket can't say **where in the frame** you are. |
| Radio only, no optics | Presence, not a pixel coordinate. One opt-out in range → blur everyone. Useless in a crowd. |
| Printed QR on a lanyard | Can't be revoked, can't go dark, and anyone who photographs it can wear your consent. |
| "Meta should build it in" | They should. One vendor's blur helps nobody — this only works as a protocol any camera can read. |

### "Isn't a consent form better?"

A form tells you **that** Alice consented. It doesn't tell you **which blob in
frame 4,192 is Alice.** It's not competing with the badge — it's competing with
the Solana record, and we have one.

Four things form-only can't do:

1. **Revoke in time.** Signed hours earlier. Change your mind → email someone and
   hope. Badge → next frame. *One frame vs. one support ticket.*
2. **Handle strangers.** Forms assume the recorder knows the cast in advance.
   Glasses invert that — nobody is handing out clipboards.
3. **Actually enforce.** A waiver is a promise plus a lawsuit; the footage still
   contains your face. Default-deny means the pixels were never captured.
4. **Default correctly.** Real photo releases say "by attending, you consent."
   Forms extract consent; they don't honour refusal.

Plus the human one: **the badge lets you decline without confronting anyone.**
Most people don't object because it's awkward, not because they're fine with it.

Concede honestly: *for a closed event with a stage and a known audience, a form
genuinely is enough. We're solving ambient capture by strangers.*

### "What about people who aren't wearing a badge?"

They're blurred. `consent: "unknown" → blurred: true`. **The badge isn't how you
get privacy — it's how you opt *out* of it** if you want to be on camera.

### "Would more/better computer vision solve this?"

Partly, and the split matters: **CV can only ever add blur. Only the badge can
remove it.** So we let CV handle the safe direction, where a mistake costs a
blurred patch of wall, and require an explicit signal from the person for the
risky direction, where a mistake exposes a human.

(Worth saying: the beacon decoder *is* computer vision — localization,
rectification, thresholding. We use CV in three places.)

### "Point at Alice in this video."

The counter-question to hand back when someone proposes forms or databases.

---

## 4. Known gaps in the pipeline (as of this writing)

All three are live in `main` and a judge can trigger the first one by turning
sideways.

| # | Where | Failure |
|---|---|---|
| 1 | `pipeline/loop.ts` blur loop | Blur is applied **per track**. A face BlazeFace misses (profile, motion blur, far, dark) has no track → **no blur → fully visible.** Fix: pixelate the whole frame, punch clear windows for `opt_in` only. |
| 2 | `vision/associate.ts` | No exclusivity (two beacons can bind the same face, last writer wins) and no max distance (`bestD` starts at `Infinity`). Alice opts in, Bob opts out, they stand together → Bob can inherit Alice's ID → **Bob unblurred.** Fix: one beacon ↔ one track, a distance cap, and **bind neither** when two faces are near-equidistant. |
| 3 | `vision/track.ts` + `consent/decide.ts` | `beaconId` is never cleared. Cover your badge and stay clear forever; two people cross, the IOU tracker swaps boxes, and the ID lands on the wrong face. Fix: stamp `boundAtMs`, clear after ~2s without a fresh decode. This is the "heartbeat, not login" property — the code currently does login. |
| 4 (minor) | `vision/track.ts` | An unmatched track keeps its **last known** bbox for up to 10 frames, so a fast mover outruns their own blur. Fix: predict the box, or grow `BLUR_PAD` per missed frame. |

Also: `minDetectionConfidence: 0.5` in `vision/detect.ts` should probably be
**0.3**. Counterintuitive but correct for default-deny — a false positive costs a
blurred patch of wall, a false negative exposes a human. **Bias toward
over-detecting.**

---

## 5. Integration break: `service/BADGE_PROTOCOL.md`

That doc is addressed to `firmware/src/notify.cpp` and assumes a badge that does
not exist. Four assumptions, all contradicted by `firmware/README.md` §1:

| Assumed | Reality |
|---|---|
| "The badge needs Wi-Fi and either a WebSocket client or HTTP polling" | **No Wi-Fi or HTTP from Lua.** Only `badge.radio` — broadcast, `LUA1`-prefixed, 44-byte payloads. |
| "buzz the haptic/buzzer for `buzzMs`" | **No buzzer, no haptic, no speaker** on this hardware. Replacement: red LED breathing + on-screen `YOU WERE FILMED` banner (already implemented), with the ElevenLabs voice played from the laptop. |
| Badge holds an Ed25519 keypair and signs a 49-byte message | **The badge cannot sign.** No keypair, no crypto in the sandbox. |
| `firmware/src/notify.cpp` | Doesn't exist. This is a Lua sandbox app; C++ means re-flashing, which HTN can't restore — explicit non-goal. |

**The on-chain work is not wasted.** The fix is small: the *owner's phone or
laptop* holds the keypair and signs, per §2.5. Same program, same Ed25519
verification, different signing device. Nobody should build further on the
badge-as-signer assumption.

---

## 6. Open decision: is radio in scope?

The hero path — wear badge → badge flashes ID → app decodes → looks up consent →
blurs — needs **zero radio**. It is complete without it.

Radio exists for exactly one beat: *press A on the badge, go blurry on screen.*
Visceral, and it's the moment that sells the project. But the laptop currently
**cannot hear or talk to the badge at all** (`firmware/README.md` §5, unsolved).

- **Keep the beat** → the BLE gateway is the next badge task. Cheapest version: a
  **second badge** running a tiny receiver app that `badge.sys.log()`s everything
  it hears over USB. Hardware we already own. *Watch out: Chrome's Web Serial
  holds the COM port — the IDE tab must be closed or the reader can't open it.*
- **Drop the beat** → trigger revoke from a laptop/phone UI instead (honest —
  that's how you'd really do it), delete `CNSR`/`CNSC`/`CNSF`, and reclaim ~1KB
  against the badge's compile ceiling.

Not yet decided.

---

## 7. Badge lane status

**Done and running on hardware:** MODE P optical beacon (clock + frame + 4 data
lanes, CRC-4), MODE S fallback, beacon ID derived from `badge_id` via FNV-1a,
LED mirror, status UI, buttons, radio RX (`CNSF`/`CNSC`), radio TX (`CNSR`).

**13.8KB of source against a ~14.5KB practical compile ceiling** — anything new
means cutting something. First candidate: MODE S, once MODE P decoding is proven.

**Next, in order:**

1. **Tune `flags.BEACON_*` against the live badge and flip `BEACON_DECODER` to
   `"optical"`.** Highest value; requires the physical badge, so only Maaz can do
   it.
2. 3-state LED (red/amber/green) — consent legible across the room. LEDs become
   consent state; the screen stays the data channel.
3. *(gateway-dependent)* periodic state broadcast ~1Hz with a sequence number, so
   a dropped packet doesn't silently lose a revoke and silence can be treated as
   "restrict."
4. *(gateway-dependent)* **wave-to-bind** via `badge.sensor.shake()` — wave, and
   the host binds the track whose motion spiked. This is the answer to "what if
   the badge isn't visible," and nobody else will have it.

---

## 8. Notices: "you were filmed" is a receipt, and it lives on-chain

Decided Sun 2026-09-20 05:00 ET. An opted-out person on camera gets told
(badge alarm, voice, email — the email transport is a dry-run for the demo),
and the camera files two facts on Solana per film-event: `record_capture`
(when they were filmed, camera clock + chain clock) and `record_notice` (when
and how they were told, chain clock). One PDA per event, keyed by the
event's audit hash, writable only by the registered camera, never deletable,
"told" single-use.

Trade-off, stated plainly: the 10 s commitment stream was designed so the
public chain says nothing about *when* anyone was filmed. Notices give that
up for opted-out captures, on purpose — the badge id (not a name) and two
timestamps are the evidence the person needs, and a receipt nobody can see is
not a receipt. Names and emails stay in the organizer's off-chain directory
(`contact` in `data/demo/seed-consents.json`), never on-chain.

## 9. Constraints that are not up for debate

- No face recognition, anywhere.
- No biometric database.
- No face data or images on-chain.
- Appearance signatures (if ever added) are in-memory only, session-scoped, hard
  expiry ~30s, never written to disk, never linked to a name. A privacy
  commitment, not an optimisation — enforce it in code.
- The badge cannot sign, cannot reach the network, and cannot receive data from
  the host without a gateway.
- The agent is never in the video loop.
- All code written inside the event window (Sat 12:00 AM → Sun 8:00 AM ET).
