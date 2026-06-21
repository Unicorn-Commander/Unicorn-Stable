import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { installDevTranscriptGlobals } from "./lib/devTranscript";
import "./styles/globals.css";
import "highlight.js/styles/github-dark.css";

// Dev-only: expose window.__stableSeedTranscript()/__stableInjectTranscript()
// behind the ?devtranscript flag so the live-transcript panel is testable
// before the real STT producer exists. No-op otherwise.
installDevTranscriptGlobals();

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
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
