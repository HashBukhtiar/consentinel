// Copy the freshly built IDL + TS types into client/idl so the capture app and
// the service can import them without a Rust toolchain. Run after `anchor build`.
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
await mkdir(join(root, "client", "idl"), { recursive: true });
await copyFile(join(root, "target", "idl", "consent_registry.json"), join(root, "client", "idl", "consent_registry.json"));
await copyFile(join(root, "target", "types", "consent_registry.ts"), join(root, "client", "idl", "consent_registry.ts"));
console.log("synced target/idl + target/types → client/idl");
