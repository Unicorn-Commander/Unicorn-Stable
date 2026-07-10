import { create } from "zustand";
import { loadInstances, instanceForCurrentOrigin, normalizeInstance, sameKeycloak, type StableInstance } from "@/services/instances";
import { aliasInstanceAuth, getInstanceToken, initInstanceAuth, setActiveAuthInstance } from "@/services/auth";
import { ws } from "@/services/websocket";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useKnowledgeStore } from "@/stores/knowledgeStore";

export type InstanceAuthStatus = "pending" | "authenticated" | "unauthenticated" | "error";
export interface InstanceAuthState { status: InstanceAuthStatus; token: string | null; }

interface FederationState {
  instances: StableInstance[];
  accessibleInstances: StableInstance[];
  auth: Record<string, InstanceAuthState>;
  activeInstanceId: string | null;
  initialized: boolean;
  switching: boolean;
  initialize: () => Promise<boolean>;
  switchInstance: (id: string) => Promise<void>;
  addInstance: (origin: string) => Promise<void>;
}

const ACTIVE_INSTANCE_KEY = "stable.active-instance.v1";

export const useFederationStore = create<FederationState>((set, get) => ({
  instances: [],
  accessibleInstances: [],
  auth: {},
  activeInstanceId: null,
  initialized: false,
  switching: false,

  initialize: async () => {
    if (get().initialized) {
      return get().auth[get().activeInstanceId ?? ""]?.status === "authenticated";
    }
    const instances = await loadInstances();
    const home = instanceForCurrentOrigin(instances);
    const savedId = localStorage.getItem(ACTIVE_INSTANCE_KEY);
    const initial = instances.find((item) => item.id === savedId) ?? home;
    // Interim active = home (aligns with the auth-active instance below) until
    // the accessible set resolves and the final active is chosen at the end.
    set({ instances, activeInstanceId: home.id, auth: Object.fromEntries(instances.map((item) => [item.id, { status: "pending", token: null }])) });

    // Authenticate HOME first (login-required → a top-level redirect, no iframe,
    // so it isn't blocked by Cloudflare's X-Frame-Options on the IdP). A genuine
    // init failure (IdP unreachable) is allowed to PROPAGATE so AuthGate renders
    // its "Authentication unavailable / Retry" screen; an UNauthenticated user is
    // NOT an error here (login-required top-level-redirects to Keycloak instead).
    const homeAuthed = await initInstanceAuth(home, "login-required");
    setActiveAuthInstance(home.id);
    const homeToken = getInstanceToken(home.id);

    const results = await Promise.all(instances.map(async (instance) => {
      const isHome = instance.id === home.id;
      if (isHome) {
        return { instance, status: homeAuthed ? ("authenticated" as const) : ("unauthenticated" as const) };
      }
      try {
        let token: string | null = null;
        if (homeAuthed && sameKeycloak(instance, home)) {
          // Shared Keycloak (our fleet: one uchub realm + stable-web client) →
          // the home token is valid at this backend. Reuse it instead of a
          // check-sso iframe (which Cloudflare blocks), aliasing this id to the
          // home client so a later switch keeps a live, auto-refreshed token.
          aliasInstanceAuth(instance.id, home.id);
          token = homeToken;
        } else {
          const authenticated = await initInstanceAuth(instance, "check-sso");
          token = authenticated ? getInstanceToken(instance.id) : null;
        }
        if (!token) return { instance, status: "unauthenticated" as const };
        // `/rooms` is an existing authenticated route and the cheapest membership probe.
        const response = await fetch(`${instance.apiBaseUrl}/api/v1/rooms`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        return { instance, status: response.ok ? ("authenticated" as const) : ("unauthenticated" as const) };
      } catch {
        return { instance, status: "error" as const };
      }
    }));

    const accessible = results.filter((result) => result.status === "authenticated").map((result) => result.instance);
    const auth = Object.fromEntries(results.map((result) => [result.instance.id, { status: result.status, token: getInstanceToken(result.instance.id) }]));
    const active = accessible.some((item) => item.id === initial.id) ? initial : accessible[0] ?? home;
    set({ auth, accessibleInstances: accessible.length > 0 ? accessible : [home], activeInstanceId: active.id, initialized: true });
    setActiveAuthInstance(active.id);
    localStorage.setItem(ACTIVE_INSTANCE_KEY, active.id);
    return accessible.some((item) => item.id === active.id);
  },

  switchInstance: async (id) => {
    const next = get().accessibleInstances.find((item) => item.id === id);
    if (!next || id === get().activeInstanceId) return;
    set({ switching: true });
    // Yield a macrotask so React paints the "Switching…" overlay + rail spinner
    // before the synchronous store swap below (otherwise both switching set()s
    // batch into a single commit and the indicator never renders).
    await new Promise((resolve) => setTimeout(resolve, 0));
    ws.disconnect();
    useAppStore.getState().resetForServer();
    useCallUiStore.getState().resetForServer();
    // Canvas + Knowledge hold live server-scoped data (artifacts, collections)
    // that must not linger while connected to a different backend. categoryStore
    // is deliberately NOT reset: it's persisted and keyed by globally-unique room
    // UUIDs, so it's inert across servers and wiping it would lose the user's
    // saved channel categories.
    useCanvasStore.getState().resetForServer();
    useKnowledgeStore.getState().resetForServer();
    setActiveAuthInstance(id);
    set({ activeInstanceId: id });
    localStorage.setItem(ACTIVE_INSTANCE_KEY, id);
    ws.connect();
    set({ switching: false });
  },

  addInstance: async (origin) => {
    const cleanOrigin = origin.trim().replace(/\/$/, "");
    if (!/^https?:\/\//i.test(cleanOrigin)) return;
    if (get().instances.some((item) => item.webOrigin.replace(/\/$/, "") === cleanOrigin)) return;
    const template = get().instances[0];
    if (!template) return;
    const hostname = new URL(cleanOrigin).hostname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    const instance = normalizeInstance({ ...template, id: hostname || `instance-${Date.now()}`, name: hostname || "Stable instance", webOrigin: cleanOrigin, apiBaseUrl: cleanOrigin });
    try {
      const home = instanceForCurrentOrigin(get().instances);
      let token: string | null = null;
      if (sameKeycloak(instance, home) && getInstanceToken(home.id)) {
        // Same Keycloak as home → reuse the home token (avoids the CF-blocked
        // check-sso iframe); alias so a later switch keeps a live token.
        aliasInstanceAuth(instance.id, home.id);
        token = getInstanceToken(home.id);
      } else {
        const authenticated = await initInstanceAuth(instance, "check-sso");
        token = authenticated ? getInstanceToken(instance.id) : null;
      }
      if (!token) return;
      const response = await fetch(`${instance.apiBaseUrl}/api/v1/rooms`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) return;
      set((state) => ({ instances: [...state.instances, instance], accessibleInstances: [...state.accessibleInstances, instance], auth: { ...state.auth, [instance.id]: { status: "authenticated", token } } }));
    } catch {
      // An instance that cannot silently authenticate is not added to the rail.
    }
  },
}));
