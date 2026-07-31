/**
 * Static pack of REAL brand agent avatars, exported from Brand-Ops (the
 * identity factory: brand-ops.magicunicorn.dev). Brand-Ops sits behind SSO, so
 * its avatar routes cannot be hotlinked from an <img>; the 256px derivatives
 * ship with the web bundle instead and live federation stays a backend task
 * (P-00115 — enrich the Brigade roster's avatar_url server-side).
 *
 * Every entry was generated through Brand-Ops' compliance-checked pipeline
 * (all pass the color-palette gate at 100). Agents without a pack entry fall
 * back to the animated procedural unicorn (UnicornAvatar).
 */
const PACK: Record<string, string> = {
  // -v2: reference-conditioned rerolls in the chibi sticker style (the first
  // pass generated unreferenced neon emblems; new filenames also step around
  // the CDN's cache of the old bytes).
  majik: "/agent-avatars/majik-v2.png",
  sidekick: "/agent-avatars/sidekick-v2.png",
  "corporal qwen": "/agent-avatars/corporal-qwen-v2.png",
  "cpl. colophon": "/agent-avatars/cpl-colophon.png",
  "sgt. quill": "/agent-avatars/sgt-quill.png",
  "prudence finch": "/agent-avatars/prudence-finch.png",
  "perrywinkle spector": "/agent-avatars/perrywinkle-spector.png",
  iris: "/agent-avatars/iris.png",
};

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/^chat with\s+/i, "")
    .trim();
}

/** The on-brand avatar URL for an agent display name, or null → fall back to
 *  the animated UnicornAvatar. Accepts room titles like "Chat with Majik". */
export function brandAvatarFor(name: string | null | undefined): string | null {
  if (!name) return null;
  return PACK[normalize(name)] ?? null;
}
