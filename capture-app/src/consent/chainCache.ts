// The local consent cache synced from Solana (§8). The render loop reads
// `get()` — a synchronous Map lookup — and nothing else. Two sync paths keep
// it fresh: a websocket subscription to the program's logs (push, ~1s) and a
// polling backstop every CONSENT_CACHE_SYNC_MS (getProgramAccounts). Both are
// slot-ordered so a late poll can't overwrite a newer push. Unknown beacons
// are fetched on demand and are "unknown" (⇒ blur) until resolved.
//
// Fail-safe on staleness: if neither path has succeeded within
// CONSENT_STALE_MS the cache stops being authoritative and every beacon reads
// as "unknown" (⇒ blur) until a sync lands. A dead RPC can never leave a
// face un-blurred on stale data.
import { Connection, PublicKey } from "@solana/web3.js";
import {
  ConsentRegistryClient,
  type CaptureView,
  type ConsentView,
  type LogNotification,
  type OverrideView,
  type RegistrySnapshot,
} from "../../../registry/client/src/registry";
import { capturePda, channelNames, explorerUrl, fromHex, normalizeBadgeId, type Cluster } from "../../../registry/client/src/core";
import { flags } from "../config/flags";
import type { GetConsent } from "../shared/schema";

export interface ChainStatus {
  cluster: Cluster;
  rpc: string;
  programId: string;
  programUrl: string;
  deployed: boolean | null; // null until probed
  subscribed: boolean;
  lastPushAt: number;
  syncing: boolean;
  lastSyncAt: number;
  lastSyncSlot: number;
  /** last successful sync of either kind — drives the staleness fail-safe */
  freshAt: number;
  lastError: string;
  polls: number;
  pushes: number;
}

export interface Activity {
  id: string;
  at: number;
  kind: "push" | "poll" | "tx" | "error" | "info";
  text: string;
  badgeId?: string;
  signature?: string;
  url?: string;
}

interface Stamped<T> {
  view: T;
  slot: number;
}

const NEGATIVE_TTL_MS = 10_000;
const ERROR_BACKOFF_START_MS = 1_000;
const ERROR_BACKOFF_MAX_MS = 30_000;

export class ChainConsentCache {
  readonly client: ConsentRegistryClient;
  readonly connection: Connection;
  status: ChainStatus;
  activity: Activity[] = [];

  private consents = new Map<string, Stamped<ConsentView>>();
  private overrides = new Map<string, Stamped<OverrideView>>();
  private notices = new Map<string, Stamped<CaptureView>>(); // by address; the camera's filmed/notified records
  private tombstones = new Map<string, number>(); // key → slot at which it was closed
  private normCache = new Map<string, string | null>();
  private inFlight = new Set<string>();
  private notBefore = new Map<string, number>(); // per-id: no on-demand fetch before this time
  private backoff = new Map<string, number>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private known = new Map<string, PublicKey>(); // every program account we have seen, by address
  private lastFullAt = 0;
  private backoffUntil = 0;
  private backoffMs = 0;
  private unsubscribe: (() => void) | null = null;
  private seq = 0;
  private now: () => number;

  constructor(
    rpcUrl: string = flags.SOLANA_RPC_URL,
    private opts: { autoFetch?: boolean; cluster?: Cluster; now?: () => number; onUnknown?: (id: string) => void } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.connection = new Connection(rpcUrl, { commitment: "confirmed" });
    this.client = new ConsentRegistryClient(this.connection);
    const cluster = opts.cluster ?? flags.SOLANA_CLUSTER;
    this.status = {
      cluster,
      rpc: rpcUrl,
      programId: this.client.programId.toBase58(),
      programUrl: explorerUrl("address", this.client.programId.toBase58(), cluster),
      deployed: null,
      subscribed: false,
      lastPushAt: 0,
      syncing: false,
      lastSyncAt: 0,
      lastSyncSlot: 0,
      freshAt: 0,
      lastError: "",
      polls: 0,
      pushes: 0,
    };
  }

  // ---- the hot-path read ----------------------------------------------------

  /** True when no sync has landed within CONSENT_STALE_MS (⇒ everything is "unknown"). */
  get stale(): boolean {
    return this.now() - this.status.freshAt > flags.CONSENT_STALE_MS;
  }

  /** Synchronous. Called per track per frame. Never touches the network. */
  get: GetConsent = (beaconId) => {
    let id = this.normCache.get(beaconId);
    if (id === undefined) {
      try { id = normalizeBadgeId(beaconId); } catch { id = null; }
      if (this.normCache.size > 4096) this.normCache.clear();
      this.normCache.set(beaconId, id);
    }
    if (!id) return "unknown";
    if (this.stale) return "unknown"; // fail-safe: cache no longer authoritative
    const rec = this.consents.get(id);
    if (!rec) {
      if (this.opts.autoFetch !== false) this.fetchOne(id);
      return "unknown"; // fail-safe: no record ⇒ blur
    }
    const o = this.overrides.get(id + "|" + flags.EVENT_ID);
    // an override only counts if it was set by the record's current owner
    const effective = o && o.view.owner === rec.view.owner ? o.view.consent : rec.view.consent;
    return effective ? "opt_in" : "opt_out";
  };

  // ---- lifecycle -------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    void this.probeDeployment();
    void this.syncNow(true);
    this.timer = setInterval(() => this.tick(), flags.CONSENT_CACHE_SYNC_MS);
    this.unsubscribe = this.client.onLogs((n) => this.applyLogs(n));
    this.status.subscribed = true; // requested; `pushes`/`lastPushAt` show whether it delivers
    this.note("info", `subscribed to program logs on ${this.status.cluster}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.status.subscribed = false;
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  records(): ConsentView[] {
    return [...this.consents.values()].map((s) => s.view).sort((a, b) => a.badgeId.localeCompare(b.badgeId));
  }

  /** The cameras' on-chain capture notices (filmed / notified), newest first. */
  captures(badgeId?: string): CaptureView[] {
    return [...this.notices.values()].map((s) => s.view).filter((c) => !badgeId || c.badgeId === badgeId).sort((a, b) => b.recordedAt - a.recordedAt || b.filmedAt - a.filmedAt);
  }

  overridesFor(badgeId: string): OverrideView[] {
    return [...this.overrides.values()].map((s) => s.view).filter((o) => o.badgeId === badgeId);
  }

  /** The override that currently decides `badgeId` for the configured event, if any. */
  effectiveOverride(badgeId: string): OverrideView | null {
    const rec = this.consents.get(badgeId);
    const o = this.overrides.get(badgeId + "|" + flags.EVENT_ID);
    return rec && o && o.view.owner === rec.view.owner ? o.view : null;
  }

  // ---- sync paths --------------------------------------------------------------

  private async probeDeployment(): Promise<void> {
    try {
      this.status.deployed = await this.client.isDeployed();
      if (!this.status.deployed) {
        this.status.lastError = `program ${this.status.programId} is not deployed on ${this.status.cluster}`;
        this.note("error", this.status.lastError);
      }
    } catch { /* the poll will surface RPC errors */ }
    this.emit();
  }

  /** Timer body: cheap refresh of known accounts, full discovery every DISCOVER_MS, nothing while backing off a 429. */
  private tick(): void {
    const now = this.now();
    if (now < this.backoffUntil) return;
    const full = !this.known.size || now - this.lastFullAt >= flags.CONSENT_CACHE_DISCOVER_MS;
    void this.syncNow(full);
  }

  /**
   * `full` = getProgramAccounts (discovers new records; rate-limited on public
   * RPCs). Otherwise one getMultipleAccounts over the records we know, which
   * also detects closes. Either way the read is slot-stamped and merged
   * slot-ordered, so a late poll never overwrites a newer push.
   */
  async syncNow(full = true): Promise<void> {
    if (this.status.syncing) return;
    this.status.syncing = true;
    try {
      let slot: number;
      if (full || !this.known.size) {
        const snap = await this.client.fetchAll();
        this.applySnapshot(snap);
        this.lastFullAt = this.now();
        slot = snap.slot;
      } else {
        const { snap, closed } = await this.client.fetchAccounts([...this.known.values()]);
        this.applyPartial(snap, closed);
        slot = snap.slot;
      }
      this.status.lastSyncAt = this.now();
      this.status.freshAt = this.status.lastSyncAt;
      this.status.lastSyncSlot = slot;
      if (this.status.deployed !== false) this.status.lastError = "";
      this.status.polls++;
      if (this.backoffMs) this.note("info", "RPC recovered — normal poll cadence resumed");
      this.backoffMs = 0;
    } catch (e) {
      const msg = (e as Error).message;
      this.status.lastError = msg;
      if (/\b429\b|Too many requests|rate limit/i.test(msg)) {
        // public RPC throttling: back off the poll (the log push keeps the cache
        // fresh; if BOTH stay silent for CONSENT_STALE_MS everything blurs)
        this.backoffMs = Math.min(Math.max(this.backoffMs * 2, flags.CONSENT_CACHE_SYNC_MS * 2), 30_000);
        this.backoffUntil = this.now() + this.backoffMs;
        this.note("error", `RPC rate-limited (429) — poll paused ${Math.round(this.backoffMs / 1000)}s; push stays live. A dedicated devnet RPC URL (VITE_SOLANA_RPC_URL) removes this.`);
      } else {
        this.note("error", `sync failed: ${msg}`);
      }
    } finally {
      this.status.syncing = false;
      this.emit();
    }
  }

  private remember(address: string): void {
    if (!this.known.has(address)) { try { this.known.set(address, new PublicKey(address)); } catch { /* synthetic test data */ } }
  }

  /**
   * Merge a refresh of KNOWN accounts: records present are updated (slot-
   * ordered), records reported closed are removed + tombstoned, and — unlike
   * applySnapshot — nothing else is touched, because nothing else was queried.
   */
  applyPartial(snap: RegistrySnapshot, closed: PublicKey[] = []): void {
    for (const c of snap.consents) {
      this.remember(c.address);
      if ((this.tombstones.get(c.badgeId) ?? -1) >= snap.slot) continue;
      const cur = this.consents.get(c.badgeId);
      if (cur && cur.slot > snap.slot) continue;
      const changed = !cur || cur.view.revision !== c.revision || cur.view.consent !== c.consent || cur.view.instance !== c.instance;
      this.consents.set(c.badgeId, { view: c, slot: snap.slot });
      this.notBefore.delete(c.badgeId);
      this.backoff.delete(c.badgeId);
      if (changed && cur) this.note("poll", `${c.badgeId} → ${c.consent ? "opt_in" : "opt_out"} (rev ${c.revision})`, c.badgeId);
    }
    for (const o of snap.overrides) {
      this.remember(o.address);
      const key = o.badgeId + "|" + o.eventId;
      if ((this.tombstones.get(key) ?? -1) >= snap.slot) continue;
      const cur = this.overrides.get(key);
      if (cur && cur.slot > snap.slot) continue;
      this.overrides.set(key, { view: o, slot: snap.slot });
    }
    for (const c of snap.captures) this.mergeCapture(c, snap.slot);
    for (const pk of closed) {
      const addr = pk.toBase58();
      this.known.delete(addr);
      for (const [id, s] of this.consents) if (s.view.address === addr && s.slot <= snap.slot) { this.consents.delete(id); this.tombstones.set(id, snap.slot); this.note("poll", `${id} record closed ⇒ blur (fail-safe)`, id); }
      for (const [key, s] of this.overrides) if (s.view.address === addr && s.slot <= snap.slot) { this.overrides.delete(key); this.tombstones.set(key, snap.slot); }
      if (this.notices.get(addr)?.slot! <= snap.slot) this.notices.delete(addr);
    }
  }

  /** Slot-ordered merge of one capture notice (poll or push). Notices are never closed, only completed. */
  private mergeCapture(c: CaptureView, slot: number): void {
    this.remember(c.address);
    const cur = this.notices.get(c.address);
    if (cur && cur.slot > slot) return;
    if (cur && !cur.view.notifiedAt && c.notifiedAt) this.note("poll", `${c.badgeId} notified (${channelNames(c.channels).join(", ")}) — on-chain`, c.badgeId);
    this.notices.set(c.address, { view: c, slot });
  }

  /** Apply a full poll snapshot. Records/tombstones newer than the snapshot's slot win. */
  applySnapshot(snap: RegistrySnapshot): void {
    this.known.clear();
    for (const c of snap.consents) this.remember(c.address);
    for (const o of snap.overrides) this.remember(o.address);
    for (const c of snap.captures) this.remember(c.address);
    const seen = new Set<string>();
    for (const c of snap.consents) {
      seen.add(c.badgeId);
      if ((this.tombstones.get(c.badgeId) ?? -1) >= snap.slot) continue;
      const cur = this.consents.get(c.badgeId);
      if (cur && cur.slot > snap.slot) continue;
      const changed = !cur || cur.view.revision !== c.revision || cur.view.consent !== c.consent || cur.view.instance !== c.instance;
      this.consents.set(c.badgeId, { view: c, slot: snap.slot });
      this.notBefore.delete(c.badgeId);
      this.backoff.delete(c.badgeId);
      if (changed && cur) this.note("poll", `${c.badgeId} → ${c.consent ? "opt_in" : "opt_out"} (rev ${c.revision})`, c.badgeId);
    }
    for (const [id, s] of this.consents) if (!seen.has(id) && s.slot <= snap.slot) this.consents.delete(id);

    const seenO = new Set<string>();
    for (const o of snap.overrides) {
      const key = o.badgeId + "|" + o.eventId;
      seenO.add(key);
      if ((this.tombstones.get(key) ?? -1) >= snap.slot) continue;
      const cur = this.overrides.get(key);
      if (cur && cur.slot > snap.slot) continue;
      this.overrides.set(key, { view: o, slot: snap.slot });
    }
    for (const [key, s] of this.overrides) if (!seenO.has(key) && s.slot <= snap.slot) this.overrides.delete(key);
    const seenC = new Set<string>();
    for (const c of snap.captures) { seenC.add(c.address); this.mergeCapture(c, snap.slot); }
    for (const [addr, s] of this.notices) if (!seenC.has(addr) && s.slot <= snap.slot) this.notices.delete(addr);
    // tombstones older than this snapshot have done their job
    for (const [key, slot] of this.tombstones) if (slot < snap.slot) this.tombstones.delete(key);
  }

  /** Apply a confirmed transaction's events (push path). */
  applyLogs(n: LogNotification): void {
    if (n.err) return; // failed tx: no state change
    this.status.pushes++;
    this.status.lastPushAt = this.now();
    this.status.freshAt = this.status.lastPushAt;
    for (const e of n.events) {
      switch (e.name) {
        case "ConsentChanged": {
          const cur = this.consents.get(e.badgeId);
          if (cur && cur.slot > n.slot) break;
          const view: ConsentView = {
            badgeId: e.badgeId,
            badgeIdNum: parseInt(e.badgeId, 16),
            owner: e.owner,
            consent: e.consent,
            revision: e.revision,
            instance: e.instance,
            createdAt: cur && cur.view.instance === e.instance ? cur.view.createdAt : e.at,
            updatedAt: e.at,
            address: cur?.view.address ?? "",
          };
          this.consents.set(e.badgeId, { view, slot: n.slot });
          this.tombstones.delete(e.badgeId);
          this.notBefore.delete(e.badgeId);
          this.backoff.delete(e.badgeId);
          this.note("push", `${e.badgeId} → ${e.consent ? "opt_in" : "opt_out"} (rev ${e.revision}${e.delegated ? ", badge-signed" : ""})`, e.badgeId, n.signature);
          break;
        }
        case "ConsentClosed":
          this.consents.delete(e.badgeId);
          this.tombstones.set(e.badgeId, n.slot);
          this.note("push", `${e.badgeId} record closed ⇒ unknown ⇒ blur`, e.badgeId, n.signature);
          break;
        case "EventOverrideChanged": {
          const key = e.badgeId + "|" + e.eventId;
          if (e.consent === null) {
            this.overrides.delete(key);
            this.tombstones.set(key, n.slot);
          } else {
            const cur = this.overrides.get(key);
            if (cur && cur.slot > n.slot) break;
            this.overrides.set(key, {
              view: { badgeId: e.badgeId, owner: e.owner, eventId: e.eventId, consent: e.consent, updatedAt: e.at, address: cur?.view.address ?? "" },
              slot: n.slot,
            });
            this.tombstones.delete(key);
          }
          this.note("push", `${e.badgeId} @ ${e.eventId} → ${e.consent === null ? "override cleared" : e.consent ? "opt_in" : "opt_out"}`, e.badgeId, n.signature);
          break;
        }
        case "CaptureAttested":
          this.note("push", `camera commitment #${e.count} anchored (head ${e.head.slice(0, 8)}…)`, undefined, n.signature);
          break;
        case "CaptureRecorded": {
          let address = "";
          try { address = capturePda(new PublicKey(e.camera), fromHex(e.eventHash), this.client.programId)[0].toBase58(); } catch { break; }
          const cur = this.notices.get(address);
          if (cur && cur.slot > n.slot) break;
          this.notices.set(address, {
            view: { badgeId: e.badgeId, badgeIdNum: parseInt(e.badgeId, 16), camera: e.camera, eventHash: e.eventHash, filmedAt: e.filmedAt, recordedAt: e.recordedAt, notifiedAt: cur?.view.notifiedAt ?? 0, channels: cur?.view.channels ?? 0, address },
            slot: n.slot,
          });
          this.remember(address);
          this.note("push", `${e.badgeId} filmed at ${new Date(e.filmedAt * 1000).toLocaleTimeString()} — notice filed on-chain`, e.badgeId, n.signature);
          break;
        }
        case "NoticeRecorded": {
          let address = "";
          try { address = capturePda(new PublicKey(e.camera), fromHex(e.eventHash), this.client.programId)[0].toBase58(); } catch { break; }
          const cur = this.notices.get(address);
          if (cur && cur.slot > n.slot) break;
          this.notices.set(address, {
            view: { badgeId: e.badgeId, badgeIdNum: parseInt(e.badgeId, 16), camera: e.camera, eventHash: e.eventHash, filmedAt: cur?.view.filmedAt ?? 0, recordedAt: cur?.view.recordedAt ?? 0, notifiedAt: e.notifiedAt, channels: e.channels, address },
            slot: n.slot,
          });
          this.remember(address);
          this.note("push", `${e.badgeId} notified (${channelNames(e.channels).join(", ")}) at ${new Date(e.notifiedAt * 1000).toLocaleTimeString()} — on-chain`, e.badgeId, n.signature);
          break;
        }
      }
    }
    this.emit();
  }

  /** On-demand read of a beacon the cache has never seen. Slot-ordered like every other path. */
  private fetchOne(id: string): void {
    const now = this.now();
    if (this.inFlight.has(id) || (this.notBefore.get(id) ?? 0) > now) return;
    if (this.tombstones.has(id)) return; // closed; the poll/push will show any re-registration
    this.inFlight.add(id);
    this.client
      .fetchConsentWithSlot(id)
      .then(({ view, slot }) => {
        if (view) {
          const cur = this.consents.get(id);
          const dead = (this.tombstones.get(id) ?? -1) >= slot;
          if (!dead && (!cur || cur.slot < slot)) this.consents.set(id, { view, slot });
          this.remember(view.address);
          this.backoff.delete(id);
          this.note("poll", `${id} resolved on-chain → ${view.consent ? "opt_in" : "opt_out"}`, id);
        } else {
          this.notBefore.set(id, this.now() + NEGATIVE_TTL_MS);
          this.note("info", `${id} has no on-chain record ⇒ blur (fail-safe)`, id);
          this.opts.onUnknown?.(id); // e.g. ask the organizer service to enrol it
        }
        this.emit();
      })
      .catch((e) => {
        // back off per id so a dead RPC is retried on a schedule, not per frame
        const b = Math.min((this.backoff.get(id) ?? ERROR_BACKOFF_START_MS / 2) * 2, ERROR_BACKOFF_MAX_MS);
        this.backoff.set(id, b);
        this.notBefore.set(id, this.now() + b);
        this.status.lastError = (e as Error).message;
      })
      .finally(() => this.inFlight.delete(id));
  }

  /** Record a transaction the operator UI sent (so it shows in the feed immediately). */
  note(kind: Activity["kind"], text: string, badgeId?: string, signature?: string): void {
    this.activity.unshift({
      id: String(++this.seq),
      at: this.now(),
      kind,
      text,
      badgeId,
      signature,
      url: signature ? explorerUrl("tx", signature, this.status.cluster) : undefined,
    });
    this.activity = this.activity.slice(0, 12);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}
