import type { Consent, ConsentState, GetConsent } from "../shared/schema";
import { normalizeBadgeId } from "../../../registry/client/src/core";

// THROWAWAY stub for C's consent cache. Same read shape as the real cache
// (synchronous getConsent), plus toggles so the operator panel can drive the
// demo without the chain. C replaces `get` with a read of the Solana-synced
// cache; toggling then happens on-chain (owner-signed) and the live
// revoke→blur-flip beat works identically.
type Listener = () => void;

class ConsentStore {
  private map = new Map<string, ConsentState>([
    ["A1B2", "opt_out"], // left person: not consenting → blurred
    ["C3D4", "opt_in"], //  right person: consenting → clear
  ]);
  private listeners = new Set<Listener>();

  private key(id: string): string | null { try { return normalizeBadgeId(id); } catch { return null; } }
  get: GetConsent = (id) => { const k = this.key(id); return k ? ((this.map.get(k) as Consent) ?? "unknown") : "unknown"; };
  set(id: string, c: ConsentState) { const k = this.key(id); if (k) { this.map.set(k, c); this.emit(); } }
  toggle(id: string) { this.set(id, this.get(id) === "opt_in" ? "opt_out" : "opt_in"); }
  all(): [string, ConsentState][] { return [...this.map.entries()]; }

  subscribe(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private emit() { this.listeners.forEach((l) => l()); }
}

export const consentStore = new ConsentStore();
