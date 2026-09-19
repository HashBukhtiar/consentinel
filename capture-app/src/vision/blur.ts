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
