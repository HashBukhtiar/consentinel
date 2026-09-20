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
  // a decoded badge with no record ⇒ ask the service to register it as opt_out (its card then appears)
  AUTO_REGISTER_UNKNOWN: (env.VITE_AUTO_REGISTER ?? "1") !== "0",
  FILM_EVENT_DEBOUNCE_MS: 5000,
  // The camera as the badge's radio bridge: when the light's consent flag
  // disagrees with the chain, send the badge's CNSR request to the service.
  OPTICAL_REQUESTS: (env.VITE_OPTICAL_REQUESTS ?? "1") !== "0",
  REQUEST_STABLE_MS: 1500, // the flag must read the same for this long (a button press mid-frame is not a request)
  REQUEST_MIN_INTERVAL_MS: 8000, // per badge; a stale nonce/409 is simply retried next interval

  // owned by A — shared contract value
  BEACON_SYMBOL_HZ: 10,

  // optical decoder (mine, feeds A's decodeFrame). "optical" decodes the real
  // badge (thresholds tuned on Maaz's recording; also what "Synthetic badge"
  // exercises). VITE_BEACON_DECODER=stub gives two fixed fake beacons — a
  // no-badge fallback only, never for judges. The header button flips it live.
  BEACON_DECODER: (env.VITE_BEACON_DECODER ?? "optical") as "stub" | "optical",
  // draw what the decoder sees on the feed (candidate patches, luma, bits, decoded ids)
  BEACON_DEBUG: (env.VITE_BEACON_DEBUG ?? "1") !== "0",
  BEACON_BRIGHT_T: 175, // 0..255 threshold for the localization mask
  BEACON_MIN_BORDER: 110, // min border luma for a confident sample (real screen ≈ 190-210)
  BEACON_ASPECT_MIN: 1.0, // patch aspect = 320/240 = 1.33 (full screen, was 2.3)
  BEACON_ASPECT_MAX: 1.9,
  BEACON_MIN_W: 14, // min patch width in px at PROCESS_WIDTH (decoder floor is ~22; leave headroom)
  BEACON_SYMBOL_MARGIN: 1.3, // nearest alphabet ref must be this many x closer than the runner-up
  BEACON_MATCH_PX: 64, // patch-tracking match radius across frames (scales with PROCESS_WIDTH)
  BEACON_TRACK_MISS: 20, // keep a patch's assembler alive this many frames across gaps
  BEACON_ID_HOLD_MS: 2000, // report last decoded id this long after a decode (decodes are ~0.5-1s apart)
  BEACON_CONFIRM_MS: 4000, // an id must decode twice within this window to be trusted.
  // MUST exceed 2 x FRAME_MS (900 ms): at the old 1500 a 9-symbol frame could
  // never confirm twice and every badge stayed blurred forever.

  // vision/perf (mine)
  // detection + decode input width; higher = badges decode from farther (costs CPU).
  // The badge patch must be ≥ BEACON_MIN_W px wide here: at 720 that is roughly
  // ≤ 1 m from a laptop webcam, at 1280 about ≤ 1.8 m. Live-switchable in the UI.
  PROCESS_WIDTH: Number(env.VITE_PROCESS_WIDTH ?? 720),
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
