import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { signConsentMessage, type ConsentView, type TxSigner } from "../../../registry/client/src/registry";
import type { ChainConsentCache } from "../consent/chainCache";
import { detectWallet, loadDemoKeys, walletSigner, type DemoKeys, type WalletProvider } from "../consent/signers";
import { flags } from "../config/flags";

// The Solana side of the operator panel: live registry state, sync health,
// and the on-stage beat — an owner-signed (or badge-signed + relayed)
// transaction that flips a face's blur within the sync interval.
export function ChainPanel({ cache }: { cache: ChainConsentCache }) {
  const [, force] = useState(0);
  useEffect(() => cache.subscribe(() => force((x) => x + 1)), [cache]);
  useEffect(() => { const t = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(t); }, []);

  const [keys, setKeys] = useState<DemoKeys | null>(null);
  useEffect(() => { loadDemoKeys().then(setKeys); }, []);
  const wallet = useMemo(() => detectWallet(), []);
  const [walletPk, setWalletPk] = useState<string | null>(null);
  const [delegated, setDelegated] = useState(false);
  const [busy, setBusy] = useState<Record<string, { text: string; url?: string; err?: boolean }>>({});

  const st = cache.status;
  const records = cache.records();
  const ago = (t: number) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago` : "never");
  const short = (s: string) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "—");

  function signerFor(rec: ConsentView): { signer: TxSigner; via: string } | null {
    if (wallet && walletPk && walletPk === rec.owner) return { signer: walletSigner(wallet as WalletProvider), via: "wallet" };
    const s = keys?.owners.get(rec.owner);
    return s ? { signer: s, via: "badge key" } : null;
  }

  async function connectWallet() {
    try {
      const r = await wallet!.connect();
      setWalletPk(r.publicKey.toBase58());
    } catch (e) { setBusy((b) => ({ ...b, _wallet: { text: (e as Error).message, err: true } })); }
  }

  async function act(rec: ConsentView, action: "grant" | "revoke" | "close") {
    const s = signerFor(rec);
    if (!s) return;
    const id = rec.badgeId;
    const t0 = performance.now();
    setBusy((b) => ({ ...b, [id]: { text: `signing (${s.via})…` } }));
    try {
      let sig: string;
      const feePayer = keys?.relayer ?? s.signer;
      if (action === "close") {
        sig = await cache.client.closeConsent(s.signer, id);
      } else if (delegated && keys?.relayer && keys.secrets.get(rec.owner)) {
        // badge signs the 33-byte message; relayer pays; program verifies via Ed25519 precompile
        const { signature } = signConsentMessage(keys.secrets.get(rec.owner)!, id, action === "grant", rec.revision);
        setBusy((b) => ({ ...b, [id]: { text: "badge-signed → relaying…" } }));
        sig = await cache.client.setConsentDelegated(keys.relayer, id, action === "grant", rec.revision, new PublicKey(rec.owner), signature);
      } else {
        setBusy((b) => ({ ...b, [id]: { text: "sending…" } }));
        sig = await cache.client.setConsent(s.signer, id, action === "grant", feePayer);
      }
      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      cache.note("tx", `${id} ${action} sent by operator (${s.via}) — confirmed in ${dt}s`, id, sig);
      setBusy((b) => ({ ...b, [id]: { text: `confirmed in ${dt}s ✓`, url: cache.activity[0]?.url } }));
      void cache.syncNow();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      cache.note("error", `${id} ${action} failed: ${msg.slice(0, 80)}`, id);
      setBusy((b) => ({ ...b, [id]: { text: msg.slice(0, 90), err: true } }));
    }
  }

  const health = st.lastError ? "err" : st.lastSyncAt && Date.now() - st.lastSyncAt < flags.CONSENT_CACHE_SYNC_MS * 3 ? "ok" : "warn";

  return (
    <>
      <h3>Consent <span className="muted">· Solana {st.cluster} · cache</span></h3>
      <div className="chainbar">
        <span className={"dot " + health} title={st.lastError || "synced"} />
        <span>poll {ago(st.lastSyncAt)} · slot {st.lastSyncSlot || "—"}</span>
        <span>· push {st.subscribed ? (st.pushes ? ago(st.lastPushAt) : "listening") : "off"}</span>
        <a href={st.programUrl} target="_blank" rel="noreferrer" title={st.programId}>program ↗</a>
      </div>
      {st.lastError && <div className="chainerr">RPC: {st.lastError.slice(0, 120)} — cache keeps last known state; unknown ⇒ blur</div>}

      {!records.length && <div className="muted">no records yet — run <code>npm run seed</code> in registry/</div>}
      {records.map((r) => {
        const s = signerFor(r);
        const b = busy[r.badgeId];
        const ov = cache.overridesFor(r.badgeId).find((o) => o.eventId === flags.EVENT_ID);
        const effective = ov ? ov.consent : r.consent;
        return (
          <div className="rec" key={r.badgeId}>
            <div className="rec-head">
              <b>{r.badgeId}</b>
              <span className={"pill " + (effective ? "opt_in" : "opt_out")}>{effective ? "opt_in" : "opt_out"}</span>
              {ov && <span className="muted" title={`per-event override for ${flags.EVENT_ID}`}>(event override)</span>}
              <span className="muted">rev {r.revision} · {ago(r.updatedAt * 1000)}</span>
            </div>
            <div className="rec-meta muted">
              owner {short(r.owner)} · {keys?.labels.get(r.badgeId) ?? ""}
              {s ? <span className="via"> · signer: {s.via}</span> : <span className="via warn"> · no signer for this owner</span>}
            </div>
            <div className="rec-actions">
              <button className="toggle opt_in" disabled={!s || effective} onClick={() => act(r, "grant")}>grant</button>
              <button className="toggle opt_out" disabled={!s || !effective} onClick={() => act(r, "revoke")}>revoke</button>
              <button className="toggle danger" disabled={!s} onClick={() => act(r, "close")} title="delete the record — rent back to owner; app fail-safes to blur">close</button>
              {b && (b.url ? <a className={"status"} href={b.url} target="_blank" rel="noreferrer">{b.text} ↗</a> : <span className={"status" + (b.err ? " err" : "")}>{b.text}</span>)}
            </div>
          </div>
        );
      })}

      <div className="chainopts">
        <label title="Badge signs a 33-byte message with its own key; the relayer pays; the program verifies the Ed25519 signature on-chain (no SOL on the badge)">
          <input type="checkbox" checked={delegated} disabled={!keys?.relayer} onChange={(e) => setDelegated(e.target.checked)} /> badge-signed + relayed
        </label>
        {wallet ? (
          walletPk ? <span className="muted">wallet {short(walletPk)}</span> : <button className="toggle" onClick={connectWallet}>connect wallet</button>
        ) : (
          <span className="muted">no wallet extension</span>
        )}
        {busy._wallet && <span className="status err">{busy._wallet.text}</span>}
      </div>

      <h3>Chain activity <span className="muted">· ws push + poll</span></h3>
      {cache.activity.slice(0, 8).map((a) => (
        <div className={"act " + a.kind} key={a.id}>
          <span className="t">{new Date(a.at).toLocaleTimeString()}</span>
          <span className="x">{a.text}</span>
          {a.url && <a href={a.url} target="_blank" rel="noreferrer">tx ↗</a>}
        </div>
      ))}
      {!cache.activity.length && <div className="muted">waiting for the first sync…</div>}
    </>
  );
}
