// The setup panel hands an organizer the app to paste into the badge IDE. It
// reads the manifest out of the real firmware file, so if that header ever
// changes shape the panel starts quietly claiming "v?" on an unknown slug —
// and an organizer can no longer tell a stale badge from a current one.
//
// This pins the parse against the file that actually ships.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBadgeApp } from "../src/ui/badgeApp";

const LUA = fileURLToPath(new URL("../../firmware/consentinel-beacon.lua", import.meta.url));
const src = readFileSync(LUA, "utf8");
const app = parseBadgeApp(src);

assert.ok(app.ok, "the shipped beacon has a parseable --[==[badge-app header");
assert.equal(app.manifest.slug, "consentinel", "slug is what the badge installs into");
assert.ok(app.manifest.name, "name is what appears in the badge launcher");
assert.match(app.manifest.version ?? "", /^\d+\.\d+/, "version tells an organizer which app is on the badge");
assert.match(app.manifest.api ?? "", /^\d+$/, "api level gates which badge.* calls exist");
assert.ok(app.bytes > 1000, "a near-empty file would mean the import resolved to nothing");

// Values the panel prints verbatim must not carry the trailing CR of a CRLF
// checkout, or every key renders with a stray line break.
for (const [k, v] of Object.entries(app.manifest)) {
  assert.equal(v, v.trim(), `manifest ${k} is trimmed`);
  assert.ok(!/[\r\n]/.test(v), `manifest ${k} has no line break`);
}

// No header ⇒ not installable. The panel must be able to say so rather than
// offering an organizer a file the IDE will reject.
assert.equal(parseBadgeApp("-- just some lua\nreturn 1\n").ok, false, "a headerless file is not a badge app");

console.log("ok — badge app manifest: header parses, slug/name/version/api present, CRLF-safe, headerless rejected");
