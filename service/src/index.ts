// Consentinel notify + audit service (Part C, off the render loop).
//
//   POST /film-event              ← capture app (fire-and-forget FilmEvent)
//                                   → audit log → badge buzz → spoken alert → on-chain attest
//   GET  /health                  flags + subsystem state
//   GET  /badge/:id/pending       badge poll transport (drains the queue)
//   GET  /badge/:id/consent       badge reads its own on-chain state (+ nonce to sign)
//   POST /consent/delegated       badge-signed consent update, relayed on-chain
//   GET  /audit/events?badge=A1B2 the off-chain log (for the LLM audit layer)
//   GET  /audit/verify            local hash chain vs on-chain head
//   WS   /badge?id=A1B2           badge push transport
//   WS   /operator                capture-app UI feed (alerts, attestations)
//   GET  /audio/<file>.mp3        ElevenLabs output
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config";
import { AuditLog, isFilmEvent, type AuditEntry } from "./audit";
import { BadgeHub, norm } from "./badges";
import { Voice, alertText } from "./voice";
import { Chain, HttpError } from "./chain";
import { explorerUrl } from "../../registry/client/src/core";

const audit = new AuditLog(config.AUDIT_LOG);
const badges = new BadgeHub();
const voice = new Voice();
const operators = new Set<WebSocket>();
const broadcast = (msg: unknown) => {
  const s = JSON.stringify(msg);
  for (const ws of operators) if (ws.readyState === ws.OPEN) ws.send(s);
};
const chain = new Chain(audit, (e: AuditEntry) =>
  broadcast({ type: "attested", eventId: e.eventId, beaconId: e.beaconId, signature: e.attest!.signature, head: e.attest!.head, count: e.attest!.count, explorer: explorerUrl("tx", e.attest!.signature, config.SOLANA_CLUSTER) }),
);
await chain.init();

const startedAt = Date.now();
let received = 0;

async function handleFilmEvent(ev: unknown): Promise<object> {
  if (!isFilmEvent(ev)) throw new HttpError(400, "not a FilmEvent (eventId, beaconId hex, at, cameraId; no image data)");
  if (audit.has(ev.eventId)) return { ok: true, duplicate: true };
  received++;
  const entry = audit.append(ev);
  const say = alertText(entry.beaconId, entry.cameraId);
  const delivery = badges.send(entry.beaconId, { type: "filmed", beaconId: entry.beaconId, at: entry.at, cameraId: entry.cameraId, buzzMs: 600, say });
  chain.enqueue(entry);
  // voice is async and never blocks the response
  voice.speak(say, entry.beaconId).then(
    (spoken) => broadcast({ type: "alert", beaconId: entry.beaconId, eventId: entry.eventId, text: spoken.text, provider: spoken.provider, audioUrl: spoken.audioUrl ? `http://localhost:${config.PORT}${spoken.audioUrl}` : undefined, cached: spoken.cached }),
    (err) => broadcast({ type: "alert-error", beaconId: entry.beaconId, error: String(err?.message ?? err) }),
  );
  broadcast({ type: "film-event", entry, delivery });
  return { ok: true, seq: entry.seq, hash: entry.hash, badge: delivery, attest: chain.enabled ? "queued" : "disabled" };
}

function health() {
  return {
    service: "consentinel-notify",
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    flags: {
      SOLANA_CLUSTER: config.SOLANA_CLUSTER,
      SOLANA_RPC_URL: config.SOLANA_RPC_URL,
      ATTEST_ON_CHAIN: config.ATTEST_ON_CHAIN,
      USE_ELEVENLABS: voice.provider === "elevenlabs",
      PLAY_AUDIO_LOCALLY: config.PLAY_AUDIO_LOCALLY,
      CAMERA_ID: config.CAMERA_ID,
    },
    program: chain.reg.programId.toBase58(),
    programExplorer: explorerUrl("address", chain.reg.programId.toBase58(), config.SOLANA_CLUSTER),
    voice: { provider: voice.provider, fallback: voice.provider !== "elevenlabs" },
    audit: { path: config.AUDIT_LOG, events: audit.size, receivedThisRun: received, ...audit.expectedHead() },
    attest: chain.status(),
    relayer: chain.relayer?.publicKey.toBase58() ?? null,
    badges: badges.status(),
    operators: operators.size,
  };
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const p = url.pathname;
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readJson = () =>
    new Promise<unknown>((ok, no) => {
      let s = "";
      req.on("data", (c) => { s += c; if (s.length > 64_000) { no(new HttpError(413, "body too large")); req.destroy(); } });
      req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new HttpError(400, "invalid JSON")); } });
    });

  try {
    if (p === "/health" && req.method === "GET") return json(200, health());
    if (p === "/film-event" && req.method === "POST") return json(202, await handleFilmEvent(await readJson()));
    if (p === "/consent/delegated" && req.method === "POST") {
      const r = await chain.relayDelegated(await readJson());
      broadcast({ type: "delegated", ...r });
      return json(200, r);
    }
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/badge\/([0-9a-fA-F]{1,4})\/pending$/)) && req.method === "GET") return json(200, { beaconId: norm(m[1]), pending: badges.drain(m[1]) });
    if ((m = p.match(/^\/badge\/([0-9a-fA-F]{1,4})\/consent$/)) && req.method === "GET") {
      const rec = await chain.reg.fetchConsent(m[1]);
      return json(200, rec ? { registered: true, beaconId: rec.badgeId, consent: rec.consent, nonce: rec.revision, owner: rec.owner, updatedAt: rec.updatedAt } : { registered: false, beaconId: norm(m[1]), consent: null, note: "no record ⇒ capture app blurs (fail-safe)" });
    }
    if (p === "/audit/events" && req.method === "GET") {
      const badge = url.searchParams.get("badge");
      const events = badge ? audit.forBadge(badge) : audit.all();
      return json(200, { count: events.length, events: events.slice(-200) });
    }
    if (p === "/audit/verify" && req.method === "GET") {
      const cam = await chain.refreshCamera();
      if (!cam) return json(200, { ok: false, reason: "camera not registered on-chain", local: audit.expectedHead() });
      const v = audit.verify({ head: cam.head, count: cam.count });
      return json(200, { ...v, camera: cam.address, explorer: explorerUrl("address", cam.address, config.SOLANA_CLUSTER) });
    }
    if ((m = p.match(/^\/audio\/([a-f0-9]{40}\.mp3)$/)) && req.method === "GET") {
      const f = join(config.AUDIO_DIR, m[1]);
      if (!existsSync(f)) return json(404, { error: "no such audio" });
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return void createReadStream(f).pipe(res);
    }
    json(404, { error: "not found" });
  } catch (e) {
    const he = e as HttpError;
    json(he.status ?? 500, { error: he.message ?? String(e) });
    if (!(e instanceof HttpError)) console.error(e);
  }
}

const server = createServer((req, res) => void route(req, res));
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/badge") {
    const id = url.searchParams.get("id");
    if (!id || !/^[0-9a-fA-F]{1,4}$/.test(id)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => badges.attach(id, ws));
  } else if (url.pathname === "/operator") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      operators.add(ws);
      ws.on("close", () => operators.delete(ws));
      ws.send(JSON.stringify({ type: "health", ...health() }));
    });
  } else socket.destroy();
});

server.listen(config.PORT, () => {
  const h = health();
  console.log(`consentinel service on http://localhost:${config.PORT}`);
  console.log(`  program   ${h.program}  (${config.SOLANA_CLUSTER})`);
  console.log(`  camera    ${h.attest.camera ?? "—"}  registered=${h.attest.cameraRegistered}  attest=${h.attest.enabled ? "on" : "off"}${h.attest.lastError ? "  !! " + h.attest.lastError : ""}`);
  console.log(`  relayer   ${h.relayer ?? "—"}`);
  console.log(`  voice     ${h.voice.provider}${h.voice.fallback ? " (fallback — set ELEVENLABS_API_KEY)" : ""}`);
  console.log(`  audit     ${h.audit.events} events in ${config.AUDIT_LOG}`);
});
