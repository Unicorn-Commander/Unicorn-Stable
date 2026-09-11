import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentChatModal } from "../src/components/Agents/AgentChatModal";
import { ToastStack } from "../src/components/Layout/ToastStack";
import { useChat } from "../src/hooks/useChat";
import { useAppStore } from "../src/stores/appStore";
import { ws } from "../src/services/websocket";
import type { Agent } from "../src/services/api";
import "../src/styles/globals.css";
const agent: Agent = {
  id: "fixture-runner",
  name: "Demo runner",
  display_name: "Demo runner",
  description: "Fixture account — canonical chat routing verification",
  status: "active",
  avatar_url: null,
  capabilities: [],
  model: "",
  entitled: true,
};
function App() {
  const [open, setOpen] = useState(true);
  const location = useLocation();
  useChat("canonical-fixture");
  return (
    <main style={{ padding: 48, color: "#eee", fontFamily: "sans-serif" }}>
      <h1>Stable — isolated routing fixture</h1>
      <p data-testid="path">{location.pathname}</p>
      {!open && <p>Existing canonical conversation opened.</p>}
      <button
        onClick={() =>
          (ws as any).emit("agent_error", { room_id: "canonical-fixture" })
        }
      >
        Simulate upstream failure
      </button>
      {open && (
        <AgentChatModal
          focusAgent={agent}
          agents={[agent]}
          onClose={() => setOpen(false)}
        />
      )}
      <ToastStack />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </QueryClientProvider>,
);
