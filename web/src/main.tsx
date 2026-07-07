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

// Dev-only: expose window.__stableSeedTranscript()/__stableInjectTranscript()
// behind the ?devtranscript flag so the live-transcript panel is testable
// before the real STT producer exists. No-op otherwise.
installDevTranscriptGlobals();

// Theme: stamp the stored (or system-resolved) theme before React paints,
// keeping browser chrome (meta theme-color) in sync, and start the OS-theme
// listener so a "system" preference live-updates. index.html also stamps
// inline for a truly flash-free first paint; this re-applies at runtime and
// owns the watcher. Persist=false — we're only reflecting the stored choice.
applyTheme(getStoredTheme(), false);
initSystemThemeWatcher();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

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
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
