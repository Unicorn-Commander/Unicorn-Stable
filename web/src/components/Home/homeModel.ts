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

/* ── W2: priority inbox ──────────────────────────────────────────────── */

export type PriorityItem =
  | { kind: "mention"; room: Room; unread: number }
  | { kind: "dm"; room: Room; unread: number }
  | { kind: "channel"; room: Room; unread: number }
  | { kind: "approval"; approval: PendingApproval };

export interface PriorityModel {
  /** The interleaved jump list: mentions → DM unreads → approvals → channel
   * unreads. Each group is recency-sorted internally. */
  items: PriorityItem[];
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
}): PriorityModel {
  const { rooms, unreadCounts, mentionUnreads, approvals } = input;
  const channelCap = input.channelCap ?? 5;

  const mentionRooms = rooms
    .filter((r) => mentionUnreads[r.id] === true)
    .sort(sortByRecency);

  const dmUnreadRooms = rooms
    .filter(
      (r) =>
        isHumanConversation(r) &&
        unreadCountFor(r, unreadCounts) > 0 &&
        mentionUnreads[r.id] !== true,
    )
    .sort(sortByRecency);

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
  const channelUnreadRooms = allChannelUnreads.slice(0, channelCap);
  const moreChannelCount = allChannelUnreads.length - channelUnreadRooms.length;

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
  return { items, mentionRooms, dmUnreadRooms, channelUnreadRooms, moreChannelCount };
}

/* ── W5: agent activity feed ─────────────────────────────────────────── */

export interface AgentFeedModel {
  /** Agent rooms with unread — likely waiting on the human. Capped. */
  waiting: Room[];
  /** Total waiting rooms before the cap — the stat tile must count the set,
   * not the visible slice (the old tile quietly capped at its render limit). */
  waitingTotal: number;
  /** Rooms whose latest message was agent-authored, newest first, excluding
   * rooms already in `waiting`. Capped. */
  recent: Room[];
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
  caps: { waiting?: number; recent?: number } = {},
): AgentFeedModel {
  const waitingCap = caps.waiting ?? 5;
  const recentCap = caps.recent ?? 10;

  const allWaiting = rooms
    .filter(
      (r) => isAgentConversation(r) && unreadCountFor(r, unreadCounts) > 0,
    )
    .sort(sortByRecency);
  const waiting = allWaiting.slice(0, waitingCap);

  // Exclude EVERY waiting room (not just the visible slice) so a room never
  // shows up as plain "activity" merely because the waiting list was full.
  const waitingIds = new Set(allWaiting.map((r) => r.id));
  const recent = rooms
    .filter(
      (r) =>
        r.last_message?.sender_type === "agent" && !waitingIds.has(r.id),
    )
    .sort(sortByRecency)
    .slice(0, recentCap);

  return { waiting, waitingTotal: allWaiting.length, recent };
}

/* ── W3: conversations card ──────────────────────────────────────────── */

export function humanChatsByActivity(rooms: Room[], cap = 12): Room[] {
  return roomsForView(rooms, "chats").sort(sortByRecency).slice(0, cap);
}

export function channelsByActivity(rooms: Room[], cap = 12): Room[] {
  return roomsForView(rooms, "channels").sort(sortByRecency).slice(0, cap);
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
 */
export function agentsSegment(
  roster: Pick<Agent, "availability">[],
): AgentsSegment {
  const available = roster.filter((a) => a.availability === "available").length;
  if (available > 0) {
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
