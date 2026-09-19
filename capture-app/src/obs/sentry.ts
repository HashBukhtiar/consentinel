import * as Sentry from "@sentry/react";

// Observability for the capture pipeline. Two Sentry products beyond error
// monitoring: Tracing (a span tree per sampled frame → find the slow stage) and
// Logs (structured consent decisions + film events). Session Replay is
// deliberately NOT used — it would record faces from the video feed, which is
// exactly what this app refuses to do. Even our observability honors no-image.
//
// No-ops without VITE_SENTRY_DSN, so the app runs fine unconfigured.
let enabled = false;
let sampling = false;

export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: "hackathon",
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 1.0, // we self-sample (one frame/sec), so keep what we create
    enableLogs: true,
  });
  enabled = true;
}

export const obsEnabled = () => enabled;

// Parent span for one sampled frame; stage spans created inside nest under it.
export function traceFrame<T>(fn: () => T): T {
  if (!enabled) return fn();
  sampling = true;
  try {
    return Sentry.startSpan({ name: "pipeline.frame", op: "pipeline" }, fn);
  } finally {
    sampling = false;
  }
}

// A pipeline stage span — only recorded while inside a sampled traceFrame.
export function traceStage<T>(name: string, fn: () => T): T {
  return enabled && sampling ? Sentry.startSpan({ name, op: "pipeline.stage" }, fn) : fn();
}

export function logConsent(trackId: string, beaconId: string | undefined, consent: string, blurred: boolean): void {
  if (enabled) Sentry.logger.info("consent decision", { trackId, beaconId: beaconId ?? "none", consent, blurred });
}

export function logFilmEvent(beaconId: string): void {
  if (enabled) Sentry.logger.warn("film event: opted-out subject captured", { beaconId });
}
