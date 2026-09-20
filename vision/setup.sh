#!/usr/bin/env bash
# One-time setup for the vision sidecar: a Python venv with torch + ultralytics,
# and the YOLOv8x-face weights (WIDER FACE, lindevs/yolov8-face, 130 MB — not in git).
# The badge digit model (models/badge-key.pt) IS in git; retrain with badgekey/README.md.
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-$(command -v python3.11 || command -v python3.12 || command -v python3)}"
[ -d .venv ] || "$PY" -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
mkdir -p models
if [ ! -f models/yolov8x-face-lindevs.pt ]; then
  echo "downloading yolov8x-face-lindevs.pt (130 MB) from github.com/lindevs/yolov8-face …"
  curl -L --progress-bar -o models/yolov8x-face-lindevs.pt https://github.com/lindevs/yolov8-face/releases/download/1.0.1/yolov8x-face-lindevs.pt
fi
.venv/bin/python -c "import torch; print('torch', torch.__version__, '· mps', torch.backends.mps.is_available())"
echo "ready: .venv/bin/python server.py"
