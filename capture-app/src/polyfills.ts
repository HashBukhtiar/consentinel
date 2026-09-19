// Must be the FIRST import in main.tsx: ES modules evaluate imports in order,
// so this runs before any module that touches the Solana/Anchor graph.
import { Buffer } from "buffer";
(globalThis as any).Buffer ??= Buffer;
