import type { Agent, CrewGroup, CrewMember, Room } from "@/services/api";
import {
  CREW_GROUP_LABEL,
  CREW_GROUP_ORDER,
  crewBrainChip,
  crewTargetRoom,
  type CrewTargetKind,
} from "@/lib/crew";
import {
  isAgentConversation,
  isDirectRoom,
  isPrivateChannel as roomIsPrivate,
  isThreadRoom,
  olderArchivedLabel,
} from "@/lib/conversation";
import {
  collapseKey,
  foldersFor,
  type FolderDef,
  type FolderSection,
  type PersonThreads,
} from "@/stores/categoryStore";
import type { ConversationFilter, NavView } from "@/stores/navStore";

/**
 * The sidebar's structure, computed once and consumed by everything that needs
 * to know what the sidebar looks like.
 *
 * This module exists because there used to be TWO models. RoomList built the
 * visible tree, and AppShell's sidebarRoomOrder() built a second, parallel one
 * for Alt+↑/↓. The moment the sidebar grew people rows, a private-groups
 * section and folders, the keyboard walked an order that no longer matched
 * anything on screen — the classic failure of a copy that has to be kept in
 * sync by hand. So there is exactly one builder now: RoomList RENDERS this
 * model and AppShell FLATTENS the same model. A layout change lands in both by
 * construction, because there is nothing to keep in sync.
 *
 * That is also why the search query and the per-person expand state live in a
 * store (useSidebarUi) rather than in RoomList's local state: they change what
 * is on screen, so keyboard navigation has to see them too.
 *
 * View-based nav (Slice 2) filters rooms through `view` before building the
 * sections. Classic mode uses `view: "all"`. Home yields an empty tree (the
 * UI shows a short home rail instead).
 */

/**
 * Which rooms land in which destination. `"all"` = classic single list.
 * `"chats"` is the pre-Direct alias Home still asks for: human DMs only.
 */
export type SidebarView = NavView | "all" | "chats";

function isParentInView(room: Room, view: SidebarView): boolean {
  switch (view) {
    case "all":
      return true;
    case "home":
      return false;
    case "chats":
      return (
        (room.type === "dm" || room.type === "group_dm") &&
        !isAgentConversation(room)
      );
    case "direct":
      return isDirectRoom(room);
    case "channels":
      return room.type === "channel" && !room.is_conference;
    case "agents":
      return isAgentConversation(room) && room.type !== "channel";
    case "meetings":
      return room.is_conference === true;
    default:
      return true;
  }
}

/**
 * Pre-filter the room list for a sidebar destination. Shared by RoomList and
 * Alt+↑/↓ so keyboard order always matches the visible rows.
 *
 * Child threads ride along with their parent so the model can nest them.
 * A thread whose parent is not in this view stays out.
 */
export function roomsForView(rooms: Room[], view: SidebarView): Room[] {
  if (view === "home") return [];
  const parents = rooms.filter((r) => !isThreadRoom(r) && isParentInView(r, view));
  const parentIds = new Set(parents.map((r) => r.id));
  const children = rooms.filter(
    (r) => !!r.parent_room_id && parentIds.has(r.parent_room_id),
  );
  return [...parents, ...children];
}

/** Section-level collapse keys. Bare on purpose — a section is the same concept
 *  on every instance. Distinct from categoryStore's folder keys, which are
 *  prefixed `folder:` and carry the instance. */
export const SECTION_KEYS = {
  channels: "section:channels",
  people: "section:people",
  groups: "section:groups",
  crew: "section:crew",
} as const;

export type SectionId = keyof typeof SECTION_KEYS;

/**
 * Which person row a room belongs to, or null if it is not a person at all
 * (channels, and human multi-party rooms, which get their own section).
 *
 * This is the identity a people-folder is filed against, so it is deliberately
 * the ONLY definition of it — the sidebar grouping and the folder lookup read
 * the same function and cannot drift into disagreeing about who someone is.
 *
 * Note it is a NAME, not a server-unique id, which is why categoryStore keeps
 * people assignments bucketed per instance instead of globally.
 */
export function personKeyOf(room: Room): string | null {
  if (isThreadRoom(room)) return null;
  if (room.type === "agent_hub" || room.brigade_agent_id) {
    const id = room.brigade_agent_id || room.counterpart?.agent_id;
    if (id && room.type !== "channel") return `agent:${id}`;
  }
  if (room.type !== "dm" && room.type !== "group_dm" && room.type !== "agent_hub") {
    return null;
  }
  if (room.type === "group_dm") return null;
  if (room.type === "agent_hub") {
    const id = room.counterpart?.agent_id || room.id;
    return `agent:${id}`;
  }
  // Prefer the server counterpart id so two people who share a display name
  // do not collapse into one row. Fall back to the label the row already shows.
  if (room.counterpart?.participant_id) return `person:${room.counterpart.participant_id}`;
  return `person:${room.name}`;
}

/**
 * Channels are discoverable and self-joinable by anyone on the instance (see
 * GET /rooms/browse) — they are the PUBLIC surface. DMs and group DMs are never
 * browsable, so they are the private one. `is_private` is read defensively: the
 * backend has no per-channel privacy column today, and the day it grows one the
 * sidebar honours it without another change here.
 */
export function isPrivateChannel(room: Room): boolean {
  return roomIsPrivate(room) || (room as { is_private?: boolean }).is_private === true;
}

export type PersonEntry =
  | {
      kind: "agent";
      key: string;
      agentId: string;
      /** The hub (or the newest legacy DM) the row represents. */
      hub: Room;
      /** Child threads, newest first. A hub with none lists just the hub. */
      threads: Room[];
      archivedCount: number;
      mode: string | null;
    }
  | {
      kind: "person";
      key: string;
      name: string;
      hub: Room;
      threads: Room[];
      archivedCount: number;
    };

export type SidebarRow =
  | {
      kind: "channel";
      id: string;
      room: Room;
      threads: Room[];
      expanded: boolean;
      archivedCount: number;
    }
  | {
      kind: "group";
      id: string;
      room: Room;
      threads: Room[];
      expanded: boolean;
      archivedCount: number;
    }
  | { kind: "person"; id: string; entry: PersonEntry; expanded: boolean };

export { olderArchivedLabel };

export interface SidebarGroup {
  /** The folder this group is, or null for the ungrouped tail. */
  folder: string | null;
  section: FolderSection | null;
  /** null for the ungrouped tail, which has no header and never collapses. */
  collapseKey: string | null;
  collapsed: boolean;
  rows: SidebarRow[];
}

export interface SidebarSection {
  id: SectionId;
  collapseKey: string;
  collapsed: boolean;
  /** Named folders A→Z, then the ungrouped tail last. */
  groups: SidebarGroup[];
}

export interface SidebarModel {
  /** People (DMs) first, then private groups, then channels — a fixed tuple,
   *  not a loose list, so both consumers can name a section without a
   *  might-be-undefined dance.
   *
   *  Order matches the product ask (Meeting-Ops 77fd49a9): DMs above channels.
   *  Keyboard Alt+↑/↓ flattens `sections` in this same order. */
  sections: readonly [SidebarSection, SidebarSection, SidebarSection];
  /** Every person on this instance and all of their rooms, from the UNFILTERED
   *  room list — its consumer is the one-way people migration, which must never
   *  see just whatever the search box happens to be showing. */
  allPersonThreads: PersonThreads[];
  /** roomId -> is it a channel, for every room THIS server serves. Feeds
   *  adoptLegacyCategories, which uses it to tell its own rooms from another
   *  backend's. */
  roomKinds: Record<string, boolean>;
}

export interface SidebarModelInput {
  rooms: Room[];
  searchQuery: string;
  scope: string | null;
  categories: Record<string, Record<string, string>>;
  people: Record<string, Record<string, string>>;
  folders: Record<string, FolderDef[]>;
  collapsed: Record<string, boolean>;
  expandedPeople: Record<string, boolean>;
  /**
   * Destination filter. Defaults to `"all"` (classic full tree). When a
   * specific view is set, only matching rooms appear — Alt+↑/↓ flattens the
   * same filtered model, so keyboard order stays consistent with the list.
   */
  view?: SidebarView;
}

export function buildSidebarModel(input: SidebarModelInput): SidebarModel {
  const {
    rooms: allRooms,
    searchQuery,
    scope,
    categories,
    people,
    folders,
    collapsed,
    expandedPeople,
    view = "all",
  } = input;

  // View filter first so both search and section builders see the same set.
  // allPersonThreads (people-folder migration) still reads the unfiltered list
  // so filing is not lost when a view hides half the people.
  const rooms = roomsForView(allRooms, view);

  const roomKinds: Record<string, boolean> = {};
  for (const r of allRooms) roomKinds[r.id] = r.type === "channel";

  // Every person on this instance, from the unfiltered list (see the field doc).
  const threadsByPerson = new Map<string, string[]>();
  for (const room of allRooms) {
    const key = personKeyOf(room);
    if (!key) continue;
    const ids = threadsByPerson.get(key);
    if (ids) ids.push(room.id);
    else threadsByPerson.set(key, [room.id]);
  }
  const allPersonThreads = [...threadsByPerson.entries()].map(
    ([key, roomIds]) => ({ key, roomIds }),
  );

  const q = searchQuery.trim().toLowerCase();
  const selfMatch = (room: Room) =>
    !q ||
    room.name.toLowerCase().includes(q) ||
    (room.description || "").toLowerCase().includes(q) ||
    (room.project_number || "").toLowerCase().includes(q);
  const keep = new Set<string>();
  if (!q) {
    for (const room of rooms) keep.add(room.id);
  } else {
    for (const room of rooms) {
      if (!selfMatch(room)) continue;
      keep.add(room.id);
      if (room.parent_room_id) keep.add(room.parent_room_id);
    }
    for (const room of rooms) {
      if (!room.parent_room_id && selfMatch(room)) {
        for (const child of rooms) {
          if (child.parent_room_id === room.id) keep.add(child.id);
        }
      }
    }
  }
  const filtered = rooms.filter((room) => keep.has(room.id));

  const childrenOf = new Map<string, Room[]>();
  const tops: Room[] = [];
  for (const room of filtered) {
    if (room.parent_room_id && keep.has(room.parent_room_id)) {
      if (room.is_archived) continue;
      const list = childrenOf.get(room.parent_room_id);
      if (list) list.push(room);
      else childrenOf.set(room.parent_room_id, [room]);
      continue;
    }
    if (room.parent_room_id) continue;
    tops.push(room);
  }

  function liveChildren(parentId: string): Room[] {
    return childrenOf.get(parentId) ?? [];
  }

  function archivedCount(parentId: string): number {
    let n = 0;
    for (const room of allRooms) {
      if (room.parent_room_id === parentId && room.is_archived) n += 1;
    }
    return n;
  }

  function modeOf(room: Room): string | null {
    const bound = room.brigade_agent_id || room.counterpart?.agent_id || null;
    const members = room.agent_members ?? [];
    const hit = bound ? members.find((m) => m.agent_id === bound) : members[0];
    return hit?.agent_mode ?? members[0]?.agent_mode ?? null;
  }

  // Parents only. Threads hang under the parent (hub, DM, group, channel).
  // Legacy agent DMs that predate hubs still collapse to one row per agent.
  // List order is newest-first, and we preserve it.
  const agentParents = new Map<string, Room[]>();
  const humanParents = new Map<string, Room[]>();
  const channelParents: Room[] = [];
  const groupParents: Room[] = [];
  for (const room of tops) {
    if (room.type === "channel") {
      channelParents.push(room);
      continue;
    }
    if (room.type === "group_dm") {
      groupParents.push(room);
      continue;
    }
    const key = personKeyOf(room);
    if (!key) continue;
    const bucket = key.startsWith("agent:") ? agentParents : humanParents;
    const list = bucket.get(key);
    if (list) list.push(room);
    else bucket.set(key, [room]);
  }

  const peopleEntries: PersonEntry[] = [];
  const seenPeople = new Set<string>();
  for (const room of tops) {
    if (room.type === "channel" || room.type === "group_dm") continue;
    const key = personKeyOf(room);
    if (!key || seenPeople.has(key)) continue;
    seenPeople.add(key);
    if (key.startsWith("agent:")) {
      const parents = agentParents.get(key) ?? [room];
      const hub = parents.find((p) => p.type === "agent_hub") ?? parents[0]!;
      const extras = parents.filter((p) => p.id !== hub.id);
      const nested = [
        ...liveChildren(hub.id),
        ...extras.flatMap((extra) => [extra, ...liveChildren(extra.id)]),
      ];
      peopleEntries.push({
        kind: "agent",
        key,
        agentId: hub.brigade_agent_id || hub.counterpart?.agent_id || key.slice("agent:".length),
        hub,
        threads: nested.length > 0 ? nested : [hub],
        archivedCount: archivedCount(hub.id),
        mode: modeOf(hub),
      });
    } else {
      const parents = humanParents.get(key) ?? [room];
      const hub = parents[0]!;
      const extras = parents.slice(1);
      const nested = [
        ...liveChildren(hub.id),
        ...extras.flatMap((extra) => [extra, ...liveChildren(extra.id)]),
      ];
      peopleEntries.push({
        kind: "person",
        key,
        name: hub.counterpart?.display_name || hub.name,
        hub,
        threads: [hub, ...nested],
        archivedCount: archivedCount(hub.id),
      });
    }
  }

  const filedChannels = (scope ? categories[scope] : undefined) ?? {};
  const filedPeople = (scope ? people[scope] : undefined) ?? {};

  const searching = q.length > 0;
  const channelGroups = groupRows(
    channelParents.map((room): SidebarRow => ({
      kind: "channel",
      id: room.id,
      room,
      threads: liveChildren(room.id),
      expanded: searching || expandedPeople[room.id] === true,
      archivedCount: archivedCount(room.id),
    })),
    foldersFor(folders, scope, "channels"),
    (row) => (row.kind === "channel" ? filedChannels[row.room.id] : undefined),
    "channels",
    scope,
    collapsed,
    searching,
  );

  const peopleGroups = groupRows(
    peopleEntries.map(
      (entry): SidebarRow => ({
        kind: "person",
        id: entry.key,
        entry,
        expanded: searching || expandedPeople[entry.key] === true,
      }),
    ),
    foldersFor(folders, scope, "people"),
    (row) => (row.kind === "person" ? filedPeople[row.entry.key] : undefined),
    "people",
    scope,
    collapsed,
    searching,
  );

  const groupRowsOnly: SidebarRow[] = groupParents.map((room) => ({
    kind: "group",
    id: room.id,
    room,
    threads: liveChildren(room.id),
    expanded: searching || expandedPeople[room.id] === true,
    archivedCount: archivedCount(room.id),
  }));

  return {
    // People (DMs / agents) → private groups → channels. The render order in
    // RoomList must match this tuple (and does — it destructures by name).
    sections: [
      {
        id: "people",
        collapseKey: SECTION_KEYS.people,
        collapsed: collapsed[SECTION_KEYS.people] === true,
        groups: peopleGroups,
      },
      {
        id: "groups",
        collapseKey: SECTION_KEYS.groups,
        collapsed: collapsed[SECTION_KEYS.groups] === true,
        // Private groups are not folder-able (they are a privacy class, not a
        // person or a channel), so they are one untitled tail.
        groups: [
          {
            folder: null,
            section: null,
            collapseKey: null,
            collapsed: false,
            rows: groupRowsOnly,
          },
        ],
      },
      {
        id: "channels",
        collapseKey: SECTION_KEYS.channels,
        collapsed: collapsed[SECTION_KEYS.channels] === true,
        groups: channelGroups,
      },
    ],
    allPersonThreads,
    roomKinds,
  };
}

/**
 * Bucket rows into this instance's folders, folders A→Z then the ungrouped
 * tail.
 *
 * Empty folders are KEPT while browsing — a folder you created but have not
 * filled still needs a header to hang its rename/delete menu off, and an
 * invisible folder you cannot remove is how a typo becomes permanent. While a
 * search is running they are dropped instead: a folder that is empty only
 * because of the filter would be pure noise, and its rows are not on screen.
 */
function groupRows(
  rows: SidebarRow[],
  folderNames: string[],
  folderOf: (row: SidebarRow) => string | undefined,
  section: FolderSection,
  scope: string | null,
  collapsed: Record<string, boolean>,
  searching: boolean,
): SidebarGroup[] {
  const known = new Set(folderNames);
  const byFolder = new Map<string, SidebarRow[]>();
  const ungrouped: SidebarRow[] = [];
  for (const row of rows) {
    const name = folderOf(row);
    // A name we do not know on THIS instance means the folder was deleted (or
    // the assignment predates it) — the row falls back to ungrouped rather than
    // conjuring a folder that does not exist.
    if (name && known.has(name)) {
      const arr = byFolder.get(name);
      if (arr) arr.push(row);
      else byFolder.set(name, [row]);
    } else {
      ungrouped.push(row);
    }
  }
  const groups: SidebarGroup[] = [];
  for (const name of folderNames) {
    const rowsIn = byFolder.get(name) ?? [];
    if (searching && rowsIn.length === 0) continue;
    const key = collapseKey(scope, name, section);
    groups.push({
      folder: name,
      section,
      collapseKey: key,
      collapsed: collapsed[key] === true,
      rows: rowsIn,
    });
  }
  groups.push({
    folder: null,
    section,
    collapseKey: null,
    collapsed: false,
    rows: ungrouped,
  });
  return groups;
}

/**
 * The sidebar's visible room order, flattened for Alt+↑/↓.
 *
 * Each entry is the set of room ids that one VISIBLE row can be reached by;
 * entry[0] is the navigation target. A collapsed person row carries all of that
 * person's threads so a non-newest thread still resolves to the row's position
 * instead of falling off the list; an expanded one contributes its threads
 * individually, because that is what is actually on screen.
 *
 * Collapsed sections and collapsed folders contribute nothing — their rows are
 * not visible, and Alt+↓ must not teleport into something you cannot see.
 */
export function flattenSidebarOrder(model: SidebarModel): string[][] {
  const entries: string[][] = [];
  for (const section of model.sections) {
    if (section.collapsed) continue;
    for (const group of section.groups) {
      if (group.collapsed) continue;
      for (const row of group.rows) {
        if (row.kind === "person") {
          const ids = row.entry.threads.map((t) => t.id);
          if (ids.length === 0) continue;
          if (row.expanded && ids.length > 1) {
            for (const id of ids) entries.push([id]);
          } else {
            entries.push(ids);
          }
        } else {
          const nested = row.threads.map((t) => t.id);
          if (row.expanded && nested.length > 0) {
            entries.push([row.id]);
            for (const id of nested) entries.push([id]);
          } else {
            entries.push(nested.length > 0 ? [row.id, ...nested] : [row.id]);
          }
        }
      }
    }
  }
  return entries;
}

/** The mark a one-list row wears. Threads are not rows. */
export type ConversationShape = "direct" | "group" | "channel";

export function conversationShape(row: SidebarRow): ConversationShape {
  if (row.kind === "channel") return "channel";
  if (row.kind === "group") return "group";
  return "direct";
}

/** Parent plus the threads that live inside it. The hub counts even when the
 *  expanded list is only children. */
export function roomsOnConversationRow(row: SidebarRow): Room[] {
  if (row.kind === "person") {
    const hub = row.entry.hub;
    const extra = row.entry.threads.filter((thread) => thread.id !== hub.id);
    return [hub, ...extra];
  }
  return [row.room, ...row.threads];
}

function conversationRowId(row: SidebarRow): string {
  if (row.kind === "person") return row.entry.hub.id;
  return row.room.id;
}

/** Newest activity on the row: last message, else the room's own timestamps. */
export function conversationRecency(row: SidebarRow): number {
  let best = 0;
  for (const room of roomsOnConversationRow(row)) {
    const stamp =
      room.last_message?.created_at || room.updated_at || room.created_at;
    const at = Date.parse(stamp || "");
    if (Number.isFinite(at) && at > best) best = at;
  }
  return best;
}

function rowHasUnread(
  row: SidebarRow,
  isUnread: (room: Room) => boolean,
  activeRoomId?: string | null,
): boolean {
  const onRow = roomsOnConversationRow(row);
  // Opening a room clears its unread before the route catches up, which used
  // to drop it out of the unread group and make Alt+↓ skip the rows above it.
  // While it is the open room it stays in that group (same idea as Focused
  // mode's isActive). A read room you are simply looking at stays visible in
  // the Unread filter for the same reason.
  if (activeRoomId && onRow.some((room) => room.id === activeRoomId)) return true;
  return onRow.some(isUnread);
}

/**
 * Group rows ask identity for a facepile. The list payload's `members` is
 * empty, so the resolver falls through to the last sender and does not check
 * whether that sender is you. Drop that fallback here. Callers still render
 * the group glyph when fewer than two faces come back.
 */
export function groupFaceRoom(
  room: Room,
  selfIds: readonly (string | null | undefined)[],
): Room {
  const sender = room.last_message?.sender_id;
  if (!sender) return room;
  for (const id of selfIds) {
    if (id && id === sender) return { ...room, last_message: null };
  }
  return room;
}

export interface ConversationListInput {
  rooms: Room[];
  searchQuery: string;
  scope: string | null;
  categories: SidebarModelInput["categories"];
  people: SidebarModelInput["people"];
  folders: SidebarModelInput["folders"];
  expandedPeople: Record<string, boolean>;
  filter: ConversationFilter;
  isUnread: (room: Room) => boolean;
  /** Open room. Stays in the unread group until the user leaves it. */
  activeRoomId?: string | null;
}

/**
 * The one Conversations list.
 *
 * Built from the same row model as the sectioned sidebar (so a thread stays
 * under its parent) then flattened and ordered unread-first, then recency.
 * Section collapse and folders do not apply: this is one list, not three
 * destinations. `view: "all"` keeps standing rooms (`is_conference`) in the
 * channel rows instead of routing them to a Meetings destination.
 */
export function buildConversationRows(input: ConversationListInput): SidebarRow[] {
  const model = buildSidebarModel({
    rooms: input.rooms,
    searchQuery: input.searchQuery,
    scope: input.scope,
    categories: input.categories,
    people: input.people,
    folders: input.folders,
    collapsed: {},
    expandedPeople: input.expandedPeople,
    view: "all",
  });
  const rows: SidebarRow[] = [];
  for (const section of model.sections) {
    for (const group of section.groups) rows.push(...group.rows);
  }
  const { filter, isUnread, activeRoomId = null } = input;
  const unread = (row: SidebarRow) => rowHasUnread(row, isUnread, activeRoomId);
  const visible = rows.filter((row) => {
    const shape = conversationShape(row);
    if (filter === "people" && shape === "channel") return false;
    if (filter === "channels" && shape !== "channel") return false;
    if (filter === "unread" && !unread(row)) return false;
    return true;
  });
  visible.sort((a, b) => {
    const unreadDelta = Number(unread(b)) - Number(unread(a));
    if (unreadDelta !== 0) return unreadDelta;
    const recentDelta = conversationRecency(b) - conversationRecency(a);
    if (recentDelta !== 0) return recentDelta;
    return conversationRowId(a).localeCompare(conversationRowId(b));
  });
  return visible;
}

/** Alt+↑/↓ order for the one list. Same expansion rules as the sectioned tree. */
export function flattenConversationRows(rows: readonly SidebarRow[]): string[][] {
  const entries: string[][] = [];
  for (const row of rows) {
    if (row.kind === "person") {
      const ids = row.entry.threads.map((thread) => thread.id);
      if (ids.length === 0) continue;
      if (row.expanded && ids.length > 1) {
        for (const id of ids) entries.push([id]);
      } else {
        entries.push(ids);
      }
    } else {
      const nested = row.threads.map((thread) => thread.id);
      if (row.expanded && nested.length > 0) {
        entries.push([row.id]);
        for (const id of nested) entries.push([id]);
      } else {
        entries.push(nested.length > 0 ? [row.id, ...nested] : [row.id]);
      }
    }
  }
  return entries;
}

// ---- Crew (Nav v3 §2.1) -----------------------------------------------------

/**
 * One crew row: an agent you can talk to. `roomId` is where a tap lands —
 * your hub for your seats and house agents, the newest shared room for a
 * partner's seat — when the room list has it. Null means the tap has to
 * ensure the hub first and the keyboard skips the row.
 */
export interface CrewRow {
  kind: "crew";
  /** `crew:<agent_id>` — the menu key and the React key. */
  id: string;
  member: CrewMember;
  roomId: string | null;
  hub: Room | null;
  /** How the tap resolves: the hub, a shared room, or nothing loaded yet. */
  target: CrewTargetKind | null;
  /** "#taxsq-portal" for a shared room; null for a hub. */
  targetLabel: string | null;
  /** "Fable 5.1 · high" for a seat, a model family for a house agent, or null. */
  brain: string | null;
  /**
   * The badge: the hub plus its live threads, counted the way the
   * Conversations row counts them (muted rooms are 0), when the hub is
   * loaded; the server's hub-only count otherwise.
   */
  unread: number;
}

export interface CrewGroupRows {
  group: CrewGroup;
  label: string;
  rows: CrewRow[];
}

export interface CrewSectionModel {
  collapseKey: string;
  collapsed: boolean;
  /** Visible rows, in the fixed group order; a group with nothing visible is absent. */
  groups: CrewGroupRows[];
  /** Rows folded under "More". Zero while searching or once expanded. */
  hiddenCount: number;
  /** Rows that match the search, before the cap. */
  total: number;
  searching: boolean;
  /** "More" is open: rows beyond the default set are showing. */
  expanded: boolean;
}

/**
 * Which rows show before "More" (§2.1: "your own seats, then agents with a
 * thread in the last 14 days, then the rest under a collapsed More"). A flat
 * count buried House and Partners under Aaron's eleven seats, so the cap is
 * per group: the seats heard from lately (a floor keeps a fresh install from
 * showing nothing), the top house agents, the top partners.
 */
export interface CrewCapPolicy {
  ownSeatsWindowMs: number;
  ownSeatsFloor: number;
  house: number;
  partner: number;
}

export const CREW_CAP_POLICY: CrewCapPolicy = {
  ownSeatsWindowMs: 14 * 24 * 60 * 60 * 1000,
  ownSeatsFloor: 2,
  house: 3,
  partner: 3,
};

export interface CrewSectionInput {
  crew: readonly CrewMember[];
  rooms: readonly Room[];
  /** Brigade roster, for a house agent's model family chip. */
  agents?: readonly Agent[];
  searchQuery: string;
  showAll: boolean;
  collapsed: Record<string, boolean>;
  /** The caller's participant / user ids — a hub is only yours if it names one of them. */
  selfIds?: readonly (string | null | undefined)[];
  /** /crew answered: `hub_room_id` is the truth and the room list is not searched. */
  crewAnswered?: boolean;
  /** Badge count for one room after mute (the Conversations row's rule). */
  roomUnread?: (room: Room) => number;
  now?: number;
  policy?: CrewCapPolicy;
}

/** The sidebar search box narrows the crew too: name, id, role line, owner. */
export function crewRowMatches(member: CrewMember, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [member.display_name, member.agent_id, member.role_line ?? "", member.owner ?? ""]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function heardWithin(member: CrewMember, windowMs: number, now: number): boolean {
  if (member.unread > 0) return true;
  const at = member.last_at ? Date.parse(member.last_at) : Number.NaN;
  return Number.isFinite(at) && now - at <= windowMs;
}

/** The agent ids shown before "More", per the cap policy, in server order. */
export function defaultCrewSet(
  members: readonly CrewMember[],
  policy: CrewCapPolicy,
  now: number,
): Set<string> {
  const shown = new Set<string>();
  const own = members.filter((member) => member.group === "own_seat");
  for (const member of own) {
    if (heardWithin(member, policy.ownSeatsWindowMs, now)) shown.add(member.agent_id);
  }
  for (const member of own) {
    if (shown.size >= policy.ownSeatsFloor) break;
    shown.add(member.agent_id);
  }
  let house = 0;
  let partner = 0;
  for (const member of members) {
    if (member.group === "house" && house < policy.house) {
      shown.add(member.agent_id);
      house += 1;
    } else if (member.group === "partner" && partner < policy.partner) {
      shown.add(member.agent_id);
      partner += 1;
    }
  }
  return shown;
}

/**
 * The Crew section, grouped Your seats → House → Partners in the server's
 * ranking, capped per group (never while searching — a search that hid a
 * hit under "More" would look like no hit). The same model draws the
 * desktop section, the phone Crew tab and the keyboard order.
 */
export function buildCrewSection(input: CrewSectionInput): CrewSectionModel {
  const {
    crew,
    rooms,
    agents = [],
    searchQuery,
    showAll,
    collapsed,
    selfIds = [],
    crewAnswered = true,
    roomUnread,
    now = Date.now(),
    policy = CREW_CAP_POLICY,
  } = input;
  const searching = searchQuery.trim().length > 0;
  const matching = crew.filter((member) => crewRowMatches(member, searchQuery));
  const defaults = defaultCrewSet(matching, policy, now);
  const everything = searching || showAll;
  const groups: CrewGroupRows[] = [];
  let shown = 0;
  for (const group of CREW_GROUP_ORDER) {
    const rows: CrewRow[] = [];
    for (const member of matching) {
      if (member.group !== group) continue;
      if (!everything && !defaults.has(member.agent_id)) continue;
      const target = crewTargetRoom(member, rooms, selfIds, crewAnswered);
      const hub = target?.kind === "hub" ? target.room : null;
      const roster = agents.find((agent) => agent.id === member.agent_id) ?? null;
      let unread = member.unread;
      if (hub && roomUnread) {
        unread = roomUnread(hub);
        for (const room of rooms) {
          if (room.parent_room_id === hub.id && !room.is_archived) unread += roomUnread(room);
        }
      }
      rows.push({
        kind: "crew",
        id: `crew:${member.agent_id}`,
        member,
        roomId: target?.room.id ?? (target === null && member.group !== "partner" ? member.hub_room_id : null),
        hub,
        target: target?.kind ?? null,
        targetLabel: target?.kind === "shared" ? target.label : null,
        brain: crewBrainChip(member, hub, roster),
        unread,
      });
      shown += 1;
    }
    if (rows.length > 0) groups.push({ group, label: CREW_GROUP_LABEL[group], rows });
  }
  return {
    collapseKey: SECTION_KEYS.crew,
    collapsed: collapsed[SECTION_KEYS.crew] === true,
    groups,
    hiddenCount: Math.max(0, matching.length - shown),
    total: matching.length,
    searching,
    expanded: showAll && !searching && matching.length > defaults.size,
  };
}

/**
 * Alt+↑/↓ entries for the crew rows, in the visible order. A collapsed
 * section contributes nothing; a row with no room to land on (a hub not
 * created yet, a partner you share nothing with) is skipped rather than
 * pointed at a room that does not exist.
 */
export function flattenCrewRows(section: CrewSectionModel): string[][] {
  if (section.collapsed) return [];
  const entries: string[][] = [];
  for (const group of section.groups) {
    for (const row of group.rows) {
      if (row.roomId) entries.push([row.roomId]);
    }
  }
  return entries;
}

/**
 * The one Conversations pane on a desktop: crew rows first, then the list.
 * Both halves come from the same builders RoomList renders, so the keyboard
 * walks exactly what is on screen (see the note at the top of this file).
 * A hub can appear twice — as a crew row and as its Conversations row — so
 * the walker below steps from the last index it visited, not from the first
 * copy of the active room.
 */
export function flattenConversationPane(
  crew: CrewSectionModel | null,
  rows: readonly SidebarRow[],
): string[][] {
  return [...(crew ? flattenCrewRows(crew) : []), ...flattenConversationRows(rows)];
}

export interface KeyboardStep {
  /** The row the walk is now on. */
  index: number;
  /** The room to open, or null when the row has none. */
  target: string | null;
}

/**
 * One Alt+↑/↓ step. The position is the last visited index when that row
 * still holds the active room (so a room listed twice does not trap the
 * walk between its copies), else the first row holding the active room,
 * else the end the walk enters from. Clamped at the ends.
 */
export function stepKeyboardOrder(
  entries: readonly (readonly string[])[],
  current: string | null,
  delta: -1 | 1,
  last: number | null,
): KeyboardStep | null {
  if (entries.length === 0) return null;
  let index = -1;
  if (
    current &&
    last !== null &&
    last >= 0 &&
    last < entries.length &&
    entries[last]!.includes(current)
  ) {
    index = last;
  } else if (current) {
    index = entries.findIndex((ids) => ids.includes(current));
  }
  const next =
    index === -1
      ? delta === 1
        ? 0
        : entries.length - 1
      : Math.min(Math.max(index + delta, 0), entries.length - 1);
  return { index: next, target: entries[next]?.[0] ?? null };
}
