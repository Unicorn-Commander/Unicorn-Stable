/**
 * startGroupModel — pure state/composition logic for the "Start a group
 * with <peer>…" flow (converting a 1:1 DM into a NEW group room).
 *
 * The modal owns rendering; everything decidable without I/O lives here so
 * it can be unit-tested: selection toggling, the group's default label, and
 * the request payload for POST /rooms/{id}/start-group.
 */

export interface StartGroupPersonPick {
  kind: "user";
  /** Participant id when the person has signed into Stable; null otherwise. */
  id: string | null;
  keycloak_sub: string;
  display_name: string;
  username: string;
}

export interface StartGroupAgentPick {
  kind: "agent";
  id: string;
  name: string;
}

export type StartGroupPick = StartGroupPersonPick | StartGroupAgentPick;

/** Stable identity for a pick — people keyed by participant id (fallback:
 * Keycloak sub), agents by brigade id. */
export function pickKey(p: StartGroupPick): string {
  return p.kind === "agent"
    ? `agent:${p.id}`
    : `user:${p.id || p.keycloak_sub}`;
}

/** Toggle a pick in/out of the selection (same-key picks are equal). */
export function togglePick(
  prev: StartGroupPick[],
  pick: StartGroupPick,
): StartGroupPick[] {
  const key = pickKey(pick);
  return prev.some((p) => pickKey(p) === key)
    ? prev.filter((p) => pickKey(p) !== key)
    : [...prev, pick];
}

/**
 * The new group's default label: the standing CreateDmModal formula
 * ("Group: " + up to three names, people before agents) with the DM peer
 * pinned first — the group is "with <peer>" by construction.
 */
export function groupLabelFromPicks(
  peerLabel: string,
  picks: StartGroupPick[],
): string {
  const people = picks
    .filter((p): p is StartGroupPersonPick => p.kind === "user")
    .map((p) => p.display_name || p.username);
  const agents = picks
    .filter((p): p is StartGroupAgentPick => p.kind === "agent")
    .map((p) => p.name);
  const labels = [peerLabel, ...people, ...agents]
    .map((l) => (l || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  return labels.length > 0 ? `Group: ${labels.join(", ")}` : "Group chat";
}

export interface StartGroupPayload {
  participant_ids: string[];
  keycloak_subs: string[];
  agent_ids: string[];
}

/**
 * Split the selection into the wire payload. Signed-in people travel as
 * participant ids, Keycloak-only people as subs, agents as brigade ids —
 * each deduplicated, and people already in the DM dropped (the server seeds
 * every source member itself; re-sending one is noise, not an error).
 *
 * Agent order is preserved verbatim: the server's "last-invited wins"
 * canonical-responder rule reads it.
 */
export function composeStartGroupPayload(
  picks: StartGroupPick[],
  opts: { existingParticipantIds?: Iterable<string> } = {},
): StartGroupPayload {
  const existing = new Set(opts.existingParticipantIds ?? []);
  const participant_ids: string[] = [];
  const keycloak_subs: string[] = [];
  const agent_ids: string[] = [];
  const seen = new Set<string>();

  for (const p of picks) {
    const key = pickKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.kind === "agent") {
      agent_ids.push(p.id);
    } else if (p.id) {
      if (!existing.has(p.id)) participant_ids.push(p.id);
    } else if (p.keycloak_sub) {
      keycloak_subs.push(p.keycloak_sub);
    }
  }

  return { participant_ids, keycloak_subs, agent_ids };
}

/**
 * Is this room a HUMAN 1:1 DM — the kind a resident-agent bind must never
 * touch? Binding stamps `brigade_agent_id` on the room, which reclassifies
 * it as an agent conversation everywhere (sidebar/home/quick-switcher key
 * off `dm + brigade_agent_id`), so the private human thread vanishes from
 * Chats. Entry points use this to route "add an agent" to the explicit
 * start-a-group flow instead; the server refuses the bind regardless
 * (409 `agent_bind_refused_human_dm`).
 *
 * True only when the room is a `dm` with NO resident agent AND a human
 * peer is actually identifiable in the loaded members. With members not
 * yet loaded this stays false — the caller falls through to the direct
 * bind and the server backstop has the final word.
 */
export function isHumanPairDm(
  room:
    | { type?: string; brigade_agent_id?: string | null }
    | null
    | undefined,
  members:
    | readonly {
        participant_type?: string | null;
        is_self?: boolean;
      }[]
    | undefined,
): boolean {
  if (!room || room.type !== "dm" || room.brigade_agent_id) return false;
  return (members ?? []).some(
    (m) => !m.is_self && (m.participant_type ?? "human") !== "agent",
  );
}
