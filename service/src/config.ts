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
const cluster = env("SOLANA_CLUSTER", "devnet") as "devnet" | "localnet" | "testnet" | "mainnet-beta";

export const config = {
  PORT: Number(env("PORT", "8787")),
  /** Origin allowed to call the browser-facing routes (the capture app). Badges use non-browser clients. */
  CORS_ORIGIN: env("CORS_ORIGIN", "http://localhost:5173"),
  /** If set, required as `authorization: Bearer <token>` on POST /film-event and GET /audit/events. */
  SERVICE_TOKEN: env("SERVICE_TOKEN"),
  SOLANA_CLUSTER: cluster,
  SOLANA_RPC_URL: env("SOLANA_RPC_URL", cluster === "localnet" ? "http://127.0.0.1:8899" : `https://api.${cluster}.solana.com`),
  CAMERA_KEYPAIR: abs(env("CAMERA_KEYPAIR", "../registry/keys/camera-cam-1.json")),
  CAMERA_ID: env("CAMERA_ID", "cam-1"),
  RELAYER_KEYPAIR: abs(env("RELAYER_KEYPAIR", "../registry/keys/relayer.json")),
  ATTEST_ON_CHAIN: bool("ATTEST_ON_CHAIN", true),
  /** One commitment per interval — a batch of the interval's film-events, or a heartbeat. Constant cadence ⇒ no timing leak. */
  ATTEST_INTERVAL_MS: Number(env("ATTEST_INTERVAL_MS", "10000")),
  ATTEST_HEARTBEAT: bool("ATTEST_HEARTBEAT", true),
  ELEVENLABS_API_KEY: env("ELEVENLABS_API_KEY"),
  ELEVENLABS_VOICE_ID: env("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
  ELEVENLABS_MODEL_ID: env("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
  PLAY_AUDIO_LOCALLY: bool("PLAY_AUDIO_LOCALLY", true),
  AUDIT_LOG: abs(env("AUDIT_LOG", "../data/audit/film-events.jsonl")),
  /** Badge signing keys (badge-<ID>.json, written by `npm run seed`): the service signs CNSR radio requests with them. */
  BADGE_KEYS_DIR: abs(env("BADGE_KEYS_DIR", "../registry/keys")),
  /**
   * Auto-enrol: a badge id the camera sees for the first time is registered as
   * opt_out by the organizer (issuer) key, so a card appears and can be granted.
   * opt_out can never un-blur anyone, so this is safe for anyone to trigger.
   */
  AUTO_REGISTER: bool("AUTO_REGISTER", true),
  ISSUER_KEYPAIR: abs(env("ISSUER_KEYPAIR", "~/.config/solana/id.json")),
  /** Demo key file the operator panel loads (so it can sign for auto-enrolled badges too). */
  DEMO_KEYS_FILE: abs(env("DEMO_KEYS_FILE", "../capture-app/public/demo/badges.json")),
  /** Where the capture app's 📸 diag snapshots land (frame JPEG, badge crops, classifier JSON). */
  DIAG_DIR: abs(env("DIAG_DIR", "../data/diag")),
  /** Rent guard: at most this many auto-enrolments per service run. */
  AUTO_REGISTER_MAX: Number(env("AUTO_REGISTER_MAX", "50")),
  /** While a radio bridge is connected, re-mirror every badge's consent this often (0 = off). Log pushes are the fast path. */
  RADIO_SYNC_MS: Number(env("RADIO_SYNC_MS", "20000")),
  AUDIO_DIR: join(SERVICE_DIR, "audio"),
  /** Debounce identical spoken alerts per badge (the capture app already debounces FilmEvents). */
  ALERT_MIN_INTERVAL_MS: Number(env("ALERT_MIN_INTERVAL_MS", "8000")),
  /**
   * Notices: for every film-event of an opted-out badge, `record_capture`
   * (filmed) then `record_notice` (told) on-chain, signed by the camera key.
   */
  NOTIFY_ON_CHAIN: bool("NOTIFY_ON_CHAIN", true),
  /** Organizer's directory badge → person (the `contact` field of each seed badge). Never on-chain. */
  CONTACTS_FILE: abs(env("CONTACTS_FILE", "../data/demo/seed-consents.json")),
  /**
   * Email transport. `dry-run` composes + logs and sends nothing — and, since
   * nobody was actually told, does NOT set CHANNEL_EMAIL in the on-chain
   * notice. `send` posts through Resend and sets the bit only on a 2xx.
   * Defaults to dry-run so a missing key can never silently stop notices.
   */
  EMAIL_MODE: (/^send$/i.test(env("EMAIL_MODE", "dry-run")) ? "send" : "dry-run") as "dry-run" | "send",
  RESEND_API_KEY: env("RESEND_API_KEY"),
  /**
   * Demo delivery redirect. When set, every notice email is DELIVERED here
   * regardless of the contact's address — the way `onboarding@resend.dev` needs
   * it, since the sandbox sender only reaches the account owner.
   *
   * The contact's own address is what the operator screen shows and what the
   * notice log records as `to`; this is the envelope recipient only. It is
   * disclosed in /health, the startup banner and NOTICE_LOG (as `redirectedTo`)
   * — deliberately not on the operator panel, which keeps showing the person.
   *
   * Note this makes CHANNEL_EMAIL mean "a mail was sent about this person",
   * not "this person received it". Leave unset for anything real.
   */
  EMAIL_REDIRECT_TO: env("EMAIL_REDIRECT_TO"),
  /** Must be a Resend-verified sender. `onboarding@resend.dev` works with no domain setup. */
  EMAIL_FROM: env("EMAIL_FROM", "Consentinel <onboarding@resend.dev>"),
  EMAIL_REPLY_TO: env("EMAIL_REPLY_TO"),
  EMAIL_TIMEOUT_MS: Number(env("EMAIL_TIMEOUT_MS", "8000")),
  /**
   * SMS is plumbed end to end (CHANNEL_SMS, `contact.phone`, notice state) but
   * has no transport yet, so it never sets its bit. Wiring one up means
   * implementing `sendSms()` the way `email.ts` does it — nothing else changes.
   */
  SMS_MODE: "off" as const,
  /** Where composed emails and notice outcomes are appended (JSONL; holds addresses — gitignored dir). */
  NOTICE_LOG: abs(env("NOTICE_LOG", "../data/audit/notices.jsonl")),
  /** One on-chain notice per badge per this window; film-events inside it are covered by the last notice (still audited + attested). */
  NOTICE_MIN_INTERVAL_MS: Number(env("NOTICE_MIN_INTERVAL_MS", "60000")),
  MAX_PENDING_EVENTS: 500,
  /** Thru (Unto Labs) evidence ledger — every film-event + attestation batch becomes its own Alphanet account via the `thru` CLI. Auto-disables if the CLI/funds are missing. */
  THRU_ENABLED: bool("THRU_ENABLED", true),
  THRU_FEE_PAYER: env("THRU_FEE_PAYER", "consentinel"),
  THRU_EXPLORER: env("THRU_EXPLORER", "https://scan.thru.org"),
};

/** RPC URL with any query string (API keys live there) removed. */
export function redactRpcUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return "(invalid url)";
  }
}
