// One import for "where does consent come from". The loop reads `getConsent`
// (synchronous); the UI reads `chain` for status/activity and to sign updates.
import { flags } from "../config/flags";
import { consentStore } from "../stubs/consentStore";
import { ChainConsentCache } from "./chainCache";
import type { GetConsent } from "../shared/schema";

// A decoded badge with no on-chain record: ask the organizer service to
// register it as opt_out (it can never un-blur anyone). Once per id per minute;
// the cache's next poll picks the new record up and a card appears.
const asked = new Map<string, number>();
function askToEnrol(id: string): void {
  if (!flags.AUTO_REGISTER_UNKNOWN || !flags.SERVICE_WS_URL) return;
  const now = Date.now();
  if (now - (asked.get(id) ?? 0) < 60_000) return;
  asked.set(id, now);
  let base: string;
  try { base = new URL(flags.SERVICE_WS_URL.replace(/^ws/, "http")).origin; } catch { return; }
  fetch(`${base}/badge/${id}/seen`, { method: "POST", headers: flags.SERVICE_TOKEN ? { authorization: `Bearer ${flags.SERVICE_TOKEN}` } : {} })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { chain?.note("error", `${id}: organizer service could not enrol it — ${j.error ?? r.status}`, id); return; }
      if (j.created) {
        chain?.note("tx", `${id} seen for the first time → auto-registered as opt_out by the organizer`, id, j.signature);
        void chain?.syncNow();
      } else if (!j.registered) chain?.note("info", `${id}: ${j.note ?? "not registered"}`, id);
    })
    .catch(() => { /* service offline: stays unknown ⇒ blur */ });
}

export const chain: ChainConsentCache | null = flags.CONSENT_SOURCE === "chain" ? new ChainConsentCache(undefined, { onUnknown: askToEnrol }) : null;

export const getConsent: GetConsent = chain ? chain.get : consentStore.get;

export function startConsent(): void {
  chain?.start();
}
