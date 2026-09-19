// The local consent cache synced from Solana (§8). The render loop reads
// `get()` — a synchronous Map lookup — and nothing else. Two sync paths keep
// it fresh: a websocket subscription to the program's logs (push, ~1s) and a
// polling backstop every CONSENT_CACHE_SYNC_MS (getProgramAccounts). Both are
// slot-ordered so a late poll can't overwrite a newer push. Unknown beacons
// are fetched on demand and are "unknown" (⇒ blur) until resolved.
import { Connection } from "@solana/web3.js";
import {
  ConsentRegistryClient,
  type ConsentView,
  type LogNotification,
  type OverrideView,
  type RegistrySnapshot,
} from "../../../registry/client/src/registry";
import { explorerUrl, normalizeBadgeId, type Cluster } from "../../../registry/client/src/core";
import { flags } from "../config/flags";
import type { GetConsent } from "../shared/schema";

export interface ChainStatus {
  cluster: Cluster;
  rpc: string;
  programId: string;
  programUrl: string;
  subscribed: boolean;
  lastPushAt: number;
  syncing: boolean;
  lastSyncAt: number;
  lastSyncSlot: number;
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

export class ChainConsentCache {
  readonly client: ConsentRegistryClient;
  readonly connection: Connection;
  status: ChainStatus;
  activity: Activity[] = [];

  private consents = new Map<string, Stamped<ConsentView>>();
  private overrides = new Map<string, Stamped<OverrideView>>();
  private tombstones = new Map<string, number>(); // key → slot at which it was closed
  private normCache = new Map<string, string | null>();
  private inFlight = new Set<string>();
  private negative = new Map<string, number>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private seq = 0;

  constructor(
    rpcUrl: string = flags.SOLANA_RPC_URL,
    private opts: { autoFetch?: boolean; cluster?: Cluster } = {},
  ) {
    this.connection = new Connection(rpcUrl, { commitment: "confirmed" });
    this.client = new ConsentRegistryClient(this.connection);
    const cluster = opts.cluster ?? flags.SOLANA_CLUSTER;
    this.status = {
      cluster,
      rpc: rpcUrl,
      programId: this.client.programId.toBase58(),
      programUrl: explorerUrl("address", this.client.programId.toBase58(), cluster),
      subscribed: false,
      lastPushAt: 0,
      syncing: false,
      lastSyncAt: 0,
      lastSyncSlot: 0,
      lastError: "",
      polls: 0,
      pushes: 0,
    };
  }

  // ---- the hot-path read ----------------------------------------------------

  /** Synchronous. Called per track per frame. Never touches the network. */
  get: GetConsent = (beaconId) => {
    let id = this.normCache.get(beaconId);
    if (id === undefined) {
      try { id = normalizeBadgeId(beaconId); } catch { id = null; }
      this.normCache.set(beaconId, id);
    }
    if (!id) return "unknown";
    const rec = this.consents.get(id);
    if (!rec) {
      if (this.opts.autoFetch !== false) this.fetchOne(id);
      return "unknown"; // fail-safe: no record ⇒ blur
    }
    const o = this.overrides.get(id + "|" + flags.EVENT_ID);
    return (o ? o.view.consent : rec.view.consent) ? "opt_in" : "opt_out";
  };

  // ---- lifecycle -------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    void this.syncNow();
    this.timer = setInterval(() => void this.syncNow(), flags.CONSENT_CACHE_SYNC_MS);
    this.unsubscribe = this.client.onLogs((n) => this.applyLogs(n));
    this.status.subscribed = true;
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

  overridesFor(badgeId: string): OverrideView[] {
    return [...this.overrides.values()].map((s) => s.view).filter((o) => o.badgeId === badgeId);
  }

  // ---- sync paths --------------------------------------------------------------

  async syncNow(): Promise<void> {
    if (this.status.syncing) return;
    this.status.syncing = true;
    try {
      const snap = await this.client.fetchAll();
      this.applySnapshot(snap);
      this.status.lastSyncAt = Date.now();
      this.status.lastSyncSlot = snap.slot;
      this.status.lastError = "";
      this.status.polls++;
    } catch (e) {
      this.status.lastError = (e as Error).message;
      this.note("error", `sync failed: ${this.status.lastError}`);
    } finally {
      this.status.syncing = false;
      this.emit();
    }
  }

  /** Apply a full poll snapshot. Records/tombstones newer than the snapshot's slot win. */
  applySnapshot(snap: RegistrySnapshot): void {
    const seen = new Set<string>();
    for (const c of snap.consents) {
      seen.add(c.badgeId);
      if ((this.tombstones.get(c.badgeId) ?? -1) >= snap.slot) continue;
      const cur = this.consents.get(c.badgeId);
      if (cur && cur.slot > snap.slot) continue;
      const changed = !cur || cur.view.revision !== c.revision || cur.view.consent !== c.consent;
      this.consents.set(c.badgeId, { view: c, slot: snap.slot });
      this.negative.delete(c.badgeId);
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
  }

  /** Apply a confirmed transaction's events (push path). */
  applyLogs(n: LogNotification): void {
    if (n.err) return; // failed tx: no state change
    this.status.pushes++;
    this.status.lastPushAt = Date.now();
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
            createdAt: cur?.view.createdAt ?? e.at,
            updatedAt: e.at,
            address: cur?.view.address ?? "",
          };
          this.consents.set(e.badgeId, { view, slot: n.slot });
          this.tombstones.delete(e.badgeId);
          this.negative.delete(e.badgeId);
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
            this.overrides.set(key, {
              view: { badgeId: e.badgeId, eventId: e.eventId, consent: e.consent, updatedAt: e.at, address: cur?.view.address ?? "" },
              slot: n.slot,
            });
            this.tombstones.delete(key);
          }
          this.note("push", `${e.badgeId} @ ${e.eventId} → ${e.consent === null ? "override cleared" : e.consent ? "opt_in" : "opt_out"}`, e.badgeId, n.signature);
          break;
        }
        case "CaptureAttested":
          this.note("push", `capture #${e.count} anchored on-chain (head ${e.head.slice(0, 8)}…)`, undefined, n.signature);
          break;
      }
    }
    this.emit();
  }

  private fetchOne(id: string): void {
    const now = Date.now();
    if (this.inFlight.has(id) || (this.negative.get(id) ?? 0) > now) return;
    this.inFlight.add(id);
    this.client
      .fetchConsent(id)
      .then((v) => {
        if (v) {
          if (!this.consents.has(id)) this.consents.set(id, { view: v, slot: 0 });
          this.note("poll", `${id} resolved on-chain → ${v.consent ? "opt_in" : "opt_out"}`, id);
        } else {
          this.negative.set(id, Date.now() + NEGATIVE_TTL_MS);
          this.note("info", `${id} has no on-chain record ⇒ blur (fail-safe)`, id);
        }
        this.emit();
      })
      .catch((e) => { this.status.lastError = (e as Error).message; })
      .finally(() => this.inFlight.delete(id));
  }

  /** Record a transaction the operator UI sent (so it shows in the feed immediately). */
  note(kind: Activity["kind"], text: string, badgeId?: string, signature?: string): void {
    this.activity.unshift({
      id: String(++this.seq),
      at: Date.now(),
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
