// Resync the local audit log's BATCH list from the chain — for when the log
// and the camera's on-chain head have diverged (another service instance
// attested with the same camera key while this log was not being written, a
// log file was restored from an older copy, …). The chain is the source of
// truth for the sequence of commitments; the local file is the source of the
// film-events themselves. This script:
//   1. reads every `attest_capture` of this camera (CaptureAttested events:
//      count, commitment, head) from the camera PDA's transaction history,
//   2. checks that folding those commitments reproduces the on-chain head,
//   3. rewrites the batch records in chain order — heartbeats as heartbeats,
//      event batches re-linked to the local events whose hashes produce that
//      commitment — and keeps every event record as it is,
//   4. writes the result next to the old log (which is kept as a .bak).
// A batch whose commitment matches no local events is a batch this log never
// saw (filmed by the other instance); it is kept with its commitment and
// listed, and verification will keep reporting it until those events are
// merged in — a gap must not be papered over.
//   cd service && npm run rebuild-audit            # uses .env (AUDIT_LOG, CAMERA_KEYPAIR, SOLANA_*)
//   cd service && npm run rebuild-audit -- --dry   # report only
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { ConsentRegistryClient } from "../../registry/client/src/registry";
import { ZERO_HEAD, batchCommitment, cameraPda, fromHex, rollHead, toHex } from "../../registry/client/src/core";
import { config } from "../src/config";
import { loadKeypair } from "../src/chain";

const dry = process.argv.includes("--dry");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The public RPC answers "Too many requests for a specific RPC call" as a JSON-RPC error (not an HTTP 429 web3 would retry): back off and retry. */
async function withRetry<T>(what: string, fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const m = String((e as Error).message ?? e);
      if (i >= attempts || !/429|Too many requests|rate/i.test(m)) throw e;
      await sleep(1500 * i);
    }
  }
}
const camera = loadKeypair(config.CAMERA_KEYPAIR);
if (!camera) throw new Error(`no camera keypair at ${config.CAMERA_KEYPAIR}`);
const conn = new Connection(config.SOLANA_RPC_URL, "confirmed");
const reg = new ConsentRegistryClient(conn);
const [pda] = cameraPda(camera.publicKey, reg.programId);
const view = await reg.fetchCamera(camera.publicKey);
if (!view) throw new Error("camera is not registered on-chain");

const lines = existsSync(config.AUDIT_LOG) ? readFileSync(config.AUDIT_LOG, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
const events = lines.filter((r) => r.kind === "event").map((r) => r.entry);
const localBatches = lines.filter((r) => r.kind === "batch").map((r) => r.batch);
console.log(`local  ${events.length} events, ${localBatches.length} batches (${config.AUDIT_LOG})`);
console.log(`chain  count ${view.count}, head ${view.head.slice(0, 16)}…  camera ${pda.toBase58()}`);

// 1. every transaction that touched the camera PDA, oldest first
const sigs: ConfirmedSignatureInfo[] = [];
let before: string | undefined;
for (;;) {
  const page = await withRetry("getSignaturesForAddress", () => conn.getSignaturesForAddress(pda, { before, limit: 1000 }, "confirmed"));
  sigs.push(...page);
  if (page.length < 1000) break;
  before = page[page.length - 1].signature;
}
sigs.reverse();
console.log(`history ${sigs.length} transactions on the camera account`);

// 2. the chain's sequence. Batches this log recorded carry their real transaction
//    signature, so their position is known from the signature list alone; only the
//    transactions the log never saw are read one by one (the public RPC refuses
//    batched reads outright), and those tell us whether they were heartbeats or
//    event batches — or not attestations at all (register_camera, record_capture
//    also touch the camera account).
interface ChainBatch { count: number; commitment: string; head: string | null; signature: string; at: number; local?: (typeof localBatches)[number] }
const localBySig = new Map(localBatches.filter((b) => !String(b.signature).startsWith("(")).map((b) => [b.signature, b]));
const unmatched = sigs.filter((s) => !s.err && !localBySig.has(s.signature));
console.log(`match  ${sigs.length - unmatched.length} transactions are batches in the local log; reading the other ${unmatched.length} one by one`);
const fetched = new Map<string, { commitment: string; head: string; count: number; at: number } | null>(); // null = not an attestation
let n = 0;
for (const s of unmatched) {
  const tx = await withRetry(`getTransaction ${s.signature.slice(0, 8)}`, () => conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
  let found: { commitment: string; head: string; count: number; at: number } | null = null;
  if (tx?.meta?.logMessages && !tx.meta.err) {
    for (const ev of reg.parseEvents(tx.meta.logMessages)) {
      if (ev.name === "CaptureAttested" && ev.camera === camera.publicKey.toBase58()) found = { commitment: ev.commitment, head: ev.head, count: ev.count, at: (tx.blockTime ?? 0) * 1000 || ev.at * 1000 };
    }
  }
  fetched.set(s.signature, found);
  if (++n % 25 === 0) process.stdout.write(`  read ${n}/${unmatched.length}\r`);
  await sleep(Number(process.env.REBUILD_PAUSE_MS ?? 150));
}
const chain: ChainBatch[] = [];
for (const s of sigs) {
  if (s.err) continue;
  const local = localBySig.get(s.signature);
  if (local) { chain.push({ count: chain.length + 1, commitment: local.commitment, head: null, signature: s.signature, at: (s.blockTime ?? 0) * 1000 || local.at, local }); continue; }
  const f = fetched.get(s.signature);
  if (!f) continue; // register_camera / record_capture / record_notice: not part of the hash chain
  if (f.count !== chain.length + 1) throw new Error(`attestation ${s.signature} says count ${f.count} but sits at position ${chain.length + 1} — history from the RPC is incomplete; retry with an RPC that has full history (SOLANA_RPC_URL)`);
  chain.push({ count: f.count, commitment: f.commitment, head: f.head, signature: s.signature, at: f.at });
}
const notInHistory = [...localBySig.keys()].filter((sig) => !sigs.some((s) => s.signature === sig));
console.log(`chain  ${chain.length} attestations in order (${unmatched.length - [...fetched.values()].filter(Boolean).length} other transactions skipped)${notInHistory.length ? `; ${notInHistory.length} local batch signature(s) not in the RPC's history — they were never confirmed: ${notInHistory.slice(0, 3).join(", ")}${notInHistory.length > 3 ? "…" : ""}` : ""}`);
if (chain.length !== view.count) throw new Error(`have ${chain.length} attestations, chain count is ${view.count} — the RPC's history is incomplete; use one with full history (SOLANA_RPC_URL) and retry`);

// 3. fold check: the chain's own sequence must reproduce its head
let head: Uint8Array = ZERO_HEAD;
const heads: string[] = [];
for (const b of chain) {
  head = rollHead(head, fromHex(b.commitment));
  heads.push(toHex(head));
  if (b.head && toHex(head) !== b.head) throw new Error(`fold mismatch at count ${b.count}: the sequence does not reproduce the chain's head there (${toHex(head).slice(0, 12)} vs ${b.head.slice(0, 12)}) — a local batch's commitment may be wrong`);
}
if (toHex(head) !== view.head) throw new Error("folded head does not match the on-chain head");
console.log(`fold   ok — ${chain.length} commitments reproduce the on-chain head`);

// 4. re-link event batches by commitment
const byHash = new Map(events.map((e) => [e.hash, e]));
const localByCommitment = new Map<string, string[]>();
for (const b of localBatches) if (b.eventIds.length) localByCommitment.set(b.commitment, b.eventIds);
// any subset of unanchored/local events could also form a commitment we never recorded as a batch: try singles + the log-order runs
const eventHashes = events.map((e) => e.hash);
for (let i = 0; i < events.length; i++) for (let j = i + 1; j <= Math.min(events.length, i + 8); j++) {
  const ids = events.slice(i, j).map((e) => e.eventId);
  const c = toHex(batchCommitment(eventHashes.slice(i, j).map(fromHex)));
  if (!localByCommitment.has(c)) localByCommitment.set(c, ids);
}
const zero = toHex(ZERO_HEAD);
const out: { seq: number; eventIds: string[]; commitment: string; head: string; signature: string; at: number }[] = [];
const foreign: number[] = [];
const linked = new Map<string, number>();
for (const b of chain) {
  let ids: string[] = [];
  if (b.commitment !== zero) {
    ids = localByCommitment.get(b.commitment) ?? [];
    if (!ids.length) foreign.push(b.count);
  }
  for (const id of ids) linked.set(id, b.count);
  out.push({ seq: b.count, eventIds: ids, commitment: b.commitment, head: heads[b.count - 1], signature: b.signature, at: b.at });
}
const unanchored = events.filter((e) => !linked.has(e.eventId)).map((e) => e.eventId);
console.log(`link   ${linked.size}/${events.length} local events matched to chain batches; ${out.filter((b) => b.commitment === zero).length} heartbeats; ${foreign.length} batch(es) with events this log never saw${foreign.length ? ` (counts ${foreign.join(", ")})` : ""}${unanchored.length ? `; ${unanchored.length} local event(s) not on the chain: ${unanchored.join(", ")}` : ""}`);
void byHash;

if (dry) { console.log("dry run — nothing written"); process.exit(0); }
const bak = `${config.AUDIT_LOG}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
if (existsSync(config.AUDIT_LOG)) copyFileSync(config.AUDIT_LOG, bak);
const text = [
  ...events.map((e) => JSON.stringify({ kind: "event", entry: { ...e, batch: linked.get(e.eventId) } })),
  ...out.map((batch) => JSON.stringify({ kind: "batch", batch })),
].join("\n") + "\n";
writeFileSync(config.AUDIT_LOG, text);
console.log(`wrote  ${events.length} events + ${out.length} batches → ${config.AUDIT_LOG}\n       old log kept at ${bak}`);
process.exit(0);
