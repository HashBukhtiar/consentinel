// The badge, as a web page. Any phone/laptop screen becomes a beacon the
// capture app can read — no HTN hardware, no firmware flash.
//
// Two geometry rules are load-bearing, and both come from the decoder:
//
//   1. THE BEACON BOX IS 4:3. The localizer gates on aspect
//      (BEACON_ASPECT_MIN..MAX = 1.0..1.9) because that is what identifies a
//      badge screen. A portrait phone filled edge-to-edge is ~0.46 and is
//      rejected before a single symbol is sampled — so we letterbox a 4:3 box
//      into whatever screen we're on, exactly matching PATCH's 320x240.
//   2. THE WHITE RING IS UNIFORM AND ALWAYS LIT. It is both the localization
//      anchor (during a BLACK symbol it is the only lit thing) and the white
//      reference every sample is divided by. At 4:3, BORDER_PX/PATCH.w and
//      BORDER_PX/PATCH.h are the same fraction of the box width, so one
//      uniform border in % of width is correct on all four sides.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  PATCH, INTERIOR, DEFAULT_TIMING_MS, SYMBOLS_PER_FRAME, FRAME_MS,
  ALPHABET, ALPHABET_NAMES, frameSymbols, hex2,
} from "@shared/beacon";

// Interior size as a fraction of the whole patch. Expressed on the INTERIOR
// rather than as padding on the frame: percentage padding resolves against the
// containing block's width, not the element's own, which silently made the
// ring 5x too thick and left the interior 0 px tall.
const IN_W_PCT = (INTERIOR.w / PATCH.w) * 100; // 85%
const IN_H_PCT = (INTERIOR.h / PATCH.h) * 100; // 80%
const cssRGB = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** ?id=4E&consent=in — so a phone can be aimed at the right identity in one tap. */
function readUrl(): { id: number; optIn: boolean } {
  const q = new URLSearchParams(location.search);
  const raw = q.get("id");
  const parsed = raw !== null ? parseInt(raw, 16) : NaN;
  const consent = q.get("consent");
  return {
    id: Number.isFinite(parsed) ? parsed & 0xff : 0x4e,
    optIn: consent === null ? true : consent === "in" || consent === "1",
  };
}

export function Badge() {
  const initial = useMemo(readUrl, []);
  const [id, setId] = useState(initial.id);
  const [optIn, setOptIn] = useState(initial.optIn);
  const [step, setStep] = useState(0);
  const [chrome, setChrome] = useState(true);
  const t0 = useRef(performance.now());

  // The transmitter, straight from the shared contract — decodeFrame() is its
  // exact inverse, so what this page paints is what the decoder expects.
  const syms = useMemo(() => frameSymbols(id, optIn), [id, optIn]);
  const symbol = syms[step];

  // Restart the frame on any change so a flipped consent shows its new marker
  // at the top of a frame rather than mid-payload.
  useEffect(() => { t0.current = performance.now(); setStep(0); }, [id, optIn]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const k = Math.floor((performance.now() - t0.current) / DEFAULT_TIMING_MS) % SYMBOLS_PER_FRAME;
      setStep(k); // React bails out when the value is unchanged, so this is cheap
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keep the screen awake — a badge that sleeps mid-demo stops being a badge.
  // Best-effort: unsupported browsers (and denied permission) just carry on.
  useEffect(() => {
    type Lock = { release: () => Promise<void> };
    let lock: Lock | null = null;
    let cancelled = false;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<Lock> } };
    const acquire = () => {
      nav.wakeLock?.request("screen")
        .then((l) => { if (cancelled) void l.release(); else lock = l; })
        .catch(() => {});
    };
    acquire();
    const onVis = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release().catch(() => {});
    };
  }, []);

  const setIdSafe = (v: string) => {
    const n = parseInt(v, 16);
    if (Number.isFinite(n)) setId(n & 0xff);
  };

  return (
    <div style={S.page} onClick={() => setChrome((c) => !c)}>
      {chrome && (
        <header style={S.header} onClick={(e) => e.stopPropagation()}>
          <Logo />
          <div style={S.controls}>
            <label style={S.label}>
              id
              <input
                value={hex2(id)}
                onChange={(e) => setIdSafe(e.target.value)}
                maxLength={2}
                inputMode="text"
                spellCheck={false}
                style={S.input}
              />
            </label>
            <button
              onClick={() => setOptIn((v) => !v)}
              style={{ ...S.toggle, background: optIn ? "#00ff84" : "#ff0084" }}
            >
              {optIn ? "OPT-IN" : "OPT-OUT"}
            </button>
          </div>
        </header>
      )}

      {/* The beacon. 4:3, letterboxed as large as the screen allows. */}
      <div style={S.stage}>
        <div style={S.frame}>
          <div style={{ ...S.interior, background: cssRGB(ALPHABET[symbol]) }} />
        </div>
      </div>

      {chrome && (
        <footer style={S.footer} onClick={(e) => e.stopPropagation()}>
          <span>
            beacon <b style={{ color: "#fff" }}>{hex2(id)}</b> · symbol {step + 1}/{SYMBOLS_PER_FRAME} ·{" "}
            <b style={{ color: cssRGB(ALPHABET[symbol]) }}>{ALPHABET_NAMES[symbol]}</b>
          </span>
          <span style={{ opacity: 0.6 }}>
            frame {FRAME_MS} ms · tap anywhere to hide this · point the capture app here
          </span>
        </footer>
      )}
    </div>
  );
}

function Logo() {
  const [ok, setOk] = useState(true);
  return (
    <div style={S.logoWrap}>
      {ok ? (
        <img src="/logo.svg" alt="Consentinel" style={S.logo} onError={() => setOk(false)} />
      ) : (
        <span style={S.wordmark}>CONSENTINEL</span>
      )}
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  page: {
    position: "fixed", inset: 0, background: "#000", color: "#aaa",
    display: "flex", flexDirection: "column",
    font: "13px ui-monospace, SFMono-Regular, Menlo, monospace",
    userSelect: "none", WebkitUserSelect: "none", overflow: "hidden",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: 12, padding: "10px 14px", flexWrap: "wrap",
  },
  controls: { display: "flex", alignItems: "center", gap: 10 },
  label: { display: "flex", alignItems: "center", gap: 6, textTransform: "uppercase", letterSpacing: ".08em" },
  input: {
    width: 56, padding: "6px 8px", textAlign: "center", textTransform: "uppercase",
    font: "16px ui-monospace, monospace", background: "#111", color: "#fff",
    border: "1px solid #333", borderRadius: 6,
  },
  toggle: {
    padding: "7px 14px", border: 0, borderRadius: 999, cursor: "pointer", color: "#000",
    font: "600 13px ui-monospace, monospace", letterSpacing: ".06em",
  },
  stage: {
    flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center",
    padding: 8,
  },
  // aspect-ratio + max dimensions letterbox a 4:3 box into any screen
  frame: {
    aspectRatio: "4 / 3", maxWidth: "100%", maxHeight: "100%",
    background: "#fff", boxSizing: "border-box",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  interior: { width: `${IN_W_PCT}%`, height: `${IN_H_PCT}%` },
  footer: {
    display: "flex", justifyContent: "space-between", gap: 12,
    padding: "8px 14px", fontSize: 12, flexWrap: "wrap",
  },
  logoWrap: { display: "flex", alignItems: "center", gap: 8 },
  logo: { height: 26, width: "auto", display: "block" },
  wordmark: { color: "#fff", font: "600 15px ui-monospace, monospace", letterSpacing: ".18em" },
};
