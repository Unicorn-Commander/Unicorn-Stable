import type { Agent } from "@/services/api";

/** Built-in fallback when the roster hasn't loaded or a user hasn't picked a
 * default — the general-purpose everyday assistant. NOT a personal orchestrator
 * (Majik/gflow are per-owner); a fresh/regular user should land on Sidekick,
 * while anyone can set their own default (e.g. Aaron → Majik) via preferences. */
export const FALLBACK_AGENT = { id: "sidekick", name: "Sidekick" };

/**
 * Resolve which agent the "New chat" button should talk to: the user's chosen
 * default if it's still in the roster, else the general Sidekick assistant, else
 * the first available agent, else the built-in fallback. Returns a stable
 * {id, name} the callers can use for both the DM and its label.
 */
export function resolveDefaultAgent(
  agents: Agent[],
  defaultAgentId: string | null,
): { id: string; name: string } {
  const chosen =
    (defaultAgentId && agents.find((a) => a.id === defaultAgentId)) ||
    agents.find(
      (a) => a.id === "sidekick" || (a.name || "").toLowerCase() === "sidekick",
    ) ||
    agents[0];
  if (chosen) return { id: chosen.id, name: chosen.display_name || chosen.name };
  return FALLBACK_AGENT;
}
