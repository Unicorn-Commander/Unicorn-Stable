/**
 * The service worker is registered at a URL that names the build:
 * `/sw.js?v=<sha>`.
 *
 * Why: Cloudflare served /sw.js from a copy it cached on 2026-08-17 under
 * the old "public, max-age=31536000, immutable" header, so the 2026-09-21
 * change to the worker (343d0e7) never reached a browser, and the edge copy
 * cannot age out by itself. The origin now answers sw.js with no-cache
 * (56c2450); a URL that changes with each release is a new cache key, which
 * the edge fetches fresh under that header.
 *
 * The scope stays "/": a registration is keyed by its scope, so the browser
 * updates the one registration to the new script URL rather than adding a
 * second worker next to the old one.
 */

export const SERVICE_WORKER_PATH = "/sw.js";
export const SERVICE_WORKER_SCOPE = "/";
/** What a build that was not given its sha (the dev server) registers: stable. */
export const DEV_BUILD_VERSION = "dev";

export function buildVersion(sha: string | null | undefined): string {
  const value = (sha ?? "").trim();
  return value || DEV_BUILD_VERSION;
}

export function serviceWorkerUrl(sha: string | null | undefined): string {
  return `${SERVICE_WORKER_PATH}?v=${encodeURIComponent(buildVersion(sha))}`;
}

/** Best-effort: a registration that fails never affects the running app. */
export async function registerServiceWorker(
  container: Pick<ServiceWorkerContainer, "register"> | null | undefined,
  sha: string | null | undefined,
): Promise<ServiceWorkerRegistration | null> {
  if (!container) return null;
  try {
    return await container.register(serviceWorkerUrl(sha), { scope: SERVICE_WORKER_SCOPE });
  } catch {
    return null;
  }
}
