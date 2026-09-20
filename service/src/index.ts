// Consentinel notify + audit service (Part C, off the render loop).
//
//   POST /film-event              ← capture app (fire-and-forget FilmEvent; Bearer SERVICE_TOKEN if set)
//                                   → audit log → badge buzz → spoken alert → next on-chain commitment
//   GET  /health                  flags + subsystem state
//   GET  /badge/:id/pending       badge poll transport (drains the queue)
//   GET  /badge/:id/consent       badge reads its own on-chain state (+ nonce/instance/serverTime to sign)
//   POST /consent/delegated       badge-signed consent update, relayed on-chain (signature-verified; open)
//   GET  /audit/events?badge=A1B2 the off-chain log (Bearer SERVICE_TOKEN if set) — for the audit layer
//   GET  /audit/verify            local log recomputed vs on-chain head (hashes only; open)
//   WS   /badge?id=A1B2           badge push transport (JSON; for a Wi-Fi bridge/dev board)
//   WS   /bridge                  radio bridge: CNS* text frames both ways (see BADGE_PROTOCOL.md)
//   GET  /bridge/pending          radio bridge poll transport (drains queued CNSF/CNSC frames)
//   POST /bridge/uplink           radio bridge: a CNSR<id><0|1> heard on the air → badge-signed on-chain update
//   WS   /operator                capture-app UI feed (alerts, attestations, radio frames)
//   GET  /audio/<file>.mp3        ElevenLabs output
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { config, redactRpcUrl } from "./config";
import { AuditLog, isFilmEvent, type AuditEntry, type Batch } from "./audit";
import { BadgeHub, norm } from "./badges";
import { Voice, alertText } from "./voice";
import { Chain, HttpError } from "./chain";
import { RadioBridge } from "./radio";
import { ThruLedger } from "./thru";
import { explorerUrl } from "../../registry/client/src/core";

const log = (m: string) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
process.on("uncaughtException", (e) => log(`uncaught exception (kept running): ${e?.stack ?? e}`));
process.on("unhandledRejection", (e: any) => log(`unhandled rejection (kept running): ${e?.stack ?? e}`));

const audit = new AuditLog(config.AUDIT_LOG);
const badges = new BadgeHub(log);
const voice = new Voice();
const operators = new Set<WebSocket>();
const broadcast = (msg: unknown) => {
  const s = JSON.stringify(msg);
  for (const ws of operators) if (ws.readyState === ws.OPEN) { try { ws.send(s); } catch { /* dropped */ } }
};
// Thru: the per-event evidence ledger (Solana keeps the periodic checkpoint).
const thru = new ThruLedger(log);
await thru.probe();
const chain = new Chain(
  audit,
  (b: Batch, entries: AuditEntry[]) => {
    broadcast({
      type: "attested",
      batch: b.seq,
      eventIds: entries.map((e) => e.eventId),
      beaconIds: entries.map((e) => e.beaconId),
      heartbeat: entries.length === 0,
      signature: b.signature,
      head: b.head,
      count: b.seq,
      explorer: b.signature.startsWith("(") ? null : explorerUrl("tx", b.signature, config.SOLANA_CLUSTER),
    });
    // mirror the checkpoint to Thru so the two ledgers cross-reference each other
    void thru.commit("attest", `at${b.seq}`, { batch: b.seq, head: b.head, solana: b.signature, events: entries.length })
      .then((c) => c && broadcast({ type: "thru", kind: "attest", batch: b.seq, seed: c.seed, account: c.account, explorer: c.explorer, ms: c.ms }));
  },
  log,
);
await chain.init();

// Badge radio (A ↔ C): film-events go down as CNSF, every on-chain consent
// change goes down as CNSC, and a CNSR request from the badge's A button comes
// up and becomes a badge-signed, relayed transaction.
const radio = new RadioBridge(chain, broadcast, log);
radio.start(config.RADIO_SYNC_MS);
let logsSubscribed = false;
try {
  chain.reg.onLogs((n) => {
    if (n.err) return;
    for (const ev of n.events) {
      if (ev.name === "ConsentChanged") radio.consentPush(ev.badgeId, ev.consent, { why: ev.delegated ? "chain: badge-signed update" : "chain: owner update" });
      else if (ev.name === "ConsentClosed") radio.consentPush(ev.badgeId, false, { force: true, why: "chain: record closed ⇒ blur" });
    }
  });
  logsSubscribed = true;
} catch (e) {
  log(`log subscription unavailable (${(e as Error).message}); radio mirror falls back to the periodic sync`);
}

const startedAt = Date.now();
let received = 0;

async function handleFilmEvent(ev: unknown): Promise<object> {
  if (!isFilmEvent(ev)) throw new HttpError(400, "not a FilmEvent: exactly {eventId, beaconId (hex), at, cameraId}");
  if (ev.cameraId !== config.CAMERA_ID) throw new HttpError(400, `cameraId must be ${config.CAMERA_ID} (this service signs for that camera only)`);
  if (audit.has(ev.eventId)) return { ok: true, duplicate: true };
  received++;
  const entry = audit.append(ev);
  const say = alertText(entry.beaconId, entry.cameraId);
  const delivery = badges.send(entry.beaconId, { type: "filmed", beaconId: entry.beaconId, at: entry.at, cameraId: entry.cameraId, buzzMs: 600, say });
  const radioEv = radio.filmEvent(entry.beaconId); // CNSF<id> → the badge's red alarm
  chain.enqueue(entry);
  // Thru: commit this one event immediately (no batching) — the evidence ledger
  void thru.commit("film-event", `ev${entry.seq}`, { eventId: entry.eventId, seq: entry.seq, hash: entry.hash, beacon: entry.beaconId, at: entry.at })
    .then((c) => c && broadcast({ type: "thru", kind: "film-event", eventId: entry.eventId, seed: c.seed, account: c.account, explorer: c.explorer, ms: c.ms }));
  // voice is async and never blocks the response
  voice.speak(say, entry.beaconId).then(
    (spoken) => broadcast({ type: "alert", beaconId: entry.beaconId, eventId: entry.eventId, text: spoken.text, provider: spoken.provider, audioUrl: spoken.audioUrl, cached: spoken.cached, playedLocally: config.PLAY_AUDIO_LOCALLY }),
    (err) => broadcast({ type: "alert-error", beaconId: entry.beaconId, error: String(err?.message ?? err) }),
  );
  broadcast({ type: "film-event", entry, delivery });
  return {
    ok: true,
    seq: entry.seq,
    hash: entry.hash,
    badge: delivery,
    radio: radioEv ? { frame: radioEv.frame, delivered: radioEv.delivered, queued: radioEv.queued } : null,
    attest: chain.enabled ? "queued for next interval" : "disabled",
    thru: thru.enabled ? "committing" : "disabled",
  };
}

function health() {
  const a = chain.status();
  return {
    service: "consentinel-notify",
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    flags: {
      SOLANA_CLUSTER: config.SOLANA_CLUSTER,
      SOLANA_RPC_URL: redactRpcUrl(config.SOLANA_RPC_URL),
      ATTEST_ON_CHAIN: config.ATTEST_ON_CHAIN,
      ATTEST_INTERVAL_MS: config.ATTEST_INTERVAL_MS,
      ATTEST_HEARTBEAT: config.ATTEST_HEARTBEAT,
      USE_ELEVENLABS: voice.provider === "elevenlabs",
      PLAY_AUDIO_LOCALLY: config.PLAY_AUDIO_LOCALLY,
      CAMERA_ID: config.CAMERA_ID,
      SERVICE_TOKEN: config.SERVICE_TOKEN ? "set" : "unset (open)",
      CORS_ORIGIN: config.CORS_ORIGIN,
    },
    program: chain.reg.programId.toBase58(),
    programExplorer: explorerUrl("address", chain.reg.programId.toBase58(), config.SOLANA_CLUSTER),
    voice: { provider: voice.provider, fallback: voice.provider !== "elevenlabs" },
    audit: { path: config.AUDIT_LOG, events: audit.size, receivedThisRun: received, ...audit.expectedHead() },
    attest: a,
    relayer: chain.relayer?.publicKey.toBase58() ?? null,
    badges: badges.status(),
    radio: { ...radio.status(), logsSubscribed, syncMs: config.RADIO_SYNC_MS },
    operators: operators.size,
  };
}

function authorized(req: IncomingMessage): boolean {
  if (!config.SERVICE_TOKEN) return true;
  return req.headers.authorization === `Bearer ${config.SERVICE_TOKEN}`;
}

function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  return new Promise((ok, no) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => { if (!done) { done = true; fn(); } };
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > 64_000) {
        finish(() => {
          res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "body too large" }));
          no(new HttpError(413, "body too large"));
          req.destroy();
        });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => finish(() => {
      const text = Buffer.concat(chunks).toString("utf8");
      try { ok(chunks.length ? JSON.parse(text) : {}); }
      catch {
        // a dumb radio bridge may POST the bare frame as text/plain (`curl -d CNSR4E1`)
        if (/^CNS[A-Z][0-9A-Fa-f]{2}[01]?\s*$/.test(text)) ok(text.trim());
        else no(new HttpError(400, "invalid JSON"));
      }
    }));
    req.on("aborted", () => finish(() => no(new HttpError(400, "client aborted"))));
    req.on("error", (e) => finish(() => no(new HttpError(400, e.message))));
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const p = url.pathname;
  res.setHeader("access-control-allow-origin", config.CORS_ORIGIN);
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("vary", "origin");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  const json = (code: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    if (p === "/health" && req.method === "GET") return json(200, health());
    if (p === "/film-event" && req.method === "POST") {
      if (!authorized(req)) return json(401, { error: "missing or wrong bearer token" });
      return json(202, await handleFilmEvent(await readJson(req, res)));
    }
    if (p === "/consent/delegated" && req.method === "POST") {
      const r = await chain.relayDelegated(await readJson(req, res));
      broadcast({ type: "delegated", ...r });
      return json(200, r);
    }
    if (p === "/bridge/pending" && req.method === "GET") return json(200, { frames: radio.drain() });
    if (p === "/bridge/uplink" && req.method === "POST") {
      const body = await readJson(req, res);
      const frame = typeof body === "string" ? body : (body as any)?.frame;
      const r = await radio.uplink(frame, "http");
      return json(r.result === "error" ? (r.status ?? 500) : 200, r);
    }
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/badge\/([0-9a-fA-F]{1,4})\/pending$/)) && req.method === "GET") return json(200, { beaconId: norm(m[1]), pending: badges.drain(m[1]) });
    if ((m = p.match(/^\/badge\/([0-9a-fA-F]{1,4})\/consent$/)) && req.method === "GET") {
      const rec = await chain.reg.fetchConsent(m[1]);
      const serverTime = Math.floor(Date.now() / 1000);
      return json(
        200,
        rec
          ? { registered: true, beaconId: rec.badgeId, consent: rec.consent, nonce: rec.revision, instance: rec.instance, owner: rec.owner, updatedAt: rec.updatedAt, serverTime }
          : { registered: false, beaconId: norm(m[1]), consent: null, serverTime, note: "no record ⇒ capture app blurs (fail-safe); ask the organizer to register this badge" },
      );
    }
    if (p === "/audit/events" && req.method === "GET") {
      if (!authorized(req)) return json(401, { error: "missing or wrong bearer token" });
      const badge = url.searchParams.get("badge");
      const events = badge ? audit.forBadge(badge) : audit.all();
      return json(200, { count: events.length, events: events.slice(-200) });
    }
    if (p === "/audit/verify" && req.method === "GET") {
      const cam = await chain.refreshCamera();
      if (!cam) return json(200, { ok: false, reason: "camera not registered on-chain", local: audit.expectedHead() });
      const v = audit.verify({ head: cam.head, count: cam.count });
      return json(200, { ...v, batches: audit.batchCount, camera: cam.address, explorer: explorerUrl("address", cam.address, config.SOLANA_CLUSTER) });
    }
    if ((m = p.match(/^\/audio\/([a-f0-9]{40}\.mp3)$/)) && req.method === "GET") {
      const f = join(config.AUDIO_DIR, m[1]);
      if (!existsSync(f)) return json(404, { error: "no such audio" });
      res.writeHead(200, { "content-type": "audio/mpeg" });
      const s = createReadStream(f);
      s.on("error", () => res.destroy());
      return void s.pipe(res);
    }
    json(404, { error: "not found" });
  } catch (e) {
    const he = e as HttpError;
    json(he.status ?? 500, { error: he.message ?? String(e) });
    if (!(e instanceof HttpError)) console.error(e);
  }
}

const server = createServer((req, res) => void route(req, res));
server.on("clientError", (_e, sock) => { try { sock.destroy(); } catch { /* gone */ } });
const wss = new WebSocketServer({ noServer: true });
wss.on("error", (e) => log(`wss error: ${e.message}`));
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/badge") {
    const id = url.searchParams.get("id");
    if (!id || !/^[0-9a-fA-F]{1,4}$/.test(id)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => badges.attach(id, ws));
  } else if (url.pathname === "/bridge") {
    wss.handleUpgrade(req, socket, head, (ws) => radio.attach(ws, url.searchParams.get("via") ?? "ws"));
  } else if (url.pathname === "/operator") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", (e) => log(`operator socket error: ${e.message}`));
      operators.add(ws);
      ws.on("close", () => operators.delete(ws));
      try { ws.send(JSON.stringify({ type: "health", ...health() })); } catch { /* dropped */ }
    });
  } else socket.destroy();
});

server.listen(config.PORT, () => {
  const h = health();
  console.log(`consentinel service on http://localhost:${config.PORT}`);
  console.log(`  program   ${h.program}  (${config.SOLANA_CLUSTER})`);
  console.log(`  camera    ${h.attest.camera ?? "—"}  registered=${h.attest.cameraRegistered}  attest=${h.attest.enabled ? `every ${config.ATTEST_INTERVAL_MS / 1000}s${config.ATTEST_HEARTBEAT ? " + heartbeat" : ""}` : "off"}${h.attest.lastError ? "  !! " + h.attest.lastError : ""}`);
  console.log(`  relayer   ${h.relayer ?? "—"}`);
  console.log(`  voice     ${h.voice.provider}${h.voice.fallback ? " (fallback — set ELEVENLABS_API_KEY)" : ""}`);
  console.log(`  audit     ${h.audit.events} events, ${h.attest.batches} batches in ${config.AUDIT_LOG}${h.audit.unanchored ? `  (${h.audit.unanchored} unanchored)` : ""}`);
  console.log(`  auth      token ${config.SERVICE_TOKEN ? "required" : "not set (open)"}; CORS ${config.CORS_ORIGIN}`);
  console.log(`  radio     bridge ws://localhost:${config.PORT}/bridge · GET /bridge/pending · POST /bridge/uplink  (keys ${config.BADGE_KEYS_DIR}; chain push ${logsSubscribed ? "on" : "off"})`);
  if (chain.relayer) {
    chain.conn.getBalance(chain.relayer.publicKey)
      .then((b) => { if (b < 0.01e9) console.log(`  !! relayer balance ${(b / 1e9).toFixed(3)} SOL — fund it or badge-signed updates will fail`); })
      .catch(() => {});
  }
});
