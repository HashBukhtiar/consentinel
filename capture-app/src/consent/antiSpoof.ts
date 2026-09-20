// Anti-forgery gate: BeaconReading[] → the subset we are willing to believe.
//
// THE ATTACK. The optical payload is a static, public, 8-bit id with a CRC —
// no secret, no signature, because 12 bits cannot hold either. So anyone can
// render a valid patch: white border, three hex digits, phone screen. They do
// not even need to read a real badge — there are only 256 ids, so cycling all
// of them at camera rate hits every opt_in badge at the event in ~9 seconds.
// Held under someone's chin, associate() binds it to that face and the chain
// says opt_in. The victim is un-blurred by a stranger holding a phone.
//
// WHAT THIS CAN AND CANNOT DO. It cannot make the beacon unforgeable; that
// needs a rolling code or a second channel (see DECISIONS.md). What it does is
// take away the property the attack depends on — that a guess is CHEAP and
// INVISIBLE. Three rules, all of which a real badge satisfies for free and a
// forger has to work around:
//
//   1. STABILITY  a real badge shows one id continuously for minutes; a
//      guesser must cycle. An id is believed only after SPOOF_STABLE_MS of
//      uninterrupted sighting at one place.
//   2. CHURN      a place that has shown more than SPOOF_MAX_IDS distinct ids
//      inside SPOOF_CHURN_MS is a screen being flipped, not a badge. Ignore
//      everything from it for SPOOF_QUARANTINE_MS.
//   3. CLONES     the same id in two places at once, and no way to tell the
//      clone from the original — so BOTH lose. That removes the point of
//      copying a number off someone's chest.
//
// Together these turn a 9-second sweep into ~8 minutes of a person visibly
// waving a flickering phone under someone's chin. That conspicuousness is the
// actual defence. An attacker who already knows one valid opt_in id and
// displays it steadily still wins — only presence on a second channel closes
// that, and this file is not it.
//
// Every rule fails toward BLUR: a false positive costs latency or an extra
// blur, never an exposure.
import type { BeaconReading } from "../shared/schema";
import { flags } from "../config/flags";

// One place in the image that has been emitting beacon readings. Sites follow
// a moving badge frame to frame; they are not tied to a face or a track.
interface Site {
  x: number;
  y: number;
  id: string; // id currently showing here
  since: number; // when `id` started showing here, uninterrupted
  changes: { id: string; t: number }[]; // id switches inside the churn window
  quarantineUntil: number;
  lastSeen: number;
}

// Funnel counters for the tuning page, same idea as decoderStats. Nothing in
// the hero path reads them.
export const spoofStats = {
  in: 0, // readings offered by the decoder
  out: 0, // readings we were willing to believe
  unstable: 0, // dropped: id has not held long enough at this site
  churned: 0, // dropped: site is quarantined for flipping through ids
  cloned: 0, // dropped: same id seen in two places at once
  sites: 0, // live sites
  reset() { this.in = this.out = this.unstable = this.churned = this.cloned = this.sites = 0; },
};

const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);

export class SpoofGuard {
  private sites: Site[] = [];
  private blockedIds = new Map<string, number>(); // id → blocked until

  /** The readings we are willing to hand to associate(). Call once per frame. */
  filter(readings: readonly BeaconReading[], tMs: number): BeaconReading[] {
    spoofStats.in += readings.length;
    this.vetoClones(readings, tMs);

    const claimed = new Set<Site>();
    const out: BeaconReading[] = [];
    for (const r of readings) {
      const site = this.claim(r, tMs, claimed);
      this.observe(site, r, tMs);

      if (tMs < (this.blockedIds.get(r.beaconId) ?? 0)) { spoofStats.cloned++; continue; }
      if (tMs < site.quarantineUntil) { spoofStats.churned++; continue; }
      if (tMs - site.since < flags.SPOOF_STABLE_MS) { spoofStats.unstable++; continue; }
      out.push(r);
    }

    this.sites = this.sites.filter((s) => tMs - s.lastSeen <= flags.SPOOF_SITE_TTL_MS);
    for (const [id, until] of this.blockedIds) if (tMs >= until) this.blockedIds.delete(id);
    spoofStats.sites = this.sites.length;
    spoofStats.out += out.length;
    return out;
  }

  // Rule 3. Two readings of one id further apart than a site radius are two
  // patches, i.e. a clone. The block outlives the frame so a clone that
  // flickers on alternate frames cannot slip through the gap.
  //
  // The distance test is what keeps this from firing on the decoder's own
  // double-tracking: a re-acquired patch briefly yields two readings of the
  // same id at nearly the same spot, and that is not a clone.
  private vetoClones(readings: readonly BeaconReading[], tMs: number): void {
    const byId = new Map<string, BeaconReading[]>();
    for (const r of readings) {
      const g = byId.get(r.beaconId);
      if (g) g.push(r); else byId.set(r.beaconId, [r]);
    }
    for (const [id, group] of byId) {
      if (group.length < 2) continue;
      let apart = false;
      for (let i = 0; i < group.length && !apart; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i].imagePosition, b = group[j].imagePosition;
          if (dist(a.x, a.y, b.x, b.y) > flags.SPOOF_SITE_RADIUS) { apart = true; break; }
        }
      }
      if (apart) this.blockedIds.set(id, tMs + flags.SPOOF_CLONE_HOLD_MS);
    }
  }

  // Nearest unclaimed site within the radius, preferring one already showing
  // this id — so a forged patch appearing next to a real badge starts its own
  // site, and its own stability clock, instead of inheriting the badge's.
  private claim(r: BeaconReading, tMs: number, claimed: Set<Site>): Site {
    const { x, y } = r.imagePosition;
    let best: Site | null = null;
    let bestD = Infinity;
    for (const sameIdOnly of [true, false]) {
      for (const s of this.sites) {
        if (claimed.has(s) || (sameIdOnly && s.id !== r.beaconId)) continue;
        const d = dist(s.x, s.y, x, y);
        if (d <= flags.SPOOF_SITE_RADIUS && d < bestD) { best = s; bestD = d; }
      }
      if (best) break;
    }
    if (!best) {
      best = { x, y, id: r.beaconId, since: tMs, changes: [{ id: r.beaconId, t: tMs }], quarantineUntil: 0, lastSeen: tMs };
      this.sites.push(best);
    }
    claimed.add(best);
    return best;
  }

  // Rules 1 and 2. A GAP in sighting does not reset the stability clock — the
  // decoder drops readings constantly under motion blur, and restarting on
  // every gap would mean a real badge never becomes believable. Only an actual
  // id CHANGE restarts it.
  private observe(site: Site, r: BeaconReading, tMs: number): void {
    if (site.id !== r.beaconId) {
      site.id = r.beaconId;
      site.since = tMs;
      site.changes.push({ id: r.beaconId, t: tMs });
    }
    site.changes = site.changes.filter((c) => tMs - c.t < flags.SPOOF_CHURN_MS);
    if (new Set(site.changes.map((c) => c.id)).size > flags.SPOOF_MAX_IDS) {
      site.quarantineUntil = tMs + flags.SPOOF_QUARANTINE_MS;
    }
    site.x = r.imagePosition.x;
    site.y = r.imagePosition.y;
    site.lastSeen = tMs;
  }
}

const guard = new SpoofGuard();

/** Shared instance for the hot loop. */
export const guardBeacons = (readings: readonly BeaconReading[], tMs: number): BeaconReading[] =>
  flags.SPOOF_GUARD ? guard.filter(readings, tMs) : [...readings];

/** A guard with its own state — for tests, which must not leak into each other. */
export const createGuard = (): SpoofGuard => new SpoofGuard();
