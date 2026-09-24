import type { Agent, PendingApproval, Room } from "@/services/api";
import { roomsForView } from "@/components/Sidebar/sidebarModel";

/**
 * Home dashboard derivations, extracted from HomeDashboard.tsx as pure
 * functions (the repo convention for anything a component derives that is
 * worth a unit test — see sidebarModel.ts, utils/unreadModel.ts).
 *
 * Everything here takes plain data in and returns plain data out. Store maps
 * (`unreadCounts`, `mentionUnreads`) are passed as arguments rather than read
 * from the store so tests never need zustand and the component stays the only
 * place that knows where live state comes from.
 */

/** Recent enough last activity to treat a conference room as "live-ish".
 * A heuristic, not truth — there is no cross-room "live calls" endpoint yet
 * (v2's /home/summary owns that), so the UI labels these rows "Active Xm ago"
 * rather than claiming "live". */
export const LIVE_MEETING_MS = 2 * 60 * 60 * 1000;

/** Live unread override per room id (WS-fed), falling back to the room
 * snapshot's `unread_count` when the store has no fresher value. */
export type UnreadMap = Record<string, number>;
/** Client-tracked "this room has an unseen @-mention" flags (WS-fed). */
export type MentionMap = Record<string, boolean>;

export function roomActivityAt(room: Room): number {
  return new Date(room.last_message?.created_at ?? room.updated_at).getTime();
}

export function sortByRecency(a: Room, b: Room): number {
  return roomActivityAt(b) - roomActivityAt(a);
}

export function isHumanConversation(room: Room): boolean {
  return (
    (room.type === "dm" || room.type === "group_dm") && !room.brigade_agent_id
  );
}

export function isAgentConversation(room: Room): boolean {
  return (
    (room.type === "dm" || room.type === "group_dm") && !!room.brigade_agent_id
  );
}

export function unreadCountFor(room: Room, unreadCounts: UnreadMap): number {
  return unreadCounts[room.id] ?? room.unread_count ?? 0;
}

/** Unread older than this is history, not a to-do. Two weeks of silence means
 * the conversation moved on without you — a "Needs you" list that still leads
 * with it trains the user that the whole list is ignorable. */
export const STALE_UNREAD_MS = 14 * 24 * 60 * 60 * 1000;

export function isStaleRoom(room: Room, now: number): boolean {
  return now - roomActivityAt(room) > STALE_UNREAD_MS;
}

/* ── W2: priority inbox ──────────────────────────────────────────────── */

export type PriorityItem =
  | { kind: "mention"; room: Room; unread: number }
  | { kind: "dm"; room: Room; unread: number }
  | { kind: "channel"; room: Room; unread: number }
  | { kind: "approval"; approval: PendingApproval };

export interface PriorityModel {
  /** The interleaved jump list: mentions → DM unreads → approvals → channel
   * unreads. Each group is recency-sorted internally. Fresh rooms only. */
  items: PriorityItem[];
  /** Rooms that WOULD be priority items but have been idle past
   * STALE_UNREAD_MS — rendered as a muted, collapsed tail so old unread stops
   * impersonating a to-do. Approvals are never staled out: an unanswered
   * approval blocks an agent no matter how old it is. */
  staleItems: PriorityItem[];
  mentionRooms: Room[];
  dmUnreadRooms: Room[];
  /** Channel-unread rooms actually shown (capped). */
  channelUnreadRooms: Room[];
  /** Channels with unread beyond the cap — feeds the "+N more channels" tail. */
  moreChannelCount: number;
}

export function priorityModel(input: {
  rooms: Room[];
  unreadCounts: UnreadMap;
  mentionUnreads: MentionMap;
  approvals: PendingApproval[];
  /** Channel-unread rows shown before the "+N more" tail (spec §4.2 W2: 5). */
  channelCap?: number;
  /** Injected clock (tests); the component passes Date.now(). */
  now?: number;
}): PriorityModel {
  const { rooms, unreadCounts, mentionUnreads, approvals } = input;
  const channelCap = input.channelCap ?? 5;
  const now = input.now ?? Date.now();
  const fresh = (r: Room) => !isStaleRoom(r, now);

  const allMentionRooms = rooms
    .filter((r) => mentionUnreads[r.id] === true)
    .sort(sortByRecency);
  const mentionRooms = allMentionRooms.filter(fresh);

  const allDmUnreadRooms = rooms
    .filter(
      (r) =>
        isHumanConversation(r) &&
        unreadCountFor(r, unreadCounts) > 0 &&
        mentionUnreads[r.id] !== true,
    )
    .sort(sortByRecency);
  const dmUnreadRooms = allDmUnreadRooms.filter(fresh);

  // The new fourth group: a busy channel with 40 unread and no @-mention used
  // to appear nowhere on home. Mention-flagged channels are deduped into the
  // mentions group above (same rule the DM group follows). Agent-room unreads
  // are deliberately NOT here — they are W5's "Waiting on you" group, and one
  // room in two priority lists would double the noise it is meant to cut.
  const allChannelUnreads = rooms
    .filter(
      (r) =>
        r.type === "channel" &&
        unreadCountFor(r, unreadCounts) > 0 &&
        mentionUnreads[r.id] !== true,
    )
    .sort(sortByRecency);
  const freshChannelUnreads = allChannelUnreads.filter(fresh);
  const channelUnreadRooms = freshChannelUnreads.slice(0, channelCap);
  const moreChannelCount = freshChannelUnreads.length - channelUnreadRooms.length;

  const items: PriorityItem[] = [];
  for (const room of mentionRooms) {
    items.push({
      kind: "mention",
      room,
      unread: unreadCountFor(room, unreadCounts),
    });
  }
  for (const room of dmUnreadRooms) {
    items.push({ kind: "dm", room, unread: unreadCountFor(room, unreadCounts) });
  }
  for (const approval of approvals) {
    items.push({ kind: "approval", approval });
  }
  for (const room of channelUnreadRooms) {
    items.push({
      kind: "channel",
      room,
      unread: unreadCountFor(room, unreadCounts),
    });
  }

  // Stale tail, same group order as the fresh list. Stale channels are NOT
  // capped — they only ever render collapsed behind a count.
  const staleItems: PriorityItem[] = [];
  for (const room of allMentionRooms.filter((r) => !fresh(r))) {
    staleItems.push({
      kind: "mention",
      room,
      unread: unreadCountFor(room, unreadCounts),
    });
  }
  for (const room of allDmUnreadRooms.filter((r) => !fresh(r))) {
    staleItems.push({
      kind: "dm",
      room,
      unread: unreadCountFor(room, unreadCounts),
    });
  }
  for (const room of allChannelUnreads.filter((r) => !fresh(r))) {
    staleItems.push({
      kind: "channel",
      room,
      unread: unreadCountFor(room, unreadCounts),
    });
  }

  return {
    items,
    staleItems,
    mentionRooms,
    dmUnreadRooms,
    channelUnreadRooms,
    moreChannelCount,
  };
}

/* ── W5: agent activity feed ─────────────────────────────────────────── */

/**
 * One row of the agent feed: the newest thread with an agent, plus how many
 * OTHER threads with the same agent are folded behind it.
 *
 * Every "New chat" mints a fresh room called "Chat with <agent>", so a user
 * who has talked to Majik six times has six identically-titled rooms. Listing
 * them raw turned the feed into four consecutive rows reading "Chat with
 * Majik" — indistinguishable from each other and from a rendering bug. The
 * sidebar already collapses per-agent; the feed now does too.
 */
export interface AgentThreadRow {
  room: Room;
  /** Other rooms with the same agent, folded behind this one. */
  extraThreads: number;
  /** Unread across those folded threads (this row's own unread is separate). */
  extraUnread: number;
}

export interface AgentFeedModel {
  /** Agent threads with unread — likely waiting on the human. Fresh only
   * (idle < STALE_UNREAD_MS). Capped. */
  waiting: AgentThreadRow[];
  /** Total FRESH waiting ROOMS before grouping/capping — the stat tile must
   * count the set, not the visible slice (the old tile quietly capped at its
   * render limit) and not the collapsed row count. */
  waitingTotal: number;
  /** Waiting rooms idle past STALE_UNREAD_MS — an agent that asked a question
   * a month ago is not "waiting on you", it's history. Rendered collapsed. */
  staleWaitingTotal: number;
  /** Threads whose latest message was agent-authored, newest first, excluding
   * anything already in `waiting`. Capped. */
  recent: AgentThreadRow[];
}

/**
 * Fold rooms that talk to the SAME agent into one row each, newest first.
 *
 * Rooms with no resident agent (an agent posting in a channel) group by their
 * own id, i.e. they never merge with anything.
 */
export function collapseAgentThreads(rooms: Room[]): AgentThreadRow[] {
  const byAgent = new Map<string, Room[]>();
  for (const room of rooms) {
    const key = room.brigade_agent_id ?? `room:${room.id}`;
    const bucket = byAgent.get(key);
    if (bucket) bucket.push(room);
    else byAgent.set(key, [room]);
  }
  const rows: AgentThreadRow[] = [];
  for (const bucket of byAgent.values()) {
    const sorted = [...bucket].sort(sortByRecency);
    const newest = sorted[0];
    if (!newest) continue; // a bucket only exists because a room went into it
    const rest = sorted.slice(1);
    rows.push({
      room: newest,
      extraThreads: rest.length,
      extraUnread: rest.reduce((sum, r) => sum + (r.unread_count ?? 0), 0),
    });
  }
  return rows.sort((a, b) => sortByRecency(a.room, b.room));
}

/**
 * Client-derived agent feed: `last_message.sender_type === "agent"`.
 *
 * `sender_type` is real data end to end — the rooms list eager-loads the
 * sender participant and reuses the canonical message serializer
 * (room_service.list_rooms_for_user → _msg_to_response), so it reflects
 * `participants.participant_type`, not a client guess. This is one row per
 * room (last message only); v2's /home/summary upgrades it to a true
 * per-message feed.
 */
export function agentFeed(
  rooms: Room[],
  unreadCounts: UnreadMap,
  caps: { waiting?: number; recent?: number; now?: number } = {},
): AgentFeedModel {
  const waitingCap = caps.waiting ?? 5;
  const recentCap = caps.recent ?? 10;
  const now = caps.now ?? Date.now();

  const allWaiting = rooms
    .filter(
      (r) => isAgentConversation(r) && unreadCountFor(r, unreadCounts) > 0,
    )
    .sort(sortByRecency);
  const freshWaiting = allWaiting.filter((r) => !isStaleRoom(r, now));
  const waiting = collapseAgentThreads(freshWaiting).slice(0, waitingCap);

  // Exclude EVERY waiting room, fresh or stale, not just the visible slice —
  // a room must never show up as plain "activity" merely because the waiting
  // list was full or because it aged out of it.
  const waitingIds = new Set(allWaiting.map((r) => r.id));
  const recent = collapseAgentThreads(
    rooms.filter(
      (r) => r.last_message?.sender_type === "agent" && !waitingIds.has(r.id),
    ),
  ).slice(0, recentCap);

  return {
    waiting,
    waitingTotal: freshWaiting.length,
    staleWaitingTotal: allWaiting.length - freshWaiting.length,
    recent,
  };
}

/* ── Agents rail ─────────────────────────────────────────────────────── */

const FLEET_STATUS_ORDER: Record<string, number> = {
  working: 0,
  active: 1,
  idle: 2,
  offline: 3,
};

/**
 * Which agents the rail shows, in the order that answers "who do I work with".
 *
 * The old ordering was status-then-alphabetical, and Brigade reports nearly
 * every agent as `active` — so it collapsed to PURE ALPHABETICAL and the rail
 * rendered Brief Drafter, Capt. Cadence, Claude, Cognitive Companion… i.e. a
 * roster of specialists this user has never once spoken to, while Majik and
 * the dev agents they use daily sat below the fold. A directory sorted by
 * accident of spelling is not a dashboard.
 *
 * Rank: (1) agents you actually have a thread with, most recently active
 * first — your working set, and the only signal here that is about YOU;
 * (2) everyone else by Brigade status; (3) name, to keep it deterministic.
 * "Browse all" still reaches the full roster.
 */
export function rankedFleet(
  roster: Agent[],
  rooms: Room[],
  cap = 8,
): Agent[] {
  const lastSeenByAgent = new Map<string, number>();
  for (const room of rooms) {
    const agentId = room.brigade_agent_id;
    if (!agentId) continue;
    const at = roomActivityAt(room);
    if (at > (lastSeenByAgent.get(agentId) ?? 0)) {
      lastSeenByAgent.set(agentId, at);
    }
  }
  return [...roster]
    .sort((a, b) => {
      const aSeen = lastSeenByAgent.get(a.id) ?? 0;
      const bSeen = lastSeenByAgent.get(b.id) ?? 0;
      if (aSeen !== bSeen) return bSeen - aSeen;
      const byStatus =
        (FLEET_STATUS_ORDER[a.status] ?? 9) - (FLEET_STATUS_ORDER[b.status] ?? 9);
      if (byStatus !== 0) return byStatus;
      return (a.display_name || a.name).localeCompare(b.display_name || b.name);
    })
    .slice(0, cap);
}

/**
 * The one-line descriptor under an agent's name.
 *
 * Brigade carries `rank`, `title` and `domain` separately and they frequently
 * restate each other — the CFO row rendered "Chief Financial Officer · Chief
 * Financial Of…", spending its whole width saying one thing twice and then
 * truncating. Keep the parts that add information; drop any that is a prefix
 * of one already shown (case-insensitive).
 */
export function agentSubtitle(parts: (string | null | undefined)[]): string {
  const kept: string[] = [];
  for (const raw of parts) {
    const part = (raw ?? "").trim();
    if (!part) continue;
    const lower = part.toLowerCase();
    const redundant = kept.some((k) => {
      const kl = k.toLowerCase();
      return kl.startsWith(lower) || lower.startsWith(kl);
    });
    if (!redundant) kept.push(part);
  }
  return kept.join(" · ");
}

/* ── W3: conversations card ──────────────────────────────────────────── */

export function humanChatsByActivity(
  rooms: Room[],
  cap = 12,
  exclude?: ReadonlySet<string>,
): Room[] {
  return roomsForView(rooms, "chats")
    .filter((r) => !exclude?.has(r.id))
    .sort(sortByRecency)
    .slice(0, cap);
}

/**
 * `exclude` carries the rooms the priority inbox is ALREADY showing directly
 * above this card. Without it the same two channels rendered twice on one
 * screen — identical title, identical preview, identical unread pill — which
 * reads as a duplication bug and costs the second copy's row for nothing.
 */
export function channelsByActivity(
  rooms: Room[],
  cap = 12,
  exclude?: ReadonlySet<string>,
): Room[] {
  return roomsForView(rooms, "channels")
    .filter((r) => !exclude?.has(r.id))
    .sort(sortByRecency)
    .slice(0, cap);
}

export type ConversationsTab = "chats" | "channels";

/** Default tab = whichever list has the newer top activity. Ties (and the
 * nothing-anywhere case) fall to chats, the human-first default. */
export function defaultConversationsTab(
  chats: Room[],
  channels: Room[],
): ConversationsTab {
  const topChat = chats[0];
  const topChannel = channels[0];
  const chatTop = topChat ? roomActivityAt(topChat) : 0;
  const channelTop = topChannel ? roomActivityAt(topChannel) : 0;
  return channelTop > chatTop ? "channels" : "chats";
}

/* ── W4: live now ────────────────────────────────────────────────────── */

export function liveConferences(input: {
  rooms: Room[];
  unreadCounts: UnreadMap;
  activeCallRoomId: string | null;
  hasActiveCall: boolean;
  now: number;
  cap?: number;
}): Room[] {
  const { rooms, unreadCounts, activeCallRoomId, hasActiveCall, now } = input;
  const cap = input.cap ?? 4;
  return rooms
    .filter((r) => r.is_conference)
    .filter((r) => {
      if (hasActiveCall && r.id === activeCallRoomId) return false;
      const age = now - roomActivityAt(r);
      // Joined conference with recent activity, or any conference the user
      // already belongs to (rejoin target) when updated recently.
      return age <= LIVE_MEETING_MS || unreadCountFor(r, unreadCounts) > 0;
    })
    .sort(sortByRecency)
    .slice(0, cap);
}

/* ── W7: health strip semantics ──────────────────────────────────────── */

/** Honest segment tone: `ok` and `warn` require a positive signal; the
 * absence of any signal is `unknown`, never green (availability doctrine —
 * server/app/services/agent_availability.py). `off` is a fourth state for
 * features the server EXPLICITLY reports as not configured (e.g. Meeting-Ops
 * disabled): it renders gray like unknown, but it is a known-good answer, not
 * a missing one. */
export type SegmentTone = "ok" | "warn" | "unknown" | "off";

/** Worst-of aggregation for the Workspace stat tile: a single warn taints the
 * whole chip, and any unknown blocks the all-clear — "green because we could
 * not check" is exactly the lie the strip exists to prevent. `off` counts as
 * healthy: a feature deliberately not configured must not park the workspace
 * chip on "unknown" forever. */
export function overallTone(tones: SegmentTone[]): SegmentTone {
  if (tones.includes("warn")) return "warn";
  if (tones.includes("unknown") || tones.length === 0) return "unknown";
  return "ok";
}

export interface AgentsSegment {
  tone: SegmentTone;
  label: string;
}

/**
 * The Agents segment of the health strip, from the already-polled roster.
 *
 * There is NO worker-liveness signal today (agent_events are per-voice-session
 * only), so `availability` on the roster is the only honest input:
 *  - any agent explicitly "available"      → ok, count it
 *  - every agent explicitly "unavailable"  → warn — that IS a signal, and
 *    collapsing it into "unknown" would hide a fleet-wide outage
 *  - anything else (empty roster, missing/"unknown" availability) → unknown
 *
 * Wording: Brigade marks ~every registered agent "available", so a roster
 * where EVERYONE is available carries no liveness information — that number
 * is the registration count and gets the same word the Agents rail uses
 * ("registered"). Only a real split earns "available".
 */
export function agentsSegment(
  roster: Pick<Agent, "availability">[],
): AgentsSegment {
  const available = roster.filter((a) => a.availability === "available").length;
  if (available > 0) {
    if (available === roster.length) {
      return { tone: "ok", label: `${available} registered` };
    }
    return { tone: "ok", label: `${available} available` };
  }
  if (
    roster.length > 0 &&
    roster.every((a) => a.availability === "unavailable")
  ) {
    return { tone: "warn", label: "unreachable" };
  }
  return { tone: "unknown", label: "unknown" };
}

/** One row of the Server segment's per-service tooltip. */
export interface ServiceEntry {
  name: string;
  state: string;
}

/**
 * Flatten /api/v1/health's `services` map for a tooltip. Values vary by
 * service (plain strings, `{state, required}`, `{revision}`…), so anything
 * non-string is reduced to its most status-like field rather than JSON noise.
 */
export function serviceEntries(services: Record<string, unknown>): ServiceEntry[] {
  const entries: ServiceEntry[] = [];
  for (const [name, value] of Object.entries(services)) {
    if (name === "build") continue; // rendered separately as the revision sha
    if (typeof value === "string") {
      entries.push({ name, state: value });
    } else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      const state = v.state ?? v.status;
      entries.push({
        name,
        state: typeof state === "string" ? state : "unknown",
      });
    }
  }
  return entries;
}

/** Short deploy sha from `services.build.revision`, or null. Surfaced so a
 * self-hoster can spot deploy drift from the dashboard (the "deploy checkout
 * behind the running image" failure mode). */
export function buildRevision(
  services: Record<string, unknown> | undefined,
): string | null {
  const build = services?.build;
  if (!build || typeof build !== "object") return null;
  const revision = (build as Record<string, unknown>).revision;
  if (typeof revision !== "string" || revision.length === 0) return null;
  return revision.slice(0, 7);
}

/* ── Dashboard v3 ────────────────────────────────────────────────── */

export const HOME_SECTION_IDS = [
  "needs_you",
  "live_now",
  "crew",
  "recent",
  "today",
] as const;

export type HomeSectionId = (typeof HOME_SECTION_IDS)[number];

/** A live call plus the v3 pills. Missing flags mean the detail poll has not landed. */
export interface HomeLiveCall {
  room_id: string;
  display_name: string;
  room_type: string;
  participant_count: number;
  has_agent: boolean;
  recording?: boolean;
  broadcast?: boolean;
  floor_holder?: {
    participant_id: string;
    kind: string;
    display_name: string;
    avatar_url: string | null;
    agent_id: string | null;
  } | null;
}

export function normalizeSectionOrder(
  order: readonly string[] | null | undefined,
): HomeSectionId[] {
  const known = new Set<string>(HOME_SECTION_IDS);
  const out: HomeSectionId[] = [];
  for (const id of order ?? []) {
    if (known.has(id) && !out.includes(id as HomeSectionId)) {
      out.push(id as HomeSectionId);
    }
  }
  for (const id of HOME_SECTION_IDS) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function moveSection(
  order: readonly HomeSectionId[],
  id: HomeSectionId,
  dir: -1 | 1,
): HomeSectionId[] {
  const next = [...order];
  const index = next.indexOf(id);
  const target = index + dir;
  if (index < 0 || target < 0 || target >= next.length) return next;
  const from = next[index];
  const to = next[target];
  if (!from || !to) return next;
  next[index] = to;
  next[target] = from;
  return next;
}

export function reorderSections(
  order: readonly HomeSectionId[],
  fromId: HomeSectionId,
  toId: HomeSectionId,
): HomeSectionId[] {
  if (fromId === toId) return [...order];
  const next = order.filter((id) => id !== fromId);
  const index = next.indexOf(toId);
  if (index < 0) return [...order];
  next.splice(index, 0, fromId);
  return next;
}

export function partitionNeedsYou<T extends { stale: boolean }>(
  rows: readonly T[],
): { fresh: T[]; stale: T[] } {
  return {
    fresh: rows.filter((row) => !row.stale),
    stale: rows.filter((row) => row.stale),
  };
}

/** Last 12 conversations touched, human DMs and groups before everything else. */
export function recentConversations(rooms: Room[], cap = 12): Room[] {
  const visible = rooms.filter((room) => !room.is_archived);
  const human = visible.filter(isHumanConversation).sort(sortByRecency);
  const other = visible
    .filter((room) => !isHumanConversation(room))
    .sort(sortByRecency);
  return [...human, ...other].slice(0, cap);
}

/** Heartbeat / task "since" newer than this still counts as working. */
export const CREW_WORKING_MS = 90_000;

export function isCrewWorking(
  card: { current_task?: string | null; since?: string | null; status: string },
  now: number,
): boolean {
  if (card.current_task) return true;
  if (!card.since || card.status === "offline") return false;
  const at = Date.parse(card.since);
  if (Number.isNaN(at)) return false;
  return now - at <= CREW_WORKING_MS;
}

export function modeLabel(mode: string | null | undefined): string {
  switch (mode) {
    case "answers_all":
      return "Answers all";
    case "when_named":
      return "When named";
    case "listening":
      return "Listening";
    case "muted":
      return "Muted";
    default:
      return "Default";
  }
}

/**
 * How Home draws a section once the summary has resolved.
 *
 * `content` — rows, header, and a count. Same as a section that already has work.
 * `line` — the section exists and is empty right now: one quiet sentence.
 * `omit` — it has never had content: no header and no zero.
 *
 * When nothing needs you, those quiet lines fold into one "You're all clear".
 * A live call, a crew card, a recent room, or a today row still renders.
 */
export type SectionChrome = "content" | "line" | "omit";

export interface HomeInboxFacts {
  /** Fresh and stale needs-you rows. Stale still counts as content. */
  needsCount: number;
  liveCount: number;
  crewCount: number;
  recentCount: number;
  /** The user has rooms, including ones recentConversations hides as archived. */
  hadConversations: boolean;
  todayCount: number;
  /** False when Today is unreachable and nothing local stands in. */
  todayKnown: boolean;
}

export interface HomeEmptyPolicy {
  allClear: boolean;
  sections: Record<HomeSectionId, SectionChrome>;
}

export function homeEmptyPolicy(facts: HomeInboxFacts): HomeEmptyPolicy {
  const sections: Record<HomeSectionId, SectionChrome> = {
    needs_you: facts.needsCount > 0 ? "content" : "line",
    live_now: facts.liveCount > 0 ? "content" : "line",
    // No crew cards means the section has never had content.
    crew: facts.crewCount > 0 ? "content" : "omit",
    recent:
      facts.recentCount > 0 ? "content" : facts.hadConversations ? "line" : "omit",
    today: facts.todayCount > 0 ? "content" : facts.todayKnown ? "line" : "omit",
  };

  const allClear = facts.needsCount === 0;
  if (allClear) {
    sections.needs_you = "omit";
    if (sections.live_now === "line") sections.live_now = "omit";
    if (sections.recent === "line") sections.recent = "omit";
    if (sections.today === "line") sections.today = "omit";
  }
  return { allClear, sections };
}

/** Human DMs starred in People, in that order, then the other recent rooms. */
export function homeRailConversations(
  rooms: Room[],
  favoriteIds: readonly string[],
  cap = 8,
): { pinned: Room[]; recent: Room[] } {
  const pinned: Room[] = [];
  const seen = new Set<string>();
  const dms = rooms.filter(
    (room) =>
      !room.is_archived &&
      !room.parent_room_id &&
      isHumanConversation(room),
  );
  for (const id of favoriteIds) {
    if (!id) continue;
    const room = dms.find(
      (candidate) => !seen.has(candidate.id) && roomParticipantIds(candidate).includes(id),
    );
    if (!room) continue;
    seen.add(room.id);
    pinned.push(room);
  }
  return {
    pinned,
    recent: recentConversations(
      rooms.filter((room) => !seen.has(room.id)),
      cap,
    ),
  };
}

function roomParticipantIds(room: Room): string[] {
  const ids: string[] = [];
  if (room.counterpart?.participant_id) ids.push(room.counterpart.participant_id);
  for (const member of room.members) {
    if (member.participant_id) ids.push(member.participant_id);
    if (member.user_id) ids.push(member.user_id);
    if (member.id) ids.push(member.id);
  }
  return ids;
}

/**
 * Hide Today only when both federated blocks are null and there is no local
 * standing-room catalog to show instead. An empty list is a real answer.
 */
export function todaySectionHidden(
  today: { po_tasks: unknown[] | null; meetings: unknown[] | null } | null,
  standingFallback: number,
): boolean {
  if (today == null) return standingFallback === 0;
  if (today.po_tasks == null && today.meetings == null) return standingFallback === 0;
  return false;
}

/** Occupancy from the shared live-call poll, with v3 recording / floor laid on top. */
export function mergeLiveCalls(
  live: readonly HomeLiveCall[],
  detailed: readonly HomeLiveCall[],
): HomeLiveCall[] {
  const extra = new Map(detailed.map((call) => [call.room_id, call]));
  const seen = new Set<string>();
  const out: HomeLiveCall[] = [];
  for (const call of live) {
    seen.add(call.room_id);
    const rich = extra.get(call.room_id);
    out.push({
      room_id: call.room_id,
      display_name: rich?.display_name || call.display_name,
      room_type: rich?.room_type || call.room_type,
      participant_count: call.participant_count,
      has_agent: call.has_agent,
      recording: rich?.recording ?? false,
      broadcast: rich?.broadcast ?? false,
      floor_holder: rich?.floor_holder ?? null,
    });
  }
  for (const call of detailed) {
    if (!seen.has(call.room_id)) out.push(call);
  }
  return out;
}
