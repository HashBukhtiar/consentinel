"""Train the badge-key digit model (YOLOv8n, 17 classes) on vision/badgekey/data.
  vision/.venv/bin/python vision/badgekey/train.py [--epochs 30] [--model yolov8n.pt]
Writes the best weights to vision/models/badge-key.pt (what server.py loads)."""
import argparse
import shutil
from pathlib import Path

from ultralytics import YOLO

ap = argparse.ArgumentParser()
ap.add_argument("--data", default="vision/badgekey/data/data.yaml")
ap.add_argument("--model", default="yolov8n.pt")
ap.add_argument("--epochs", type=int, default=30)
ap.add_argument("--imgsz", type=int, default=640)
ap.add_argument("--batch", type=int, default=32)
ap.add_argument("--out", default="vision/models/badge-key.pt")
args = ap.parse_args()

model = YOLO(args.model)
res = model.train(
    data=args.data, epochs=args.epochs, imgsz=args.imgsz, batch=args.batch, device="mps", workers=4,
    project="vision/badgekey/runs", name="badgekey", exist_ok=True,
    fliplr=0.0,  # a mirrored glyph is a different (or no) digit
    degrees=8.0, translate=0.1, scale=0.5, perspective=0.0005,
    hsv_h=0.02, hsv_s=0.5, hsv_v=0.4, mosaic=1.0, close_mosaic=5, patience=12, plots=False, verbose=True,
)
best = Path(res.save_dir) / "weights" / "best.pt"
Path(args.out).parent.mkdir(parents=True, exist_ok=True)
shutil.copy(best, args.out)
print("saved", args.out)
