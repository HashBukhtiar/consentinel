// The camera as the badge's radio bridge.
//
// The badge's A button cannot reach the chain on its own (no Wi-Fi, no key),
// and the BLE bridge is hardware we may not have. But the badge already talks
// to the camera through light, so the button's state rides on bit 7 of the
// beacon. When that flag disagrees with the on-chain record we send the very
// same `CNSR<id><0|1>` frame the BLE bridge would (service/BADGE_PROTOCOL.md
// §1): the service signs it with the badge's key, the program verifies the
// signature on-chain, the cache gets the push, the blur follows.
//
// Trust model is identical to the BLE request: unsigned, so it can only ask;
// the chain still decides. Debounced so a button bounce or a mis-decode is
// not a transaction: the flag must be stable for REQUEST_STABLE_MS and we
// send at most one request per badge per REQUEST_MIN_INTERVAL_MS.
import { flags } from "../config/flags";
import { chain } from "../consent/store";
import type { Consent } from "../shared/schema";

interface Seen { want: boolean; since: number; lastSent: number; inFlight: boolean; last?: string }

export class ConsentRequester {
  private byId = new Map<string, Seen>();

  observe(id: string, want: boolean, chainState: Consent, now = Date.now()): void {
    if (!flags.OPTICAL_REQUESTS || !flags.SERVICE_WS_URL) return;
    let s = this.byId.get(id);
    if (!s || s.want !== want) {
      s = { want, since: now, lastSent: s?.lastSent ?? 0, inFlight: false, last: s?.last };
      this.byId.set(id, s);
    }
    if (chainState === "unknown") return; // no record yet: auto-enrolment first, then this fires
    if ((chainState === "opt_in") === want) return; // light and chain agree
    if (now - s.since < flags.REQUEST_STABLE_MS) return;
    if (s.inFlight || now - s.lastSent < flags.REQUEST_MIN_INTERVAL_MS) return;
    s.inFlight = true;
    s.lastSent = now;
    const me = s;
    void this.send(id, want).then((r) => { me.last = r; }).finally(() => { me.inFlight = false; });
  }

  /** For the operator panel. */
  status(id: string): { want: boolean; sentAgoMs: number | null; inFlight: boolean; last?: string } | null {
    const s = this.byId.get(id);
    return s ? { want: s.want, sentAgoMs: s.lastSent ? Date.now() - s.lastSent : null, inFlight: s.inFlight, last: s.last } : null;
  }

  private async send(id: string, want: boolean): Promise<string> {
    const frame = `CNSR${id}${want ? 1 : 0}`;
    let base: string;
    try { base = new URL(flags.SERVICE_WS_URL.replace(/^ws/, "http")).origin; } catch { return "bad service url"; }
    try {
      const r = await fetch(`${base}/bridge/uplink`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(flags.SERVICE_TOKEN ? { authorization: `Bearer ${flags.SERVICE_TOKEN}` } : {}) },
        body: JSON.stringify({ frame, via: "optical" }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (j.result === "relayed") {
        chain?.note("tx", `${id}: badge says ${want ? "OPT-IN" : "OPT-OUT"} (read off the light) → badge-signed update relayed, rev ${j.revision}`, id, j.signature);
        void chain?.syncNow();
        return `relayed rev ${j.revision}`;
      }
      if (j.result === "noop") return "already on-chain";
      const why = j.error ?? j.note ?? `HTTP ${r.status}`;
      chain?.note("error", `${id}: optical request ${frame} not relayed — ${why}`, id);
      return String(why);
    } catch {
      return "service offline";
    }
  }
}

export const consentRequester = new ConsentRequester();
