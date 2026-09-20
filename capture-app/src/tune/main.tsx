import "../polyfills";
import { createRoot } from "react-dom/client";
import { Tune } from "./Tune";
import "../styles.css";

createRoot(document.getElementById("root")!).render(<Tune />);
