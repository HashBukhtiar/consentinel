// The badge IDE splits `--[==[badge-app … ]==]` off the top of a .lua file into
// `manifest.cfg` and keeps the rest as `main.lua`. This parser mirrors that
// split so the setup panel can describe what an organizer is about to push.
//
// Pure on purpose — it takes the source as an argument instead of importing it
// — so a test can read the real firmware file and prove the panel will report
// it correctly. A panel that quietly shows "v?" is worse than no panel: the
// organizer can't tell a stale app from a current one.

export interface BadgeApp {
  /** manifest.cfg keys: slug, name, icon, api, heap_kb, version, … */
  manifest: Record<string, string>;
  /** the file as the IDE sees it, in bytes */
  bytes: number;
  /** false when the `--[==[badge-app` header is missing or malformed */
  ok: boolean;
}

const HEADER = /^--\[==\[badge-app\r?\n([\s\S]*?)\r?\n\]==\]/;

export function parseBadgeApp(src: string): BadgeApp {
  const block = HEADER.exec(src);
  const manifest: Record<string, string> = {};
  for (const line of (block?.[1] ?? "").split(/\r?\n/)) {
    const kv = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (kv) manifest[kv[1]] = kv[2].trim();
  }
  // slug is what the badge keys an installed app on; without it the IDE has
  // nothing to install into, so treat its absence as a failed parse.
  return { manifest, bytes: new TextEncoder().encode(src).length, ok: !!manifest.slug };
}
