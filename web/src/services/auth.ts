import Keycloak from "keycloak-js";

const keycloak = new Keycloak({
  url: import.meta.env.VITE_KEYCLOAK_URL || "http://localhost:8080",
  realm: import.meta.env.VITE_KEYCLOAK_REALM || "stable",
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID || "stable-web",
});

// keycloak-js 26.x still probes /3p-cookies/step1.html which the Keycloak
// server no longer ships (404 noise in the console). The probe guard skips
// when endpoints.thirdPartyCookiesIframe isn't a function, so intercept the
// endpoints assignment during init() and null out that one method. PKCE +
// silentCheckSsoRedirectUri cover our SSO flow without the iframe check.
let endpointsStore: Record<string, unknown> | null = null;
Object.defineProperty(keycloak, "endpoints", {
  configurable: true,
  get() {
    return endpointsStore;
  },
  set(value: Record<string, unknown>) {
    if (value && typeof value === "object") {
      value.thirdPartyCookiesIframe = null;
    }
    endpointsStore = value;
  },
});

let initialized = false;
let refreshIntervalId: ReturnType<typeof setInterval> | null = null;

const TOKEN_REFRESH_INTERVAL_MS = 30_000;
const TOKEN_MIN_VALIDITY_S = 60;

export interface UserProfile {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  roles: string[];
  avatarUrl: string | null;
}

export async function initAuth(): Promise<boolean> {
  if (initialized) {
    return keycloak.authenticated ?? false;
  }

  // Local preview without a Keycloak server: `vite dev` with no VITE_KEYCLOAK_URL
  // set. Skip the SSO redirect (which would bounce to a non-existent IdP and
  // error out) so App's dev-mock seed renders the UI. `import.meta.env.DEV` is
  // statically false in production builds, so this branch is dead-code-eliminated
  // and can never weaken the real auth flow.
  if (import.meta.env.DEV && !import.meta.env.VITE_KEYCLOAK_URL) {
    throw new Error("dev: Keycloak disabled (no VITE_KEYCLOAK_URL)");
  }

  // We don't use silentCheckSsoRedirectUri because Cloudflare injects
  // X-Frame-Options: SAMEORIGIN on auth.unicorncommander.ai, which blocks
  // the hidden iframe. Without it, check-sso does a top-level redirect the
  // first time — no iframe, no frame-ancestors issue.
  const authenticated = await keycloak.init({
    onLoad: "check-sso",
    checkLoginIframe: false,
    pkceMethod: "S256",
  });

  initialized = true;

  if (authenticated) {
    startTokenRefresh();
  }

  keycloak.onTokenExpired = () => {
    keycloak.updateToken(TOKEN_MIN_VALIDITY_S).catch(() => {
      logout();
    });
  };

  keycloak.onAuthLogout = () => {
    stopTokenRefresh();
  };

  return authenticated;
}

function startTokenRefresh(): void {
  stopTokenRefresh();
  refreshIntervalId = setInterval(() => {
    keycloak.updateToken(TOKEN_MIN_VALIDITY_S).catch(() => {
      logout();
    });
  }, TOKEN_REFRESH_INTERVAL_MS);
}

function stopTokenRefresh(): void {
  if (refreshIntervalId !== null) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
}

export function login(): void {
  keycloak.login({
    redirectUri: window.location.origin,
  });
}

export function logout(): void {
  stopTokenRefresh();
  keycloak.logout({
    redirectUri: window.location.origin,
  });
}

export function getToken(): string | null {
  return keycloak.token ?? null;
}

export function isAuthenticated(): boolean {
  return keycloak.authenticated ?? false;
}

export function hasRole(role: string): boolean {
  return keycloak.hasRealmRole(role) || keycloak.hasResourceRole(role);
}

export function getUserProfile(): UserProfile | null {
  if (!keycloak.authenticated || !keycloak.tokenParsed) {
    return null;
  }

  const parsed = keycloak.tokenParsed as Record<string, unknown>;
  const realmRoles = (
    (parsed.realm_access as { roles?: string[] } | undefined)?.roles ?? []
  ).filter((r) => r !== "offline_access" && r !== "uma_authorization");

  return {
    id: (parsed.sub as string) ?? "",
    username: (parsed.preferred_username as string) ?? "",
    email: (parsed.email as string) ?? "",
    firstName: (parsed.given_name as string) ?? "",
    lastName: (parsed.family_name as string) ?? "",
    displayName:
      (parsed.name as string) ??
      (parsed.preferred_username as string) ??
      "User",
    roles: realmRoles,
    avatarUrl: (parsed.picture as string) ?? null,
  };
}

export async function refreshToken(): Promise<string | null> {
  const refreshed = await keycloak.updateToken(TOKEN_MIN_VALIDITY_S);
  if (refreshed) {
    return keycloak.token ?? null;
  }
  return keycloak.token ?? null;
}

export { keycloak };
