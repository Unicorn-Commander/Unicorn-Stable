import { configureRuntimeHosts } from "@/lib/runtimeHosts";

export interface StableInstance {
  id: string;
  name: string;
  icon?: string;
  webOrigin: string;
  apiBaseUrl: string;
  wsUrl?: string;
  keycloak: { url: string; realm: string; clientId: string };
  trustedOrigins?: string | string[];
  analyticsScriptUrl?: string;
  analyticsWebsiteId?: string;
  appUrl?: string;
  marketingBaseUrl?: string;
  contactEmail?: string;
  sourceUrl?: string;
}

function envInstance(): StableInstance {
  const webOrigin = window.location.origin;
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "";
  return {
    id: "home",
    name: "Stable",
    icon: "S",
    webOrigin,
    apiBaseUrl,
    keycloak: {
      url: import.meta.env.VITE_KEYCLOAK_URL || "http://localhost:8080",
      realm: import.meta.env.VITE_KEYCLOAK_REALM || "stable",
      clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID || "stable-web",
    },
  };
}

export function normalizeInstance(instance: StableInstance): StableInstance {
  const apiBaseUrl = instance.apiBaseUrl || instance.webOrigin;
  const wsUrl = instance.wsUrl || apiBaseUrl.replace(/^http/, "ws") + "/ws";
  return { ...instance, apiBaseUrl, wsUrl };
}

export async function loadInstances(): Promise<StableInstance[]> {
  try {
    const response = await fetch("/instances.json", { cache: "no-store" });
    if (response.ok) {
      const parsed = (await response.json()) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const instances = parsed.map((item) => normalizeInstance(item as StableInstance));
        configureRuntimeHosts(instances);
        return instances;
      }
    }
  } catch {
    // A missing instances.json is the expected single-instance fallback.
  }
  const instances = [normalizeInstance(envInstance())];
  configureRuntimeHosts(instances);
  return instances;
}

export function instanceForCurrentOrigin(instances: StableInstance[]): StableInstance {
  const origin = window.location.origin.replace(/\/$/, "");
  return instances.find((item) => item.webOrigin.replace(/\/$/, "") === origin) ?? instances[0]!;
}

/** Two instances share a Keycloak session (and therefore a token) when their
 *  url + realm + clientId all match — true for our fleet (one uchub realm +
 *  stable-web client across every instance). */
export function sameKeycloak(a: StableInstance, b: StableInstance): boolean {
  return (
    a.keycloak.url === b.keycloak.url &&
    a.keycloak.realm === b.keycloak.realm &&
    a.keycloak.clientId === b.keycloak.clientId
  );
}
