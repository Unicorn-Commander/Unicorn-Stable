/**
 * Conversation model (design §3) — pure helpers shared by the rail, the
 * sidebar, the New sheet, and the thread entry points.
 *
 * A thread is a child room (`parent_room_id`). Message-level replies stay
 * "Replies". One hub per agent; the "+" on a row starts a thread under that
 * row, it does not mint another room.
 */
import type { Message, Room, RoomMember } from "@/services/api";

export type AgentMode = "answers_all" | "when_named" | "listening" | "muted";

export const AGENT_MODES: readonly AgentMode[] = [
  "answers_all",
  "when_named",
  "listening",
  "muted",
] as const;

export const AGENT_MODE_LABEL: Record<AgentMode, string> = {
  answers_all: "Answers everyone",
  when_named: "When named",
  listening: "Listening",
  muted: "Muted",
};

export function agentModeLabel(mode: string | null | undefined): string | null {
  if (!mode) return null;
  if (mode in AGENT_MODE_LABEL) return AGENT_MODE_LABEL[mode as AgentMode];
  return null;
}

export function isThreadRoom(room: { parent_room_id?: string | null }): boolean {
  return !!room.parent_room_id;
}

type ConversationMember = {
  participant_type?: string | null;
  is_self?: boolean;
};

type AgentConversationRoom = {
  type?: string;
  brigade_agent_id?: string | null;
  brigade_agent_ids?: readonly string[] | null;
  member_count?: number;
  members?: readonly ConversationMember[] | null;
  agent_members?: readonly { agent_id?: string | null }[] | null;
  counterpart?: { kind?: string | null; agent_id?: string | null } | null;
};

function agentMemberCount(room: AgentConversationRoom): number {
  const members = room.members ?? [];
  if (members.length > 0) {
    return members.filter((member) => member.participant_type === "agent").length;
  }
  const ids = new Set<string>();
  for (const member of room.agent_members ?? []) {
    if (member.agent_id) ids.add(member.agent_id);
  }
  for (const id of room.brigade_agent_ids ?? []) {
    if (id) ids.add(id);
  }
  if (room.brigade_agent_id) ids.add(room.brigade_agent_id);
  if (room.counterpart?.agent_id) ids.add(room.counterpart.agent_id);
  if (room.counterpart?.kind === "agent" && ids.size === 0) ids.add("agent");
  return ids.size;
}

/** Human-ish members, including the caller, for placement of group DMs. */
export function humanMemberCount(room: AgentConversationRoom): number {
  const members = room.members ?? [];
  if (members.length > 0) {
    return members.filter((member) => member.participant_type !== "agent").length;
  }
  return Math.max(0, (room.member_count ?? 0) - agentMemberCount(room));
}

export function isAgentConversation(room: {
  type?: string;
  display_name?: string | null;
  parent_room_id?: string | null;
  brigade_agent_id?: string | null;
  brigade_agent_ids?: readonly string[] | null;
  member_count?: number;
  members?: readonly ConversationMember[] | null;
  agent_members?: readonly { agent_id?: string | null }[] | null;
  counterpart?: { kind?: string | null; agent_id?: string | null } | null;
}): boolean {
  if (room.type === "agent_hub") return true;
  if (room.type !== "dm" && room.type !== "group_dm") return false;
  const hasAgent = agentMemberCount(room) > 0;
  if (!hasAgent) return false;
  // A group somebody named (a customer call room, a bridge-created working
  // room) is a group, however many humans happen to be in it: Aaron could
  // not find "Bureau of Readiness · Magic Unicorn" because its one human
  // plus two agents filed it under Agents. Only an unnamed group with a
  // single human is an agent conversation.
  if (room.type === "group_dm" && hasExplicitTitle(room) && humanMemberCount(room) >= 1) return false;
  return humanMemberCount(room) < 2;
}

/** True when a person (or the bridge that made the room) gave it a title. */
function hasExplicitTitle(room: { display_name?: string | null; parent_room_id?: string | null }): boolean {
  const explicit = (room.display_name || "").trim();
  if (!explicit) return false;
  return !(room.parent_room_id && explicit === "New thread");
}

/** DM, group, or hub — a direct relationship, not a channel. */
export function isDirectRoom(room: {
  type?: string;
  is_conference?: boolean;
}): boolean {
  if (room.is_conference) return false;
  return (
    room.type === "dm" ||
    room.type === "group_dm" ||
    room.type === "agent_hub"
  );
}

export function isPrivateChannel(room: {
  type?: string;
  visibility?: string | null;
  is_private?: boolean;
}): boolean {
  if (room.type && room.type !== "channel") return false;
  return room.visibility === "private" || room.is_private === true;
}

/**
 * Needs-you: an unread DM/hub/group, or an unread @-mention. Channel chatter
 * with no mention does not badge the rail.
 */
export function roomNeedsYou(
  room: { id: string; type?: string; is_conference?: boolean },
  unread: number,
  hasMention: boolean,
  muted = false,
): boolean {
  if (muted) return false;
  if (hasMention) return true;
  if (isDirectRoom(room) && unread > 0) return true;
  return false;
}

export function countNeedsYou(
  rooms: Array<{ id: string; type?: string; is_conference?: boolean; unread_count?: number; has_unread_mention?: boolean }>,
  unreadById?: Record<string, number>,
  mentionById?: Record<string, boolean>,
  isMuted?: (roomId: string) => boolean,
): number {
  let n = 0;
  for (const room of rooms) {
    const unread = unreadById?.[room.id] ?? room.unread_count ?? 0;
    const mention =
      mentionById?.[room.id] === true || room.has_unread_mention === true;
    if (roomNeedsYou(room, unread, mention, isMuted?.(room.id) === true)) n += 1;
  }
  return n;
}

export interface RoomTitleInput {
  name?: string | null;
  display_name?: string | null;
  type?: string;
  parent_room_id?: string | null;
  counterpart?: { display_name?: string | null } | null;
  first_message?: Pick<Message, "content"> | null;
  last_message?: Pick<Message, "content"> | null;
}

export function threadMessageTitle(message: Pick<Message, "content"> | null | undefined): string {
  const text = (message?.content || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= 60 ? text : `${text.slice(0, 59).trimEnd()}…`;
}

/**
 * The one title resolver for rooms. An explicit display name is authoritative;
 * group DMs never turn their bridge metadata or member roster into a title.
 * The optional member argument is intentionally ignored so callers cannot
 * accidentally reintroduce member-list titles at a new surface.
 */
export function roomTitle(
  room: RoomTitleInput | null | undefined,
  _members?: readonly RoomMember[] | null,
): string {
  if (!room) return "Conversation";
  const explicit = (room.display_name || "").trim();
  // The server's empty-thread placeholder is not a user title. Once a first
  // message exists, the child must graduate to that line even if the list
  // payload still carries display_name="New thread".
  if (explicit && !(room.parent_room_id && explicit === "New thread")) return explicit;

  if (room.parent_room_id) {
    // A thread named by a person keeps that name; the server's slug-shaped
    // names (…-t-<hash>) and its "New thread" placeholder are not titles, so
    // such a child reads as its opening line until somebody names it.
    const named = (room.name || "").trim();
    if (named && named !== "New thread" && !/-t-[a-z0-9]+$/i.test(named)) return named;
    return threadMessageTitle(room.first_message) || threadMessageTitle(room.last_message) || "New thread";
  }
  if (
    room.counterpart?.display_name &&
    (room.type === "dm" || room.type === "agent_hub")
  ) {
    return room.counterpart.display_name.trim();
  }
  return (room.name || "").trim() || "Conversation";
}

export type RoomTypeLabel = "Channel" | "Group" | "DM" | "Agent hub" | "Meeting";

export function roomTypeLabel(room: Pick<Room, "type"> & { is_conference?: boolean }): RoomTypeLabel {
  if (room.is_conference) return "Meeting";
  switch (room.type) {
    case "channel":
      return "Channel";
    case "group_dm":
      return "Group";
    case "agent_hub":
      return "Agent hub";
    default:
      return "DM";
  }
}

/**
 * Everyone in the room but me. The server-set `is_self` is the only reliable
 * marker — a participant id is a UUID and never equals the Keycloak id, so a
 * comparison alone left the human in "others" and a private hub read as a
 * channel. The id comparison stays as the fallback for rows without the flag.
 */
export function othersInRoom<
  T extends { participant_id?: string | null; user_id?: string | null; is_self?: boolean },
>(participants: readonly T[], currentUserId: string | null | undefined): T[] {
  return participants.filter(
    (p) => !p.is_self && (p.participant_id || p.user_id) !== currentUserId,
  );
}

export interface ThreadSeed {
  /** "Nate Ellison" — the seed line's true author. */
  authorName: string;
  /** "Started from Nate Ellison’s message". */
  label: string;
  seedMessageId: string | null;
}

/**
 * A thread's seed line: the message the thread was started from, quoted as
 * the thread's first entry under its TRUE author (`metadata.kind =
 * "thread_seed"`). The creator may see it as unread and "Needs you" may name
 * the seed's author — that is the record being honest, so the line says
 * where it came from instead of looking like a fresh message.
 */
export function threadSeedOf(message: {
  sender_name?: string | null;
  metadata?: Record<string, unknown> | null;
}): ThreadSeed | null {
  const meta = message.metadata;
  if (!meta || meta.kind !== "thread_seed") return null;
  const named =
    (typeof meta.seed_sender_name === "string" && meta.seed_sender_name.trim()) ||
    (message.sender_name || "").trim();
  const authorName = named || "someone";
  const possessive = named ? `${named}${/s$/i.test(named) ? "’" : "’s"}` : "someone’s";
  return {
    authorName,
    label: `Started from ${possessive} message`,
    seedMessageId: typeof meta.seed_message_id === "string" ? meta.seed_message_id : null,
  };
}

/** Collapsed-row hint: "+3 older · 1 archived". Null when there is nothing to say. */
export function olderArchivedLabel(older: number, archived: number): string | null {
  const parts: string[] = [];
  if (older > 0) parts.push(`+${older} older`);
  if (archived > 0) {
    parts.push(archived === 1 ? "1 archived" : `${archived} archived`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function channelConsequence(visibility: "public" | "private"): string {
  if (visibility === "private") {
    return "Only people you invite can see this channel. It is not listed anywhere.";
  }
  return "Anyone in this Stable can find this channel and join it.";
}

export function projectChannelConsequence(): string {
  return "Private channel bound to that project. The header shows its number, and Tasks lists the open work.";
}

export function guestLinkConsequence(): string {
  return "For people outside Unicorn Commander. They get no account, and history starts now.";
}

/** The parent a new thread should hang from. Threads are one level deep. */
export function threadParentId(room: Room, rooms: readonly Room[]): string | null {
  if (room.parent_room_id) return room.parent_room_id;
  if (room.id) return room.id;
  return rooms.find((r) => r.id === room.id)?.id ?? null;
}

export interface ThreadSlash {
  title: string | null;
}

/** `/thread` or `/thread <title>`. Null when the input is some other command. */
export function parseThreadSlash(input: string): ThreadSlash | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const space = trimmed.indexOf(" ");
  const cmd = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  if (cmd !== "thread") return null;
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
  return { title: rest || null };
}

/**
 * Every place a new conversation thread can start. The UI wires each id;
 * the test locks the list so a surface cannot quietly disappear.
 */
export const THREAD_ENTRY_POINTS = [
  { id: "sidebar-plus", label: "Plus on a sidebar row", detail: "hover on desktop, long-press on phone" },
  { id: "room-header", label: "New thread", detail: "room header" },
  { id: "threads-panel", label: "New thread", detail: "top of the Threads panel" },
  { id: "shortcut", label: "Mod+Shift+N", detail: "any open room" },
  { id: "new-sheet", label: "New thread in…", detail: "room picker" },
  { id: "message-menu", label: "Start a thread from here", detail: "passes seed_message_id" },
  { id: "slash", label: "/thread <title>", detail: "composer" },
  { id: "crew-card", label: "New thread with…", detail: "crew card menu on Home" },
  { id: "phone-fab", label: "New thread", detail: "FAB inside a hub or channel" },
] as const;

export type ThreadEntryPointId = (typeof THREAD_ENTRY_POINTS)[number]["id"];

export const NEW_SHEET_ITEMS = [
  { id: "person", label: "Message a person", detail: "Open your one conversation with them" },
  { id: "agent", label: "Talk to an agent", detail: "Opens their hub" },
  { id: "thread", label: "New thread in…", detail: "A thread inside a room you already have" },
  { id: "channel", label: "New channel", detail: "Public or private" },
  { id: "project", label: "Project channel", detail: "Pick a Project-Ops project" },
  { id: "call", label: "Start a call", detail: "Voice or video in a room" },
] as const;

export type NewSheetItemId = (typeof NEW_SHEET_ITEMS)[number]["id"];

/** Three prompts an empty hub offers. Same words as the agent empty state. */
export const HUB_STARTER_PROMPTS = [
  "Give me a 30-second intro of what you do best.",
  "What questions should I ask you first?",
  "Walk me through a typical task you handle.",
] as const;

export interface ThreadCreatedEvent {
  room_id: string;
  parent_room_id: string;
  display_name?: string | null;
  created_by?: string | null;
}

/** A list row we can show before GET /rooms/{id} returns. */
export function threadStubFromEvent(event: ThreadCreatedEvent, parent?: Room | null): Room {
  const now = new Date().toISOString();
  const explicit = (event.display_name || "").trim();
  return {
    id: event.room_id,
    name: explicit || "New thread",
    display_name: explicit || undefined,
    description: "",
    type: parent?.type ?? "channel",
    created_at: now,
    updated_at: now,
    member_count: parent?.member_count ?? 0,
    unread_count: 0,
    last_message: null,
    first_message: null,
    members: [],
    agents: [],
    parent_room_id: event.parent_room_id,
    visibility: parent?.visibility,
    project_number: parent?.project_number ?? null,
    brigade_agent_id: parent?.brigade_agent_id ?? null,
    brigade_agent_ids: parent?.brigade_agent_ids ?? null,
    is_conference: parent?.is_conference,
    metadata_: parent?.metadata_ ?? null,
  };
}

/** Insert or replace a room. Newest first when it is new. Preserves a live preview. */
export function upsertRoomList(rooms: readonly Room[], room: Room): Room[] {
  const idx = rooms.findIndex((r) => r.id === room.id);
  if (idx === -1) return [room, ...rooms];
  return rooms.map((r) =>
    r.id === room.id
      ? {
          ...r,
          ...room,
          last_message: room.last_message ?? r.last_message,
          first_message: room.first_message ?? r.first_message,
        }
      : r,
  );
}

/** Bump the parent's thread_count when a child appears. */
export function noteThreadOnParent(rooms: readonly Room[], parentId: string, child: Room): Room[] {
  const withChild = upsertRoomList(rooms, child);
  return withChild.map((r) => {
    if (r.id !== parentId) return r;
    const already = withChild.some((t) => t.id === child.id && t.parent_room_id === parentId);
    if (!already) return r;
    const siblings = withChild.filter((t) => t.parent_room_id === parentId && !t.is_archived);
    return { ...r, thread_count: Math.max(r.thread_count ?? 0, siblings.length) };
  });
}
