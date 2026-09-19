// §10 feature flags + pipeline tuning. Safe defaults: hero path runs with
// everything else off. Tune the beacon/perf knobs for your camera at the venue.
export const flags = {
  DEFAULT_CONSENT: "blur" as const, // fail-safe: unknown/undecoded ⇒ blur
  DEMO_FALLBACK_MODE: false, // load a clip instead of a live source

  // owned by C — kept here as the shared contract values
  CONSENT_CACHE_SYNC_MS: 3000,
  FILM_EVENT_ENDPOINT: "", // C's notify service; "" ⇒ local log only
  FILM_EVENT_DEBOUNCE_MS: 5000,

  // owned by A — shared contract value
  BEACON_SYMBOL_HZ: 10,

  // optical decoder (mine, feeds A's decodeFrame). "stub" keeps the hero path
  // safe until the pixel thresholds are tuned against a real badge/recording.
  BEACON_DECODER: "stub" as "stub" | "optical",
  BEACON_BRIGHT_T: 175, // 0..255 threshold for the localization mask
  BEACON_MIN_BORDER: 110, // min border luma for a confident sample (real screen ≈ 190-210)
  BEACON_ASPECT_MIN: 1.5, // patch aspect ≈ 304/132 = 2.3
  BEACON_ASPECT_MAX: 3.2,
  BEACON_MIN_W: 22, // min patch width in px at PROCESS_WIDTH
  BEACON_CELL_LIT_FRAC: 0.5, // cell lit if lum > frac × borderLum
  BEACON_CONTRAST_FRAC: 0.12, // min |cellLum − threshold| / borderLum to trust the read
  BEACON_MATCH_PX: 64, // patch-tracking match radius across frames (scales with PROCESS_WIDTH)
  BEACON_TRACK_MISS: 20, // keep a patch's assembler alive this many frames across gaps
  BEACON_ID_HOLD_MS: 2000, // report last decoded id this long after a decode (decodes are ~0.5-1s apart)
  BEACON_CONFIRM_MS: 1500, // an id must decode twice within this window to be trusted

  // vision/perf (mine)
  PROCESS_WIDTH: 720, // detection + decode input width; higher = badges decode from farther (costs CPU)
  DISPLAY_MAX_WIDTH: 960, // composited output width cap
  IOU_MATCH: 0.3, // tracker match threshold
  TRACK_MAX_MISSED: 10, // frames to hold a blur through occlusion (~0.6s @15fps)
  BLUR_PAD: 0.35, // pad the bbox — fail-safe covers more, never less
  PIXELATE_SIZE: 14, // block size in px; bigger = blockier
};
