import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Per-user sidebar organization — personal folders over channels and over the
 * people/agents you talk to, plus the collapse state of every sidebar group.
 *
 * Stored client-side: this is a view preference, not a shared room property, so
 * it needs no permissions and never conflicts between users. The shape is
 * backend-syncable later if we want it to follow you across devices.
 *
 * ── FOLDER IDENTITY IS (instance, section, name) ─────────────────────────────
 * That triple is the whole design, and every map below is keyed consistently
 * with it. The web app runs on ONE origin but can be pointed at several Stable
 * backends (see federationStore.switchInstance), and localStorage is
 * origin-scoped — so anything keyed by NAME alone is shared across every server
 * the user has ever opened. Two servers each having a "Work" folder are two
 * INDEPENDENT folders; renaming or deleting one must not touch the other.
 *
 * An earlier shape kept `categories` as a global roomId -> name map. Room ids
 * are server-unique UUIDs, so READING it was harmless — but writing it by name
 * was not: deleting "Work" on one server walked every assignment in the map and
 * unfiled the rooms of every other server's "Work" too, silently destroying
 * organization on backends the user was not even looking at. Hence:
 *
 *   `categories`   scopeId -> roomId -> folder name.  PER-INSTANCE. Scoped so a
 *                  name-keyed mutation can only ever reach the server it was
 *                  issued against.
 *
 *   `people`       scopeId -> personKey -> folder name.  PER-INSTANCE. A person
 *                  key is `agent:<id>` or `person:<display name>` — a NAME, not
 *                  a server-unique id, so two backends can each have a
 *                  "person:Dana".
 *
 *   `folders`      scopeId -> folder definitions.  PER-INSTANCE. The sole
 *                  source of truth for which folders exist on the server you
 *                  are looking at.
 *
 *   `collapsed`    key -> collapsed?.  Folder keys are built by collapseKey()
 *                  and carry the instance, so one server's shut "Work" does not
 *                  shut another's. Section keys stay bare: a section is the same
 *                  concept on every server.
 *
 * ── WHAT EACH ASSIGNMENT IS KEYED TO ─────────────────────────────────────────
 * A channel folder is a property of the CHANNEL, so it is keyed by room id.
 * A people folder is a property of the PERSON, so it is keyed by the person —
 * NOT by one of their rooms. Filing "Dana" and then receiving a new DM from
 * Dana must not change where Dana lives; keying people by any single thread id
 * makes the answer depend on which thread happens to sort first, which is a
 * silent loss of the user's saved preference the moment a new thread arrives.
 */

export type FolderSection = "channels" | "people";

export interface FolderDef {
  name: string;
  section: FolderSection;
}

/** One person/agent row in the sidebar and every room that belongs to them.
 *  Used only to re-key v1 assignments; see adoptLegacyPeopleFolders. */
export interface PersonThreads {
  key: string;
  roomIds: string[];
}

/**
 * Collapse key for a folder. Carries the instance because folder identity is
 * (instance, section, name) — see the header. Section headers use their own
 * bare keys (SECTION_KEYS in sidebarModel.ts) and never collide with these.
 */
export function collapseKey(
  scope: string | null,
  name: string,
  section: FolderSection,
): string {
  return `folder:${scope ?? "-"}:${section}:${name}`;
}

interface CategoryState {
  /** instance id -> roomId -> folder name. Per-instance (see header). */
  categories: Record<string, Record<string, string>>;
  /** instance id -> personKey -> folder name. Per-instance (see header). */
  people: Record<string, Record<string, string>>;
  /** collapse key -> collapsed? Folder keys carry the instance. */
  collapsed: Record<string, boolean>;
  /** instance id -> the folders that exist ON THAT SERVER. Never leaks. */
  folders: Record<string, FolderDef[]>;
  /**
   * Channel assignments saved before `categories` was per-instance, still in
   * the old flat roomId -> name shape and not yet attributed to a server.
   * Drained by adoptLegacyCategories() as each instance identifies its own
   * rooms; see there for why this cannot be done in persist.migrate.
   */
  legacyCategories: Record<string, string>;

  /** Assign one or more CHANNELS on `scope` to a folder (null clears). Registers
   *  the folder so it survives the last channel leaving it. */
  setCategory: (
    scope: string | null,
    roomIds: string | string[],
    category: string | null,
  ) => void;
  /** Assign a PERSON (agent or human) to a folder on this instance; null
   *  clears. Keyed by the person, so new threads never move them. */
  setPeopleCategory: (
    scope: string,
    personKey: string,
    category: string | null,
  ) => void;
  toggleCollapsed: (key: string) => void;
  /** Create an empty folder on this instance (usable before anything is in it). */
  ensureFolder: (scope: string, name: string, section: FolderSection) => void;
  /** Rename ONE folder — the (scope, section, from) one. Every map it touches
   *  is entered at `scope` first, so a same-named folder on another server is
   *  structurally out of reach. */
  renameFolder: (
    scope: string,
    section: FolderSection,
    from: string,
    to: string,
  ) => void;
  /** Forget ONE folder and unfile what was in it. Unfile, never delete: the
   *  rooms and people stay, they just return to the ungrouped list. Scoped the
   *  same way renameFolder is. */
  removeFolder: (scope: string, section: FolderSection, name: string) => void;
  /**
   * Attribute pre-scoping channel assignments to the instance they belong to.
   *
   * `isChannel` is this server's rooms: roomId -> is it a channel. Only rooms
   * this server actually serves are adopted, which is what makes the split
   * correct rather than a guess — a UUID the server does not know belongs to a
   * different backend, so it stays in `legacyCategories` until the user opens
   * that one. Nothing is ever dropped and nothing leaks sideways.
   *
   * Folder names are registered only for CHANNELS. A v1 build filed people by
   * room id too; those entries are moved into scope so adoptLegacyPeopleFolders
   * can re-key them onto the person, but registering them here would leave a
   * stray empty channels folder behind.
   *
   * Convergent, so it is safe on every room refresh: it consumes what it
   * adopts, and an empty `legacyCategories` makes it a no-op.
   */
  adoptLegacyCategories: (
    scope: string,
    isChannel: Record<string, boolean>,
  ) => void;
  /**
   * Migration for people filed by the v1 build, which wrote a folder onto every
   * one of the person's ROOM ids. Re-keys those assignments onto the person and
   * removes the room-id entries it consumed, so a filed person keeps their
   * folder instead of being orphaned by the shape change.
   *
   * Consuming the old entries is what makes this safe to run on every render:
   * once they are gone there is nothing left to adopt, so it cannot resurrect an
   * assignment the user has since cleared. It needs room data to know which
   * rooms are whose, which is why it lives here and not in persist.migrate.
   */
  adoptLegacyPeopleFolders: (scope: string, entries: PersonThreads[]) => void;
}

export const useChannelCategories = create<CategoryState>()(
  persist(
    (set) => ({
      categories: {},
      people: {},
      collapsed: {},
      folders: {},
      legacyCategories: {},

      setCategory: (scope, roomIds, category) =>
        set((s) => {
          if (!scope) return s;
          const ids = Array.isArray(roomIds) ? roomIds : [roomIds];
          const forScope = { ...(s.categories[scope] ?? {}) };
          const name = category?.trim();
          for (const id of ids) {
            if (name) forScope[id] = name;
            else delete forScope[id];
          }
          const categories = { ...s.categories, [scope]: forScope };
          if (!name) return { categories };
          return {
            categories,
            folders: withFolder(s.folders, scope, name, "channels"),
          };
        }),

      setPeopleCategory: (scope, personKey, category) =>
        set((s) => {
          const name = category?.trim();
          const forScope = { ...(s.people[scope] ?? {}) };
          if (name) forScope[personKey] = name;
          else delete forScope[personKey];
          const people = { ...s.people, [scope]: forScope };
          if (!name) return { people };
          return {
            people,
            folders: withFolder(s.folders, scope, name, "people"),
          };
        }),

      toggleCollapsed: (key) =>
        set((s) => ({
          collapsed: { ...s.collapsed, [key]: !s.collapsed[key] },
        })),

      ensureFolder: (scope, name, section) =>
        set((s) => {
          const clean = name.trim();
          if (!clean) return s;
          return { folders: withFolder(s.folders, scope, clean, section) };
        }),

      renameFolder: (scope, section, from, to) =>
        set((s) => {
          const clean = to.trim();
          if (!clean || clean === from) return s;
          const existing = s.folders[scope] ?? [];
          if (!existing.some((f) => f.name === from && f.section === section)) {
            return s;
          }
          // Renaming ONTO a sibling merges into it, which is what the user just
          // asked for; dedupe so the list never grows a twin.
          const folders = {
            ...s.folders,
            [scope]: dedupe(
              existing.map((f) =>
                f.name === from && f.section === section
                  ? { ...f, name: clean }
                  : f,
              ),
            ),
          };
          // Channels live in `categories`, people in `people`. Both are entered
          // at THIS scope, so another server's "Work" is untouched by
          // construction rather than by a filter someone has to remember.
          const next: Partial<CategoryState> = { folders };
          if (section === "channels") {
            const forScope = { ...(s.categories[scope] ?? {}) };
            for (const [roomId, cat] of Object.entries(forScope)) {
              if (cat === from) forScope[roomId] = clean;
            }
            next.categories = { ...s.categories, [scope]: forScope };
          } else {
            const forScope = { ...(s.people[scope] ?? {}) };
            for (const [personKey, cat] of Object.entries(forScope)) {
              if (cat === from) forScope[personKey] = clean;
            }
            next.people = { ...s.people, [scope]: forScope };
          }
          const oldKey = collapseKey(scope, from, section);
          const newKey = collapseKey(scope, clean, section);
          if (oldKey in s.collapsed) {
            const collapsed = { ...s.collapsed };
            collapsed[newKey] = collapsed[oldKey] ?? false;
            delete collapsed[oldKey];
            next.collapsed = collapsed;
          }
          return next;
        }),

      removeFolder: (scope, section, name) =>
        set((s) => {
          const folders = {
            ...s.folders,
            [scope]: (s.folders[scope] ?? []).filter(
              (f) => !(f.name === name && f.section === section),
            ),
          };
          const next: Partial<CategoryState> = { folders };
          if (section === "channels") {
            const forScope = { ...(s.categories[scope] ?? {}) };
            for (const [roomId, cat] of Object.entries(forScope)) {
              if (cat === name) delete forScope[roomId];
            }
            next.categories = { ...s.categories, [scope]: forScope };
          } else {
            const forScope = { ...(s.people[scope] ?? {}) };
            for (const [personKey, cat] of Object.entries(forScope)) {
              if (cat === name) delete forScope[personKey];
            }
            next.people = { ...s.people, [scope]: forScope };
          }
          const key = collapseKey(scope, name, section);
          if (key in s.collapsed) {
            const collapsed = { ...s.collapsed };
            delete collapsed[key];
            next.collapsed = collapsed;
          }
          return next;
        }),

      adoptLegacyCategories: (scope, isChannel) =>
        set((s) => {
          const pending = Object.entries(s.legacyCategories);
          if (pending.length === 0) return s;
          const legacyCategories = { ...s.legacyCategories };
          const forScope = { ...(s.categories[scope] ?? {}) };
          let folders = s.folders;
          let changed = false;
          for (const [roomId, name] of pending) {
            const known = isChannel[roomId];
            if (known === undefined) continue; // another server's room
            delete legacyCategories[roomId];
            changed = true;
            // A folder the user has since cleared on this instance must not
            // come back; only fill a gap.
            if (!(roomId in forScope)) forScope[roomId] = name;
            if (known) folders = withFolder(folders, scope, name, "channels");
          }
          if (!changed) return s;
          return {
            legacyCategories,
            categories: { ...s.categories, [scope]: forScope },
            folders,
          };
        }),

      adoptLegacyPeopleFolders: (scope, entries) =>
        set((s) => {
          const forRooms = { ...(s.categories[scope] ?? {}) };
          const forPeople = { ...(s.people[scope] ?? {}) };
          let folders = s.folders;
          let changed = false;
          for (const entry of entries) {
            // v1 wrote the folder onto EVERY thread of the person, but rooms
            // arrive newest-first and a new thread has no assignment — so scan
            // them all and take the first one that carries a folder. That is
            // the preference the user actually saved.
            let found: string | undefined;
            for (const roomId of entry.roomIds) {
              const cat = forRooms[roomId];
              if (cat) {
                if (!found) found = cat;
                delete forRooms[roomId];
                changed = true;
              }
            }
            // A person filed under the new shape already wins; the old entries
            // are still cleared above so this stays a one-way move.
            if (found && !forPeople[entry.key]) {
              forPeople[entry.key] = found;
              // The name has to exist as a PEOPLE folder on this instance or
              // the sidebar will not render it and the rescue is invisible.
              folders = withFolder(folders, scope, found, "people");
              changed = true;
            }
          }
          if (!changed) return s;
          return {
            categories: { ...s.categories, [scope]: forRooms },
            people: { ...s.people, [scope]: forPeople },
            folders,
          };
        }),
    }),
    {
      name: "stable-channel-categories",
      version: 3,
      migrate: (persisted, version) => {
        // `categories` is deliberately re-typed: in every version before 3 it
        // was a FLAT roomId -> name map, which is not the current field's type.
        const prior = (persisted ?? {}) as Omit<
          Partial<CategoryState>,
          "categories"
        > & { categories?: Record<string, string> };
        if (version >= 3) return prior;
        // v0, v1 and v2 all stored `categories` as a FLAT roomId -> name map.
        // It cannot be split by instance here — that needs each server's room
        // list — so it is parked in `legacyCategories` and drained by
        // adoptLegacyCategories() as the sidebar mounts against each one.
        // Nothing is discarded; the assignments are simply not attributed yet.
        const flat = prior.categories ?? {};
        // v0 had no folder list at all. v1+ DOES, and it must be carried
        // through untouched — rebuilding it here would throw away every folder
        // the user made, including the empty ones that hold no room.
        const folders = version < 1 ? {} : (prior.folders ?? {});
        return {
          ...prior,
          categories: {},
          legacyCategories: { ...(prior.legacyCategories ?? {}), ...flat },
          folders,
          people: prior.people ?? {},
          collapsed: prior.collapsed ?? {},
        };
      },
    },
  ),
);

function dedupe(list: FolderDef[]): FolderDef[] {
  const seen = new Set<string>();
  return list.filter((f) => {
    const key = `${f.section} ${f.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withFolder(
  folders: Record<string, FolderDef[]>,
  scope: string,
  name: string,
  section: FolderSection,
): Record<string, FolderDef[]> {
  const existing = folders[scope] ?? [];
  if (existing.some((f) => f.name === name && f.section === section)) {
    return folders;
  }
  return { ...folders, [scope]: [...existing, { name, section }] };
}

/**
 * The folders that exist on `scope`, for `section`, sorted A→Z.
 *
 * Sorted, not hand-ordered, and this is the ONLY ordering of folders in the
 * app: the sidebar and Alt+↑/↓ both read the model built on top of it (see
 * sidebarModel.ts), so there is no second order that can drift out of sync.
 */
export function foldersFor(
  folders: Record<string, FolderDef[]>,
  scope: string | null,
  section: FolderSection,
): string[] {
  if (!scope) return [];
  return (folders[scope] ?? [])
    .filter((f) => f.section === section)
    .map((f) => f.name)
    .sort((a, b) => a.localeCompare(b));
}
