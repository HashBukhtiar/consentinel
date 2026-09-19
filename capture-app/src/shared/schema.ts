// Shared data contracts for Consentinel's capture pipeline (§13).
// This file is also the hand-off doc: A implements `DecodeBeacons`,
// C implements `GetConsent` + consumes `FilmEvent`. All image coords are
// normalized [0,1] relative to the frame so association survives downscaling.

export type ConsentState = "opt_in" | "opt_out";
export type Consent = ConsentState | "unknown"; // "unknown" ⇒ blur (fail-safe)

export interface BeaconReading {
  beaconId: string; // two uppercase hex digits — hex2() in @shared/beacon
  imagePosition: { x: number; y: number }; // normalized [0,1]; center of the patch quad
  confidence: number; // decode confidence 0..1
}

// A tracked face in the current frame (internal to the capture app).
export interface Track {
  trackId: string;
  bbox: { x: number; y: number; w: number; h: number }; // normalized [0,1]
  beaconId?: string; // sticky once associated; persists through brief occlusion
  consent: Consent;
  blurred: boolean;
  missed: number; // frames since last detection (drives occlusion persistence)
}

export interface FilmEvent {
  eventId: string;
  beaconId: string;
  at: number;
  cameraId: string;
  // no image data — privacy by construction (§4.2)
}

// Mirrors the on-chain account (C's registry). Here for reference/typing only.
export interface ConsentRecord {
  badgeId: string;
  ownerPubkey: string;
  consent: ConsentState;
  perEventOverrides?: Record<string, ConsentState>;
  updatedAt: number;
}

export interface ConsentPolicy {
  subject: string;
  rule: "blur_unless_opt_in" | "allow_all" | "blur_all" | "per_event";
  scope?: string;
}

// ---- Integration contracts ----------------------------------------------
// A (beacon decoder): stateful, reads the frame, returns beacons seen this call.
export type DecodeBeacons = (frame: ImageData, tMs: number) => BeaconReading[];
// C (consent cache): SYNCHRONOUS read from a locally-synced cache — never the
// chain directly, never blocks the render loop (§8).
export type GetConsent = (beaconId: string) => Consent;
