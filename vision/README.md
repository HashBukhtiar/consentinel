# vision — the YOLO sidecar

Faces and badge keys from **YOLOv8 on the laptop's GPU** (Apple MPS via PyTorch),
fed by the capture app over a local WebSocket. The browser keeps everything that
decides (tracker, badge↔face binding, consent, blur); this process only *looks*.

| model | what | file |
|---|---|---|
| YOLOv8x-face ([lindevs/yolov8-face](https://github.com/lindevs/yolov8-face), WIDER FACE) | face boxes, whole frame at 640 | `models/yolov8x-face-lindevs.pt` (130 MB, fetched by `setup.sh`, not in git) |
| badge-key (ours, YOLOv8n, 17 classes) | the badge's 7-segment glyphs 0–F + the whole 3-digit key, full 1280 frame | `models/badge-key.pt` (in git) |

Nothing here identifies anyone: face boxes only, no embeddings, nothing stored (DECISIONS.md §4.2).

```bash
./setup.sh                      # once: venv + torch + ultralytics, downloads the face weights
.venv/bin/python server.py      # ws://127.0.0.1:8765 — prints per-model ms once warmed up
```

The capture app connects automatically (`VITE_VISION_URL`; `VITE_VISION_REMOTE=0` disables it; `VITE_VISION_WIDTH=1920` sends the camera's native frame instead of the 1280 px processing frame — every pixel of a far glyph, about twice the badge model's cost)
and shows `vision: sidecar …` in the debug HUD; if the socket is down it says so and
runs the in-browser BlazeFace + classical decoder instead, per frame, no restart.

## How a badge is read

`server.py` runs the glyph model, groups digit boxes left→right into rows of three
(same height, adjacent), and keeps a triple only when `crc4(id) == last digit`
(`shared/beacon.ts` `unpackKey`). Consent is the glyph colour — MINT (opt-in) or
ROSE (opt-out) — read from the pixels inside the box (G above R or not; the webcam's
crosstalk never flips the sign). The app then applies the same confirm (2 reads in 4 s)
and hold rules as the classical engine (`capture-app/src/decode/key.ts` `ingest`).

## What it measured (Sun 2026-09-20, epoch-16 checkpoint)

| input | result |
|---|---|
| four 🎥 clips of badge 27 (175 frames, 0.3–0.8 m, white ring still on, LEDs at 255) | read directly in 174 frames; the classical engine managed 42, 42, 34, 24 of 43–44 per clip *including* holds |
| two clips with no key on the badge (149 frames) | no reading |
| 36 synthetic badges, both colours, key 40 / 70 / 140 px wide | 33 exact id + consent, 0 wrong; the misses are 40 px keys (12 px glyphs) |
| round trip from the browser, 1280 px frame, M4 Pro | ~80 ms (faces ~40, badge ~20, JPEG + transfer the rest) → results ~12×/s, the display loop stays at camera rate |

Caveat: the clips above also fed the training set (labelled frames, and unreadable
frames with the badge covered by a synthetic one), so fresh recordings are the honest test.

## Retraining the badge model (~40 min on an M4 Pro)

```bash
# 1. real frames: label every 🎥 recording in data/diag with the classical decoder
cd capture-app && npx tsx scripts/keylabels.ts ../data/diag > ../data/diag/keylabels.json
# 2. dataset: those frames (badge labelled, or covered by a synthetic one where unreadable)
#    + synthetic badges with perspective, bloom, LED halos, crosstalk, blur, noise, JPEG
cd .. && vision/.venv/bin/python vision/badgekey/dataset.py --diag data/diag --n-synth 1500
# 3. train (writes models/badge-key.pt)
vision/.venv/bin/python vision/badgekey/train.py --epochs 30
# 4. check it on the recordings through the real sidecar
vision/.venv/bin/python vision/server.py &   # then, per clip:
cd capture-app && REPLAY_REMOTE=1 npx tsx scripts/replay.ts ../data/diag/<ts>-seq
```

If the badge's picture changes (firmware), update `KEY`/`SEG_RECTS` in
`badgekey/dataset.py` together with `shared/beacon.ts`, regenerate and retrain.
