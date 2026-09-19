import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// A's optical wire-format contract lives at repo-root shared/beacon.ts.
// `@shared` lets the decoder + stubs import it as the single source of truth.
const shared = fileURLToPath(new URL("../shared", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, fs: { allow: [".."] } },
  resolve: { alias: { "@shared": shared } },
});
