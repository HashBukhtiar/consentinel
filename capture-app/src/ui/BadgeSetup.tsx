import { useRef, useState } from "react";
// The real beacon, inlined at build time. Importing the file itself — rather
// than keeping a copy here — is the whole point: the console can never hand an
// organizer a stale app that the decoder no longer reads.
import beaconLua from "../../../firmware/consentinel-beacon.lua?raw";
import { parseBadgeApp } from "./badgeApp";

const IDE = "https://badge.hackthenorth.com/ide/";

// Parsed from the file itself, so this panel reports what is actually in it
// rather than what someone once typed into this component.
const APP = parseBadgeApp(beaconLua);
const MANIFEST = APP.manifest;
const KB = (APP.bytes / 1024).toFixed(1);

/**
 * Clipboard API needs a secure context. The console is usually localhost, but
 * `vite --host` puts it on a plain-http LAN address for the phone relay, and
 * there the API is missing. Fall back to the old selection copy, and if even
 * that fails say so, because the source block is then the only path.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
}

/**
 * Badge setup lives in the topbar, not in the operator panel: it is what an
 * organizer does *before* there is anything to look at, and burying it under
 * the live logs meant scrolling past the demo to reach it. A native <dialog>
 * gives Esc-to-close and a real backdrop for free, and the extra width lets
 * the Lua source be readable instead of a 388 px slit.
 */
export function BadgeSetup() {
  const dlg = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);       // 14 KB of Lua stays out of the DOM until asked for
  const [src, setSrc] = useState(false);
  const [copied, setCopied] = useState<"" | "ok" | "no">("");

  function show() { setOpen(true); dlg.current?.showModal(); }
  function hide() { dlg.current?.close(); }

  async function onCopy() {
    const ok = await copyText(beaconLua);
    setCopied(ok ? "ok" : "no");
    if (!ok) setSrc(true);
    setTimeout(() => setCopied(""), 2500);
  }

  function onSave() {
    const url = URL.createObjectURL(new Blob([beaconLua], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "consentinel-beacon.lua";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <button className="chip setup-open" onClick={show}
        title="Install the consent beacon on a Hack the North badge">
        <span aria-hidden="true">⚙</span> Badge setup
      </button>

      <dialog ref={dlg} className="setup-dlg"
        onClose={() => { setOpen(false); setSrc(false); }}
        onClick={(e) => { if (e.target === dlg.current) hide(); }}>
        {open && (
          <div className="dlg-body">
            <header className="dlg-head">
              <h2>Put the beacon on a badge</h2>
              <span className="dlg-meta">
                <span className="mono">{MANIFEST.name ?? "Consentinel"} v{MANIFEST.version ?? "?"}</span>
                <span className="muted">slug <code>{MANIFEST.slug ?? "consentinel"}</code> · api {MANIFEST.api ?? "?"} · {KB} KB</span>
              </span>
              <button className="dlg-x" onClick={hide} aria-label="Close">×</button>
            </header>

            <div className="btnrow">
              <button className={"toggle" + (copied === "ok" ? " opt_in" : copied === "no" ? " opt_out" : "")} onClick={onCopy}>
                {copied === "ok" ? "copied ✓" : copied === "no" ? "copy blocked — select below" : "Copy app"}
              </button>
              <button className="toggle" onClick={onSave}>Save .lua</button>
              <a className="toggle" href={IDE} target="_blank" rel="noreferrer">Open badge IDE ↗</a>
            </div>

            <ol className="steps">
              <li>Badge <b>off</b> → plug in a <b>data</b> USB-C cable → switch it back on. Don’t hold START while connecting.</li>
              <li>In the IDE (Chrome), <b>Connect</b> → choose <b>USB JTAG/serial debug unit</b>.</li>
              <li><b>Import app</b> → paste. This <em>replaces</em> the editor contents — hit <b>Download app</b> first if there’s work in there.</li>
              <li><b>Push.</b> Nothing reaches the badge until you click it.</li>
              <li>If <code>{MANIFEST.slug ?? "consentinel"}</code> was already installed, press <b>Reboot</b> as well — manifest keys don’t take effect on Push alone.</li>
              <li>Open <b>{MANIFEST.name ?? "Consentinel"}</b> from the launcher.</li>
            </ol>

            <p className="setup-note">
              On the badge: <b>A</b> opt in/out · <b>UP/DOWN</b> brightness · <b>LEFT</b> LEDs · <b>RIGHT</b> radio · <b>START</b> arms the beacon.
              The three digits it shows are the badge key: the first two are the id to register in the consent panel, the third is a check digit.
            </p>

            <div className="btnrow">
              <button className="toggle danger" onClick={() => setSrc((s) => !s)}>{src ? "Hide source" : "View source"}</button>
            </div>
            {src && <pre className="luasrc" onClick={(e) => getSelection()?.selectAllChildren(e.currentTarget)}>{beaconLua}</pre>}
          </div>
        )}
      </dialog>
    </>
  );
}
