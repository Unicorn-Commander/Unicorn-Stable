/**
 * VRM URL resolution — deliberately NOT `toAvatarSrc`.
 *
 * `toAvatarSrc` rewrites a leading-slash path onto the API origin (`:8400`),
 * because that is where Brigade serves portraits. A VRM shipped in `web/public`
 * lives on the WEB origin, so running it through the avatar helper would 404
 * every time. Same allowlist, different base — hence a second function rather
 * than a flag on the first.
 *
 * The allowlist matters more here than it does for an `<img>`: a glTF is a
 * container format that can reference external buffers and images, so a hostile
 * model is a request generator, not just a tracking pixel. See the loader in
 * VrmAvatar, which additionally refuses to resolve any in-file URI that is not
 * relative to the model's own base path.
 */

const VRM_HOST_SUFFIXES = [
  "magicunicorn.dev",
  "magicunicorn.tech",
  "unicorncommander.ai",
];

/**
 * Hard ceiling on a model download. A VRM head is a few MB; anything past this
 * is either a mistake or an attempt to OOM a phone. Enforced by counting bytes
 * off the response stream, not by trusting Content-Length.
 */
export const MAX_VRM_BYTES = 6 * 1024 * 1024;

/** Abort a model that has not finished in this long and fall down the ladder. */
export const VRM_LOAD_TIMEOUT_MS = 15_000;

/**
 * Absolute URL to fetch a model from, or null when the URL is missing or not
 * one we will talk to. Relative paths resolve against the WEB origin.
 */
export function resolveVrmSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  const raw = url.trim();
  if (!raw) return null;
  // Protocol-relative is an absolute URL wearing a relative costume.
  if (raw.startsWith("//")) return null;
  if (raw.startsWith("/")) {
    const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
    const path = `${base}${raw}`.replace(/\/{2,}/g, "/");
    if (typeof window !== "undefined") {
      try {
        return new URL(path, window.location.origin).href;
      } catch {
        return null;
      }
    }
    return path;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null; // blocks http:, data:, blob:, javascript:
  const host = parsed.hostname.toLowerCase();
  if (typeof window !== "undefined" && host === window.location.hostname) {
    return parsed.href;
  }
  const ok = VRM_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
  return ok ? parsed.href : null;
}
