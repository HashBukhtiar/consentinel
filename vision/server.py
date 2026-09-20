"""Consentinel vision sidecar: YOLOv8 on the laptop's GPU (Apple MPS), fed by
the capture app over a local WebSocket.

Two models per frame:
  * faces  — YOLOv8x-face (lindevs, WIDER FACE). Boxes only: no identity, no
             embeddings, nothing stored (DECISIONS.md §4.2).
  * badge  — our YOLOv8n trained on the badge's 7-segment glyphs
             (vision/badgekey). Digits are grouped left-to-right into
             three-digit keys; a key is reported only when its CRC-4 checks
             (shared/beacon.ts unpackKey). Consent = the glyph colour
             (MINT opt-in / ROSE opt-out), read from the pixels.

Wire format (one request in flight per client; the app drops frames while it waits):
  client → binary: float64 LE tMs (client clock) + JPEG bytes
  server → text JSON: { tMs, w, h, faces: [{x,y,w,h,conf}], keys: [{id, hex, optIn, digits, box, conf, key}],
                        digits: [{cls, cool, box, conf}], ms: {decode, faces, keys, total} }
  boxes are normalized to the frame that was sent.

  vision/.venv/bin/python vision/server.py            # ws://127.0.0.1:8765
"""
from __future__ import annotations

import argparse
import asyncio
import json
import struct
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from ultralytics import YOLO

try:
    from websockets.asyncio.server import serve
except ImportError:  # websockets < 13
    from websockets.server import serve  # type: ignore

HERE = Path(__file__).parent
CLASS_KEY = 16


def crc4(value: int, nbits: int = 8) -> int:
    reg = 0
    for i in range(nbits - 1, -1, -1):
        top = (reg >> 3) & 1
        reg = ((reg << 1) | ((value >> i) & 1)) & 0xF
        if top:
            reg ^= 0x3
    return reg & 0xF


def iou(a, b) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    return inter / max(1e-6, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def is_cool(img_bgr: np.ndarray, box) -> bool:
    """MINT (opt-in) vs ROSE (opt-out): over the lit pixels of the box, is G above R?
    The webcam's crosstalk keeps R ≈ 0.5 G on a mint bar (and G ≈ 0.5 R on rose), so the sign is safe."""
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    sub = img_bgr[max(0, y0):max(0, y1), max(0, x0):max(0, x1)].astype(np.int32)
    if sub.size == 0:
        return True
    peak = sub.max(axis=2)
    lit = peak >= max(60, int(peak.max() * 0.6))
    if not lit.any():
        return True
    return float(sub[..., 1][lit].mean()) >= float(sub[..., 2][lit].mean())


def group_keys(img_bgr: np.ndarray, dets: list[tuple[int, float, float, float, float, float]]):
    """dets: (cls, conf, x0, y0, x1, y1) in px. → (keys, digits) where each key
    is a CRC-valid triple of digits read left to right."""
    digits = [d for d in dets if d[0] != CLASS_KEY]
    key_boxes = [d for d in dets if d[0] == CLASS_KEY]
    # NMS across classes: two glyph guesses for one cell keep the confident one
    digits.sort(key=lambda d: -d[1])
    kept: list = []
    for d in digits:
        if all(iou(d[2:], k[2:]) < 0.45 for k in kept):
            kept.append(d)
    kept.sort(key=lambda d: d[2])
    out = []
    n = len(kept)
    for i in range(n):
        a = kept[i]
        row = [a]
        j = i + 1
        while j < n and len(row) < 3:
            p, d = row[-1], kept[j]
            hp, hd = p[5] - p[3], d[5] - d[3]
            wp = p[4] - p[2]
            vo = min(p[5], d[5]) - max(p[3], d[3])
            gap = d[2] - p[4]
            same_row = vo >= 0.5 * min(hp, hd) and 0.6 <= hd / max(1e-6, hp) <= 1.6
            adjacent = -0.35 * wp <= gap <= 0.9 * wp
            if same_row and adjacent:
                row.append(d)
                j += 1
            elif d[2] - p[4] > 0.9 * wp:
                break
            else:
                j += 1
        if len(row) != 3:
            continue
        key = (row[0][0] << 8) | (row[1][0] << 4) | row[2][0]
        bid = (key >> 4) & 0xFF
        if crc4(bid) != (key & 0xF):
            continue
        box = (min(r[2] for r in row), min(r[3] for r in row), max(r[4] for r in row), max(r[5] for r in row))
        conf = min(r[1] for r in row)
        has_key = any(iou(box, k[2:]) > 0.3 for k in key_boxes)
        out.append({"id": bid, "hex": f"{bid:02X}", "digits": [r[0] for r in row], "box": box, "conf": conf, "key": has_key, "optIn": is_cool(img_bgr, box)})
    # dedupe overlapping readings: the one with the whole-key box, then confidence
    out.sort(key=lambda k: (k["key"], k["conf"]), reverse=True)
    final = []
    for k in out:
        if all(iou(k["box"], f["box"]) < 0.3 for f in final):
            final.append(k)
    return final, [(d[0], is_cool(img_bgr, d[2:]), d[2:], d[1]) for d in kept] + [(CLASS_KEY, is_cool(img_bgr, k[2:]), k[2:], k[1]) for k in key_boxes]


class Vision:
    def __init__(self, faces: Path, keys: Path | None, device: str, face_imgsz: int, key_imgsz: int, face_conf: float, key_conf: float):
        self.device = device
        self.face_imgsz, self.key_imgsz, self.face_conf, self.key_conf = face_imgsz, key_imgsz, face_conf, key_conf
        self.faces = YOLO(str(faces))
        self.keys = YOLO(str(keys)) if keys and keys.exists() else None
        self.lock = asyncio.Lock()
        warm = np.zeros((720, 1280, 3), np.uint8)
        for _ in range(2):
            self.infer(warm)

    def infer(self, img: np.ndarray):
        t0 = time.perf_counter()
        H, W = img.shape[:2]
        r = self.faces.predict(img, imgsz=self.face_imgsz, conf=self.face_conf, device=self.device, verbose=False)[0]
        faces = [{"x": float(b[0]) / W, "y": float(b[1]) / H, "w": float(b[2] - b[0]) / W, "h": float(b[3] - b[1]) / H, "conf": float(c)}
                 for b, c in zip(r.boxes.xyxy.cpu().numpy(), r.boxes.conf.cpu().numpy())]
        t1 = time.perf_counter()
        keys, digits = [], []
        if self.keys is not None:
            r = self.keys.predict(img, imgsz=self.key_imgsz, conf=self.key_conf, device=self.device, verbose=False)[0]
            dets = [(int(c), float(p), float(b[0]), float(b[1]), float(b[2]), float(b[3]))
                    for b, c, p in zip(r.boxes.xyxy.cpu().numpy(), r.boxes.cls.cpu().numpy(), r.boxes.conf.cpu().numpy())]
            ks, ds = group_keys(img, dets)
            nb = lambda b: {"x": b[0] / W, "y": b[1] / H, "w": (b[2] - b[0]) / W, "h": (b[3] - b[1]) / H}
            keys = [{**k, "box": nb(k["box"])} for k in ks]
            digits = [{"cls": c, "cool": cool, "box": nb(b), "conf": p} for (c, cool, b, p) in ds]
        t2 = time.perf_counter()
        return faces, keys, digits, {"faces": (t1 - t0) * 1000, "keys": (t2 - t1) * 1000}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--faces", default=str(HERE / "models" / "yolov8x-face-lindevs.pt"))
    ap.add_argument("--keys", default=str(HERE / "models" / "badge-key.pt"))
    ap.add_argument("--face-imgsz", type=int, default=640)
    ap.add_argument("--key-imgsz", type=int, default=1280)
    ap.add_argument("--face-conf", type=float, default=0.35)
    ap.add_argument("--key-conf", type=float, default=0.30)
    ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    args = ap.parse_args()

    print(f"loading {Path(args.faces).name} + {Path(args.keys).name if Path(args.keys).exists() else '(no badge model yet: faces only)'} on {args.device} …", flush=True)
    v = Vision(Path(args.faces), Path(args.keys), args.device, args.face_imgsz, args.key_imgsz, args.face_conf, args.key_conf)
    _, _, _, ms = v.infer(np.zeros((720, 1280, 3), np.uint8))
    print(f"ready: faces {ms['faces']:.0f} ms @ {args.face_imgsz} · badge {ms['keys']:.0f} ms @ {args.key_imgsz} · ws://{args.host}:{args.port}", flush=True)

    async def handle(ws):
        peer = getattr(ws, "remote_address", "?")
        n = 0
        async for msg in ws:
            if not isinstance(msg, (bytes, bytearray)) or len(msg) < 9:
                continue
            t0 = time.perf_counter()
            (t_ms,) = struct.unpack_from("<d", msg, 0)
            img = cv2.imdecode(np.frombuffer(msg, np.uint8, offset=8), cv2.IMREAD_COLOR)
            if img is None:
                await ws.send(json.dumps({"tMs": t_ms, "error": "bad jpeg"}))
                continue
            td = (time.perf_counter() - t0) * 1000
            async with v.lock:
                faces, keys, digits, ms = await asyncio.to_thread(v.infer, img)
            ms = {"decode": td, **ms, "total": (time.perf_counter() - t0) * 1000}
            await ws.send(json.dumps({"tMs": t_ms, "w": img.shape[1], "h": img.shape[0], "faces": faces, "keys": keys, "digits": digits, "ms": ms}))
            n += 1
            if n % 100 == 0:
                print(f"{peer}: {n} frames · last {ms['total']:.0f} ms (faces {ms['faces']:.0f}, badge {ms['keys']:.0f}) · {len(faces)} faces, {len(keys)} keys", flush=True)

    async with serve(handle, args.host, args.port, max_size=16 * 1024 * 1024, compression=None):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
