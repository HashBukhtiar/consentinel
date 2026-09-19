# Consentinel — capture app (vertical B)

The CV core + demo surface. Camera → detect faces → decode beacons → associate
beacon↔face → **blur anyone not explicitly opted in** → emit film-events.
Near-real-time, fail-safe (blur on any uncertainty), no face database.

## Run

```bash
npm install
npm run setup   # fetch MediaPipe wasm + model into public/ (needs net ONCE; run before the venue)
npm run dev     # http://localhost:5173
npm test        # self-check: tracker, association, fail-safe blur
```

**Stop:** `Ctrl+C` in the terminal running `npm run dev`. If it got orphaned in the
background (no terminal to interrupt), kill it by port:

```bash
lsof -ti :5173 | xargs kill
```

Pick **Use camera** (webcam), **Share screen (WhatsApp)** for the glasses feed
mirrored in a window, or **Load clip** for `DEMO_FALLBACK_MODE`. Toggle a
beacon's consent in the operator panel to see a face blur/clear live.

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

## The two integration seams (owned by teammates)

Both are stubbed in `src/stubs/` so the whole pipeline runs today. The contracts
live in [`src/shared/schema.ts`](src/shared/schema.ts):

- **A → `DecodeBeacons`**: `(frame: ImageData, tMs) => BeaconReading[]`, coords
  normalized [0,1]. Replace `src/stubs/decodeBeacons.ts`.
- **C → `GetConsent`**: `(beaconId) => "opt_in" | "opt_out" | "unknown"`,
  a *synchronous* read of the chain-synced cache. Replace `src/stubs/consentStore.ts`.
- **C ← `FilmEvent`**: set `FILM_EVENT_ENDPOINT` in `src/config/flags.ts` to C's
  notify service; the app POSTs opted-out captures there (fire-and-forget).

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
src/events/filmEvent.ts      debounced, fire-and-forget FilmEvent emit
src/pipeline/loop.ts         the hot loop (never awaits network/chain)
src/ui/                      operator panel + live consent controls (demo surface)
src/config/flags.ts          §10 flags + perf knobs
```

Tuning knobs in `flags.ts`: `PROCESS_WIDTH` (speed), `PIXELATE_SIZE`,
`TRACK_MAX_MISSED` (occlusion hold), `BLUR_PAD`.

**Beacon decoder:** `BEACON_DECODER` is `"stub"` (fixed beacons, safe hero path)
or `"optical"` (real decode of A's patch). The `BEACON_*` thresholds are tuned
against Maaz's badge recording — verified decoding id `4E` cleanly, no false ids.
Re-tune for new footage with `tsx scripts/tune.ts <raw-rgba> <w> <h>` (extract
frames with `ffmpeg -i clip.mov -vf scale=480:-2 -f rawvideo -pix_fmt rgba out.raw`).
Unit-tested end-to-end in `test/decode.test.ts` on synthetic frames.
