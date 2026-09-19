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

  // vision/perf (mine)
  PROCESS_WIDTH: 480, // detection input width; smaller = faster
  DISPLAY_MAX_WIDTH: 960, // composited output width cap
  IOU_MATCH: 0.3, // tracker match threshold
  TRACK_MAX_MISSED: 10, // frames to hold a blur through occlusion (~0.6s @15fps)
  BLUR_PAD: 0.35, // pad the bbox — fail-safe covers more, never less
  PIXELATE_SIZE: 14, // block size in px; bigger = blockier
};
