import "./polyfills";
import { createRoot } from "react-dom/client";
import { initSentry } from "./obs/sentry";
import { App } from "./ui/App";
import "./styles.css";

initSentry(); // no-op without VITE_SENTRY_DSN
createRoot(document.getElementById("root")!).render(<App />);
