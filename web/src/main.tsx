import { registerServiceWorker } from "@/lib/serviceWorker";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installDevTranscriptGlobals } from "./lib/devTranscript";
import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "./styles/globals.css";
import "highlight.js/styles/github-dark.css";
import { applyTheme, getStoredTheme, initSystemThemeWatcher } from "./lib/theme";
import { initPalette } from "./stores/themeStore";
import { installInsecureContextCryptoShim } from "./lib/insecureContextCrypto";

// MUST run before any auth code: plain-HTTP LAN self-hosts have no
// crypto.randomUUID / crypto.subtle (insecure context) and keycloak-js 26
// refuses to init without them. No-op on https/localhost.
installInsecureContextCryptoShim();

// Dev-only: expose window.__stableSeedTranscript()/__stableInjectTranscript()
// behind the ?devtranscript flag so the live-transcript panel is testable
// before the real STT producer exists. No-op otherwise.
installDevTranscriptGlobals();

// Deploy-survival: after a redeploy, a tab still holding the previous build's
// shell will 404 on any lazy chunk it hasn't loaded yet ("Failed to fetch
// dynamically imported module …") — e.g. joining a video call crashed on the
// old VrmAvatar hash. Vite reports every such failure as `vite:preloadError`;
// reload ONCE to pick up the current build. The sessionStorage latch (cleared
// on a successful boot) is the loop-breaker for genuine network failure.
const PRELOAD_RELOAD_AT = "stable:chunk-reload-at";
window.addEventListener("vite:preloadError", (event) => {
  const last = Number(sessionStorage.getItem(PRELOAD_RELOAD_AT) ?? 0);
  if (Date.now() - last < 60_000) return; // reloaded <1min ago: real outage, don't loop
  event.preventDefault(); // we own recovery — don't also surface the throw
  sessionStorage.setItem(PRELOAD_RELOAD_AT, String(Date.now()));
  window.location.reload();
});

// Theme: stamp the stored (or system-resolved) theme before React paints,
// keeping browser chrome (meta theme-color) in sync, and start the OS-theme
// listener so a "system" preference live-updates. index.html also stamps
// inline for a truly flash-free first paint; this re-applies at runtime and
// owns the watcher. Persist=false — we're only reflecting the stored choice.
applyTheme(getStoredTheme(), false);
initSystemThemeWatcher();

// Palette is the second theme axis (data-palette). Called explicitly rather
// than relying on themeStore's module side effect: an import that exists only
// to run a side effect is exactly the kind of thing a bundler or a later
// refactor drops, and if it never runs, data-palette is never stamped and no
// palette can apply at all. index.html stamps this pre-paint too; this is the
// runtime re-apply, and AppShell re-scopes it once the user is known.
initPalette();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

// Error observability (Sentry/GlitchTip) — no-op unless VITE_SENTRY_DSN was
// set at build time. Dynamically imported so the SDK only loads when active.
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (SENTRY_DSN) {
  import("@sentry/react")
    .then((Sentry) => {
      Sentry.init({
        dsn: SENTRY_DSN,
        environment: import.meta.env.MODE,
        release: import.meta.env.VITE_GIT_SHA as string | undefined,
        tracesSampleRate: 0,
      });
    })
    .catch(() => {});
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* Root boundary: a render crash anywhere above AppShell's own
            boundaries (auth gate, providers, shell chrome) would otherwise
            white-screen the whole app — catch it with a full-screen reload. */}
        <ErrorBoundary fullScreen>
          <App />
        </ErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

// PWA: register the service worker (app-shell offline cache + a push handler
// wired for later). Best-effort — a failure never affects the running app.
// The URL names the build (lib/serviceWorker): each release is a new cache
// key at the edge, and the one registration at "/" is updated to it.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void registerServiceWorker(
      navigator.serviceWorker,
      import.meta.env.VITE_GIT_SHA as string | undefined,
    );
  });
}
