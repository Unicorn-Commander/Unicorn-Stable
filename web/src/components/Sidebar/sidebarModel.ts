import type { Room } from "@/services/api";
import {
  collapseKey,
  foldersFor,
  type FolderDef,
  type FolderSection,
  type PersonThreads,
} from "@/stores/categoryStore";

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
 */

/** Section-level collapse keys. Bare on purpose — a section is the same concept
 *  on every instance. Distinct from categoryStore's folder keys, which are
 *  prefixed `folder:` and carry the instance. */
export const SECTION_KEYS = {
  channels: "section:channels",
  people: "section:people",
  groups: "section:groups",
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
  if (room.type !== "dm" && room.type !== "group_dm") return null;
  if (room.brigade_agent_id) return `agent:${room.brigade_agent_id}`;
  if (room.type === "group_dm") return null;
  // The /rooms payload carries no member rows, so the counterpart display name
  // is the only handle we have on "who this is" — and it is exactly what the
  // row already shows.
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
  return (room as { is_private?: boolean }).is_private === true;
}

export type PersonEntry =
  | { kind: "agent"; key: string; agentId: string; threads: Room[] }
  | { kind: "person"; key: string; name: string; threads: Room[] };

export type SidebarRow =
  | { kind: "channel"; id: string; room: Room }
  | { kind: "group"; id: string; room: Room }
  | { kind: "person"; id: string; entry: PersonEntry; expanded: boolean };

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
}

export function buildSidebarModel(input: SidebarModelInput): SidebarModel {
  const {
    rooms,
    searchQuery,
    scope,
    categories,
    people,
    folders,
    collapsed,
    expandedPeople,
  } = input;

  const roomKinds: Record<string, boolean> = {};
  for (const r of rooms) roomKinds[r.id] = r.type === "channel";

  // Every person on this instance, from the unfiltered list (see the field doc).
  const threadsByPerson = new Map<string, string[]>();
  for (const room of rooms) {
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
  const filtered = q
    ? rooms.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q),
      )
    : rooms;

  const channels = filtered.filter((r) => r.type === "channel");

  // "Who you talk to", not "every room you are in". Agent conversations group
  // under their resident (ChatGPT-style thread history) and human DMs group
  // under the person, so someone you have several threads with is ONE row you
  // can expand — and one thing you can file into a folder. Private group rooms
  // are a different privacy class and get their own section.
  //
  // The rooms query is already ordered most-recent-first by the backend
  // (updated_at DESC), so each group's threads and the mixed ordering stay
  // newest → oldest for free (a group sits at its newest thread's position).
  const byKey = new Map<string, PersonEntry>();
  const peopleEntries: PersonEntry[] = [];
  const privateGroups: Room[] = [];
  for (const room of filtered) {
    if (room.type !== "dm" && room.type !== "group_dm") continue;
    const agentId = room.brigade_agent_id;
    if (agentId) {
      const key = personKeyOf(room)!;
      const existing = byKey.get(key);
      if (existing) {
        existing.threads.push(room);
      } else {
        const entry: PersonEntry = {
          kind: "agent",
          key,
          agentId,
          threads: [room],
        };
        byKey.set(key, entry);
        peopleEntries.push(entry);
      }
    } else if (room.type === "group_dm") {
      // A human multi-party room: private, invite-only, and not a "person".
      privateGroups.push(room);
    } else {
      const key = personKeyOf(room)!;
      const existing = byKey.get(key);
      if (existing) {
        existing.threads.push(room);
      } else {
        const entry: PersonEntry = {
          kind: "person",
          key,
          name: room.name,
          threads: [room],
        };
        byKey.set(key, entry);
        peopleEntries.push(entry);
      }
    }
  }

  const filedChannels = (scope ? categories[scope] : undefined) ?? {};
  const filedPeople = (scope ? people[scope] : undefined) ?? {};

  const channelGroups = groupRows(
    channels.map((room): SidebarRow => ({ kind: "channel", id: room.id, room })),
    foldersFor(folders, scope, "channels"),
    (row) => (row.kind === "channel" ? filedChannels[row.room.id] : undefined),
    "channels",
    scope,
    collapsed,
    q.length > 0,
  );

  const peopleGroups = groupRows(
    peopleEntries.map(
      (entry): SidebarRow => ({
        kind: "person",
        id: entry.key,
        entry,
        expanded: expandedPeople[entry.key] === true,
      }),
    ),
    foldersFor(folders, scope, "people"),
    (row) => (row.kind === "person" ? filedPeople[row.entry.key] : undefined),
    "people",
    scope,
    collapsed,
    q.length > 0,
  );

  const groupRowsOnly: SidebarRow[] = privateGroups.map((room) => ({
    kind: "group",
    id: room.id,
    room,
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
          entries.push([row.id]);
        }
      }
    }
  }
  return entries;
}
