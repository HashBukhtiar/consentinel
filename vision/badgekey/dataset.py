"""Build the YOLO training set for the badge-key digit model.

The badge (firmware 0.4.0) shows three giant 7-segment hex digits —
id(8) << 4 | crc4(id) — in MINT (opt-in) or ROSE (opt-out) on black, with a
white L bar right/below (painted black once the firmware patch is pushed) and
six WS2812 LEDs whose halos sit above/below the display. The model learns to
find each DIGIT GLYPH (16 classes, 0-F) and the whole KEY (class 16); the
colour (= consent) is read from the pixels afterwards, and the three digits
must satisfy the CRC before anything is reported (see server.py).

Two sources, mixed:
  * REAL 🎥 frames from data/diag (never committed), auto-labelled by the
    classical decoder (capture-app/scripts/keylabels.ts). A frame it could not
    read gets its badge COVERED by a synthetic one at the neighbouring frame's
    position, so no real digit goes unlabelled.
  * SYNTHETIC badges rendered from the same geometry as shared/beacon.ts and
    pasted onto those frames with perspective, blur, bloom, sensor crosstalk,
    LED halos, noise and JPEG — the things that made the classical fit brittle.

Samples are 640x640 crops at native scale (inference runs the full 1280 frame
at imgsz=1280, so object sizes match).

  vision/.venv/bin/python vision/badgekey/dataset.py --diag data/diag --out vision/badgekey/data --n-synth 1500
"""
from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path

import cv2
import numpy as np

# ---- badge geometry (mirrors shared/beacon.ts KEY / SEG_RECTS / SEG7) ----------
PATCH_W, PATCH_H = 320, 240
KEY = dict(pad=30, border=24, w=76, h=160, t=18, gap=14, half=53, x0=32, y0=40, pitch=90, span=256, barRight=296, barBottom=216)
SEG7 = [0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F, 0x77, 0x7C, 0x39, 0x5E, 0x79, 0x71]
_W, _H, _T, _Hf = KEY["w"], KEY["h"], KEY["t"], KEY["half"]
SEG_RECTS = [
    (_T, 0, _W - 2 * _T, _T),  # a
    (_W - _T, _T, _T, _Hf),  # b
    (_W - _T, 2 * _T + _Hf, _T, _Hf),  # c
    (_T, _H - _T, _W - 2 * _T, _T),  # d
    (0, 2 * _T + _Hf, _T, _Hf),  # e
    (0, _T, _T, _Hf),  # f
    (_T, _T + _Hf, _W - 2 * _T, _T),  # g
]
MINT = (0, 255, 132)
ROSE = (255, 0, 132)
CLASS_KEY = 16
NAMES = [format(i, "X") for i in range(16)] + ["key"]


def crc4(value: int, nbits: int = 8) -> int:
    reg = 0
    for i in range(nbits - 1, -1, -1):
        top = (reg >> 3) & 1
        reg = ((reg << 1) | ((value >> i) & 1)) & 0xF
        if top:
            reg ^= 0x3
    return reg & 0xF


def key_digits(badge_id: int) -> list[int]:
    k = ((badge_id & 0xFF) << 4) | crc4(badge_id & 0xFF)
    return [(k >> 8) & 0xF, (k >> 4) & 0xF, k & 0xF]


# ---- synthetic badge ------------------------------------------------------------
def render_patch(badge_id: int, opt_in: bool, S: float, rng: random.Random):
    """The badge front at S px per unit: RGB float image + alpha + the digit cell
    boxes (patch px). Includes a dark body around the display and the LEDs."""
    margin = rng.uniform(10, 60)  # body beyond the display, units
    led_room = rng.uniform(40, 120)  # space above/below the display for the LED halos
    W = int((PATCH_W + 2 * margin) * S)
    H = int((PATCH_H + 2 * margin + 2 * led_room) * S)
    ox, oy = margin * S, (margin + led_room) * S  # display origin in patch px
    img = np.zeros((H, W, 3), np.float32)
    alpha = np.zeros((H, W), np.float32)

    def rect(x, y, w, h, color, target=img):
        x0, y0 = int(round(ox + x * S)), int(round(oy + y * S))
        x1, y1 = int(round(ox + (x + w) * S)), int(round(oy + (y + h) * S))
        target[max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = color

    # body (PCB / case): dark, random tint, covers the whole patch
    body = np.array([rng.uniform(8, 60) for _ in range(3)], np.float32)
    img[:] = body
    alpha[:] = 1.0
    # display: black lifted a little (the panel's own glow shows even when off)
    bright = rng.uniform(0.35, 1.0)
    on = np.array(MINT if opt_in else ROSE, np.float32) * bright
    lift = rng.uniform(0.0, 0.25)
    rect(0, 0, PATCH_W, PATCH_H, on * lift)
    # ring: the white L bar as shipped (p .45), full ring (p .1), painted black (p .45)
    ring_mode = rng.random()
    white = np.array([255, 255, 255], np.float32) * rng.uniform(0.6, 1.0) * bright ** 0.5
    if ring_mode < 0.45:
        rect(KEY["barRight"], KEY["pad"], PATCH_W - KEY["barRight"], PATCH_H - KEY["pad"], white)
        rect(KEY["pad"], KEY["barBottom"], PATCH_W - KEY["pad"], PATCH_H - KEY["barBottom"], white)
    elif ring_mode < 0.55:
        rect(0, 0, PATCH_W, PATCH_H, white)
        rect(KEY["border"], KEY["border"], PATCH_W - 2 * KEY["border"], PATCH_H - 2 * KEY["border"], on * lift)
    # digits
    digits = key_digits(badge_id)
    cells = []
    for k, d in enumerate(digits):
        cx = KEY["x0"] + k * KEY["pitch"]
        for s in range(7):
            if SEG7[d] & (1 << s):
                r = SEG_RECTS[s]
                rect(cx + r[0], KEY["y0"] + r[1], r[2], r[3], on)
        cells.append((ox + cx * S, oy + KEY["y0"] * S, KEY["w"] * S, KEY["h"] * S, d))
    key_box = (ox + KEY["x0"] * S, oy + KEY["y0"] * S, KEY["span"] * S, KEY["h"] * S)

    # sensor crosstalk: a bright mint bar reads R ≈ 0.45–0.6 G on the webcam (rose: G ≈ k R)
    k = rng.uniform(0.0, 0.65)
    if opt_in:
        img[..., 0] += k * img[..., 1]
    else:
        img[..., 1] += k * img[..., 0]
    # bloom: the display's blacks read 80–150 next to 240 bars — glow of the lit content
    sigma = rng.uniform(2, 10) * S
    glow = cv2.GaussianBlur(img, (0, 0), sigma)
    # …confined to the display and a little beyond its bezel (the body stays dark)
    reach = np.zeros((H, W), np.float32)
    rect(-15, -15, PATCH_W + 30, PATCH_H + 30, 1.0, target=reach)
    reach = cv2.GaussianBlur(reach, (0, 0), 8 * S)[..., None]
    img = img + glow * reach * rng.uniform(0.3, 1.1)
    # LEDs: six halos in a row above and/or below the display, white core + coloured skirt
    if rng.random() < 0.65:
        n = rng.choice([3, 6, 6, 6])
        rows = rng.choice([["top"], ["bottom"], ["top", "bottom"]])
        for row in rows:
            yy = oy - rng.uniform(0.25, 0.7) * led_room * S if row == "top" else oy + PATCH_H * S + rng.uniform(0.25, 0.7) * led_room * S
            xs = np.linspace(ox + rng.uniform(0, 40) * S, ox + (PATCH_W - rng.uniform(0, 40)) * S, n)
            for x in xs:
                if rng.random() < 0.15:
                    continue
                r = rng.uniform(0.12, 0.32) * PATCH_H * S
                col = np.array(rng.choice([MINT, ROSE, (255, 255, 255), (255, 200, 60), (80, 120, 255)]), np.float32) * rng.uniform(0.5, 1.0)
                halo = np.zeros_like(img)
                cv2.circle(halo, (int(x), int(yy)), int(r), col.tolist(), -1)
                halo = cv2.GaussianBlur(halo, (0, 0), r * 0.5)
                core = np.zeros_like(img)
                cv2.circle(core, (int(x), int(yy)), max(1, int(r * 0.3)), (255, 255, 255), -1)
                core = cv2.GaussianBlur(core, (0, 0), max(0.5, r * 0.12))
                img = img + halo + core
    return np.clip(img, 0, 255), alpha, cells, key_box


def rotation(yaw: float, pitch: float, roll: float) -> np.ndarray:
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cr, sr = math.cos(roll), math.sin(roll)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def project(points: np.ndarray, R: np.ndarray, f: float) -> np.ndarray:
    P = np.c_[points, np.zeros(len(points))] @ R.T
    z = P[:, 2] + f
    return np.c_[f * P[:, 0] / z, f * P[:, 1] / z]


def paste_badge(frame: np.ndarray, badge_id: int, opt_in: bool, key_w_px: float, center: tuple[float, float], rng: random.Random):
    """Warp a rendered badge into the frame (BGR uint8, modified in place).
    Returns YOLO boxes [(cls, x, y, w, h) in px] or None if it fell outside."""
    S = max(0.25, 2.0 * key_w_px / KEY["span"])  # render at ~2x the target scale, then blur down
    img, alpha, cells, key_box = render_patch(badge_id, opt_in, S, rng)
    H, W = alpha.shape
    # antialias for the downscale the warp will do
    img = cv2.GaussianBlur(img, (0, 0), 0.6 * (S * KEY["span"] / key_w_px))
    # patch corners (centred) → 3-D rotate → project; scale so the key box is key_w_px wide
    yaw, pitch, roll = math.radians(rng.uniform(-35, 35)), math.radians(rng.uniform(-25, 25)), math.radians(rng.uniform(-15, 15))
    R = rotation(yaw, pitch, roll)
    corners = np.array([[0, 0], [W, 0], [W, H], [0, H]], np.float64) - [W / 2, H / 2]
    f = 3.0 * max(W, H)
    proj = project(corners, R, f)
    kx, ky = key_box[0] - W / 2, key_box[1] - H / 2
    kp = project(np.array([[kx, ky], [kx + key_box[2], ky]]), R, f)
    scale = key_w_px / max(1e-6, np.linalg.norm(kp[1] - kp[0]))
    dst = proj * scale + np.array(center)
    M = cv2.getPerspectiveTransform(np.float32(corners + [W / 2, H / 2]), np.float32(dst))
    fh, fw = frame.shape[:2]
    x0, y0 = int(np.floor(dst[:, 0].min())), int(np.floor(dst[:, 1].min()))
    x1, y1 = int(np.ceil(dst[:, 0].max())), int(np.ceil(dst[:, 1].max()))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    # warp into a local canvas covering the destination bbox
    T = np.array([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]], np.float64)
    cw, ch = x1 - x0, y1 - y0
    if cw > 2 * fw or ch > 2 * fh:
        return None
    warped = cv2.warpPerspective(img, T @ M, (cw, ch), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    walpha = cv2.warpPerspective(alpha, T @ M, (cw, ch), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    # exposure / motion blur on the badge alone
    warped *= rng.uniform(0.7, 1.15)
    if rng.random() < 0.35:
        klen = rng.randint(2, 9)
        kern = np.zeros((klen, klen), np.float32)
        ang = rng.uniform(0, math.pi)
        cv2.line(kern, (int(klen / 2 - math.cos(ang) * klen / 2), int(klen / 2 - math.sin(ang) * klen / 2)), (int(klen / 2 + math.cos(ang) * klen / 2), int(klen / 2 + math.sin(ang) * klen / 2)), 1, 1)
        kern /= max(1e-6, kern.sum())
        warped = cv2.filter2D(warped, -1, kern)
        walpha = cv2.filter2D(walpha, -1, kern)
    sig = rng.uniform(0, 1.4)
    if sig > 0.2:
        warped = cv2.GaussianBlur(warped, (0, 0), sig)
        walpha = cv2.GaussianBlur(walpha, (0, 0), sig)
    # composite (clip to the frame)
    fx0, fy0, fx1, fy1 = max(0, x0), max(0, y0), min(fw, x1), min(fh, y1)
    if fx1 <= fx0 or fy1 <= fy0:
        return None
    sub = frame[fy0:fy1, fx0:fx1].astype(np.float32)
    wsub = warped[fy0 - y0:fy1 - y0, fx0 - x0:fx1 - x0][..., ::-1]  # RGB → BGR
    asub = walpha[fy0 - y0:fy1 - y0, fx0 - x0:fx1 - x0][..., None]
    frame[fy0:fy1, fx0:fx1] = np.clip(sub * (1 - asub) + wsub * asub, 0, 255).astype(np.uint8)

    def box_of(x, y, w, h):
        pts = np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], np.float32).reshape(-1, 1, 2)
        p = cv2.perspectiveTransform(pts, M).reshape(-1, 2)
        bx0, by0, bx1, by1 = p[:, 0].min(), p[:, 1].min(), p[:, 0].max(), p[:, 1].max()
        return bx0, by0, bx1 - bx0, by1 - by0

    boxes = [(d, *box_of(x, y, w, h)) for (x, y, w, h, d) in cells]
    boxes.append((CLASS_KEY, *box_of(*key_box)))
    return boxes


def paste_distractor(frame: np.ndarray, rng: random.Random):
    """A mint/rose blob that is NOT a key (shirt, chair, phone screen) — a hard negative."""
    fh, fw = frame.shape[:2]
    col = np.array(rng.choice([MINT, ROSE, (0, 255, 200), (255, 40, 120), (120, 255, 120)]), np.float32) * rng.uniform(0.3, 1.0)
    layer = np.zeros((fh, fw, 3), np.float32)
    cx, cy = rng.uniform(0, fw), rng.uniform(0, fh)
    kind = rng.random()
    if kind < 0.4:
        cv2.ellipse(layer, (int(cx), int(cy)), (int(rng.uniform(10, 200)), int(rng.uniform(10, 200))), rng.uniform(0, 180), 0, 360, col.tolist(), -1)
    elif kind < 0.7:
        w, h = rng.uniform(10, 240), rng.uniform(4, 60)
        cv2.rectangle(layer, (int(cx - w / 2), int(cy - h / 2)), (int(cx + w / 2), int(cy + h / 2)), col.tolist(), -1)
    else:  # a few bars, not a glyph
        for _ in range(rng.randint(1, 4)):
            w, h = rng.uniform(4, 30), rng.uniform(20, 120)
            x, y = cx + rng.uniform(-100, 100), cy + rng.uniform(-60, 60)
            cv2.rectangle(layer, (int(x), int(y)), (int(x + w), int(y + h)), col.tolist(), -1)
    layer = cv2.GaussianBlur(layer, (0, 0), rng.uniform(0.5, 6))
    a = np.clip(layer.max(axis=2, keepdims=True) / 255.0 * rng.uniform(0.5, 1.0), 0, 1)
    frame[:] = np.clip(frame.astype(np.float32) * (1 - a) + layer[..., ::-1] * a, 0, 255).astype(np.uint8)


# ---- real frames --------------------------------------------------------------
def load_real(diag: Path):
    """(frame path, W, H, boxes-or-None, cover-box-or-None) for every recorded frame."""
    labels_file = diag / "keylabels.json"
    clips = json.loads(labels_file.read_text())["clips"] if labels_file.exists() else []
    items = []
    for clip in clips:
        frames = clip["frames"]
        for i, fr in enumerate(frames):
            path = diag / clip["dir"] / fr["file"]
            if fr["label"]:
                L = fr["label"]
                boxes = [(c["digit"], c["x"], c["y"], c["w"], c["h"]) for c in L["cells"]]
                boxes.append((CLASS_KEY, L["key"]["x"], L["key"]["y"], L["key"]["w"], L["key"]["h"]))
                items.append((path, clip["width"], clip["height"], boxes, None))
            else:
                # unreadable: cover the badge where a neighbour (≤ 300 ms away) saw it
                near = [g for g in frames if g["label"] and abs(g["tMs"] - fr["tMs"]) <= 300]
                if near:
                    g = min(near, key=lambda g: abs(g["tMs"] - fr["tMs"]))["label"]["key"]
                    items.append((path, clip["width"], clip["height"], None, (g["x"], g["y"], g["w"], g["h"])))
                elif not any(g["label"] for g in frames):
                    items.append((path, clip["width"], clip["height"], [], None))  # blink-era clip: no key anywhere
    for p in sorted(diag.glob("*-frame.jpg")):
        items.append((p, None, None, None, None))  # single 📸 frames: badge position unknown → synthetic-only background after a cover
    return items


# ---- crops ----------------------------------------------------------------------
def crops_for(frame: np.ndarray, boxes: list, rng: random.Random, size: int, n_pos: int, n_neg: int):
    fh, fw = frame.shape[:2]
    out = []
    keys = [b for b in boxes if b[0] == CLASS_KEY]

    def window(x0, y0):
        x0 = int(min(max(0, x0), fw - size)); y0 = int(min(max(0, y0), fh - size))
        crop = frame[y0:y0 + size, x0:x0 + size]
        lab = []
        for (c, x, y, w, h) in boxes:
            cx0, cy0, cx1, cy1 = max(x, x0), max(y, y0), min(x + w, x0 + size), min(y + h, y0 + size)
            if cx1 - cx0 < 0.6 * w or cy1 - cy0 < 0.6 * h:
                if cx1 > cx0 and cy1 > cy0:
                    return None  # a partly-cut glyph would be a wrong label: skip the window
                continue
            lab.append((c, (cx0 + cx1) / 2 - x0, (cy0 + cy1) / 2 - y0, cx1 - cx0, cy1 - cy0))
        return crop, lab

    for k in keys:
        for _ in range(n_pos):
            for _try in range(6):
                r = window(k[1] + k[3] / 2 - rng.uniform(0.15, 0.85) * size, k[2] + k[4] / 2 - rng.uniform(0.15, 0.85) * size)
                if r:
                    out.append(r); break
    for _ in range(n_neg):
        for _try in range(6):
            r = window(rng.uniform(0, fw - size), rng.uniform(0, fh - size))
            if r and not r[1]:
                out.append(r); break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--diag", default="data/diag")
    ap.add_argument("--out", default="vision/badgekey/data")
    ap.add_argument("--n-synth", type=int, default=1500)
    ap.add_argument("--size", type=int, default=640)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--preview", type=int, default=12)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    out = Path(args.out)
    for split in ("train", "val"):
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)
    (out / "preview").mkdir(exist_ok=True)

    real = load_real(Path(args.diag))
    print(f"real frames: {len(real)} ({sum(1 for r in real if r[3])} labelled, {sum(1 for r in real if r[4])} to cover)")
    backgrounds = []  # (frame BGR, boxes) ready to receive synthetic badges
    for (path, W, H, boxes, cover) in real:
        img = cv2.imread(str(path))
        if img is None:
            continue
        if W and img.shape[1] != W:
            img = cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)
        if boxes is None:
            boxes = []
            if cover:
                x, y, w, h = cover
                # a synthetic badge over the real one, bigger, so nothing real peeks out
                b = paste_badge(img, rng.randrange(256), rng.random() < 0.6, w * rng.uniform(1.15, 1.35), (x + w / 2, y + h / 2), rng)
                if b is None:
                    continue
                boxes = b
            else:
                # unknown badge position (📸 frame): blank the centre band where the wearer stands is unsafe; use as
                # synthetic-only background after covering with a big badge in a random spot is also unsafe. Skip.
                continue
        backgrounds.append((img, boxes))
    print(f"backgrounds: {len(backgrounds)}")
    if not backgrounds:
        raise SystemExit("no backgrounds — run capture-app/scripts/keylabels.ts first")

    n_written = {"train": 0, "val": 0}
    previews = {"real": 0, "syn": 0}

    def emit(crop, lab, tag):
        nonlocal previews
        split = "val" if rng.random() < 0.1 else "train"
        i = n_written[split]; n_written[split] += 1
        name = f"{tag}-{i:05d}"
        q = rng.randint(55, 92)
        cv2.imwrite(str(out / "images" / split / f"{name}.jpg"), crop, [cv2.IMWRITE_JPEG_QUALITY, q])
        with open(out / "labels" / split / f"{name}.txt", "w") as fh:
            for (c, cx, cy, w, h) in lab:
                fh.write(f"{c} {cx / args.size:.6f} {cy / args.size:.6f} {w / args.size:.6f} {h / args.size:.6f}\n")
        if previews[tag] < args.preview // 2 and lab:
            vis = crop.copy()
            for (c, cx, cy, w, h) in lab:
                cv2.rectangle(vis, (int(cx - w / 2), int(cy - h / 2)), (int(cx + w / 2), int(cy + h / 2)), (0, 255, 255) if c == CLASS_KEY else (255, 255, 0), 1)
                cv2.putText(vis, NAMES[c], (int(cx - w / 2), int(cy - h / 2) - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 0), 1)
            cv2.imwrite(str(out / "preview" / f"{name}.jpg"), vis)
            previews[tag] += 1

    # 1. the real frames as they are (real badge labelled or covered) + a few negatives
    for img, boxes in backgrounds:
        for crop, lab in crops_for(img, boxes, rng, args.size, n_pos=2, n_neg=1):
            emit(crop, lab, "real")
    # 2. synthetic badges on top of those frames
    for n in range(args.n_synth):
        img, boxes = rng.choice(backgrounds)
        img = img.copy(); boxes = list(boxes)
        fh, fw = img.shape[:2]
        for _ in range(rng.choice([1, 1, 1, 2, 3])):
            key_w = math.exp(rng.uniform(math.log(20), math.log(320)))
            for _try in range(8):
                cx, cy = rng.uniform(0.05, 0.95) * fw, rng.uniform(0.05, 0.95) * fh
                # keep clear of the labelled badges already in the frame
                if all(abs(cx - (b[1] + b[3] / 2)) > key_w + b[3] or abs(cy - (b[2] + b[4] / 2)) > key_w + b[4] for b in boxes if b[0] == CLASS_KEY):
                    b = paste_badge(img, rng.randrange(256), rng.random() < 0.55, key_w, (cx, cy), rng)
                    if b:
                        boxes += b
                    break
        for _ in range(rng.choice([0, 0, 1, 2])):
            paste_distractor(img, rng)
        if rng.random() < 0.5:
            noise = np.random.default_rng(rng.randrange(1 << 30)).normal(0, rng.uniform(1, 7), img.shape).astype(np.float32)
            img = np.clip(img.astype(np.float32) + noise, 0, 255).astype(np.uint8)
        for crop, lab in crops_for(img, boxes, rng, args.size, n_pos=1, n_neg=0 if rng.random() < 0.7 else 1):
            emit(crop, lab, "syn")
        if n % 200 == 0:
            print(f"synthetic {n}/{args.n_synth} · written {n_written}")

    (out / "data.yaml").write_text(
        f"path: {out.resolve()}\ntrain: images/train\nval: images/val\nnames:\n" + "".join(f"  {i}: '{n}'\n" for i, n in enumerate(NAMES))
    )
    print(f"done: {n_written} → {out / 'data.yaml'}")


if __name__ == "__main__":
    main()
