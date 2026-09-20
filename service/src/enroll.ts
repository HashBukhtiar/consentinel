// Auto-enrolment: "every badge in frame just works".
//
// The camera decodes any badge's id with no setup, but consent is a record the
// person owns on-chain, and the light carries no consent bit (a spoofed light
// must never be able to un-blur anyone). So when the capture app sees an id
// that has no record, it tells us, and the organizer (the registry issuer)
// registers it as opt_out — the same thing the desk would do when handing the
// badge out. opt_out cannot un-blur anyone, so an attacker triggering this on
// purpose gains nothing except paying our rent; AUTO_REGISTER_MAX caps that.
//
// Demo honesty: the badge's key is generated here and kept in BADGE_KEYS_DIR
// (and mirrored into the operator panel's demo key file) because the firmware
// cannot hold a key yet. In the product the badge generates it and the desk
// binds the public key.
import { Keypair } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keypairSigner } from "../../registry/client/src/registry";
import { explorerUrl, normalizeBadgeId } from "../../registry/client/src/core";
import { config } from "./config";
import { HttpError, loadKeypair, type Chain } from "./chain";

export interface EnrolResult {
  badgeId: string;
  registered: boolean;
  created: boolean;
  consent: boolean | null;
  owner: string | null;
  signature?: string;
  explorer?: string;
  note?: string;
}

export class Enroller {
  private locks = new Map<string, Promise<EnrolResult>>();
  private created: string[] = [];

  constructor(
    private chain: Chain,
    private broadcast: (m: unknown) => void,
    private log: (m: string) => void = () => {},
  ) {}

  get enabled(): boolean {
    return config.AUTO_REGISTER && existsSync(config.ISSUER_KEYPAIR);
  }

  status() {
    return { enabled: this.enabled, issuerKeypair: config.ISSUER_KEYPAIR, createdThisRun: this.created.slice(), max: config.AUTO_REGISTER_MAX };
  }

  /** The capture app saw `badgeId` and found no record. Register it (once) as opt_out. */
  seen(rawId: string): Promise<EnrolResult> {
    let id: string;
    try { id = normalizeBadgeId(rawId); } catch { throw new HttpError(400, "badgeId must be 1..4 hex characters"); }
    const prev = this.locks.get(id);
    if (prev) return prev;
    const run = this.enrol(id).finally(() => { if (this.locks.get(id) === run) this.locks.delete(id); });
    this.locks.set(id, run);
    return run;
  }

  private async enrol(id: string): Promise<EnrolResult> {
    const existing = await this.chain.reg.fetchConsent(id);
    if (existing) return { badgeId: id, registered: true, created: false, consent: existing.consent, owner: existing.owner };
    if (!config.AUTO_REGISTER) return { badgeId: id, registered: false, created: false, consent: null, owner: null, note: "AUTO_REGISTER is off — add the badge to data/demo/seed-consents.json and run `npm run seed`" };
    const issuer = loadKeypair(config.ISSUER_KEYPAIR);
    if (!issuer) throw new HttpError(503, `issuer keypair missing (${config.ISSUER_KEYPAIR}) — cannot auto-register`);
    if (this.created.length >= config.AUTO_REGISTER_MAX) throw new HttpError(429, `auto-registration cap (${config.AUTO_REGISTER_MAX}) reached for this run`);
    const registry = await this.chain.reg.fetchRegistry();
    if (!registry) throw new HttpError(503, "registry not initialized — run `npm run seed` in registry/");
    if (registry.issuer !== issuer.publicKey.toBase58()) throw new HttpError(503, `this laptop's key ${issuer.publicKey.toBase58()} is not the registry issuer (${registry.issuer}); only the issuer can register badges`);

    const keyPath = join(config.BADGE_KEYS_DIR, `badge-${id}.json`);
    let badge = loadKeypair(keyPath);
    if (!badge) {
      badge = Keypair.generate();
      mkdirSync(dirname(keyPath), { recursive: true });
      writeFileSync(keyPath, JSON.stringify(Array.from(badge.secretKey)));
    }
    const signature = await this.chain.reg.register(keypairSigner(issuer), id, badge.publicKey, false);
    this.created.push(id);
    this.mirrorDemoKey(id, badge);
    const explorer = explorerUrl("tx", signature, config.SOLANA_CLUSTER);
    this.log(`auto-registered ${id} as opt_out (owner ${badge.publicKey.toBase58()}) ${explorer}`);
    this.broadcast({ type: "registered", badgeId: id, owner: badge.publicKey.toBase58(), consent: false, signature, explorer, at: Date.now() });
    return { badgeId: id, registered: true, created: true, consent: false, owner: badge.publicKey.toBase58(), signature, explorer };
  }

  /** Add the new badge key to the operator panel's demo key file (same shape as `npm run seed` writes). */
  private mirrorDemoKey(id: string, badge: Keypair): void {
    try {
      const f = config.DEMO_KEYS_FILE;
      const j = existsSync(f)
        ? JSON.parse(readFileSync(f, "utf8"))
        : { _warning: "DEVNET DEMO KEYS — never commit. In the product these keys live on the badges.", cluster: config.SOLANA_CLUSTER, badges: [] };
      j.badges = (j.badges ?? []).filter((b: any) => b.badgeId !== id);
      j.badges.push({ badgeId: id, label: "auto-registered on first sight — opted OUT (blurred)", owner: badge.publicKey.toBase58(), secretKey: Array.from(badge.secretKey) });
      if (!j.relayer && this.chain.relayer) j.relayer = { pubkey: this.chain.relayer.publicKey.toBase58(), secretKey: Array.from(this.chain.relayer.secretKey) };
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(j, null, 2));
    } catch (e) {
      this.log(`could not update ${config.DEMO_KEYS_FILE}: ${(e as Error).message}`);
    }
  }
}
