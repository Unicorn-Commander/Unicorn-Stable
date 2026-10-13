/**
 * Hosts supplied by the runtime instance descriptor.
 *
 * The public bundle must not know which deployment serves it.  The instance
 * descriptor is loaded before the authenticated shell, so URL safety checks
 * can use the same deployment-owned origins without baking an allowlist into
 * this bundle.
 */

export interface RuntimeHostConfig {
  webOrigin?: string | null;
  apiBaseUrl?: string | null;
  wsUrl?: string | null;
  keycloak?: { url?: string | null } | null;
  trustedOrigins?: string | readonly string[] | null;
}

const exactHosts = new Set<string>();
const suffixHosts = new Set<string>();

function addValue(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(addValue);
    return;
  }
  if (typeof value !== "string") return;

  for (const item of value.split(",")) {
    const candidate = item.trim();
    if (!candidate) continue;
    const wildcard = candidate.startsWith("*.");
    const input = wildcard ? candidate.slice(2) : candidate;
    let parsed: URL;
    try {
      parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
      continue;
    }
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!host) continue;
    (wildcard ? suffixHosts : exactHosts).add(host);
  }
}

export function configureRuntimeHosts(instances: readonly RuntimeHostConfig[]): void {
  exactHosts.clear();
  suffixHosts.clear();
  for (const instance of instances) {
    addValue(instance.webOrigin);
    addValue(instance.apiBaseUrl);
    addValue(instance.wsUrl);
    addValue(instance.keycloak?.url);
    addValue(instance.trustedOrigins);
  }
}

/** Return true when a parsed URL hostname belongs to the active descriptor. */
export function isRuntimeHostAllowed(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  if (typeof window !== "undefined" && normalized === window.location.hostname.toLowerCase()) {
    return true;
  }
  if (exactHosts.has(normalized)) return true;
  return [...suffixHosts].some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}
