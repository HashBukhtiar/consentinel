// Fail loudly if the built program's id differs from declare_id!/core.ts (a
// fresh clone without registry/keys/program-keypair.json would otherwise mint a
// new id and every client would point at the wrong program).
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
const idl = JSON.parse(readFileSync(new URL("../../target/idl/consent_registry.json", import.meta.url), "utf8"));
const core = readFileSync(new URL("../src/core.ts", import.meta.url), "utf8");
const expected = core.match(/CONSENT_REGISTRY_PROGRAM_ID = new PublicKey\("([1-9A-HJ-NP-Za-km-z]+)"\)/)[1];
let built = idl.address;
try { built = execSync("solana-keygen pubkey target/deploy/consent_registry-keypair.json", { encoding: "utf8" }).trim(); } catch {}
if (built !== expected) {
  console.error(`program id mismatch: built ${built}, expected ${expected}.\n` +
    `  registry/keys/program-keypair.json is not in git — get it from the teammate who deployed, or run \`anchor keys sync\` to adopt a new id everywhere.`);
  process.exit(1);
}
console.log(`program id ok: ${built}`);
