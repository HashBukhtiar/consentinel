// Radio-frame self-check: the service must speak exactly the frames the Lua
// app parses (firmware/consentinel-beacon.lua `on_radio`) and must never put
// a malformed or oversized payload on the air.
import assert from "node:assert";
import { RADIO_MAX_BYTES, consentFrame, filmFrame, parseFrame, requestFrame } from "../src/radio";

// downlink frames, byte-for-byte what the badge expects
assert.equal(filmFrame("4E"), "CNSF4E");
assert.equal(filmFrame("4e"), "CNSF4E", "ids are upper-cased");
assert.equal(filmFrame("0x4e"), "CNSF4E");
assert.equal(filmFrame("7"), "CNSF07", "8-bit ids are two hex digits");
assert.equal(consentFrame("4E", true), "CNSC4E1");
assert.equal(consentFrame("4E", false), "CNSC4E0");
assert.equal(requestFrame("A1", true), "CNSRA11");
assert.throws(() => filmFrame("A1B2"), /8-bit/, "16-bit ids cannot be carried by the badge radio");
assert.throws(() => filmFrame("zz"));
for (const f of [filmFrame("FF"), consentFrame("FF", true)]) assert.ok(Buffer.byteLength(f) <= RADIO_MAX_BYTES);

// uplink parsing mirrors the Lua: tag, kind, two hex digits, optional 0|1
assert.deepEqual(parseFrame("CNSR4E1"), { kind: "R", id: "4E", consent: true, raw: "CNSR4E1" });
assert.deepEqual(parseFrame("cnsr4e0\r\n"), null, "the tag is case-sensitive (Lua compares bytes)");
assert.deepEqual(parseFrame("CNSR4e0\n"), { kind: "R", id: "4E", consent: false, raw: "CNSR4E0" }, "id hex may be lower-case; whitespace trimmed");
assert.deepEqual(parseFrame("CNSF4E"), { kind: "F", id: "4E", raw: "CNSF4E" });
assert.deepEqual(parseFrame("CNSC4E1"), { kind: "C", id: "4E", consent: true, raw: "CNSC4E1" });
assert.equal(parseFrame("CNSR4E"), null, "R needs the consent digit");
assert.equal(parseFrame("CNSR4E2"), null, "consent digit must be 0|1");
assert.equal(parseFrame("CNSF4E1"), null, "F carries no payload");
assert.equal(parseFrame("CNSX4E1"), null, "unknown kind");
assert.equal(parseFrame("LUA1CNSR4E1"), null, "the firmware prefix is stripped by the radio layer, not us");
assert.equal(parseFrame("CNSR4E1".padEnd(45, "x")), null, "over 44 bytes");
assert.equal(parseFrame(42), null);
assert.equal(parseFrame(""), null);

console.log("radio frames ok");
