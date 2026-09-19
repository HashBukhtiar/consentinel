// Hash-chain self-check: the service's local recomputation must match the
// program's `attest_capture` folding over batch commitments, and tampering
// (edit, reorder, drop) must be detectable from raw fields.
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, isFilmEvent } from "../src/audit";
import { ZERO_HEAD, batchCommitment, filmEventHash, rollHead, toHex } from "../../registry/client/src/core";

const dir = mkdtempSync(join(tmpdir(), "consentinel-audit-"));
const path = join(dir, "events.jsonl");
const log = new AuditLog(path);

// validation: strict allowlist + shape
assert.ok(isFilmEvent({ eventId: "e1", beaconId: "A1B2", at: 1, cameraId: "cam-1" }));
assert.ok(!isFilmEvent({ eventId: "e1", beaconId: "A1B2", at: 1, cameraId: "cam-1", image: "..." }), "image payloads are refused");
assert.ok(!isFilmEvent({ eventId: "e1", beaconId: "A1B2", at: 1, cameraId: "cam-1", thumbnailJpeg: "..." }), "any extra field is refused");
assert.ok(!isFilmEvent({ eventId: "e1", beaconId: "ZZZZ", at: 1, cameraId: "cam-1" }), "beacon id must be hex");
assert.ok(!isFilmEvent({ eventId: "e1", beaconId: "A1B2", at: 1, cameraId: "" }), "cameraId required");

// append + canonical hashing (ids normalized to 4 upper-case hex)
const e1 = log.append({ eventId: "e1", beaconId: "1f", at: 1000, cameraId: "cam-1" });
const e2 = log.append({ eventId: "e2", beaconId: "A1B2", at: 2000, cameraId: "cam-1" });
const e3 = log.append({ eventId: "e3", beaconId: "a1b2", at: 3000, cameraId: "cam-1" });
assert.equal(e1.beaconId, "001F", "beacon ids are zero-padded before hashing");
assert.equal(e1.hash, toHex(filmEventHash({ eventId: "e1", beaconId: "001F", at: 1000, cameraId: "cam-1" })));
assert.equal(log.forBadge("a1b2").length, 2);

// nothing attested yet ⇒ head is zero, 3 unanchored
assert.deepEqual(log.expectedHead(), { head: toHex(ZERO_HEAD), count: 0, mismatches: [], unanchored: 3 });

// batch 1 = {e1,e2}; batch 2 = heartbeat; batch 3 = {e3}. Compare with an independent fold.
const b1 = log.nextHead(["e1", "e2"]);
log.recordBatch({ eventIds: ["e1", "e2"], commitment: toHex(b1.commitment), head: toHex(b1.head), signature: "s1", at: 1 });
const b2 = log.nextHead([]);
log.recordBatch({ eventIds: [], commitment: toHex(b2.commitment), head: toHex(b2.head), signature: "s2", at: 2 });
const b3 = log.nextHead(["e3"]);
log.recordBatch({ eventIds: ["e3"], commitment: toHex(b3.commitment), head: toHex(b3.head), signature: "s3", at: 3 });

let head = ZERO_HEAD;
head = rollHead(head, batchCommitment([filmEventHash(e1), filmEventHash(e2)]));
head = rollHead(head, batchCommitment([]));
head = rollHead(head, batchCommitment([filmEventHash(e3)]));
assert.equal(toHex(b2.commitment), toHex(ZERO_HEAD), "heartbeat commits the zero hash");
assert.equal(log.expectedHead().head, toHex(head));
assert.equal(log.expectedHead().unanchored, 0);
assert.ok(log.verify({ head: toHex(head), count: 3 }).ok, "matches the on-chain head");
assert.ok(log.verify({ head: toHex(head), count: 3 }).complete);
assert.ok(!log.verify({ head: toHex(head), count: 4 }).ok, "count mismatch detected");
assert.ok(!log.verify({ head: toHex(rollHead(ZERO_HEAD, batchCommitment([filmEventHash(e3)]))), count: 3 }).ok, "reordered/missing batch detected");

// reload from disk reproduces the same state
const again = new AuditLog(path);
assert.equal(again.size, 3);
assert.equal(again.batchCount, 3);
assert.equal(again.expectedHead().head, toHex(head));
assert.equal(again.get("e3")!.batch, 3);

// tamper: relabel who was filmed in the JSONL ⇒ recomputed hash differs ⇒ mismatch, verify fails
const tampered = readFileSync(path, "utf8").replace('"beaconId":"A1B2","at":2000', '"beaconId":"C3D4","at":2000');
writeFileSync(path, tampered);
const bad = new AuditLog(path);
const chk = bad.expectedHead();
assert.ok(chk.mismatches.includes("e2"), "edited event detected from raw fields");
assert.ok(!bad.verify({ head: toHex(head), count: 3 }).ok, "tampered log fails verification even with the right head");

console.log("ok — audit log hashing, batch commitments + heartbeat fold, tamper detection, reload");
