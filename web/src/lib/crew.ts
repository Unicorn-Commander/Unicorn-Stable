/**
 * Crew — pure helpers for the agents you can talk to (Nav v3 §2.0, C3).
 *
 * Five kinds of agent exist: house Brigade agents, YOUR seats (runners on
 * your machines), PARTNERS' seats (another member's runner you share a room
 * with), guest agents (an outside account's agent let into named rooms) and
 * integrations (webhooks, relays, probes). The crew list carries the first
 * three, grouped in that order; guests show only inside a room's roster,
 * marked; integrations are never people-like anywhere.
 *
 * Everything here is data → data so the sidebar model, the New sheet and the
 * seat popover agree on one reading of a row. Nothing touches a store.
 */
import type {
  Agent,
  CrewGroup,
  CrewMember,
  Room,
  RoomMember,
  RoomSeat,
  RoomSeats,
  SeatCapabilities,
} from "@/services/api";
import { agentPresence } from "@/lib/agentStatus";

export const CREW_GROUP_ORDER: readonly CrewGroup[] = ["own_seat", "house", "partner"] as const;

export const CREW_GROUP_LABEL: Record<CrewGroup, string> = {
  own_seat: "Your seats",
  house: "House",
  partner: "Partners",
};

export interface CrewGroupBlock {
  group: CrewGroup;
  label: string;
  members: CrewMember[];
}

/** Server order within a group is the ranking; groups are fixed §2.0 order. Empty groups drop. */
export function groupCrew(crew: readonly CrewMember[]): CrewGroupBlock[] {
  const out: CrewGroupBlock[] = [];
  for (const group of CREW_GROUP_ORDER) {
    const members = crew.filter((member) => member.group === group);
    if (members.length === 0) continue;
    out.push({ group, label: CREW_GROUP_LABEL[group], members });
  }
  return out;
}

/** A runner-backed seat (yours or a partner's), as opposed to a house persona. */
export function isRunnerSeat(member: Pick<CrewMember, "kind" | "backend">): boolean {
  return member.kind === "seat" || member.backend === "runner";
}

/** Only your own seat takes a per-conversation brain. A partner's is read-only. */
export function canEditSeat(member: Pick<CrewMember, "kind" | "backend" | "group">): boolean {
  return member.group === "own_seat" && isRunnerSeat(member);
}

/**
 * Stale-server fallback: the Brigade roster as house rows. It has no owner
 * or seat facts, so every row is a house agent; nothing here can manufacture
 * a seat, a partner, a guest or an integration.
 */
export function crewFromRoster(agents: readonly Agent[]): CrewMember[] {
  return agents
    .filter((agent) => agent.entitled !== false)
    .map((agent) => ({
      agent_id: agent.id,
      participant_id: "",
      display_name: agent.display_name || agent.name || agent.id,
      avatar_url: agent.avatar_url ?? null,
      role_line: agent.title || agent.domain || null,
      backend: "brigade" as const,
      kind: "brigade" as const,
      owner: null,
      group: "house" as const,
      presence:
        agent.availability === "available" ||
        (agent.availability === undefined && agent.status !== "offline")
          ? ("online" as const)
          : ("offline" as const),
      hub_room_id: null,
      seat_capabilities: null,
      last_line: null,
      last_at: null,
      unread: 0,
    }));
}

const FAMILY_WORD: Record<string, string> = {
  gpt: "GPT",
  glm: "GLM",
  o1: "o1",
  o3: "o3",
  o4: "o4",
  qwen: "Qwen",
  llama: "Llama",
  grok: "Grok",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  mixtral: "Mixtral",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  codex: "Codex",
  claude: "Claude",
};

function word(token: string): string {
  const known = FAMILY_WORD[token.toLowerCase()];
  if (known) return known;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * "claude-fable-5-1" → "Fable 5.1", "claude-opus-5-5" → "Opus 5.5",
 * "gpt-5-codex" → "GPT 5 Codex". A vendor prefix goes, a date stamp goes,
 * and a run of version numbers reads as one dotted version. Only the
 * fallback: a seat that announced `models[].label` wins (see modelLabel).
 */
export function humanizeModelId(id: string): string {
  const bare = id
    .trim()
    .replace(/^[a-z0-9_.-]+\//i, "")
    .replace(/^(claude|anthropic)[-_]/i, "");
  if (!bare) return id;
  const tokens = bare.split(/[-_]+/).filter(Boolean);
  const parts: string[] = [];
  let version: string[] = [];
  const flush = () => {
    if (version.length > 0) parts.push(version.join("."));
    version = [];
  };
  for (const token of tokens) {
    if (/^\d{6,}$/.test(token)) continue; // 20250514 — a build date, not a version
    if (/^\d+$/.test(token)) {
      version.push(token);
      continue;
    }
    flush();
    parts.push(word(token));
  }
  flush();
  return parts.join(" ") || id;
}

/** Label for a model id: the seat's announced label, else the humanized id. */
export function modelLabel(
  id: string | null | undefined,
  caps: SeatCapabilities | null | undefined,
): string | null {
  if (!id) return null;
  const announced = caps?.models.find((model) => model.id === id);
  return announced?.label || humanizeModelId(id);
}

/** Family of a Brigade agent's configured model, for its crew chip. Null when unknown. */
export function modelFamilyLabel(model: string | null | undefined): string | null {
  const raw = (model || "").trim().toLowerCase();
  if (!raw) return null;
  const bare = raw.replace(/^[a-z0-9_.-]+\//, "");
  if (/^(claude|anthropic)/.test(bare)) return "Claude";
  if (/^(gpt|o1|o3|o4|openai)/.test(bare)) return "GPT";
  if (/^qwen/.test(bare)) return "Qwen";
  if (/^llama/.test(bare)) return "Llama";
  if (/^gemini/.test(bare)) return "Gemini";
  if (/^grok/.test(bare)) return "Grok";
  if (/^deepseek/.test(bare)) return "DeepSeek";
  if (/^(mistral|mixtral)/.test(bare)) return "Mistral";
  const first = bare.split(/[-_:/.\s]+/)[0];
  return first ? word(first) : null;
}

const NO_SEAT: RoomSeat = { model: null, effort: null };

function parseSeat(raw: unknown): RoomSeat {
  if (!raw || typeof raw !== "object") return NO_SEAT;
  const seat = raw as { model?: unknown; effort?: unknown };
  return {
    model: typeof seat.model === "string" && seat.model ? seat.model : null,
    effort: typeof seat.effort === "string" && seat.effort ? seat.effort : null,
  };
}

/** Every seat's brain in a room: `metadata.seats`, keyed by agent id. */
export function readRoomSeats(
  room: { metadata_?: Record<string, unknown> | null } | null | undefined,
): RoomSeats {
  const raw = room?.metadata_?.seats;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: RoomSeats = {};
  for (const [agentId, seat] of Object.entries(raw as Record<string, unknown>)) {
    if (agentId) out[agentId] = parseSeat(seat);
  }
  return out;
}

/** One seat's brain in a room (`metadata.seats[agent_id]`), tolerant of any shape. */
export function readRoomSeat(
  room: { metadata_?: Record<string, unknown> | null } | null | undefined,
  agentId: string | null | undefined,
): RoomSeat {
  if (!agentId) return NO_SEAT;
  return readRoomSeats(room)[agentId] ?? NO_SEAT;
}

/**
 * Is this room the caller's hub with an agent? `room_type = agent_hub` is
 * not enough — a thread under a hub carries the same type — so it is the
 * type AND no parent AND, when the server names the hub's human and we
 * know who we are, that human is us.
 */
export function isHubRoom(
  room: Pick<Room, "type" | "parent_room_id" | "metadata_">,
  selfIds: readonly (string | null | undefined)[] = [],
): boolean {
  if (room.type !== "agent_hub" || room.parent_room_id) return false;
  const meta = room.metadata_?.agent_hub;
  const humanId =
    meta && typeof meta === "object" ? (meta as { human_id?: unknown }).human_id : undefined;
  if (typeof humanId === "string" && humanId) {
    const known = selfIds.filter((id): id is string => !!id);
    if (known.length > 0 && !known.includes(humanId)) return false;
  }
  return true;
}

/**
 * "Fable 5.1 · high" — the conversation's brain: the room's override where
 * set, else the seat's announced default. Null when neither side knows.
 */
export function brainLabel(seat: RoomSeat, caps: SeatCapabilities | null | undefined): string | null {
  const model = modelLabel(seat.model ?? caps?.default_model ?? null, caps);
  const effort = seat.effort ?? caps?.default_effort ?? null;
  if (!model && !effort) return null;
  if (model && effort) return `${model} · ${effort}`;
  return model ?? effort;
}

/** The seat's own defaults, named — the popover's "Default (…)" row. */
export function defaultBrainLabel(caps: SeatCapabilities | null | undefined): string | null {
  if (!caps) return null;
  return brainLabel({ model: null, effort: null }, caps);
}

function roomHasAgent(
  room: Room,
  member: Pick<CrewMember, "agent_id" | "participant_id">,
): boolean {
  return (
    room.counterpart?.agent_id === member.agent_id ||
    room.brigade_agent_id === member.agent_id ||
    (room.brigade_agent_ids ?? []).includes(member.agent_id) ||
    (!!member.participant_id && room.counterpart?.participant_id === member.participant_id) ||
    (room.agent_members ?? []).some(
      (row) =>
        row.agent_id === member.agent_id ||
        (!!member.participant_id && row.participant_id === member.participant_id),
    )
  );
}

/**
 * The agent hub in the room list that belongs to this crew member, if
 * loaded: the server's `hub_room_id` first, else the one hub room with
 * this agent on the other side (`isHubRoom`, never a thread).
 */
export function hubRoomFor(
  member: Pick<CrewMember, "agent_id" | "hub_room_id" | "participant_id">,
  rooms: readonly Room[],
  selfIds: readonly (string | null | undefined)[] = [],
): Room | null {
  if (member.hub_room_id) {
    const byId = rooms.find((room) => room.id === member.hub_room_id);
    if (byId) return byId;
  }
  return (
    rooms.find(
      (room) =>
        isHubRoom(room, selfIds) &&
        !room.is_archived &&
        (room.counterpart?.agent_id === member.agent_id ||
          room.brigade_agent_id === member.agent_id ||
          (!!member.participant_id &&
            room.counterpart?.participant_id === member.participant_id)),
    ) ?? null
  );
}

/**
 * The newest room you share with a partner's seat. A partner's seat has no
 * hub of yours — asking the server for one is refused ("ask the seat's
 * owner") — so its row opens the room its owner put it in.
 */
export function sharedRoomFor(
  member: Pick<CrewMember, "agent_id" | "participant_id">,
  rooms: readonly Room[],
): Room | null {
  const candidates = rooms.filter(
    (room) => !room.is_archived && !room.parent_room_id && roomHasAgent(room, member),
  );
  candidates.sort(
    (a, b) =>
      Date.parse(b.last_message?.created_at || b.updated_at || "") -
      Date.parse(a.last_message?.created_at || a.updated_at || ""),
  );
  return candidates[0] ?? null;
}

/** A runner counts as online while it has polled the gateway in this window. */
export const RUNNER_PRESENCE_WINDOW_MS = 3 * 60_000;

export interface CrewPresenceBadge {
  online: boolean;
  /** Tooltip / aria-label for the dot. */
  label: string;
  dotClass: string;
}

/** "Runner not seen for 12 min" from the runner's last announcement. */
export function runnerSeenLabel(lastSeen: string | null | undefined, now: number): string {
  const at = lastSeen ? Date.parse(lastSeen) : Number.NaN;
  if (!Number.isFinite(at)) return "Runner offline";
  const minutes = Math.max(1, Math.round((now - at) / 60_000));
  if (minutes < 60) return `Runner not seen for ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Runner not seen for ${hours} h`;
  return `Runner not seen for ${Math.round(hours / 24)} d`;
}

/**
 * The presence dot on a crew row. For a seat, `presence` means the runner
 * polled the gateway in the last three minutes, and the tooltip says so;
 * a house agent keeps Brigade's availability wording.
 */
export function crewPresence(member: CrewMember, now = Date.now()): CrewPresenceBadge {
  const online = member.presence === "online";
  if (isRunnerSeat(member)) {
    if (online) {
      return { online, label: "Runner online", dotClass: agentPresence({ isOnline: true }).dotClass };
    }
    return {
      online,
      label: runnerSeenLabel(member.seat_capabilities?.updated_at ?? member.last_at, now),
      dotClass: agentPresence({ availability: "unavailable" }).dotClass,
    };
  }
  if (online) {
    return {
      online,
      label: `${member.display_name} is available`,
      dotClass: agentPresence({ isOnline: true }).dotClass,
    };
  }
  return {
    online,
    label: `${member.display_name} is unavailable`,
    dotClass: agentPresence({ availability: "unavailable" }).dotClass,
  };
}

/**
 * The chip on a crew row. A seat (yours or a partner's) shows the hub's
 * brain once the runner has announced its capabilities — a seat that has
 * not announced yet gets no chip, not a guess. House agents show their
 * model family, or nothing. A partner's seat shows the same chip
 * read-only; the settings popover is the part that is yours.
 */
export function crewBrainChip(
  member: CrewMember,
  hubRoom: Room | null,
  rosterAgent?: Pick<Agent, "model"> | null,
): string | null {
  if (isRunnerSeat(member)) {
    if (!member.seat_capabilities) return null;
    return brainLabel(readRoomSeat(hubRoom, member.agent_id), member.seat_capabilities);
  }
  return modelFamilyLabel(rosterAgent?.model);
}

export type MemberKindMark =
  | { kind: "guest" }
  | { kind: "partner_seat"; owner: string; label: string };

/**
 * "Shafen’s seat" — possessive of a name that may already end in s. The
 * crew list only carries the owner's USERNAME; a bare lowercase one reads
 * as a name with its first letter up, a display name is left alone.
 */
export function ownerSeatLabel(owner: string): string {
  const raw = owner.trim();
  if (!raw) return "Partner's seat";
  const name = /^[a-z][a-z0-9._-]*$/.test(raw) ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw;
  return `${name}${/s$/i.test(name) ? "’" : "’s"} seat`;
}

/**
 * What the roster says beside a member's name (§2.0): a guest agent is
 * marked, another member's seat carries its owner. Read from the members
 * payload; a server that does not send `metadata` yields nothing, never a
 * guess from a username.
 */
export function memberKindMark(
  member: Pick<RoomMember, "metadata" | "participant_type">,
  selfUsername?: string | null,
): MemberKindMark | null {
  const meta = member.metadata ?? null;
  if (!meta || typeof meta !== "object") return null;
  const kind = typeof meta.kind === "string" ? meta.kind : null;
  if (kind === "guest_agent") return { kind: "guest" };
  const backend = typeof meta.backend === "string" ? meta.backend : null;
  const owner = typeof meta.owner === "string" ? meta.owner.trim() : "";
  if (backend !== "runner" || !owner) return null;
  if (selfUsername && owner.toLowerCase() === selfUsername.toLowerCase()) return null;
  const ownerName =
    (typeof meta.owner_display_name === "string" && meta.owner_display_name.trim()) ||
    (typeof meta.owner_name === "string" && meta.owner_name.trim()) ||
    owner;
  return { kind: "partner_seat", owner, label: ownerSeatLabel(ownerName) };
}

/** Runner seats keyed for a fast "is this member a seat" lookup. */
export function seatIndex(crew: readonly CrewMember[]): {
  byAgent: Map<string, CrewMember>;
  byParticipant: Map<string, CrewMember>;
} {
  const byAgent = new Map<string, CrewMember>();
  const byParticipant = new Map<string, CrewMember>();
  for (const member of crew) {
    if (!isRunnerSeat(member)) continue;
    byAgent.set(member.agent_id, member);
    if (member.participant_id) byParticipant.set(member.participant_id, member);
  }
  return { byAgent, byParticipant };
}
