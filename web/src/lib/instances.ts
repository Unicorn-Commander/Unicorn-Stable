/**
 * Federated instance IDENTITY — the untrusted half of the server rail.
 *
 * `@/services/instances` owns *routing* (which origins exist, which Keycloak
 * they use). This module owns *branding* (logo, display name, description),
 * which is fetched at runtime from each peer's own
 * `GET /api/v1/instance/meta` so that a server's own admin controls how their
 * server appears — see `server/app/api/instance_meta.py` for why that beats
 * baking it into the mounted `instances.json`.
 *
 * EVERYTHING IN HERE IS ATTACKER-CONTROLLED. A federated Stable is somebody
 * else's box; if it turns hostile it will answer these two requests with
 * whatever it likes. The rules this module enforces:
 *
 *  1. **We never follow a URL a peer gave us.** The meta document has no URL
 *     field, and we ignore one if a peer invents it. The logo address is
 *     *derived* from the apiBaseUrl the user already chose to federate with, so
 *     a peer cannot beacon every viewer's IP at a third-party tracker, probe
 *     the viewer's LAN, or smuggle a `javascript:`/`data:` URI into an `<img>`.
 *  2. **The logo is fetched, not `<img src>`'d.** `redirect: "error"` means a
 *     302 to a tracker fails instead of leaking; the bytes are then checked to
 *     be a real raster type and handed to the DOM as a blob: URL. `<img src>`
 *     would follow redirects silently and give us no type control.
 *  3. **`image/svg+xml` is refused.** SVG executes script in some rendering
 *     paths and is never worth it for a 48px rail icon.
 *  4. **Text is sanitised twice** — once by the honest server on write, once
 *     here on read, because a hostile peer runs its own code. Bidi overrides
 *     are stripped (they let "evil.example.com" paint itself as a trusted name
 *     in the rail), as are control/invisible characters, and length is capped.
 *  5. **Failure is silent and bounded.** Short timeout, size caps, no throw. A
 *     peer that is down, slow, or hostile gets the static fallback label and
 *     never blocks or breaks the rail.
 *
 * The residual, honest risk: fetching meta tells that peer we are online, from
 * this IP. That is not new information — the rail already polls the same host
 * for cross-server unread counts, and the user explicitly added it.
 */

import type { StableInstance } from "@/services/instances";

export interface InstanceMeta {
  /** Admin-set display name; "" when unset (fall back to the static name). */
  name: string;
  /** Admin-set description, plain text, already capped. "" when unset. */
  description: string;
  /** Admin-set accent, validated `#rrggbb`, or null (fall back to identityFor). */
  accent: string | null;
  /** True when the peer reports a logo. The URL is derived, never supplied. */
  logo: boolean;
  logoVersion: string | null;
}

export const NAME_MAX = 40;
export const DESCRIPTION_MAX = 280;

const META_TIMEOUT_MS = 4000;
const LOGO_TIMEOUT_MS = 6000;
const MAX_META_BYTES = 8 * 1024;
const MAX_LOGO_BYTES = 512 * 1024;

/** Raster only — mirrors the server's allow-list. SVG is deliberately absent. */
const LOGO_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

/**
 * Bidi overrides + invisible formatting characters. In a server name these are
 * a spoofing primitive: U+202E reverses the rest of the string, so a rail entry
 * can render as a name it is not. Stripped unconditionally.
 */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], // C0 controls
  [0x7f, 0x9f], // DEL + C1 controls
  [0xad, 0xad], // soft hyphen
  [0x61c, 0x61c], // arabic letter mark
  [0x200b, 0x200f], // zero-width + LRM/RLM
  [0x202a, 0x202e], // bidi embedding/override -- the rail-spoofing primitive
  [0x2060, 0x2064], // word joiner + invisible operators
  [0x2066, 0x206f], // bidi isolates + deprecated formatting
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function stripUnsafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a) {
      out += ch; // newlines are handled (kept or collapsed) by the caller
      continue;
    }
    if (UNSAFE_RANGES.some(([lo, hi]) => code >= lo && code <= hi)) continue;
    out += ch;
  }
  return out;
}

/**
 * Reduce untrusted text to something safe to render as a text node.
 * Note this is NOT HTML escaping — we never build HTML from this. React renders
 * the result as a text node, so markup in it is inert by construction.
 */
export function sanitizeLabel(
  value: unknown,
  limit: number,
  { allowNewlines = false }: { allowNewlines?: boolean } = {},
): string {
  if (typeof value !== "string") return "";
  let text = stripUnsafe(value.normalize("NFC"));
  text = allowNewlines
    ? text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/[^\S\n]{2,}/g, " ")
    : text.replace(/\s+/g, " ");
  return text.trim().slice(0, limit);
}

/** The host a user should judge a server by. Falsifiable names, unfalsifiable host. */
export function instanceHost(instance: StableInstance): string {
  try {
    return new URL(instance.webOrigin).host;
  } catch {
    return instance.webOrigin;
  }
}

/** The name to show: admin-set if present, else the static list's name. */
export function displayName(instance: StableInstance, meta?: InstanceMeta): string {
  return meta?.name || sanitizeLabel(instance.name, NAME_MAX) || instanceHost(instance);
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Fetch a peer's self-declared branding. Never throws; returns null when the
 * peer is unreachable, slow, non-JSON, oversized, or answering nonsense.
 */
export async function fetchInstanceMeta(instance: StableInstance): Promise<InstanceMeta | null> {
  const { signal, done } = withTimeout(META_TIMEOUT_MS);
  try {
    const response = await fetch(`${instance.apiBaseUrl}/api/v1/instance/meta`, {
      signal,
      // No cookies, no tokens: branding is public and this request must not be
      // able to act with the viewer's authority on a hostile peer.
      credentials: "omit",
      redirect: "error",
      cache: "no-cache",
    });
    if (!response.ok) return null;
    if (!(response.headers.get("content-type") ?? "").includes("json")) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_META_BYTES) return null;
    const raw: unknown = JSON.parse(new TextDecoder().decode(buffer));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    return {
      name: sanitizeLabel(record.name, NAME_MAX),
      description: sanitizeLabel(record.description, DESCRIPTION_MAX, { allowNewlines: true }),
      accent: typeof record.accent === "string" && /^#[0-9a-f]{6}$/i.test(record.accent.trim())
        ? record.accent.trim().toLowerCase()
        : null,
      logo: record.logo === true,
      // Cache-buster only; never interpolated anywhere but a query value.
      logoVersion:
        typeof record.logo_version === "string" && /^[a-z0-9]{1,32}$/i.test(record.logo_version)
          ? record.logo_version
          : null,
    };
  } catch {
    // Down, blocked by CORS, DNS-dead, or actively hostile — all the same to us.
    return null;
  } finally {
    done();
  }
}

/**
 * Fetch a peer's logo into a blob: URL.
 *
 * The URL is DERIVED from the instance's own apiBaseUrl — never read from the
 * meta document — and `redirect: "error"` means a peer cannot bounce us to a
 * third party. The bytes must claim an allowed raster type AND the Blob we hand
 * the DOM is re-typed to that value, so a mislabelled `image/svg+xml` payload
 * can never reach an <img> as SVG.
 *
 * Caller owns the returned URL and must URL.revokeObjectURL() it.
 */
export async function fetchInstanceLogo(
  instance: StableInstance,
  meta: InstanceMeta | null,
): Promise<string | null> {
  if (!meta?.logo) return null;
  const { signal, done } = withTimeout(LOGO_TIMEOUT_MS);
  try {
    const version = meta.logoVersion ? `?v=${encodeURIComponent(meta.logoVersion)}` : "";
    const response = await fetch(`${instance.apiBaseUrl}/api/v1/instance/logo${version}`, {
      signal,
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!LOGO_MIME.has(type)) return null;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_LOGO_BYTES) return null;
    const blob = await response.blob();
    // Re-check after the body lands: content-length is a hint, not a promise.
    if (blob.size === 0 || blob.size > MAX_LOGO_BYTES) return null;
    // Re-type explicitly so the object URL cannot inherit a scriptable type.
    return URL.createObjectURL(blob.slice(0, blob.size, type));
  } catch {
    return null;
  } finally {
    done();
  }
}
