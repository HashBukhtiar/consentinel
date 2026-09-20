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
  // Poll cadence. Every SYNC_MS the cache refreshes the accounts it already
  // knows with ONE cheap getMultipleAccounts call; only every DISCOVER_MS does it
  // run getProgramAccounts to find new records (the public devnet RPC throttles
  // that call: "429 Too many requests for a specific RPC call"). New records
  // also arrive sooner via the log push and via the on-demand fetch of an
  // unknown id. A 429 backs the poll off (up to 30 s); pushes keep it fresh.
  CONSENT_CACHE_SYNC_MS: 3000,
  CONSENT_CACHE_DISCOVER_MS: 30_000,
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
  // Optical decoder engine. "seq": identity from the ORDER of colour changes
  // matched against all 512 possible frames (no white reference, no colour
  // calibration — the only thing that worked on a real webcam, see
  // src/decode/seq.ts). "color": Maaz's absolute-colour classifier (what the
  // sweep models; needs a resolvable white ring and an sRGB-like panel).
  // "key": the STATIC KEY the badge shows since firmware 0.4.0 — three giant
  // 7-segment hex digits read from a single frame (src/decode/key.ts). The two
  // blink-era engines stay selectable for old recordings and the sweep.
  BEACON_OPTICAL_MODE: (env.VITE_BEACON_OPTICAL_MODE ?? "key") as "key" | "seq" | "color",
  // key decoder knobs (units: channel values 0..255 unless noted)
  KEY_CHROMA_T: 40, // a lit pixel is chromatic: (G+B)/2−R (mint) or (R+B)/2−G (rose) at least this
  KEY_TOPHAT_T: 25, // …and this much MORE chromatic than its surroundings (kills LED flare, coloured cloth, the badge's own glow)
  KEY_LIT_MIN: 90, // …and bright: brightest channel at least this
  KEY_WIN_DIV: 140, // top-hat half-window = frame width / this (9 px at 1280; a segment is thinner than that beyond ~40 cm)
  KEY_MIN_PX: 3, // smallest component kept
  KEY_MERGE_GAP: 0.8, // a component joins a cluster when the VERTICAL gap to a member ≤ this × the smaller one's size ('1' = two bars 18 units apart over 53-unit bars; the mask erodes bar ends, so the gap reads ~28)
  KEY_MERGE_GAP_X: 2.0, // …and the HORIZONTAL gap ≤ this × that size (a '1' lights only its right bars: 72 units from the digit before it, over bars that erode to ~40 units far away)
  KEY_MERGE_FLOOR_PX: 1.5, // …or when they all but touch (blur-broken corners)
  KEY_MERGE_REACH_H: 0.75, // horizontal reach never exceeds this × the cluster's height (90 units over a 124–160-unit digit)
  KEY_MERGE_CLUSTER_FRAC: 0.25, // …or within this × the cluster's height (the pieces of a hollowed-out bar close up; an LED is ≥ 0.66 heights above/below)
  KEY_MERGE_LIT_TOL: 0.10, // …and only if its lit level is within this fraction of the cluster's (segments are uniform; flare and glow are dimmer)
  KEY_THIN_PX: 6, // parts thinner than this (far bars) get the looser band below: their mean is dragged down by edge pixels
  KEY_MERGE_LIT_TOL_THIN: 0.3,
  KEY_MIN_W: 18, // smallest lit extent worth a fit, px at PROCESS_WIDTH (256 units ⇒ a segment is ~1.3 px)
  KEY_ASPECT_MIN: 0.8, // lit extent aspect: 180..256 wide over 124..160 tall, ±30% perspective
  KEY_ASPECT_MAX: 2.8,
  KEY_STRETCH_MIN: 0.6, // x-scale over y-scale a hypothesis may imply (yaw foreshortening)
  KEY_STRETCH_MAX: 1.6,
  KEY_MIN_CONTRAST: 40, // lit − dark, in the digit's channel
  KEY_DARK_MAX_FRAC: 0.6, // the always-dark spots must read below this × lit
  KEY_SAMPLE_FRAC: 0.3, // half-size of a sample box as a fraction of the segment thickness
  KEY_REFINE_FROM: -0.1, // refine a placement only if it starts at least this well (below: not even roughly right)
  KEY_REFINE_FINE_FROM: 0.08, // …and run the half-pixel phase only from here
  KEY_REFINE_ITERS: 8, // coordinate-descent steps per phase (1 px, then 0.5 px) per edge
  KEY_MARGIN: 0.2, // every sample at least this far (× contrast) from the lit/dark midpoint
  KEY_RIVAL_FRAC: 0.7, // a second id whose margin is ≥ this × the best one's ⇒ ambiguous ⇒ no reading
  KEY_TRIM_MAX: 6, // when a cluster fails to fit, peel up to this many brightness-deviant members (one at a time) and retry (junk stuck to the key)
  KEY_TRIM_CANDIDATES: 3, // …but only for the largest few clusters per frame (a retry is a full fit)
  KEY_FINE_BELOW_PX: 240, // fit on a native-res crop when the lit extent is narrower than this (coarse px)
  KEY_CONFIRM_N: 2, // decodes of the same id+consent within BEACON_CONFIRM_MS before it is reported
  // seq decoder knobs (measured on data/diag 2026-09-20, 1.5 m, 20 fps):
  SEQ_DIFF_T: 60, // sum |ΔR|+|ΔG|+|ΔB| between consecutive frames that counts as "changed" (badge symbol changes measure 40–400; sensor noise ~20)
  SEQ_MIN_W: 8, // smallest blinking rectangle worth tracking, px at PROCESS_WIDTH (~3 m at 1280)
  SEQ_MIN_FILL: 0.45, // a lit rectangle is solid; a moving person is ragged
  SEQ_CLEAN_SD: 25, // interior colour spread above this = mid-refresh / motion frame, skipped (clean frames measured ≤ 22)
  SEQ_RUN_SPLIT: 20, // colour jump that starts a new run (BLUE→AZURE, the closest pair on the webcam, was 38; a spurious split re-merges in the matcher)
  SEQ_SAME_MAX: 30, // same symbol ⇒ all its colours within this of their mean
  SEQ_DIFF_MIN: 28, // different symbols ⇒ centroids at least this far apart
  SEQ_MIN_RUNS: 12, // > one 9-symbol frame before a match is attempted
  SEQ_WINDOW_RUNS: 24, // match over the most recent runs (≈ 2.5 frames)
  SEQ_HISTORY_MS: 5000,
  SEQ_MATCH_EVERY: 4, // frames between match attempts per track (a full match is ~4 ms)
  SEQ_TRACK_MISS: 45, // frames a blink track survives without a new change blob (~1.5 s; symbols change every 3–5 frames)
  // Localization mask = WHITENESS: min(R,G,B) > this. Measured on a real webcam
  // frame in a lit room: the badge's white ring came out [121,169,203] (min 121),
  // the coloured interior always has a channel near 0, skin ≈ 110-130 (and a
  // face fails the aspect test anyway), grey cloth ≈ 180+ (rejected by shape).
  BEACON_WHITE_T: 96,
  BEACON_MIN_BORDER: 90, // min ring luma for a confident sample (measured 155 in a lit room; a dark room reads 190-210)
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
  PROCESS_WIDTH: Number(env.VITE_PROCESS_WIDTH ?? 1280), // 1280: the badge needs the pixels (1080p webcam); drop to 720 on a slow laptop
  DISPLAY_MAX_WIDTH: 960, // composited output width cap
  IOU_MATCH: 0.3, // tracker match threshold
  TRACK_MAX_MISSED: 10, // frames to hold a blur through occlusion (~0.6s @15fps)
  PIXELATE_SIZE: 14, // block size in px; bigger = blockier
  // How the blur is composited (header button flips it live):
  //   "frame": DEFAULT DENY — the whole frame is pixelated and clear windows are
  //            punched out only for opt_in faces (DECISIONS.md §2.6); a face the
  //            detector never found is still covered.
  //   "faces": pixelate only detected faces that are not opt_in (padded outward).
  //            Looks like a normal video with blurred people; an undetected face
  //            is shown clear. The privacy story is weaker; the picture is nicer.
  COMPOSITE: (env.VITE_COMPOSITE ?? "frame") as "frame" | "faces",
  BLUR_PAD: 0.35, // "faces" mode: pad each blurred bbox outward — fail-safe covers more, never less

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
