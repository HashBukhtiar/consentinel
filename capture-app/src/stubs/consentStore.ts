import type { Consent, ConsentState, GetConsent } from "../shared/schema";

// THROWAWAY stub for C's consent cache. Same read shape as the real cache
// (synchronous getConsent), plus toggles so the operator panel can drive the
// demo without the chain. C replaces `get` with a read of the Solana-synced
// cache; toggling then happens on-chain (owner-signed) and the live
// revoke→blur-flip beat works identically.
type Listener = () => void;

class ConsentStore {
  private map = new Map<string, ConsentState>([
    ["4E", "opt_out"], // Maaz's real demo badge → blurred
    ["A1", "opt_out"], // second badge (synthetic/stub) → blurred
    ["C3", "opt_in"], //  consenting badge → clear
  ]);
  private listeners = new Set<Listener>();

  get: GetConsent = (id) => (this.map.get(id) as Consent) ?? "unknown";
  set(id: string, c: ConsentState) { this.map.set(id, c); this.emit(); }
  toggle(id: string) { this.set(id, this.get(id) === "opt_in" ? "opt_out" : "opt_in"); }
  all(): [string, ConsentState][] { return [...this.map.entries()]; }

  subscribe(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private emit() { this.listeners.forEach((l) => l()); }
}

export const consentStore = new ConsentStore();
