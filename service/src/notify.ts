// The notice path: an opted-out person was on camera → tell them → put both
// facts on-chain. Two transactions per film-event, signed by the camera
// authority (the same key that anchors the audit log):
//
//   record_capture  — "badge 86 was on cam-1 at 12:01:03"   (filmed_at from the
//                     camera, recorded_at from the chain clock)
//   record_notice   — "…and was told at 12:01:07 by email + voice"
//
// The notice lives at ["capture", camera, sha256(FilmEvent)] — the same hash
// the audit log stores for the entry — so the on-chain record and the log
// entry name each other. Nothing personal goes on-chain: the badge id is the
// only key; the organizer's contact directory (CONTACTS_FILE) turns it into a
// person here, off-chain, and only the person's masked address ever reaches
// the operator screen.
//
// Email transport: DRY-RUN for the demo. The message is composed and logged
// (NOTICE_LOG), nothing leaves the laptop; /health and the operator panel say
// so. The on-chain notice is real either way — that is the point of it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { CHANNEL_BADGE_RADIO, CHANNEL_EMAIL, CHANNEL_VOICE, channelNames, explorerUrl, normalizeBadgeId } from "../../registry/client/src/core";
import type { AuditEntry } from "./audit";
import type { Chain } from "./chain";
import { config } from "./config";

export interface Contact {
  badgeId: string;
  name: string;
  email?: string;
}

export type NoticeStage = "queued" | "recorded" | "notified" | "unreachable" | "coalesced" | "error";

/** What the operator UI gets (broadcast at every stage change) and what NOTICE_LOG keeps. */
export interface NoticeState {
  type: "notice";
  at: number;
  stage: NoticeStage;
  eventId: string;
  beaconId: string;
  eventHash: string;
  cameraId: string;
  filmedAt: number; // ms, the camera's clock (FilmEvent.at)
  person: { name: string; email?: string } | null; // email MASKED
  capture?: { signature: string; explorer: string; address: string; addressExplorer: string; recordedAt: number }; // unix s (chain clock)
  notice?: { signature: string; explorer: string; notifiedAt: number; channels: string[] }; // unix s (chain clock)
  email?: { to: string; subject: string; mode: "dry-run" | "sent"; at: number }; // `to` masked
  /** `coalesced`: this film-event is covered by the notice filed for that earlier event (same badge, within NOTICE_MIN_INTERVAL_MS) */
  coveredBy?: { eventId: string; at: number };
  error?: string;
}

export interface NoticeInputs {
  /** the badge radio frame reached a live bridge (CNSF → the badge's alarm) */
  radioDelivered: boolean;
  /** the laptop will speak the alert (ElevenLabs / macOS say) */
  voice: boolean;
}

/** `hashbukhtiar@gmail.com` → `h•••@gmail.com`: enough to recognise, not enough to harvest. */
export function maskEmail(e: string): string {
  const at = e.indexOf("@");
  if (at <= 0) return "•••";
  return `${e[0]}•••${e.slice(at)}`;
}

export function composeEmail(c: Contact, entry: AuditEntry): { to: string; subject: string; text: string } {
  const when = new Date(entry.at).toLocaleString();
  return {
    to: c.email!,
    subject: `Consentinel: you were on camera ${entry.cameraId} at ${new Date(entry.at).toLocaleTimeString()}`,
    text:
      `Hi ${c.name.split(" ")[0]},\n\n` +
      `Badge ${entry.beaconId} (yours) was in view of camera ${entry.cameraId} at ${when}. ` +
      `You are opted out, so your face was blurred in that footage and nothing identifying was stored.\n\n` +
      `This capture and this notice are recorded on Solana under your badge id (no name, no email on-chain). ` +
      `You can review or change your consent from your badge at any time.\n\n— Consentinel`,
  };
}

export class Notifier {
  private queue: Promise<unknown> = Promise.resolve();
  private contacts = new Map<string, Contact>();
  private contactsMtime = -1;
  private recent: NoticeState[] = [];
  private counts = { recorded: 0, notified: 0, unreachable: 0, coalesced: 0, errors: 0 };
  private lastByBadge = new Map<string, { eventId: string; at: number }>(); // last notice filed per badge (coalescing window)

  constructor(
    private chain: Chain,
    private broadcast: (m: unknown) => void,
    private log: (m: string) => void = () => {},
  ) {
    this.loadContacts();
  }

  /** On-chain notices need the camera key and a registered CameraLog (same as attestation). */
  get enabled(): boolean {
    return config.NOTIFY_ON_CHAIN && !!this.chain.camera && this.chain.status().cameraRegistered;
  }

  /** The organizer's directory: badge id → person. Re-read when the file changes. */
  loadContacts(): Map<string, Contact> {
    try {
      const f = config.CONTACTS_FILE;
      if (!existsSync(f)) { this.contacts = new Map(); return this.contacts; }
      const m = statSync(f).mtimeMs;
      if (m === this.contactsMtime) return this.contacts;
      const j = JSON.parse(readFileSync(f, "utf8"));
      const out = new Map<string, Contact>();
      for (const b of j.badges ?? []) {
        if (!b?.badgeId || !b?.contact?.name) continue;
        let id: string;
        try { id = normalizeBadgeId(String(b.badgeId)); } catch { continue; }
        out.set(id, { badgeId: id, name: String(b.contact.name), email: b.contact.email ? String(b.contact.email) : undefined });
      }
      this.contacts = out;
      this.contactsMtime = m;
    } catch (e) {
      this.log(`contacts: could not read ${config.CONTACTS_FILE}: ${(e as Error).message}`);
    }
    return this.contacts;
  }

  contact(beaconId: string): Contact | null {
    return this.loadContacts().get(normalizeBadgeId(beaconId)) ?? null;
  }

  status() {
    return {
      enabled: this.enabled,
      onChain: config.NOTIFY_ON_CHAIN,
      emailMode: config.EMAIL_MODE,
      minIntervalMs: config.NOTICE_MIN_INTERVAL_MS,
      contactsFile: config.CONTACTS_FILE,
      contacts: [...this.loadContacts().values()].map((c) => ({ badgeId: c.badgeId, name: c.name, email: c.email ? maskEmail(c.email) : null })),
      counts: { ...this.counts },
      recent: this.recent.slice(-8),
    };
  }

  /**
   * Fire-and-forget from the film-event handler; notices run one at a time so
   * the RPC never sees a burst. A badge that stays in frame fires a film-event
   * every few seconds (the badge alarm needs that); the person needs ONE
   * receipt for that, so events within NOTICE_MIN_INTERVAL_MS of the last
   * notice filed for the same badge are coalesced onto it (still audited and
   * attested like every film-event — just not a second on-chain notice).
   */
  handle(entry: AuditEntry, inputs: NoticeInputs): { stage: "queued" | "coalesced" | "disabled"; coveredBy?: { eventId: string; at: number } } {
    if (!this.enabled) return { stage: "disabled" };
    const last = this.lastByBadge.get(entry.beaconId);
    if (last && entry.at - last.at < config.NOTICE_MIN_INTERVAL_MS) {
      this.counts.coalesced++;
      const st: NoticeState = {
        type: "notice", at: Date.now(), stage: "coalesced", eventId: entry.eventId, beaconId: entry.beaconId, eventHash: entry.hash, cameraId: entry.cameraId,
        filmedAt: entry.at, person: this.personOf(entry.beaconId), coveredBy: last,
      };
      this.broadcast({ ...st });
      this.remember(st);
      return { stage: "coalesced", coveredBy: last };
    }
    this.lastByBadge.set(entry.beaconId, { eventId: entry.eventId, at: entry.at });
    this.queue = this.queue.then(() => this.run(entry, inputs)).catch(() => {});
    return { stage: "queued" };
  }

  private personOf(beaconId: string): NoticeState["person"] {
    const c = this.contact(beaconId);
    return c ? { name: c.name, email: c.email ? maskEmail(c.email) : undefined } : null;
  }

  /** Why an on-chain write failed, in words the operator can act on. */
  private explain(e: unknown): string {
    const m = (e as Error).message ?? String(e);
    if (/InstructionFallbackNotFound|Fallback functions are not supported|invalid instruction data|101\b/.test(m)) {
      return `the deployed program has no record_capture/record_notice yet — upgrade it: cd registry && npm run build && anchor deploy --provider.cluster ${config.SOLANA_CLUSTER}`;
    }
    if (/insufficient funds|insufficient lamports|Attempt to debit an account but found no record/i.test(m)) {
      return `camera key ${this.chain.camera?.publicKey.toBase58() ?? ""} cannot pay the notice rent — cd registry && npm run seed (tops it up)`;
    }
    return m.split("\n")[0].slice(0, 160);
  }

  private async run(entry: AuditEntry, inputs: NoticeInputs): Promise<void> {
    const c = this.contact(entry.beaconId);
    const st: NoticeState = {
      type: "notice", at: Date.now(), stage: "queued", eventId: entry.eventId, beaconId: entry.beaconId, eventHash: entry.hash, cameraId: entry.cameraId,
      filmedAt: entry.at, person: this.personOf(entry.beaconId),
    };
    const emit = () => { st.at = Date.now(); this.broadcast({ ...st }); };
    emit();
    if (!this.enabled) {
      st.stage = "error";
      st.error = !this.chain.camera ? `no camera keypair (${config.CAMERA_KEYPAIR})` : !config.NOTIFY_ON_CHAIN ? "NOTIFY_ON_CHAIN is off" : "camera not registered on-chain — run `npm run seed` in registry/";
      this.counts.errors++;
      this.lastByBadge.delete(entry.beaconId);
      emit(); this.remember(st);
      return;
    }
    // 1. filmed → on-chain (the camera's clock as filmed_at, the chain's as recorded_at)
    try {
      const r = await this.chain.recordCapture(entry);
      st.capture = { ...r, addressExplorer: explorerUrl("address", r.address, config.SOLANA_CLUSTER) };
      st.stage = "recorded";
      this.counts.recorded++;
      this.log(`notice: ${entry.beaconId} filmed at ${new Date(entry.at).toLocaleTimeString()} → on-chain ${r.explorer}`);
      emit();
    } catch (e) {
      st.stage = "error";
      st.error = `record_capture failed: ${this.explain(e)}`;
      this.counts.errors++;
      this.lastByBadge.delete(entry.beaconId); // nothing filed: the next film-event tries again
      this.log(`notice: ${st.error}`);
      emit(); this.remember(st);
      return;
    }
    // 2. tell them — every channel that actually reached them
    let channels = 0;
    if (c?.email) {
      const mail = composeEmail(c, entry);
      // DRY-RUN: composed and logged, never sent (no mail API in the demo)
      st.email = { to: maskEmail(mail.to), subject: mail.subject, mode: config.EMAIL_MODE, at: Date.now() };
      this.logLine({ kind: "email", mode: config.EMAIL_MODE, eventId: entry.eventId, beaconId: entry.beaconId, to: mail.to, subject: mail.subject, text: mail.text, at: st.email.at });
      channels |= CHANNEL_EMAIL;
    }
    if (inputs.radioDelivered) channels |= CHANNEL_BADGE_RADIO;
    if (inputs.voice) channels |= CHANNEL_VOICE;
    if (!channels) {
      st.stage = "unreachable";
      this.counts.unreachable++;
      this.log(`notice: ${entry.beaconId} has no contact on file and no live channel — capture recorded, nobody told`);
      emit(); this.remember(st);
      return;
    }
    // 3. told → on-chain (chain clock)
    try {
      const r = await this.chain.recordNotice(entry, channels);
      st.notice = { ...r, channels: channelNames(channels) };
      st.stage = "notified";
      this.counts.notified++;
      this.log(`notice: ${c ? c.name : `badge ${entry.beaconId}`} notified (${channelNames(channels).join(", ")}) → on-chain ${r.explorer}`);
    } catch (e) {
      st.stage = "error";
      st.error = `record_notice failed: ${this.explain(e)}`;
      this.counts.errors++;
      this.log(`notice: ${st.error}`);
    }
    emit(); this.remember(st);
  }

  private remember(st: NoticeState): void {
    this.recent.push({ ...st });
    if (this.recent.length > 50) this.recent.shift();
    this.logLine({ kind: "notice", ...st, type: undefined });
  }

  private logLine(rec: unknown): void {
    try {
      mkdirSync(dirname(config.NOTICE_LOG), { recursive: true });
      appendFileSync(config.NOTICE_LOG, JSON.stringify(rec) + "\n");
    } catch (e) {
      this.log(`notice log: ${(e as Error).message}`);
    }
  }
}
