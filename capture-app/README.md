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
