import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // the registry client lives one level up (registry/client/src)
    fs: { allow: [repoRoot] },
  },
  resolve: {
    // one copy of web3.js/anchor even though registry/ has its own node_modules
    dedupe: ["@solana/web3.js", "@anchor-lang/core", "buffer", "bn.js", "tweetnacl", "@noble/hashes"],
  },
  define: { "process.env": {} },
  optimizeDeps: { include: ["@anchor-lang/core", "@solana/web3.js", "buffer"] },
});
