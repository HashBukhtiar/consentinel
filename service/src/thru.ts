// Thru (Unto Labs) evidence ledger.
//
// Solana holds *authorization* (who consents — rare, owner-signed, revocable).
// Thru holds *evidence* (what the camera did — frequent, append-only): every
// film-event and every attestation batch is committed the moment it happens,
// each as its own account on Alphanet, addressed by a seed and readable by
// anyone on scan.thru.org. Nothing visual is ever stored — the same fields the
// Solana attestation already carries (ids, hashes, timestamps).
//
// ponytail: drives the installed `thru` CLI (`uploader upload`) instead of the
// @thru/sdk uploader flow — the CLI is verified working today; swap to the SDK
// when there's time. Commits are serialized (the CLI manages the nonce).
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config";

export type ThruKind = "film-event" | "attest";
export interface ThruCommit { kind: ThruKind; seed: string; account: string; meta: string; explorer: string; ms: number }

function thru(args: string[]): Promise<string> {
  return new Promise((res, rej) =>
    execFile("thru", ["--quiet", ...args], { timeout: 90_000 }, (err, stdout, stderr) =>
      err ? rej(new Error((stderr || stdout || err.message).trim().slice(0, 300))) : res(stdout)));
}

export class ThruLedger {
  enabled = config.THRU_ENABLED;
  commits = 0;
  lastError = "";
  private q: Promise<unknown> = Promise.resolve();
  private readonly dir = mkdtempSync(join(tmpdir(), "cns-thru-"));
  private readonly salt = Math.random().toString(16).slice(2, 6); // seeds unique across restarts

  constructor(private readonly log: (m: string) => void) {}

  /** Disable cleanly if the CLI is missing or the fee payer isn't funded — never let Thru break the hero path. */
  async probe(): Promise<void> {
    if (!this.enabled) return;
    try {
      const out = await thru(["getbalance", config.THRU_FEE_PAYER]);
      const bal = /Balance:\s*([\d_]+)/.exec(out)?.[1]?.replace(/_/g, "");
      if (!bal || Number(bal) < 10) throw new Error(`fee payer '${config.THRU_FEE_PAYER}' has no funds (run: thru faucet withdraw ${config.THRU_FEE_PAYER} 5000 --fee-payer ${config.THRU_FEE_PAYER})`);
      this.log(`thru      alphanet · fee payer ${config.THRU_FEE_PAYER} · balance ${bal}`);
    } catch (e) {
      this.enabled = false;
      this.lastError = (e as Error).message;
      this.log(`thru      disabled — ${this.lastError}`);
    }
  }

  /** Queue one commit. Resolves to null (and logs) on failure; never throws. */
  commit(kind: ThruKind, key: string, payload: Record<string, unknown>): Promise<ThruCommit | null> {
    if (!this.enabled) return Promise.resolve(null);
    const p = this.q
      .then(() => this.upload(kind, key, payload))
      .catch((e) => { this.lastError = (e as Error).message; this.log(`thru      commit failed: ${this.lastError}`); return null; });
    this.q = p;
    return p;
  }

  private async upload(kind: ThruKind, key: string, payload: Record<string, unknown>): Promise<ThruCommit> {
    const seed = `cns-${this.salt}-${key}`;
    const file = join(this.dir, `${seed}.json`);
    writeFileSync(file, JSON.stringify({ v: 1, kind, camera: config.CAMERA_ID, ...payload }));
    const t0 = Date.now();
    const out = await thru(["uploader", "upload", seed, file, "--fee-payer", config.THRU_FEE_PAYER, "--skip-elf-check", "--json"]);
    const j = JSON.parse(out.slice(out.indexOf("{")));
    const u = j.program_upload;
    if (!u || u.status !== "success" || !u.buffer_account) throw new Error(`upload not confirmed: ${out.slice(0, 200)}`);
    this.commits++;
    const ms = Date.now() - t0;
    this.log(`thru      ${kind} ${key} → ${u.buffer_account} in ${(ms / 1000).toFixed(1)}s`);
    return { kind, seed, account: u.buffer_account, meta: u.meta_account, explorer: `${config.THRU_EXPLORER}/address/${u.buffer_account}`, ms };
  }

  status() {
    return { enabled: this.enabled, feePayer: config.THRU_FEE_PAYER, commits: this.commits, lastError: this.lastError || null };
  }
}
