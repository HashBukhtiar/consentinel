# Threat model & positioning

**Addendum to `DECISIONS.md`. Written 2026-09-20. Revises §2.2, §3, §6.**
Where this and `DECISIONS.md` disagree, this is newer — but `DECISIONS.md` §1
(default deny) and §8 (constraints) are unchanged and still binding.

---

## TL;DR — the five things

1. **The adversary is covert smart glasses, not cameras in general.** A visible
   phone is a solved social problem. A taped-over LED is not.
2. **Enforcement has to live in firmware**, below the layer the wearer controls.
   Tape reaches an LED. It cannot reach the capture pipeline.
3. **That means the default flips depending on scope.** Two rows, §3. The code
   currently implements one of them, unconditionally, and nobody wrote down
   which scope it was for.
4. **The beacon proves identity, never consent.** Forgery is real and currently
   unclosed.
5. **Six things are verifiably broken right now.** §6. Read that one first if
   it's 4am.

---

## 1. Threat model

The harm is not *being recorded*. It is **being recorded without the ability to
know and respond.**

- A phone is visible. You can move, object, decide how to act. Agency intact.
- Smart glasses with tape over the recording LED remove that entirely. There is
  no moment where you *could* have objected.

> **The recording indicator is an output the wearer controls. Tape defeats it.
> We move the indicator to the person being recorded.**

The LED asks you to trust the wearer. The badge doesn't.

### Two worlds

| | Camera runs Consentinel | Camera does not |
|---|---|---|
| Blur | yes | **no** |
| Film-event logged | yes | **no** |
| Wearer notified | yes | **no** |
| Can we detect it? | n/a | **no, and never** |

**You cannot detect a passive camera.** A camera is a receiver; it emits nothing
except the LED that just got taped. There is no channel by which a badge learns a
lens is pointed at it. (IR retroreflection — cat's-eye return off a lens — is the
real technique. Short range, false-positives on glasses and jewellery, and this
badge has no IR emitter and no sensor. Not a path.)

Say this out loud before a judge says it.

---

## 2. Where enforcement lives

**In the glasses firmware, always on.** Not an app, not a mode, not a door policy.

Fixes three things at once:

- Tape the indicator → doesn't matter, the software still ran.
- Conceal the glasses at the door, pull them out inside → no registration step to
  evade.
- Refuse to install a consent app → there is nothing to install.

It also defuses the most dangerous objection. *"A badge only some cameras honour"*
becomes *"a badge every device from a participating platform honours."*

### Why the ask is credible

Make this argument explicitly — a platform engineer will be doing the math.

The beacon is **cheap**: find a bright quad, check aspect, sample six cell centres,
check a CRC. A threshold and a handful of pixel reads. Orders of magnitude below
face recognition against a database, which is the only alternative and which no
platform ships for legal reasons alone.

Refusing face recognition started as an ethical constraint. At platform scale it
becomes the *feasibility* argument.

### What still breaks

1. **Only participating vendors.** A phone, a GoPro, non-Meta glasses. Still not
   "protection" — but "every device from participating platforms" is defensible
   in a way "some app might be running" never was.
2. **Who owns the format.** If one vendor defines it, no other vendor adopts it,
   and you're back to `DECISIONS.md` §3: *one vendor's blur helps nobody*. The
   spec must be neutral; the vendor is the first implementation, not the owner.
3. **Id namespacing at scale.** 8 bits works for one room. Badge `0x4E` at HTN and
   `0x4E` at CES are different people. Needs per-venue namespaces, a bigger id,
   and an offline lookup path — glasses can't hit a chain per frame. `EVENT_ID`
   in `flags.ts` is the seed of this and it is the thing that actually needs
   designing.

---

## 3. The two defaults ← the important one

| Scope | Default | What the badge does |
|---|---|---|
| **Everywhere** (glasses in the world) | allow | opt **out** — a badge saying no blurs you |
| **Inside a venue session** | deny | opt **in** — a badge saying yes clears you |

The badge does double duty: outside a venue it is a **decline signal**, inside a
venue it is the **clearance key**. The venue is what flips the default.

This is also the real answer to *"does it blur his family when he goes home?"* —
no badges present means nobody made a claim, so nothing happens. Not a geofence,
not a session timer. **The protocol activates where the protocol is deployed.**

⚠️ **The code implements row 2 only, unconditionally.** `pipeline/loop.ts` enforces
on every frame with no scope check. `EVENT_ID` exists but only scopes per-badge
overrides (`chainCache.ts:128`). A time-boxed event session is the missing piece.

⚠️ Do **not** implement "no badge in frame → don't blur" as a per-frame rule. That
is fail-open and an attacker just occludes badges. Use badge presence only for
session entry/exit on a long window (30 min+). Inside a session, default-deny
always.

---

## 4. The badge proves identity, never consent

This was already right and is the best property in the repo. Keep it.

- **Chain = declaration** ("Alice consents"). **Light = binding** ("*that* face is
  Alice"). Only the second can un-blur.
- If the light could *grant*, a forger rendering green overrides a wearer showing
  red — and the person who most wants blur becomes the cheapest target. Light is
  **restrict-only**.

**Verified:** `set_consent` is `has_one = owner` + `owner: Signer`
(`lib.rs:417-426`). A camera's only on-chain write is `attest_capture`, which
takes a 32-byte commitment and nothing else (`lib.rs:232`). **No instruction
anywhere lets a camera grant permission.**

**Caveat — say the precise version.** `register` takes `consent: bool` chosen by
the issuer, and `owner` is an `UncheckedAccount` with no attendee signature
(`lib.rs:390-412`). So a venue *can* register 500 badges as `consent = true` with
keys it generated.

- ✅ Say: *"the camera cannot grant itself permission."*
- ❌ Never say: *"nobody but the attendee can grant permission."*
- Fix is small: force `consent = false` at issuance, make `owner` a `Signer`.

---

## 5. Forgery — still open

The optical payload is a **static, public 8-bit id** with no secret and no
signature. 256 exist. Render one on paper, hold it under someone's chin, and
`associate()` binds it to their face. `antiSpoof.ts` documents this attack itself
and concedes its heuristics only make *blind guessing* slow and conspicuous.

### The fix: rolling one-time code

The cells stop meaning `id|crc` and start meaning `code12(step)` — a per-badge
64-bit seed mixed with a counter ticking every ~2s. Camera accepts a badge only
after 3 codes in the right order at the right spacing, then keeps a **per-badge
high-water mark**.

**Trace the copy:** photo of Alice at step 900 held under Bob. Camera's high-water
for Alice is 947. 900 ≤ 947 → dropped → Bob never gets a `beaconId` → **Bob stays
blurred.** Alice unaffected. That is strictly better than today's clone rule,
which blurs *both* — safe, but a free griefing tool.

### What it does not fix

- **Live relay.** Mirror a badge's *current* code onto a screen at someone's
  chest. Codes are valid. Unclosable on a one-way optical channel.
- **Cold camera.** One that has never seen that badge has no high-water and will
  accept a recording.
- **12 bits cannot do public-key verification.** Whoever can verify can forge. So
  **keep the code table on the service, never in the browser.**

Don't say "unforgeable." Say: *stale or invented tokens fail to blurred; a live
relay still wins.*

---

## 6. Verifiably broken right now

| # | Where | What |
|---|---|---|
| 1 | `decode/beacon.ts:31` | `boxLum` is **min-of-RGB**. Every saturated cell colour has a zero channel, so lit cells read as black. Needs **max-of-RGB** — not luma. |
| 2 | `flags.ts` | `BEACON_ASPECT_MIN 1.5 / MAX 3.2`. The badge panel is 320×240 = **1.333** → rejected at localization before a single cell is sampled. Needs ~1.15–1.60. |
| 3 | `shared/beacon.ts` | Still describes the **deleted** 304×132 blinking layout: `BORDER_PX 14` (badge has 24), plus `COLS/ROWS/CLOCK_CELL/DATA_CELLS/SYNC_RUN/decodeFrame` for a temporal format that no longer exists. Both files carry "MUST match" comments and both are wrong. |
| 4 | `decide.ts` | The **"chain opt-in AND light opt-in"** invariant the firmware comments claim is **not implemented**. `BeaconReading` has no colour field, `Track` has no light-consent, nothing in `capture-app/src/` mentions the consent colours. `decide.ts` is chain-only. Fix it or delete the comment — a judge will open the file you pointed them at. |
| 5 | `shared/beacon.ts` `beaconIdFromBadgeId` | Id is **8 bits** = 256 values. Birthday collision is a **coin flip at ~20 badges**. A collision means one person's opt-in silently clears a stranger's face, and the stranger cannot revoke it because she is not the owner. This is the one failure that ends in exposure, not blur. Chain field is already `u16`. |
| 6 | `service/src/index.ts:195` | `POST /consent/delegated` has no `authorized(req)` while `/film-event` (:192) and `/audit/events` (:220) do. Body still needs a valid owner signature, so this is relayer fee-drain, not a consent bypass. One-line fix. |

Also: there is **no activation scope gate** anywhere (§3).

---

## 7. What changed on the badge tonight

`firmware/consentinel-beacon.lua` — 7-segment digits → **3×2 grid of solid colour
cells** + a consent stripe.

| | Before | After |
|---|---|---|
| Smallest feature | 18 px stroke (5.6% of patch width) | 86 px cell (**27%**) |
| Widgets | 21 segment boxes | 6 cells + 1 stripe |
| Payload | `id(8)<<4 \| crc4(id)` | unchanged — 6 cells × 2 bits, MSB cell first |
| Consent | digit colour | 272×26 stripe, MINT/ROSE |

Why: range is set by the smallest feature the camera must resolve. Alphabet is
W/R/G/B so the decoder classifies with what it already computes — `min(r,g,b)`
splits white from the primaries, `argmax` picks between them. `dim()` scales all
three channels together so argmax survives the brightness knob.

**File is 14822 bytes against a ~14.5 KB ceiling — ~26 bytes of headroom.** If you
need room, the radio path (`radio_send`, `on_radio`, RIGHT branch) is ~1.36 KB and
cannot run without a bridge that does not exist.

**Not yet syntax-checked on hardware. Push it and confirm the panel renders.**

---

## 8. Notification & attribution

**World A (camera cooperating) — built:**
- Live push: `FilmEmitter.maybeEmit()` fires for an opted-out person on camera
  (5s debounce) → `POST /film-event` → `CNSF<id>` → badge red LED + banner + voice.
- Pull, later: `GET /audit/events?badge=4E` → `audit.forBadge()`.
- Note: in World A the face **was already blurred**. The film-event is a receipt
  that blurred pixels passed through — not that anyone was exposed.

**World B (not cooperating):** nothing. See §1.

**What the venue actually gets: accountability by absence.** Compliant cameras
anchor captures into a per-camera rolling hash (`head = H(head || commitment)`).
Footage appearing in no registered camera's chain is provably from an unregistered
device. That doesn't catch anyone in the act — it converts "he says he wasn't
recording" into a policy violation the venue can act on.

⚠️ **Do not put film events on-chain.** "Badge 4E filmed at 19:42 by cam-1" on a
public chain is a movement and attendance trail — exactly the surveillance we're
built against. The code already gets this right: only a 32-byte commitment lands
on-chain, readable events stay off-chain in the service. Make it a talking point.

Caveat: film-events fire only for opt-out, so the *existence* of an attestation
leaks that someone who opted out was filmed in that interval. Attest on a fixed
heartbeat if you want that closed.

---

## 9. Pitch

**The line:**

> Consentinel turns the badge a conference already hands you into a consent signal
> the event's own cameras can read — every face blurred by default, cleared only
> by a record the attendee owns on-chain.

**Platform's role:** the endgame, one sentence, at the end. *"Venues are the
beachhead — once a room's own cameras honour a badge, a glasses vendor has
something worth reading."* Never the thing that has to happen before anything works.

### Objection playbook

| Question | Answer | Concede |
|---|---|---|
| Isn't this a feature request for a company not in the room? | The buyer is the conference ops director, who can say yes Monday over badge stock already in the swag bag. | The endgame does need vendors and we have zero leverage. |
| Why a blockchain? That's a Postgres row. | It's not storage, it's **write authority**. `set_consent` is `has_one = owner`, so the venue running the box cannot flip your answer. In Postgres the venue owns everyone's answer. | It needs a public append-only log plus user-held keys. Solana is one instance of that, not a requirement. |
| Can I beat this with a photocopier? | Today, yes, in one case — see §5. The clone rule makes copying a neighbour's badge fail safe; a steady forged id with the real badge absent wins. | Concede flat and first: the beacon is an identifier, not an authenticator, and no 12-bit optical channel can be one. |
| 256 ids at a 300-person conference? | It breaks, coin-flip at ~20 badges. See §6.5. | Say the fix: chain field is already `u16`. Safe at twenty badges, not five hundred. |
| A guy films me on his iPhone. What does the badge do? | Nothing, and it never will. This governs cameras that are listening. | Say the false-confidence half unprompted, below. |
| Would this blur my kids at dinner? | See §3 — no badges, no claims, nothing happens. | Concede the scope gate isn't built yet; today the pipeline enforces unconditionally. |

### The false-confidence answer (say it before they do)

Against a phone the badge does nothing and never will. The subtler harm: the badge
can't tell you what kind of camera is pointed at you, so its silence reads as
*"nobody filmed me."* With this hardware that is unfixable — the badge has no
receive path.

So: **never say "protection." Say "clearance for the cameras the venue controls."**
And fire the *you were filmed* alert on every capture, not just opt-out, so it
reads as a receipt rather than an alarm that happens to be silent exactly when
someone forged your id.

The honest baseline isn't perfect privacy — it's an LED someone taped over.
Against that, the badge is strictly better, because the signal now comes from the
person who wants it instead of the person who'd rather it didn't.

### Do not say

- ❌ *"The badge you're holding is decoding live"* — see §6.1/§6.2.
- ❌ *"Nobody but the attendee can grant permission"* — see §4.
- ❌ *"Venue infrastructure for CES / ceiling cameras"* — range is 1–2 m, id space
  is 8 bits. Say *"a roving photographer, safe at about twenty badges."*
- ❌ *"This protects you from being filmed"* — say **clearance**.
- ❌ *"A face clears only on chain opt-in AND light opt-in"* — not implemented, §6.4.
- ❌ *"The chain proves our capture log is complete"* — it proves nothing was
  edited after anchoring. Say **tamper-evident**.
- ❌ *"Every failure path lands on blurred, so we're safe"* as a catch-all —
  default-deny is a *video* property. It gives zero coverage over id collisions,
  forged patches, or what's in the film-event log. Saying that distinction
  yourself is the most credible thing you can do in Q&A.

---

## 10. Suggested order

1. **Decoder geometry + sampler** (§6.1, §6.2) — nothing works without it, and it
   gates every range number you'd quote.
2. **`shared/beacon.ts`** rewritten to the colour-cell layout (§6.3, §7).
3. **Measure the range.** Every number in `firmware/README.md` §3 was measured on
   a layout that no longer exists.
4. **The light-AND** (§6.4) — small, and closes a real hole.
5. **Rolling code** (§5) — abandonable at 2am without losing the demo.
6. Scope gate (§3), id widening (§6.5), `/consent/delegated` auth (§6.6).
