// One import for "where does consent come from". The loop reads `getConsent`
// (synchronous); the UI reads `chain` for status/activity and to sign updates.
import { flags } from "../config/flags";
import { consentStore } from "../stubs/consentStore";
import { ChainConsentCache } from "./chainCache";
import type { GetConsent } from "../shared/schema";

export const chain: ChainConsentCache | null = flags.CONSENT_SOURCE === "chain" ? new ChainConsentCache() : null;

export const getConsent: GetConsent = chain ? chain.get : consentStore.get;

export function startConsent(): void {
  chain?.start();
}
