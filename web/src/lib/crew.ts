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
import {
  coerceOwner,
  ownerNames,
  type Agent,
  type CrewGroup,
  type CrewMember,
  type Room,
  type RoomMember,
  type RoomSeat,
  type RoomSeats,
  type SeatCapabilities,
} from "@/services/api";
import { agentPresence } from "@/lib/agentStatus";
import { roomLabel } from "@/lib/conversation";

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
 * a seat, a partner, a guest or an integration. Presence is only what the
 * roster states: `availability` decides, and a roster without it is
 * "unknown" — no dot, rather than a green one nobody measured.
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
        agent.availability === "available"
          ? ("online" as const)
          : agent.availability === "unavailable" || agent.status === "offline"
            ? ("offline" as const)
            : ("unknown" as const),
      hub_room_id: null,
      seat_capabilities: null,
      last_line: null,
      last_at: null,
      last_seen_at: null,
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
 * Is this room the caller's hub with an agent? The server's test (R7): the
 * room is `agent_hub` AND has no parent AND `metadata.agent_hub.human_id`
 * is the caller. `room_type` alone is never enough — a thread under a hub
 * carries the same type — and a hub that does not name its human is not
 * yours: a human can be invited into someone else's hub.
 */
export function isHubRoom(
  room: Pick<Room, "type" | "parent_room_id" | "metadata_">,
  selfIds: readonly (string | null | undefined)[],
): boolean {
  if (room.type !== "agent_hub" || room.parent_room_id) return false;
  const meta = room.metadata_?.agent_hub;
  const humanId =
    meta && typeof meta === "object" ? (meta as { human_id?: unknown }).human_id : undefined;
  if (typeof humanId !== "string" || !humanId) return false;
  return selfIds.some((id) => !!id && id === humanId);
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
 * The caller's hub with this crew member, if the room list has it. When
 * /crew answered, `hub_room_id` is the truth (the server already applied
 * R7) and nothing else is searched: a null means "no hub yet". Only the
 * roster fallback, which carries no hub id, searches the list — and then
 * only a room that passes `isHubRoom` for the caller, never a thread and
 * never someone else's hub.
 */
export function hubRoomFor(
  member: Pick<CrewMember, "agent_id" | "hub_room_id" | "participant_id">,
  rooms: readonly Room[],
  selfIds: readonly (string | null | undefined)[],
  crewAnswered = true,
): Room | null {
  if (member.hub_room_id) {
    return rooms.find((room) => room.id === member.hub_room_id) ?? null;
  }
  if (crewAnswered) return null;
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

export type CrewTargetKind = "hub" | "shared";

export interface CrewTarget {
  kind: CrewTargetKind;
  room: Room;
  /** "#taxsq-portal" for a shared room; the agent's name for a hub. */
  label: string;
}

/**
 * The one room a crew row opens — the same answer for the rail, the phone
 * tab and the New sheet. Your seats and house agents open their hub (null
 * when it does not exist yet: the caller may then ask the server for one);
 * a partner's seat opens the newest room you share, in key order, and is
 * never asked for a hub (the server refuses: "ask the seat's owner").
 */
export function crewTargetRoom(
  member: CrewMember,
  rooms: readonly Room[],
  selfIds: readonly (string | null | undefined)[],
  crewAnswered = true,
): CrewTarget | null {
  if (member.group === "partner") {
    const shared = sharedRoomFor(member, rooms);
    if (!shared) return null;
    const label = shared.type === "channel" ? `#${roomLabel(shared)}` : roomLabel(shared);
    return { kind: "shared", room: shared, label };
  }
  const hub = hubRoomFor(member, rooms, selfIds, crewAnswered);
  return hub ? { kind: "hub", room: hub, label: member.display_name } : null;
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
  // An unparsable stamp sorts as "never", not as NaN (which made the order
  // implementation-defined).
  const stamp = (room: Room) => {
    const at = Date.parse(room.last_message?.created_at || room.updated_at || "");
    return Number.isFinite(at) ? at : 0;
  };
  candidates.sort((a, b) => stamp(b) - stamp(a));
  return candidates[0] ?? null;
}

/** A runner counts as online while it has polled the gateway in this window. */
export const RUNNER_PRESENCE_WINDOW_MS = 3 * 60_000;

export interface CrewPresenceBadge {
  online: boolean;
  /** Tooltip / aria-label for the dot. */
  label: string;
  /** Null = draw no dot (presence unknown). */
  dotClass: string | null;
}

/** What the offline dot on a seat says when the row carries no `last_seen_at`. */
export const RUNNER_OFFLINE_LABEL = "Runner offline — no gateway call in the last 3 min";
export const RUNNER_ONLINE_LABEL = "Runner online";

/** "12 min ago", "3 h ago", "8 d ago"; null for a stamp that does not parse. */
export function relativeTime(iso: string | null | undefined, now: number): string | null {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * "Runner last seen 12 min ago" from the row's `last_seen_at` — the
 * runner's last gateway call, the only stamp that is a "seen" time (the
 * hourly announce and the last line are not). Without it, the plain
 * offline label.
 */
export function runnerSeenLabel(lastSeen: string | null | undefined, now: number): string {
  const when = relativeTime(lastSeen, now);
  return when ? `Runner last seen ${when}` : RUNNER_OFFLINE_LABEL;
}

/**
 * The presence dot on a crew row. For a seat, `presence` means the runner
 * called the gateway in the last three minutes, and the tooltip says exactly
 * that; a house agent keeps Brigade's availability wording. "unknown" (the
 * roster fallback) draws no dot at all — `dotClass` is null.
 */
export function crewPresence(member: CrewMember, now = Date.now()): CrewPresenceBadge {
  if (member.presence === "unknown") {
    return { online: false, label: "Presence unknown", dotClass: null };
  }
  const online = member.presence === "online";
  if (isRunnerSeat(member)) {
    if (online) {
      return { online, label: RUNNER_ONLINE_LABEL, dotClass: agentPresence({ isOnline: true }).dotClass };
    }
    return {
      online,
      label: runnerSeenLabel(member.last_seen_at, now),
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
  | { kind: "integration" }
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
  member: Pick<RoomMember, "metadata" | "participant_type" | "participant_id" | "id">,
  selfUsername?: string | null,
  /** Participant ids of YOUR seats (from /crew): the server's word on ownership. */
  ownSeatIds?: ReadonlySet<string>,
): MemberKindMark | null {
  const meta = member.metadata ?? null;
  if (!meta || typeof meta !== "object") return null;
  const kind = typeof meta.kind === "string" ? meta.kind : null;
  if (kind === "guest_agent") return { kind: "guest" };
  if (kind === "integration") return { kind: "integration" };
  const backend = typeof meta.backend === "string" ? meta.backend : null;
  // `owner` is a username or a list of usernames (one person can have two).
  const owners = ownerNames(meta.owner);
  const owner = coerceOwner(meta.owner) ?? "";
  if (backend !== "runner" || !owner) return null;
  const pid = member.participant_id || member.id || "";
  if (pid && ownSeatIds?.has(pid)) return null;
  if (selfUsername && owners.some((name) => name.toLowerCase() === selfUsername.toLowerCase())) {
    return null;
  }
  const ownerName =
    (typeof meta.owner_display_name === "string" && meta.owner_display_name.trim()) || owner;
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

/**
 * `metadata.class_floor`: "shared" once a line from outside your seats was
 * written in the room. The floor is sticky — the seat answers there with
 * reduced hands from then on — so the header says it, with the reason.
 */
export function roomClassFloor(
  room: { metadata_?: Record<string, unknown> | null } | null | undefined,
): "shared" | null {
  return room?.metadata_?.class_floor === "shared" ? "shared" : null;
}

export const SHARED_FLOOR_REASON =
  "A line from outside your seats was written here, so this conversation is shared: seats answer when named, with reduced hands. Start a new conversation for a private one.";

