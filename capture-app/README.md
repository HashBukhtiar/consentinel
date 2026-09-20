# Consentinel — capture app

The CV core + demo surface. Camera → detect faces → decode beacons → associate
beacon↔face → **blur anyone not explicitly opted in** → emit film-events.
Near-real-time, fail-safe (blur on any uncertainty), no face database.

## Run

```bash
npm install
npm run setup   # fetch MediaPipe wasm + model into public/ (needs net ONCE; run before the venue)
npm run dev     # http://localhost:5173
npm test        # self-check: tracker, association, fail-safe blur, chain-cache semantics
npm run typecheck
```

Consent comes from **Solana** by default (see the root README, "Part C"):

```bash
cd ../registry && npm run seed     # registers the demo badges; writes public/demo/badges.json (devnet demo keys)
cd ../service && npm run dev       # notify + audit service (buzz, voice, on-chain attestations)
```

Localnet instead of devnet: put `VITE_SOLANA_CLUSTER=localnet` in `.env.local`
(the RPC URL follows). No network at all: `VITE_CONSENT_SOURCE=stub` keeps the
in-memory toggles.

**Stop:** `Ctrl+C` in the terminal running `npm run dev`. If it got orphaned in the
background (no terminal to interrupt), kill it by port:

```bash
lsof -ti :5173 | xargs kill
```

Pick **Use camera** (webcam), **Share screen (WhatsApp)** for the glasses feed
mirrored in a window, or **Load clip** for `DEMO_FALLBACK_MODE`. In the
operator panel, **grant / revoke / close** send a real transaction; the face
blurs or clears when the websocket push lands (~1 s), always within the 3 s
poll.

## Observability (Sentry)

Two products beyond error monitoring, per the track: **Tracing** (a span tree
`detect → track → decode → associate → decide → blur+notify`, sampled ~1 frame/s
so the 120fps loop is never touched) and **Logs** (structured consent decisions,
logged on change, + film events). **Session Replay is deliberately omitted** — it
would record faces from the video feed, the exact thing the app refuses to do.

Off by default; activate by adding your DSN (Sentry then bundles + turns on):

```bash
cp .env.example .env.local   # then set VITE_SENTRY_DSN=…
```

Instrumentation lives in `src/obs/sentry.ts`; no-ops with no DSN.

## Integration seams

Contracts live in [`src/shared/schema.ts`](src/shared/schema.ts):

- **A → `DecodeBeacons`**: `(frame: ImageData, tMs) => BeaconReading[]`, coords
  normalized [0,1]. Still stubbed in `src/stubs/decodeBeacons.ts`.
- **C → `GetConsent`**: wired. `src/consent/store.ts` picks
  `ChainConsentCache` (Solana-synced, slot-ordered, staleness fail-safe) or the
  stub off `CONSENT_SOURCE`. The loop only ever does a synchronous Map read.
- **C ← `FilmEvent`**: wired. `FILM_EVENT_ENDPOINT` defaults to the service;
  `VITE_SERVICE_TOKEN` must match the service's `SERVICE_TOKEN` if set.

## Layout

```
src/sources/videoSource.ts   camera | screen | file → one HTMLVideoElement
src/decode/beacon.ts         optical decoder: patch → cells → clock → decodeFrame (A's wire format)
src/decode/patch.ts          patch geometry + pixel paint (shared by decoder & self-check)
src/vision/detect.ts         MediaPipe BlazeFace (detection only, no identity)
src/vision/track.ts          IOU tracker → stable trackId, persists blur on occlusion
src/vision/associate.ts      beacon → nearest face above, sticky on the track
src/vision/blur.ts           canvas-2D pixelation
src/consent/decide.ts        fail-safe: clear only on opt_in
src/consent/chainCache.ts    local cache synced from Solana (ws push + poll; unknown/stale ⇒ blur)
src/consent/store.ts         chain vs stub selection
src/consent/signers.ts       demo badge keys (devnet) + injected wallet
src/events/filmEvent.ts      debounced, fire-and-forget FilmEvent emit
src/events/operatorLink.ts   feed from the notify service (alerts, attestations)
src/pipeline/loop.ts         the hot loop (never awaits network/chain)
src/ui/                      operator panel + ChainPanel (the on-stage beat)
src/config/flags.ts          §10 flags + perf knobs
```

Tuning knobs in `flags.ts`: `PROCESS_WIDTH` (speed), `PIXELATE_SIZE`,
`TRACK_MAX_MISSED` (occlusion hold), `BLUR_PAD`, `CONSENT_CACHE_SYNC_MS`,
`CONSENT_STALE_MS`.

**Beacon decoder:** `BEACON_DECODER` is `"optical"` (real decode of A's patch,
the default) or `"stub"` (fixed fake beacons, no-badge fallback). The pipeline
runs once per *video* frame (pixel-fingerprint gated), not per display refresh:
the decoder's miss counters are tuned at the video rate, exactly like
`scripts/tune.ts`. **overlay: on** draws candidates/decodes on the feed and the
**Beacons** panel explains a non-decode (too small, too dim, low contrast, no
repeat yet). `?clip=/demo/<file>.mp4` runs the pipeline on a recording. The `BEACON_*` thresholds are tuned
against Maaz's badge recording — verified decoding id `4E` cleanly, no false ids.
Re-tune for new footage with `tsx scripts/tune.ts <raw-rgba> <w> <h>` (extract
frames with `ffmpeg -i clip.mov -vf scale=480:-2 -f rawvideo -pix_fmt rgba out.raw`).
Unit-tested end-to-end in `test/decode.test.ts` on synthetic frames.
