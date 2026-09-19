import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// A's optical wire-format contract lives at repo-root shared/beacon.ts.
// `@shared` lets the decoder + stubs import it as the single source of truth.
const shared = fileURLToPath(new URL("../shared", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // shared/ (A's beacon contract) and registry/client/src (C's Solana client) live one level up
    fs: { allow: [repoRoot] },
  },
  resolve: {
    alias: { "@shared": shared },
    // one copy of web3.js/anchor even though registry/ has its own node_modules
    dedupe: ["@solana/web3.js", "@anchor-lang/core", "buffer", "bn.js", "tweetnacl", "@noble/hashes"],
  },
  define: { "process.env": {} },
  optimizeDeps: { include: ["@anchor-lang/core", "@solana/web3.js", "buffer"] },
});
