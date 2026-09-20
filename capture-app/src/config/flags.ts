// §10 feature flags + pipeline tuning. Safe defaults: hero path runs with
// everything else off. Tune the beacon/perf knobs for your camera at the venue.
// Override any VITE_* value with a capture-app/.env.local file.
const env = ((import.meta as any).env ?? {}) as Record<string, string | undefined>;
const cluster = (env.VITE_SOLANA_CLUSTER ?? "devnet") as "devnet" | "localnet";

export const flags = {
  DEFAULT_CONSENT: "blur" as const, // fail-safe: unknown/undecoded ⇒ blur
  DEMO_FALLBACK_MODE: false, // load a clip instead of a live source

  // ---- C: consent registry (Solana) + notify service ----------------------
  // "chain": read consent from the devnet-synced cache (the real thing).
  // "stub":  in-memory toggles, zero network — for a dead-Wi-Fi fallback only.
  CONSENT_SOURCE: (env.VITE_CONSENT_SOURCE ?? "chain") as "chain" | "stub",
  SOLANA_CLUSTER: cluster,
  SOLANA_RPC_URL: env.VITE_SOLANA_RPC_URL ?? (cluster === "localnet" ? "http://127.0.0.1:8899" : "https://api.devnet.solana.com"),
  CONSENT_CACHE_SYNC_MS: 3000, // poll backstop; websocket pushes land faster
  // If neither a poll nor a push succeeded within this window the cache is
  // no longer authoritative: every beacon reads as "unknown" ⇒ blur (fail-safe).
  CONSENT_STALE_MS: 60_000,
  EVENT_ID: env.VITE_EVENT_ID ?? "htn2026-demo", // scope for per-event overrides
  FILM_EVENT_ENDPOINT: env.VITE_FILM_EVENT_ENDPOINT ?? "http://localhost:8787/film-event", // "" ⇒ local log only
  SERVICE_TOKEN: env.VITE_SERVICE_TOKEN ?? "", // must match the service's SERVICE_TOKEN when set
  SERVICE_WS_URL: env.VITE_SERVICE_WS_URL ?? "ws://localhost:8787/operator", // alerts + attestations feed
  FILM_EVENT_DEBOUNCE_MS: 5000,

  // owned by A — shared contract value
  BEACON_SYMBOL_HZ: 10,

  // optical decoder (mine, feeds A's decodeFrame). "optical" decodes the real
  // badge (thresholds tuned on Maaz's recording; also what "Synthetic badge"
  // exercises). VITE_BEACON_DECODER=stub gives two fixed fake beacons — a
  // no-badge fallback only, never for judges. The header button flips it live.
  BEACON_DECODER: (env.VITE_BEACON_DECODER ?? "optical") as "stub" | "optical",
  BEACON_BRIGHT_T: 175, // 0..255 threshold for the localization mask
  BEACON_MIN_BORDER: 110, // min border luma for a confident sample (real screen ≈ 190-210)
  BEACON_ASPECT_MIN: 1.5, // patch aspect ≈ 304/132 = 2.3
  BEACON_ASPECT_MAX: 3.2,
  BEACON_MIN_W: 14, // min patch width in px at PROCESS_WIDTH (decoder floor is ~22; leave headroom)
  BEACON_CELL_LIT_FRAC: 0.5, // cell lit if lum > frac × borderLum
  BEACON_CONTRAST_FRAC: 0.12, // min |cellLum − threshold| / borderLum to trust the read
  BEACON_MATCH_PX: 64, // patch-tracking match radius across frames (scales with PROCESS_WIDTH)
  BEACON_TRACK_MISS: 20, // keep a patch's assembler alive this many frames across gaps
  BEACON_ID_HOLD_MS: 2000, // report last decoded id this long after a decode (decodes are ~0.5-1s apart)
  BEACON_CONFIRM_MS: 1500, // an id must decode twice within this window to be trusted

  // ---- anti-forgery gate (src/consent/antiSpoof.ts) ----------------------
  // The patch is a static public 8-bit id: no secret, no signature, forgeable
  // by anyone with a phone screen. These knobs do not make it unforgeable —
  // they make guessing slow and visible. See the header of antiSpoof.ts.
  SPOOF_GUARD: true, // off ⇒ believe every decode (pre-hardening behaviour)
  // An id must hold at one place this long before it can un-blur anyone. This
  // is added latency on the FIRST sighting of a real badge, so it trades
  // demo snappiness against brute-force cost directly. 1500 ≈ one extra
  // second on top of the decoder's own confirm.
  SPOOF_STABLE_MS: 1500,
  SPOOF_SITE_RADIUS: 0.08, // normalized; how far a patch can move and stay "the same place"
  SPOOF_SITE_TTL_MS: 2000, // forget a place that has gone quiet this long
  // A real badge shows one id. Three different ids at one spot inside the
  // window is a screen being flipped — sit that spot out.
  SPOOF_CHURN_MS: 5000,
  SPOOF_MAX_IDS: 3,
  SPOOF_QUARANTINE_MS: 10_000,
  SPOOF_CLONE_HOLD_MS: 3000, // same id in two places ⇒ distrust it this long

  // vision/perf (mine)
  PROCESS_WIDTH: 720, // detection + decode input width; higher = badges decode from farther (costs CPU)
  DISPLAY_MAX_WIDTH: 960, // composited output width cap
  IOU_MATCH: 0.3, // tracker match threshold
  TRACK_MAX_MISSED: 10, // frames to hold a blur through occlusion (~0.6s @15fps)
  PIXELATE_SIZE: 14, // block size in px; bigger = blockier

  // ---- default-deny composite + binding guards (see DECISIONS.md §4) ------
  // The frame is pixelated WHOLE and clear windows are punched out only for
  // explicit opt_in, so a face the detector never found is still covered.
  // Inset is the inverse of the old per-box pad: blur covers everything, and
  // a clear window shrinks inward so it reveals less rather than more.
  CLEAR_INSET: 0.06,
  // Binding is the only thing that can un-blur, so it refuses rather than guesses:
  // Max face↔badge distance, in multiples of that face's bbox height. A
  // chest-worn badge sits ~2-3 face-heights below the face, and that ratio
  // holds at any camera distance — an absolute normalized cap does not.
  BIND_MAX_FACE_HEIGHTS: 3.0,
  BIND_AMBIGUOUS_RATIO: 1.25, // runner-up within 25% of the winner ⇒ bind neither
  // How long a binding vouches for a face after the last sighting of its
  // beacon. Stacks on top of BEACON_ID_HOLD_MS (the decoder keeps reporting a
  // decoded id for that long), so true worst-case staleness is the sum — drop
  // BEACON_ID_HOLD_MS too if that window feels long.
  BIND_TTL_MS: 1200,
};
