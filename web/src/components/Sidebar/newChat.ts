import type { Agent } from "@/services/api";

/** Built-in fallback when the roster hasn't loaded or has no obvious
 * orchestrator — keeps "New chat" working on day one before the user has
 * picked a default. Matches the seeded Majik persona. */
export const FALLBACK_AGENT = { id: "majik", name: "Majik" };

/**
 * Resolve which agent the "New chat" button should talk to: the user's chosen
 * default if it's still in the roster, else the Majik orchestrator, else the
 * first available agent, else the built-in fallback. Returns a stable
 * {id, name} the callers can use for both the DM and its label.
 */
export function resolveDefaultAgent(
  agents: Agent[],
  defaultAgentId: string | null,
): { id: string; name: string } {
  const chosen =
    (defaultAgentId && agents.find((a) => a.id === defaultAgentId)) ||
    agents.find(
      (a) => a.id === "majik" || (a.name || "").toLowerCase() === "majik",
    ) ||
    agents[0];
  if (chosen) return { id: chosen.id, name: chosen.display_name || chosen.name };
  return FALLBACK_AGENT;
}
