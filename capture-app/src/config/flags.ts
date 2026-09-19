// §10 feature flags + pipeline tuning. Safe defaults: hero path runs with
// everything else off. Tune the beacon/perf knobs for your camera at the venue.
// Override any VITE_* value with a capture-app/.env.local file.
const env = ((import.meta as any).env ?? {}) as Record<string, string | undefined>;

export const flags = {
  DEFAULT_CONSENT: "blur" as const, // fail-safe: unknown/undecoded ⇒ blur
  DEMO_FALLBACK_MODE: false, // load a clip instead of a live source

  // ---- C: consent registry (Solana) + notify service ----------------------
  // "chain": read consent from the devnet-synced cache (the real thing).
  // "stub":  in-memory toggles, zero network — for a dead-Wi-Fi fallback only.
  CONSENT_SOURCE: (env.VITE_CONSENT_SOURCE ?? "chain") as "chain" | "stub",
  SOLANA_CLUSTER: (env.VITE_SOLANA_CLUSTER ?? "devnet") as "devnet" | "localnet",
  SOLANA_RPC_URL: env.VITE_SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  CONSENT_CACHE_SYNC_MS: 3000, // poll backstop; websocket pushes land faster
  EVENT_ID: env.VITE_EVENT_ID ?? "htn2026-demo", // scope for per-event overrides
  FILM_EVENT_ENDPOINT: env.VITE_FILM_EVENT_ENDPOINT ?? "http://localhost:8787/film-event", // "" ⇒ local log only
  SERVICE_WS_URL: env.VITE_SERVICE_WS_URL ?? "ws://localhost:8787/operator", // alerts + attestations feed
  FILM_EVENT_DEBOUNCE_MS: 5000,

  // owned by A — shared contract value
  BEACON_SYMBOL_HZ: 10,

  // vision/perf (B)
  PROCESS_WIDTH: 480, // detection input width; smaller = faster
  DISPLAY_MAX_WIDTH: 960, // composited output width cap
  IOU_MATCH: 0.3, // tracker match threshold
  TRACK_MAX_MISSED: 10, // frames to hold a blur through occlusion (~0.6s @15fps)
  BLUR_PAD: 0.35, // pad the bbox — fail-safe covers more, never less
  PIXELATE_SIZE: 14, // block size in px; bigger = blockier
};
