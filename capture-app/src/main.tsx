import { Buffer } from "buffer";
// Solana/Anchor codecs expect a global Buffer in the browser.
(globalThis as any).Buffer ??= Buffer;

import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
