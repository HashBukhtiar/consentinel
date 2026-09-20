// Email transport for the notice path.
//
// The on-chain `record_notice` instruction writes a `channels` bitmask that
// claims *how the person was told*. That claim has to be earned: this module
// returns a definite sent/failed verdict and `notify.ts` sets CHANNEL_EMAIL
// only on `ok`. A composed-but-unsent message is `dry-run`, which is not a
// notification and never sets the bit.
//
// Transport is Resend's HTTP API — one POST, no SMTP, no dependency (Node 20
// has global fetch). EMAIL_MODE=dry-run keeps the old demo behaviour: compose,
// log, send nothing, claim nothing.
import { config } from "./config";

export type EmailMode = "dry-run" | "send";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailResult {
  /** true only when the provider accepted the message — the gate for CHANNEL_EMAIL */
  ok: boolean;
  mode: EmailMode;
  /** provider message id, for the operator log */
  id?: string;
  error?: string;
  ms: number;
  /** set when EMAIL_REDIRECT_TO diverted delivery away from the contact's address */
  redirectedTo?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Why the transport is not going to send, or null when it is ready. */
export function emailDisabledReason(): string | null {
  if (config.EMAIL_MODE === "dry-run") return "EMAIL_MODE=dry-run";
  if (!config.RESEND_API_KEY) return "RESEND_API_KEY is not set";
  if (!config.EMAIL_FROM) return "EMAIL_FROM is not set";
  return null;
}

export function emailReady(): boolean {
  return emailDisabledReason() === null;
}

/**
 * Send one notice email. Never throws: every failure path comes back as
 * `{ok: false, error}` so the notice pipeline can record "we tried and
 * failed" rather than dropping the capture.
 */
export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  const started = Date.now();
  const blocked = emailDisabledReason();
  if (blocked) {
    return { ok: false, mode: config.EMAIL_MODE, error: blocked, ms: 0 };
  }
  // Demo redirect: one inbox receives everything, but the caller keeps showing
  // and logging the contact's own address (see config.EMAIL_REDIRECT_TO).
  const envelopeTo = config.EMAIL_REDIRECT_TO || msg.to;
  const redirectedTo = config.EMAIL_REDIRECT_TO && config.EMAIL_REDIRECT_TO !== msg.to ? config.EMAIL_REDIRECT_TO : undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.EMAIL_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.EMAIL_FROM,
        to: [envelopeTo],
        subject: msg.subject,
        text: msg.text,
        ...(config.EMAIL_REPLY_TO ? { reply_to: config.EMAIL_REPLY_TO } : {}),
      }),
      signal: ctrl.signal,
    });
    const ms = Date.now() - started;
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, mode: "send", error: `resend ${res.status}: ${providerError(body)}`, ms, redirectedTo };
    }
    let id: string | undefined;
    try {
      id = JSON.parse(body)?.id;
    } catch {
      /* a 2xx with an unparseable body still counts as accepted */
    }
    return { ok: true, mode: "send", id, ms, redirectedTo };
  } catch (e) {
    const ms = Date.now() - started;
    const err = e as Error;
    if (err.name === "AbortError") {
      return { ok: false, mode: "send", error: `timed out after ${config.EMAIL_TIMEOUT_MS}ms`, ms, redirectedTo };
    }
    return { ok: false, mode: "send", error: err.message.slice(0, 160), ms, redirectedTo };
  } finally {
    clearTimeout(timer);
  }
}

/** Resend puts the useful part in `.message`; fall back to the raw body. */
function providerError(body: string): string {
  try {
    const j = JSON.parse(body);
    return String(j?.message ?? j?.error ?? body).slice(0, 160);
  } catch {
    return body.slice(0, 160);
  }
}
