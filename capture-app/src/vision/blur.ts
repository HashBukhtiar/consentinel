// Pixelate a region of a canvas in place (cheap, reads as "privacy" better than
// gaussian). All args in device px of `ctx.canvas`.
let tmp: HTMLCanvasElement | null = null;

export function pixelate(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, size: number,
): void {
  w = Math.max(1, w); h = Math.max(1, h);
  if (!tmp) tmp = document.createElement("canvas");
  const tw = Math.max(1, Math.round(w / size)), th = Math.max(1, Math.round(h / size));
  tmp.width = tw; tmp.height = th;
  const t = tmp.getContext("2d")!;
  t.imageSmoothingEnabled = false;
  t.drawImage(ctx.canvas, x, y, w, h, 0, 0, tw, th); // downsample
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, tw, th, x, y, w, h); // blow back up
  ctx.imageSmoothingEnabled = true;
}

// Pixelate the ENTIRE canvas. This is the default-deny composite: blur
// everything, then punch clear windows back out for explicitly consented
// faces. Costs two drawImage calls regardless of how many people are present,
// and means a face the detector never found is still covered.
export function pixelateAll(ctx: CanvasRenderingContext2D, size: number): void {
  pixelate(ctx, 0, 0, ctx.canvas.width, ctx.canvas.height, size);
}

// Redraw one sharp region from the source over the pixelated canvas.
// `box` is normalized [0,1]; `inset` shrinks it — the inverse of BLUR_PAD.
// Blur pads OUTWARD to cover more; a clear window insets INWARD to reveal
// less, so a consented face can't drag a sliver of the person behind them
// into the clear.
export function clearWindow(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  srcW: number, srcH: number,
  box: { x: number; y: number; w: number; h: number },
  inset: number,
): void {
  const nx = box.x + (box.w * inset) / 2;
  const ny = box.y + (box.h * inset) / 2;
  const nw = box.w * (1 - inset);
  const nh = box.h * (1 - inset);
  if (nw <= 0 || nh <= 0) return;

  const W = ctx.canvas.width, H = ctx.canvas.height;
  const dx = Math.max(0, nx * W), dy = Math.max(0, ny * H);
  const dw = Math.min(nw * W, W - dx), dh = Math.min(nh * H, H - dy);
  if (dw <= 0 || dh <= 0) return;

  ctx.drawImage(src, (dx / W) * srcW, (dy / H) * srcH, (dw / W) * srcW, (dh / H) * srcH, dx, dy, dw, dh);
}

// ---- icon mask (demo feature) ----------------------------------------------
// An image the operator dropped on the feed stands in for the pixelation. It is
// drawn object-fit:cover inside the SAME padded box the blur would use, clipped
// to it, so coverage is identical — the icon can never reveal less than a blur.
let mask: HTMLImageElement | null = null;
export function setMaskImage(img: HTMLImageElement | null): void { mask = img; }
export function hasMaskImage(): boolean { return !!mask && mask.complete && mask.naturalWidth > 0; }

export function coverFace(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  mode: "blur" | "icon", size: number,
): void {
  if (mode !== "icon" || !hasMaskImage()) { pixelate(ctx, x, y, w, h, size); return; } // fail-safe: no icon ⇒ blur
  const img = mask!;
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight); // cover, not contain
  const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = "#000"; ctx.fillRect(x, y, w, h); // opaque floor under transparent PNGs
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}
