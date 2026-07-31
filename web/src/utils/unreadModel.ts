/**
 * Focused unread controls (human-first nav, slice 3).
 *
 * Pure helpers so classic RoomList and any future view-based sidebar share the
 * same filter / sort / badge rules. Mute semantics match `mute.ts`:
 *   - "muted"    → no badge contribution
 *   - "mentions" → still badges (ping is gated elsewhere)
 *   - "all"      → full badge
 *
 * Focused mode shows rooms that need attention:
 *   - DMs / group DMs with a badge-visible unread
 *   - rooms with an unread @-mention (client-tracked)
 *   - the currently active room (so the list doesn't yank under you)
 *
 * Mentions sort first within Focused; then DM unreads; then everything else
 * keeps its relative (recency) order.
 */

import { getNotifyLevel, type NotifyLevel } from "@/utils/mute";
import type { Room } from "@/services/api";

export type FocusMode = "focused" | "all";

export const FOCUS_MODE_STORAGE_KEY = "stable.sidebar-focus-mode.v1";

export function loadFocusMode(): FocusMode {
  try {
    const raw = localStorage.getItem(FOCUS_MODE_STORAGE_KEY);
    if (raw === "focused" || raw === "all") return raw;
  } catch {
    /* ignore */
  }
  return "all";
}

export function saveFocusMode(mode: FocusMode): void {
  try {
    localStorage.setItem(FOCUS_MODE_STORAGE_KEY, mode);
  } catch {
    /* ignore quota / private mode */
  }
}

/** Does this message @-mention the current user? Matches @here / @channel or
 *  @username (word-boundary, case-insensitive). Shared by notification pings
 *  and mention-unread tracking. */
export function messageMentionsUser(
  content: string | undefined,
  username: string | undefined,
): boolean {
  if (!content) return false;
  if (/@channel\b|@here\b/i.test(content)) return true;
  if (!username) return false;
  const esc = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${esc}\\b`, "i").test(content);
}

/**
 * Badge number for a room after mute filtering.
 * Fully muted rooms contribute 0 so they never inflate sidebar or rail totals.
 */
export function badgeCount(
  roomId: string,
  rawUnread: number,
  level?: NotifyLevel,
): number {
  const lvl = level ?? getNotifyLevel(roomId);
  if (lvl === "muted") return 0;
  return Math.max(0, rawUnread | 0);
}

/** Sum badge counts for a list of rooms (federation rail, section headers). */
export function sumBadgeCounts(
  rooms: Array<{ id: string; unread_count?: number }>,
  unreadById?: Record<string, number>,
): number {
  let total = 0;
  for (const r of rooms) {
    const raw = unreadById?.[r.id] ?? r.unread_count ?? 0;
    total += badgeCount(r.id, raw);
  }
  return total;
}

export function isDmLike(room: { type: string }): boolean {
  return room.type === "dm" || room.type === "group_dm";
}

export interface RoomFocusMeta {
  /** Live or cold-load unread (pre-mute). */
  unread: number;
  /** Client-tracked: at least one unread message @-mentioned me. */
  hasMention: boolean;
  notifyLevel: NotifyLevel;
  /** Keep the open room visible even when Focused would otherwise drop it. */
  isActive?: boolean;
}

/**
 * Whether a room belongs in Focused mode.
 * High-priority for v1 = DM-like with badge-visible unread (no separate flag).
 */
export function qualifiesForFocused(
  room: { id: string; type: string },
  meta: RoomFocusMeta,
): boolean {
  if (meta.isActive) return true;
  if (meta.notifyLevel === "muted") return false;
  const badge = badgeCount(room.id, meta.unread, meta.notifyLevel);
  if (meta.hasMention) return true;
  if (isDmLike(room) && badge > 0) return true;
  return false;
}

/** Sort tier within Focused: mentions (0) → DM unreads (1) → rest (2). */
export function focusSortTier(
  room: { id: string; type: string },
  meta: RoomFocusMeta,
): number {
  if (meta.notifyLevel === "muted") return 3;
  if (meta.hasMention) return 0;
  const badge = badgeCount(room.id, meta.unread, meta.notifyLevel);
  if (isDmLike(room) && badge > 0) return 1;
  return 2;
}

export type RoomMetaResolver = (room: Room) => RoomFocusMeta;

/**
 * Filter + reorder rooms for the sidebar builder.
 * "all" is a no-op (returns the same array reference).
 * "focused" filters then stable-sorts mentions-first.
 */
export function prepareRoomsForSidebar(
  rooms: Room[],
  mode: FocusMode,
  getMeta: RoomMetaResolver,
): Room[] {
  if (mode !== "focused") return rooms;

  const filtered = rooms.filter((r) => qualifiesForFocused(r, getMeta(r)));
  // Stable sort: assign original index so equal tiers keep recency order.
  return filtered
    .map((room, index) => ({ room, index, tier: focusSortTier(room, getMeta(room)) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((x) => x.room);
}

/** Rooms that still need a mark-read (raw unread > 0). */
export function roomsNeedingMarkRead(
  rooms: Room[],
  getUnread: (room: Room) => number,
): Room[] {
  return rooms.filter((r) => getUnread(r) > 0);
}
