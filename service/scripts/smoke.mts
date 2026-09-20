// End-to-end smoke test of the wired system, no camera or badge needed:
//   FilmEvent → audit log → CNSF radio frame → on-chain attestation
//            → notice: record_capture (filmed) + email dry-run + record_notice (told), both on-chain
//   CNSR radio request → badge-signed relay → on-chain flip → CNSC mirror
// Run with the service up (`npm run dev` here) and the registry seeded.
//   npm run smoke            # against http://localhost:8787
//   SERVICE_URL=http://host:8787 npm run smoke
const URL_ = process.env.SERVICE_URL ?? "http://localhost:8787";
const BADGE = (process.argv[2] ?? "4E").toUpperCase();
const token = process.env.SERVICE_TOKEN ?? "";
const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

type Res = { status: number; body: any };
const get = async (p: string): Promise<Res> => { const r = await fetch(URL_ + p, { headers: auth }); return { status: r.status, body: await r.json() }; };
const post = async (p: string, body: unknown): Promise<Res> => {
  const r = await fetch(URL_ + p, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
  console.log(`${ok ? "  ok " : "  FAIL"} ${what}${detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 160) : ""}`);
  if (!ok) failures++;
};

console.log(`smoke → ${URL_} (badge ${BADGE})`);

// 1. service + chain
const h = await get("/health").catch(() => null);
if (!h) { console.error("service is not reachable — start it with `npm run dev` in service/"); process.exit(1); }
check(h.status === 200, `health ${h.body.flags.SOLANA_CLUSTER} · program ${h.body.program}`);
check(h.body.attest.cameraRegistered === true, "camera registered on-chain (attestation enabled)", h.body.attest.lastError ?? undefined);
check(!!h.body.relayer, "relayer key loaded (pays for badge-signed updates)");
const interval = Number(h.body.flags.ATTEST_INTERVAL_MS);

// 2. the badge record
const c0 = await get(`/badge/${BADGE}/consent`);
check(c0.body.registered === true, `${BADGE} registered on-chain`, c0.body.registered ? { consent: c0.body.consent, rev: c0.body.nonce } : c0.body);
if (!c0.body.registered) { console.error("run `npm run seed` in registry/ first"); process.exit(1); }

// 3. FilmEvent → audit + CNSF frame
await get("/bridge/pending"); // clear anything queued before we look
const ev = { eventId: `smoke-${Date.now()}`, beaconId: BADGE, at: Date.now(), cameraId: h.body.flags.CAMERA_ID };
const fe = await post("/film-event", ev);
check(fe.status === 202 && fe.body.ok === true, "POST /film-event accepted", { seq: fe.body.seq, radio: fe.body.radio });
const q1 = await get("/bridge/pending");
const bridged = fe.body.radio?.delivered > 0;
check(bridged || q1.body.frames.includes(`CNSF${BADGE}`), bridged ? "CNSF frame delivered to the live radio bridge" : "CNSF frame queued for the radio bridge", q1.body.frames);

// 4. CNSR request (what the badge's A button sends) → badge-signed relay → chain
const want = !c0.body.consent;
const up = await post("/bridge/uplink", { frame: `CNSR${BADGE}${want ? 1 : 0}` });
check(up.status === 200 && up.body.result === "relayed", `CNSR${BADGE}${want ? 1 : 0} relayed on-chain as a badge-signed update`, up.body.explorer ?? up.body);
const c1 = await get(`/badge/${BADGE}/consent`);
check(c1.body.consent === want, `on-chain consent is now ${want ? "opt_in" : "opt_out"} (rev ${c1.body.nonce})`);
const q2 = await get("/bridge/pending");
check(bridged || q2.body.frames.includes(`CNSC${BADGE}${want ? 1 : 0}`), "CNSC mirror frame produced for the badge", q2.body.frames);
const again = await post("/bridge/uplink", { frame: `CNSR${BADGE}${want ? 1 : 0}` });
check(again.body.result === "noop", "a repeated request is a no-op (no duplicate transaction)", again.body.note);

// 5. restore the original state through the same path
const back = await post("/bridge/uplink", `CNSR${BADGE}${c0.body.consent ? 1 : 0}`);
check(back.body.result === "relayed", `restored ${BADGE} to ${c0.body.consent ? "opt_in" : "opt_out"}`, back.body.explorer ?? back.body);

// 6. the notice: filmed → told, two camera-signed transactions, readable straight from the chain
if (fe.body.notice === "disabled") check(false, "notices are disabled on the service (NOTIFY_ON_CHAIN / camera key)");
else if (fe.body.notice?.stage === "coalesced") check(true, `notice coalesced onto the one filed ${Math.round((ev.at - fe.body.notice.coveredBy.at) / 1000)}s ago for ${BADGE} (NOTICE_MIN_INTERVAL_MS) — re-run later to watch the two transactions land`);
else {
  console.log(`  … waiting up to 40s for the on-chain notice (record_capture → record_notice)`);
  let mine: any = null;
  for (let t = 0; t < 40_000; t += 2000) {
    await sleep(2000);
    const r = await get(`/audit/notices?badge=${BADGE}`);
    mine = (r.body.onChain ?? []).find((n: any) => n.eventHash === fe.body.hash) ?? null;
    if (mine?.notifiedAt) break;
  }
  check(!!mine, `record_capture landed: notice account for this film-event (filmed_at ${mine ? new Date(mine.filmedAt * 1000).toLocaleTimeString() : "?"})`, mine ? { address: mine.address, recordedAt: mine.recordedAt } : undefined);
  check(!!mine?.notifiedAt, `record_notice landed: told at ${mine?.notifiedAt ? new Date(mine.notifiedAt * 1000).toLocaleTimeString() : "?"} (channels ${mine?.channels})`, mine ? { notifiedAt: mine.notifiedAt, channels: mine.channels } : undefined);
  check(mine ? mine.filmedAt === Math.floor(ev.at / 1000) : false, "filmed_at on-chain equals the FilmEvent's timestamp");
}

// 7. the film-event gets anchored in the next interval
console.log(`  … waiting up to ${Math.round((interval + 8000) / 1000)}s for the next on-chain commitment`);
let verified: any = null;
for (let t = 0; t < interval + 8000; t += 2000) {
  await sleep(2000);
  verified = (await get("/audit/verify")).body;
  if (verified.ok && verified.local?.unanchored === 0) break;
}
check(!!verified?.ok && verified.local?.unanchored === 0, "audit log verifies against the on-chain head", verified ? { count: verified.onChain?.count, batches: verified.batches, explorer: verified.explorer } : undefined);

console.log(failures ? `\n${failures} check(s) failed` : "\nall wired: capture → service → radio → chain (attested + filmed + told) → mirror");
process.exit(failures ? 1 : 0);
