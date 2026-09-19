// Tail the registry: prints every confirmed event (push, via websocket logs)
// and a periodic snapshot diff (poll) — the same two paths the capture app's
// cache uses. Handy for proving the on-chain beat from a second terminal.
import { CLUSTER, client, tx } from "./_env.mts";

const { reg } = client();
console.log(`watching program ${reg.programId.toBase58()} on ${CLUSTER} …`);
let last = new Map<string, string>();
async function poll() {
  try {
    const snap = await reg.fetchAll();
    const now = new Map(snap.consents.map((c) => [c.badgeId, `${c.consent ? "opt_in " : "opt_out"} rev=${c.revision}`]));
    for (const [id, s] of now) if (last.get(id) !== s) console.log(`[poll] ${id} ${s}`);
    for (const id of last.keys()) if (!now.has(id)) console.log(`[poll] ${id} record closed`);
    last = now;
  } catch (e) {
    console.warn(`[poll] ${(e as Error).message}`);
  }
}
await poll();
setInterval(poll, 3000);
reg.onLogs((n) => {
  for (const e of n.events) console.log(`[ws] ${JSON.stringify(e)}  ${tx(n.signature)}`);
});
