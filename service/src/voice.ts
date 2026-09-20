// Spoken alert. ElevenLabs when a key is present (cached per phrase so the
// demo never waits on the API twice); macOS `say` as an honest fallback.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

export type VoiceProvider = "elevenlabs" | "macos-say" | "none";

export interface SpokenAlert {
  text: string;
  provider: VoiceProvider;
  /** served by the service at /audio/<file> (ElevenLabs only) */
  audioUrl?: string;
  cached: boolean;
}

export class Voice {
  readonly provider: VoiceProvider;
  private lastSpoke = new Map<string, number>();

  constructor() {
    this.provider = config.ELEVENLABS_API_KEY ? "elevenlabs"
      : process.platform === "darwin" && config.PLAY_AUDIO_LOCALLY ? "macos-say" // `say` only runs when it will be heard
      : "none";
    mkdirSync(config.AUDIO_DIR, { recursive: true });
  }

  /** Generate (or reuse) the audio for `text`, play it locally if enabled, return where it lives. */
  async speak(text: string, key: string): Promise<SpokenAlert> {
    const now = Date.now();
    const cached = this.lastSpoke.get(key) ?? 0;
    if (now - cached < config.ALERT_MIN_INTERVAL_MS) return { text, provider: this.provider, cached: true };
    this.lastSpoke.set(key, now);

    if (this.provider === "elevenlabs") {
      const file = join(config.AUDIO_DIR, createHash("sha1").update(config.ELEVENLABS_VOICE_ID + "|" + text).digest("hex") + ".mp3");
      let wasCached = existsSync(file);
      if (!wasCached) {
        try {
          const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${config.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`, {
            method: "POST",
            headers: { "xi-api-key": config.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
            body: JSON.stringify({ text, model_id: config.ELEVENLABS_MODEL_ID, voice_settings: { stability: 0.4, similarity_boost: 0.8 } }),
            signal: AbortSignal.timeout(6000), // venue Wi-Fi: never hang the alert path
          });
          if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
          writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        } catch (e) {
          this.lastSpoke.set(key, cached); // roll back the debounce so the next capture retries
          throw e;
        }
      }
      if (config.PLAY_AUDIO_LOCALLY && process.platform === "darwin") execFile("afplay", [file], () => {});
      return { text, provider: "elevenlabs", audioUrl: `/audio/${file.split("/").pop()}`, cached: wasCached };
    }
    if (this.provider === "macos-say" && config.PLAY_AUDIO_LOCALLY) execFile("say", [text], () => {});
    return { text, provider: this.provider, cached: false };
  }
}

export function alertText(beaconId: string, cameraId: string, name?: string): string {
  const who = name ? `${name.split(" ")[0]}, badge ${beaconId.split("").join(" ")}` : `badge ${beaconId.split("").join(" ")}`;
  return `Heads up ${who}: you were just recorded by camera ${cameraId}. Your face is blurred because you have not opted in.${name ? " We are sending you the details." : ""}`;
}
