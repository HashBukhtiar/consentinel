// Hash-chain self-check: the service's local recomputation must match the
// program's `attest_capture` folding, and tampering must be detectable.
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, isFilmEvent } from "../src/audit";
import { ZERO_HEAD, filmEventHash, rollHead, toHex } from "../../registry/client/src/core";

const dir = mkdtempSync(join(tmpdir(), "consentinel-audit-"));
const log = new AuditLog(join(dir, "events.jsonl"));

// validation: privacy guard + shape
assert.ok(isFilmEvent({ eventId: "e1", beaconId: "A1B2", at: 1, cameraId: "cam-1" }));
assert.ok(!isFilmEvent({ eventId: "e1", beaconId: "A1B2", at: 1, cameraId: "cam-1", image: "..." }), "image payloads are refused");
assert.ok(!isFilmEvent({ eventId: "e1", beaconId: "ZZZZ", at: 1, cameraId: "cam-1" }), "beacon id must be hex");

// append + hash
const e1 = log.append({ eventId: "e1", beaconId: "a1b2", at: 1000, cameraId: "cam-1" });
const e2 = log.append({ eventId: "e2", beaconId: "A1B2", at: 2000, cameraId: "cam-1" });
assert.equal(e1.beaconId, "A1B2", "beacon ids are normalized before hashing");
assert.equal(e1.hash, toHex(filmEventHash({ eventId: "e1", beaconId: "A1B2", at: 1000, cameraId: "cam-1" })));

// nothing attested yet ⇒ head is zero
assert.deepEqual(log.expectedHead(), { head: toHex(ZERO_HEAD), count: 0 });

// attest both, in order, and compare with an independent fold
log.recordAttestation("e1", { signature: "s1", head: "", count: 1, at: 1 });
log.recordAttestation("e2", { signature: "s2", head: "", count: 2, at: 2 });
let head: Uint8Array = ZERO_HEAD;
head = rollHead(head, filmEventHash(e1));
head = rollHead(head, filmEventHash(e2));
assert.equal(log.expectedHead().head, toHex(head));
assert.ok(log.verify({ head: toHex(head), count: 2 }).ok, "matches the on-chain head");
assert.ok(!log.verify({ head: toHex(head), count: 3 }).ok, "count mismatch detected");
assert.ok(!log.verify({ head: toHex(rollHead(ZERO_HEAD, filmEventHash(e2))), count: 2 }).ok, "reordered/missing event detected");

// reload from disk reproduces the same state
const again = new AuditLog(join(dir, "events.jsonl"));
assert.equal(again.size, 2);
assert.equal(again.expectedHead().head, toHex(head));
assert.equal(again.forBadge("a1b2").length, 2);

console.log("ok — audit log hashing, attestation fold, tamper detection, reload");
