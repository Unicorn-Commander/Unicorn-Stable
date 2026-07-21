import Keycloak, { type KeycloakInstance } from "keycloak-js";
import type { StableInstance } from "./instances";

const clients = new Map<string, KeycloakInstance>();
/** Ids whose client has FINISHED `init()`. Before that point `authenticated`
 * is meaningless (undefined), so "not authenticated" must not be read as
 * "session is dead" — see getAuthSessionState(). */
const initializedInstances = new Set<string>();
const refreshers = new Map<string, ReturnType<typeof setInterval>>();
let activeInstanceId: string | null = null;
const TOKEN_MIN_VALIDITY_S = 60;
const TOKEN_REFRESH_INTERVAL_MS = 30_000;

function createClient(instance: StableInstance): KeycloakInstance {
  const client = new Keycloak({ url: instance.keycloak.url, realm: instance.keycloak.realm, clientId: instance.keycloak.clientId });
  let endpointsStore: Record<string, unknown> | null = null;
  Object.defineProperty(client, "endpoints", {
    configurable: true,
    get: () => endpointsStore,
    set: (value: Record<string, unknown>) => {
      if (value && typeof value === "object") value.thirdPartyCookiesIframe = null;
      endpointsStore = value;
    },
  });
  clients.set(instance.id, client);
  return client;
}

function refreshFor(id: string): void {
  const client = clients.get(id);
  if (!client) return;
  const old = refreshers.get(id);
  if (old) clearInterval(old);
  refreshers.set(id, setInterval(() => {
    void client.updateToken(TOKEN_MIN_VALIDITY_S).catch(() => stopRefresh(id));
  }, TOKEN_REFRESH_INTERVAL_MS));
}

function stopRefresh(id: string): void {
  const timer = refreshers.get(id);
  if (timer) clearInterval(timer);
  refreshers.delete(id);
}

export async function initInstanceAuth(instance: StableInstance, onLoad: "login-required" | "check-sso"): Promise<boolean> {
  const client = clients.get(instance.id) ?? createClient(instance);
  if (import.meta.env.DEV && !import.meta.env.VITE_KEYCLOAK_URL && onLoad === "login-required") {
    throw new Error("dev: Keycloak disabled (no VITE_KEYCLOAK_URL)");
  }
  const authenticated = await client.init({
    onLoad,
    checkLoginIframe: false,
    pkceMethod: "S256",
    silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
  });
  initializedInstances.add(instance.id);
  if (authenticated) refreshFor(instance.id);
  client.onTokenExpired = () => { void client.updateToken(TOKEN_MIN_VALIDITY_S); };
  client.onAuthLogout = () => stopRefresh(instance.id);
  return authenticated;
}

export function setActiveAuthInstance(id: string): void { activeInstanceId = id; }
export function getInstanceToken(id: string): string | null { return clients.get(id)?.token ?? null; }
export async function refreshInstanceToken(id: string): Promise<string | null> {
  const client = clients.get(id);
  if (!client?.authenticated) return null;
  await client.updateToken(TOKEN_MIN_VALIDITY_S);
  return client.token ?? null;
}

/**
 * Point a second instance id at an already-initialized client. Instances that
 * share a Keycloak (same url+realm+clientId) share one session + token, so the
 * home login is valid for them — we skip a separate check-sso, whose hidden
 * iframe Cloudflare blocks via X-Frame-Options on the IdP. The alias keeps a
 * live, auto-refreshed token after a later switch (the source client's refresher
 * owns it).
 */
export function aliasInstanceAuth(aliasId: string, sourceId: string): boolean {
  const client = clients.get(sourceId);
  if (!client) return false;
  clients.set(aliasId, client);
  // The alias shares the SOURCE's client, so it shares its init state too.
  // Without this the alias would look "initialising" forever and a dead
  // session on it could never be recognised as terminal.
  if (initializedInstances.has(sourceId)) initializedInstances.add(aliasId);
  return true;
}

/** Compatibility entry point for code that still uses the original singleton auth API. */
export async function initAuth(): Promise<boolean> {
  const instance: StableInstance = {
    id: "legacy",
    name: "Stable",
    webOrigin: window.location.origin,
    apiBaseUrl: import.meta.env.VITE_API_BASE_URL || "",
    keycloak: {
      url: import.meta.env.VITE_KEYCLOAK_URL || "http://localhost:8080",
      realm: import.meta.env.VITE_KEYCLOAK_REALM || "stable",
      clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID || "stable-web",
    },
  };
  const authenticated = await initInstanceAuth(instance, "check-sso");
  setActiveAuthInstance(instance.id);
  return authenticated;
}
export function login(): void { clients.get(activeInstanceId ?? "")?.login({ redirectUri: window.location.origin }); }
export function logout(): void {
  if (activeInstanceId) stopRefresh(activeInstanceId);
  void clients.get(activeInstanceId ?? "")?.logout({ redirectUri: window.location.origin });
}
export function getToken(): string | null { return activeInstanceId ? getInstanceToken(activeInstanceId) : null; }
export async function refreshToken(): Promise<string | null> { return activeInstanceId ? refreshInstanceToken(activeInstanceId) : null; }
export function isAuthenticated(): boolean { return activeInstanceId ? clients.get(activeInstanceId)?.authenticated ?? false : false; }

/**
 * Why this exists and why `isAuthenticated()` is NOT enough.
 *
 * `isAuthenticated()` collapses three very different situations into one
 * `false`: "there is no active instance yet", "its client has not finished
 * init()", and "the session is dead". Callers that must decide between RETRY
 * and GIVE UP need them separated, and getting it wrong is a silent-failure
 * bug in both directions — treat "initialising" as dead and a boot race
 * strands the user behind a false "session expired"; treat "dead" as
 * transient and the client retries forever with no socket and no banner.
 *
 * `expired` specifically covers the keycloak-js `clearToken()` path: on a 400
 * (invalid_grant) from the refresh endpoint keycloak-js clears the token AND
 * sets `authenticated = false` (keycloak.js:1591, verified in the installed
 * 26.2.3). After that `refreshInstanceToken()` returns null WITHOUT throwing,
 * so a caller watching only for a rejection never learns the session is gone.
 */
export type AuthSessionState = "no-session" | "initialising" | "authenticated" | "expired";
export function getAuthSessionState(): AuthSessionState {
  if (!activeInstanceId) return "no-session";
  const client = clients.get(activeInstanceId);
  if (!client) return "no-session";
  if (!initializedInstances.has(activeInstanceId)) return "initialising";
  return client.authenticated ? "authenticated" : "expired";
}

export interface UserProfile { id: string; username: string; email: string; firstName: string; lastName: string; displayName: string; roles: string[]; avatarUrl: string | null; }
export function getUserProfile(): UserProfile | null {
  const parsed = activeInstanceId ? clients.get(activeInstanceId)?.tokenParsed as Record<string, unknown> | undefined : undefined;
  if (!parsed) return null;
  const roles = ((parsed.realm_access as { roles?: string[] } | undefined)?.roles ?? []).filter((role) => !["offline_access", "uma_authorization"].includes(role));
  return { id: String(parsed.sub ?? ""), username: String(parsed.preferred_username ?? ""), email: String(parsed.email ?? ""), firstName: String(parsed.given_name ?? ""), lastName: String(parsed.family_name ?? ""), displayName: String(parsed.name ?? parsed.preferred_username ?? "User"), roles, avatarUrl: typeof parsed.picture === "string" ? parsed.picture : null };
}
export function hasRole(role: string): boolean { const client = activeInstanceId ? clients.get(activeInstanceId) : undefined; return !!client && (client.hasRealmRole(role) || client.hasResourceRole(role)); }
export const keycloak = { get token() { return getToken(); } };
