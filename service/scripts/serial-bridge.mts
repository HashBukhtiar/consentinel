// Laptop side of the badge downlink (firmware/README.md §5, option 1).
//
//   ESP32 dev board ──USB serial── this script ──WebSocket── service /bridge
//
// Serial line protocol (both directions, one frame per line, 115200 8N1):
//   service → board:  "CNSF4E\n" / "CNSC4E1\n"   the board re-broadcasts the line as a LUA1 frame
//   board → service:  "CNSR4E1\n"                 every CNS* frame the board hears on the air
// Anything the board prints that does not start with CNS is treated as a log
// line and shown, never forwarded.
//
//   npm run bridge -- --port /dev/cu.usbserial-0001 [--baud 115200] [--service ws://localhost:8787/bridge]
//   npm run bridge -- --stdin        # no hardware: type CNSR4E1 ⏎ to act as the badge's A button
//
// Zero dependencies beyond `ws`: the tty is opened as a file after `stty`
// sets the line discipline (macOS/Linux). If that is not enough for your
// board, any serial tool that can pipe lines works — the contract is the lines.
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import WebSocket from "ws";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = opt("--port");
const BAUD = Number(opt("--baud", "115200"));
const SERVICE = opt("--service", process.env.SERVICE_WS_URL ?? "ws://localhost:8787/bridge")!;
const STDIN = args.includes("--stdin");
if (!PORT && !STDIN) {
  console.error("usage: npm run bridge -- --port /dev/cu.usbserial-XXXX [--baud 115200] [--service ws://host:8787/bridge]\n       npm run bridge -- --stdin   (keyboard stands in for the board)");
  process.exit(2);
}

const ts = () => new Date().toLocaleTimeString();
let toBoard: (line: string) => void;

if (STDIN) {
  toBoard = (line) => console.log(`[${ts()}] ↓ ${line}   (would go on the air)`);
  createInterface({ input: process.stdin }).on("line", (l) => fromBoard(l));
  console.log(`no serial port — stdin stands in for the ESP32. Type a frame (e.g. CNSR4E1) and press enter.`);
} else {
  // open first, then set the line discipline: on macOS termios settings reset
  // when the last descriptor closes, so `stty` must run while we hold one.
  const rs = createReadStream(PORT!, { encoding: "utf8" });
  const ws = createWriteStream(PORT!);
  try { execFileSync("stty", ["-f", PORT!, String(BAUD), "raw", "-echo"], { stdio: "ignore" }); }
  catch { try { execFileSync("stty", ["-F", PORT!, String(BAUD), "raw", "-echo"], { stdio: "ignore" }); } catch (e) { console.error(`stty failed: ${(e as Error).message}`); } }
  rs.on("error", (e) => { console.error(`serial read error: ${e.message}`); process.exit(1); });
  ws.on("error", (e) => console.error(`serial write error: ${e.message}`));
  toBoard = (line) => { ws.write(line + "\n"); console.log(`[${ts()}] ↓ ${line}`); };
  createInterface({ input: rs }).on("line", (l) => fromBoard(l));
  console.log(`serial ${PORT} @ ${BAUD}`);
}

let sock: WebSocket | null = null;
let backoff = 1000;
const pendingUp: string[] = [];

function fromBoard(raw: string): void {
  const line = raw.replace(/\0/g, "").trim();
  if (!line) return;
  if (!line.startsWith("CNS")) { console.log(`[${ts()}] board: ${line}`); return; }
  console.log(`[${ts()}] ↑ ${line}`);
  if (sock?.readyState === WebSocket.OPEN) sock.send(line);
  else { pendingUp.push(line); if (pendingUp.length > 16) pendingUp.shift(); }
}

function connect(): void {
  const s = new WebSocket(SERVICE + (SERVICE.includes("?") ? "&" : "?") + "via=" + (STDIN ? "stdin" : "serial"));
  sock = s;
  s.on("open", () => {
    backoff = 1000;
    console.log(`[${ts()}] service connected ${SERVICE}`);
    for (const l of pendingUp.splice(0)) s.send(l);
  });
  s.on("message", (data) => {
    const text = data.toString("utf8");
    if (text.startsWith("{")) { // ack for an uplink frame
      try { const a = JSON.parse(text); console.log(`[${ts()}]   ${a.ack} → ${a.result}${a.explorer ? " " + a.explorer : a.error ? " " + a.error : a.note ? " " + a.note : ""}`); } catch { /* ignore */ }
      return;
    }
    for (const line of text.split(/\r?\n/)) if (line.trim()) toBoard(line.trim());
  });
  s.on("close", () => { sock = null; console.log(`[${ts()}] service disconnected; retry in ${backoff / 1000}s`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15_000); });
  s.on("error", (e) => { console.log(`[${ts()}] service: ${e.message}`); });
}
connect();
