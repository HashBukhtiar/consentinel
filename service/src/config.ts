// Env-driven config with demo-safe defaults. Loads ../service/.env if present.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(SERVICE_DIR, "..");

// tiny .env loader (no dependency): KEY=VALUE lines, # comments, no expansion
const envFile = join(SERVICE_DIR, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined && m[2] !== "") process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

const env = (k: string, d = "") => process.env[k] ?? d;
const bool = (k: string, d: boolean) => (process.env[k] === undefined ? d : /^(1|true|yes|on)$/i.test(process.env[k]!));
const abs = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(SERVICE_DIR, p));

export const config = {
  PORT: Number(env("PORT", "8787")),
  SOLANA_CLUSTER: env("SOLANA_CLUSTER", "devnet") as "devnet" | "localnet" | "testnet" | "mainnet-beta",
  SOLANA_RPC_URL: env("SOLANA_RPC_URL", env("SOLANA_CLUSTER", "devnet") === "localnet" ? "http://127.0.0.1:8899" : "https://api.devnet.solana.com"),
  CAMERA_KEYPAIR: abs(env("CAMERA_KEYPAIR", "../registry/keys/camera-cam-1.json")),
  CAMERA_ID: env("CAMERA_ID", "cam-1"),
  RELAYER_KEYPAIR: abs(env("RELAYER_KEYPAIR", "~/.config/solana/id.json")),
  ATTEST_ON_CHAIN: bool("ATTEST_ON_CHAIN", true),
  ELEVENLABS_API_KEY: env("ELEVENLABS_API_KEY"),
  ELEVENLABS_VOICE_ID: env("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
  ELEVENLABS_MODEL_ID: env("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
  PLAY_AUDIO_LOCALLY: bool("PLAY_AUDIO_LOCALLY", true),
  AUDIT_LOG: abs(env("AUDIT_LOG", "../data/audit/film-events.jsonl")),
  AUDIO_DIR: join(SERVICE_DIR, "audio"),
  /** Debounce identical spoken alerts per badge (the capture app already debounces FilmEvents). */
  ALERT_MIN_INTERVAL_MS: Number(env("ALERT_MIN_INTERVAL_MS", "8000")),
};
