import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// A's optical wire-format contract lives at repo-root shared/beacon.ts.
// `@shared` lets the decoder + stubs import it as the single source of truth.
const shared = fileURLToPath(new URL("../shared", import.meta.url));

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  // tune.html is the beacon threshold rig, badge.html turns any phone/laptop
  // screen into a beacon — both separate entries so nothing in them can reach
  // the hero path. Dev: http://localhost:5173/tune.html, /badge.html
  build: {
    rollupOptions: {
      input: {
        main: resolve(here, "index.html"),
        tune: resolve(here, "tune.html"),
        badge: resolve(here, "badge.html"),
        decode: resolve(here, "decode.html"),
      },
    },
  },
  server: {
    port: 5173,
    host: true, // phones on the LAN need to reach badge.html

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
