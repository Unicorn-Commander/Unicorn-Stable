/**
 * Dev-mock crew (Nav v3 C3) — the three groups the crew list carries plus
 * the two kinds it never does. Shared by the MSW handlers, the unit tests
 * and the Playwright stubs so every layer is pinned to one contract shape.
 *
 *   own_seat — Aaron's runners (Persephone, Rook, Astra, Grok, Zen, Claude)
 *   house    — Brigade personas (Majik, Sidekick, The General)
 *   partner  — Shafen's seats that share a room with Aaron (Flow, ShOX, Okapi)
 *
 * A guest agent (a customer's assistant) appears only in a room roster, and
 * an integration (webhook-dev-stable) appears nowhere.
 */
import {
  normalizeCrewMember,
  type CrewMember,
  type RawCrewMember,
  type RawRoomListItem,
  type RoomMember,
  type SeatCapabilities,
} from "@/services/api";

export const PERSEPHONE_HUB_ID = "hub-fa65c5631810";
export const ROOK_HUB_ID = "hub-rook-0c3d1a2b";

const CLAUDE_CAPS: SeatCapabilities = {
  harness: "claude-code",
  default_model: "claude-fable-5-1",
  default_effort: "high",
  models: [
    { id: "claude-fable-5-1", label: "Fable 5.1" },
    { id: "claude-opus-5-5", label: "Opus 5.5" },
    { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
  efforts: ["low", "medium", "high", "max"],
  updated_at: "2026-09-28T20:00:00Z",
};

const CODEX_CAPS: SeatCapabilities = {
  harness: "codex",
  default_model: "gpt-5-codex",
  default_effort: "medium",
  models: [
    { id: "gpt-5-codex", label: "GPT-5 Codex" },
    { id: "gpt-5", label: "GPT-5" },
  ],
  efforts: ["low", "medium", "high"],
  updated_at: "2026-09-28T19:30:00Z",
};

function member(over: Partial<CrewMember> & Pick<CrewMember, "agent_id" | "display_name" | "group">): CrewMember {
  const seat = over.group !== "house";
  return {
    participant_id: `p-${over.agent_id}`,
    avatar_url: null,
    role_line: null,
    backend: seat ? "runner" : "brigade",
    kind: seat ? "seat" : "brigade",
    owner: over.group === "own_seat" ? "aaron" : over.group === "partner" ? "shafen" : null,
    presence: "offline",
    hub_room_id: null,
    seat_capabilities: null,
    last_line: null,
    last_at: null,
    unread: 0,
    ...over,
  };
}

/** Ranked as the server ranks: own seats, house with a recent thread, partners, the rest. */
export const CREW_FIXTURE: CrewMember[] = [
  member({
    agent_id: "persephone",
    display_name: "Persephone",
    group: "own_seat",
    role_line: "Main assistant · Mac Studio",
    presence: "online",
    hub_room_id: PERSEPHONE_HUB_ID,
    seat_capabilities: CLAUDE_CAPS,
    last_line: "Board is clear; two PRs waiting on you.",
    last_at: "2026-09-28T20:12:00Z",
    unread: 1,
  }),
  member({
    agent_id: "claude-code",
    display_name: "Rook",
    group: "own_seat",
    role_line: "Showrunner",
    presence: "online",
    hub_room_id: ROOK_HUB_ID,
    seat_capabilities: { ...CLAUDE_CAPS, default_model: "claude-opus-5-5", default_effort: "medium" },
    last_line: "Cue sheet locked for Thursday.",
    last_at: "2026-09-28T18:40:00Z",
  }),
  member({
    agent_id: "codex-astra",
    display_name: "Astra",
    group: "own_seat",
    role_line: "Codex seat",
    presence: "online",
    seat_capabilities: CODEX_CAPS,
  }),
  member({
    agent_id: "grok",
    display_name: "Grok",
    group: "own_seat",
    role_line: "Grok seat",
    seat_capabilities: {
      harness: "grok",
      default_model: "grok-4",
      default_effort: "medium",
      models: [{ id: "grok-4", label: "Grok 4" }],
      efforts: ["low", "medium", "high"],
      updated_at: "2026-09-28T18:00:00Z",
    },
  }),
  member({
    agent_id: "zen",
    display_name: "Zen",
    group: "own_seat",
    role_line: "OpenCode · local Qwen",
    seat_capabilities: {
      harness: "opencode",
      default_model: "qwen3.6-35b-chat",
      default_effort: "medium",
      models: [{ id: "qwen3.6-35b-chat", label: "Qwen 3.6 35B" }],
      efforts: ["low", "medium", "high"],
      updated_at: "2026-09-28T18:00:00Z",
    },
  }),
  // A seat that has not announced yet: no capabilities, so no chip.
  member({
    agent_id: "claude",
    display_name: "Claude",
    group: "own_seat",
    role_line: "Plain Claude Code seat",
    seat_capabilities: null,
  }),
  member({
    agent_id: "majik",
    display_name: "Majik Mane",
    group: "house",
    role_line: "House DJ",
    presence: "online",
    avatar_url: "/agent-puppets/majik.webp",
    last_line: "Radio is on the wave-2 catalogue.",
    last_at: "2026-09-28T19:05:00Z",
  }),
  member({
    agent_id: "sidekick",
    display_name: "Sidekick",
    group: "house",
    role_line: "Everyday assistant",
    presence: "online",
  }),
  member({
    agent_id: "the-general",
    display_name: "The General",
    group: "house",
    role_line: "Fleet watch",
  }),
  member({
    agent_id: "shafen-claude-code",
    display_name: "Flow",
    group: "partner",
    role_line: "Shafen's Claude Code",
    presence: "online",
    seat_capabilities: CLAUDE_CAPS,
    last_line: "Pushed the Z13 fix.",
    last_at: "2026-09-28T17:30:00Z",
  }),
  member({
    agent_id: "shox",
    display_name: "ShOX",
    group: "partner",
    role_line: "Shafen's OpenCode",
  }),
  member({
    agent_id: "okapi-grok",
    display_name: "Okapi",
    group: "partner",
    role_line: "Shafen's Grok",
  }),
];

/**
 * What a server might put on the wire, including the two kinds the client
 * must drop on sight: a guest agent and an integration. `CREW_FIXTURE` is
 * this list after `normalizeCrewMember`.
 */
export const CREW_RAW_FIXTURE: RawCrewMember[] = [
  ...CREW_FIXTURE,
  {
    agent_id: "taxsq-assistant",
    participant_id: "p-taxsq-assistant",
    display_name: "Northbridge Tax assistant",
    avatar_url: null,
    role_line: null,
    backend: "external",
    kind: "guest_agent",
    owner: null,
    group: "house",
    presence: "offline",
    hub_room_id: null,
    seat_capabilities: null,
    last_line: null,
    last_at: null,
    unread: 0,
  },
  {
    agent_id: "webhook-dev-stable",
    participant_id: "p-webhook-dev-stable",
    display_name: "Claude Code",
    avatar_url: null,
    role_line: null,
    backend: "runner",
    kind: "integration",
    owner: ["aaron"],
    group: "own_seat",
    presence: "online",
    hub_room_id: null,
    seat_capabilities: null,
    last_line: "deploy ok",
    last_at: "2026-09-28T20:00:00Z",
    unread: 0,
  },
];

/** What `api.getCrew()` yields from the raw payload: the twelve, never the two. */
export function crewFromRawFixture(): CrewMember[] {
  return CREW_RAW_FIXTURE.map((row) => normalizeCrewMember(row)).filter(
    (row): row is CrewMember => row !== null,
  );
}

/** Never in Crew: an outside account's agent, visible only inside a room. */
export const GUEST_AGENT_MEMBER: RoomMember = {
  participant_id: "p-taxsq-assistant",
  username: "agent-taxsq-assistant",
  display_name: "Northbridge Tax assistant",
  avatar_url: null,
  role: "guest",
  participant_type: "agent",
  is_online: false,
  availability: "unknown",
  joined_at: "2026-09-22T15:00:00Z",
  agent_mode: "when_named",
  metadata: { kind: "guest_agent", backend: "external", owner: null },
};

/** A partner's seat inside a shared room — marked with its owner. */
export const PARTNER_SEAT_MEMBER: RoomMember = {
  participant_id: "p-shafen-claude-code",
  username: "agent-shafen-claude-code",
  display_name: "Flow",
  avatar_url: null,
  role: "member",
  participant_type: "agent",
  is_online: true,
  availability: "available",
  joined_at: "2026-09-10T15:00:00Z",
  agent_mode: "when_named",
  metadata: { backend: "runner", owner: "shafen", owner_display_name: "Shafen", crew: true },
};

export const PERSEPHONE_MEMBER: RoomMember = {
  participant_id: "p-persephone",
  username: "agent-persephone",
  display_name: "Persephone",
  avatar_url: null,
  role: "member",
  participant_type: "agent",
  is_online: true,
  availability: "available",
  availability_reason: "bridge_session_active",
  joined_at: "2026-09-03T15:00:00Z",
  agent_mode: "answers_all",
  metadata: { backend: "runner", owner: "aaron", crew: true },
};

export const AARON_MEMBER: RoomMember = {
  participant_id: "p-aaron",
  username: "aaron",
  display_name: "Aaron Stransky",
  avatar_url: null,
  role: "owner",
  participant_type: "human",
  is_online: true,
  is_self: true,
  joined_at: "2026-09-03T15:00:00Z",
};

/**
 * A hub is `room_type = agent_hub` AND no parent AND `metadata.agent_hub.
 * human_id` = the caller. A thread under it carries the same room_type, so
 * nothing may test the type alone.
 */
export function hubRoomRaw(agentId: string, over: Partial<RawRoomListItem> = {}): RawRoomListItem {
  const row = CREW_FIXTURE.find((m) => m.agent_id === agentId);
  const id = row?.hub_room_id ?? `hub-${agentId}`;
  const { metadata_: extraMeta, ...rest } = over;
  return {
    id,
    name: id,
    display_name: row?.display_name ?? agentId,
    description: "",
    room_type: "agent_hub",
    created_at: "2026-09-03T15:00:00Z",
    updated_at: "2026-09-28T20:12:00Z",
    member_count: 2,
    online_count: 2,
    unread_count: 0,
    is_archived: false,
    visibility: "private",
    parent_room_id: null,
    metadata_: { agent_hub: { human_id: "p-aaron", agent_id: agentId }, ...(extraMeta ?? {}) },
    last_message: null,
    counterpart: {
      participant_id: row?.participant_id ?? `p-${agentId}`,
      kind: "agent",
      display_name: row?.display_name ?? agentId,
      agent_id: agentId,
    },
    agents: [
      {
        participant_id: row?.participant_id ?? `p-${agentId}`,
        agent_id: agentId,
        display_name: row?.display_name ?? agentId,
        agent_mode: "answers_all",
      },
    ],
    ...rest,
  } as RawRoomListItem;
}

export function threadRoomRaw(parentId: string, n: number, title: string | null = null): RawRoomListItem {
  const id = `${parentId}-t-${String(n).padStart(8, "0")}`;
  const base = hubRoomRaw("persephone");
  return {
    ...base,
    id,
    name: id,
    display_name: title ?? "New conversation",
    // Same room_type as the hub; the parent is what makes it a thread.
    metadata_: {},
    parent_room_id: parentId,
    updated_at: new Date(Date.parse("2026-09-28T20:30:00Z") + n * 60_000).toISOString(),
    unread_count: 0,
  };
}

/** Members of a hub: the human, the seat — and, in a shared room, a guest. */
export function membersFixture(roomId: string): RoomMember[] {
  if (roomId === "room-taxsq") {
    return [AARON_MEMBER, PERSEPHONE_MEMBER, PARTNER_SEAT_MEMBER, GUEST_AGENT_MEMBER];
  }
  if (roomId.startsWith(PERSEPHONE_HUB_ID)) return [AARON_MEMBER, PERSEPHONE_MEMBER];
  return [AARON_MEMBER];
}
