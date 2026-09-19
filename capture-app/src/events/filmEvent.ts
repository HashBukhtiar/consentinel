import type { FilmEvent } from "../shared/schema";
import { flags } from "../config/flags";

// Emits a FilmEvent when an opted-out person is on camera. Fire-and-forget:
// never awaited in the render loop. Debounced per beacon so one capture doesn't
// spam the badge. C's notify service turns this into a badge buzz + ElevenLabs
// alert; here we also surface it in the operator UI via onEvent.
export class FilmEmitter {
  private last = new Map<string, number>();
  constructor(
    private onEvent: (e: FilmEvent) => void,
    private cameraId = "cam-1",
  ) {}

  maybeEmit(beaconId: string): void {
    const now = Date.now();
    if (now - (this.last.get(beaconId) ?? 0) < flags.FILM_EVENT_DEBOUNCE_MS) return;
    this.last.set(beaconId, now);
    const e: FilmEvent = { eventId: crypto.randomUUID(), beaconId, at: now, cameraId: this.cameraId };
    this.onEvent(e);
    if (flags.FILM_EVENT_ENDPOINT) {
      fetch(flags.FILM_EVENT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", ...(flags.SERVICE_TOKEN ? { authorization: `Bearer ${flags.SERVICE_TOKEN}` } : {}) },
        body: JSON.stringify(e),
      }).catch(() => {}); // never let a network error touch the loop
    }
  }
}
