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
 * ── FEDERATION SAFETY (read before changing the shape) ────────────────────────
 * The web app runs on ONE origin but can be pointed at several Stable backends
 * (see federationStore.switchInstance). localStorage is origin-scoped, so this
 * store is SHARED across instances — anything keyed by a name would leak one
 * server's structure into another server's sidebar. The split below is the rule:
 *
 *   `assignments`  roomId -> folder name.   GLOBAL and inert. Room ids are
 *                  server-unique UUIDs, so an assignment simply never matches a
 *                  room on a different backend. This is also why categoryStore
 *                  is deliberately excluded from the multi-server reset — wiping
 *                  it would destroy the user's saved preference for no gain.
 *
 *   `folders`      scopeId -> folder definitions.  PER-INSTANCE. The folder LIST
 *                  is name-keyed, so it is the one thing that could leak; it is
 *                  bucketed by instance id and is the sole source of truth for
 *                  which folders exist on the server you are looking at.
 *
 *   `collapsed`    key -> collapsed?.  GLOBAL on purpose. A pure open/shut UI
 *                  toggle carries no structure, and "I keep Work collapsed"
 *                  should hold wherever a Work folder exists. AppShell's
 *                  sidebarRoomOrder() reads this map with a bare folder name, so
 *                  channel folders MUST keep using their bare name as the key.
 */

export type FolderSection = "channels" | "people";

export interface FolderDef {
  name: string;
  section: FolderSection;
}

/** Collapse key for a folder. Channel folders keep the bare name — AppShell's
 *  sidebarRoomOrder() looks them up that way and must not silently diverge. */
export function collapseKey(name: string, section: FolderSection): string {
  return section === "channels" ? name : `people:${name}`;
}

interface CategoryState {
  /** roomId -> folder name. Global; inert across instances (see header). */
  categories: Record<string, string>;
  /** collapse key -> collapsed? Global; pure UI toggle (see header). */
  collapsed: Record<string, boolean>;
  /** instance id -> the folders that exist ON THAT SERVER. Never leaks. */
  folders: Record<string, FolderDef[]>;
  /** One-shot guard for adopting pre-folders (v0) categories. */
  legacyAdopted: boolean;

  /** Assign one or more rooms to a folder (null clears). Registers the folder
   *  on `scope` so it survives the last room leaving it. */
  setCategory: (
    roomIds: string | string[],
    category: string | null,
    opts?: { scope?: string; section?: FolderSection },
  ) => void;
  toggleCollapsed: (key: string) => void;
  /** Create an empty folder on this instance (usable before anything is in it). */
  ensureFolder: (scope: string, name: string, section: FolderSection) => void;
  renameFolder: (scope: string, from: string, to: string) => void;
  /** Forget a folder on this instance and unfile every room in it. */
  removeFolder: (scope: string, name: string) => void;
  /**
   * Migration for users upgrading from the flat v0 store, which had folder
   * names but no per-instance folder list. Runs at most once, on the first
   * instance the sidebar mounts against — in practice the one the user was last
   * looking at, which is where those folders came from. Re-filing on another
   * server is a drag-free two clicks, and nothing is ever destroyed.
   */
  adoptLegacyFolders: (scope: string) => void;
}

export const useChannelCategories = create<CategoryState>()(
  persist(
    (set, get) => ({
      categories: {},
      collapsed: {},
      folders: {},
      legacyAdopted: false,

      setCategory: (roomIds, category, opts) =>
        set((s) => {
          const ids = Array.isArray(roomIds) ? roomIds : [roomIds];
          const next = { ...s.categories };
          const name = category?.trim();
          for (const id of ids) {
            if (name) next[id] = name;
            else delete next[id];
          }
          if (!name || !opts?.scope) return { categories: next };
          return {
            categories: next,
            folders: withFolder(
              s.folders,
              opts.scope,
              name,
              opts.section ?? "channels",
            ),
          };
        }),

      toggleCollapsed: (key) =>
        set((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } })),

      ensureFolder: (scope, name, section) =>
        set((s) => {
          const clean = name.trim();
          if (!clean) return s;
          return { folders: withFolder(s.folders, scope, clean, section) };
        }),

      renameFolder: (scope, from, to) =>
        set((s) => {
          const clean = to.trim();
          if (!clean || clean === from) return s;
          const existing = s.folders[scope] ?? [];
          const target = existing.find((f) => f.name === from);
          if (!target) return s;
          // Renaming ONTO an existing name merges into it, which is what the
          // user just asked for; dedupe so the list never grows a twin.
          const folders = {
            ...s.folders,
            [scope]: dedupe(
              existing.map((f) =>
                f.name === from ? { ...f, name: clean } : f,
              ),
            ),
          };
          const categories = { ...s.categories };
          for (const [roomId, cat] of Object.entries(categories)) {
            if (cat === from) categories[roomId] = clean;
          }
          const oldKey = collapseKey(from, target.section);
          const newKey = collapseKey(clean, target.section);
          const collapsed = { ...s.collapsed };
          if (oldKey in collapsed) {
            collapsed[newKey] = collapsed[oldKey] ?? false;
            delete collapsed[oldKey];
          }
          return { folders, categories, collapsed };
        }),

      removeFolder: (scope, name) =>
        set((s) => {
          const folders = {
            ...s.folders,
            [scope]: (s.folders[scope] ?? []).filter((f) => f.name !== name),
          };
          const categories = { ...s.categories };
          for (const [roomId, cat] of Object.entries(categories)) {
            if (cat === name) delete categories[roomId];
          }
          return { folders, categories };
        }),

      adoptLegacyFolders: (scope) => {
        const s = get();
        if (s.legacyAdopted) return;
        const names = distinctCategories(s.categories);
        if (names.length === 0) {
          // Nothing to rescue — burn the guard anyway so a folder created later
          // on another instance is never mistaken for legacy data.
          set({ legacyAdopted: true });
          return;
        }
        set({
          legacyAdopted: true,
          folders: names.reduce(
            (acc, name) => withFolder(acc, scope, name, "channels"),
            s.folders,
          ),
        });
      },
    }),
    {
      name: "stable-channel-categories",
      version: 1,
      // v0 was { categories, collapsed } only. Both survive verbatim; the
      // folder list is reconstructed by adoptLegacyFolders() once the sidebar
      // knows which instance it is looking at.
      migrate: (persisted) => ({
        ...(persisted as Partial<CategoryState>),
        folders: {},
        legacyAdopted: false,
      }),
    },
  ),
);

function dedupe(list: FolderDef[]): FolderDef[] {
  const seen = new Set<string>();
  return list.filter((f) => {
    const key = `${f.section} ${f.name}`;
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
 * Sorted, not hand-ordered: AppShell's sidebarRoomOrder() (which drives Alt+↑/↓)
 * sorts channel categories with the same localeCompare, and a custom order here
 * would silently desync keyboard navigation from what is on screen.
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

/** Distinct folder names currently assigned to a room, sorted. */
export function distinctCategories(categories: Record<string, string>): string[] {
  return [...new Set(Object.values(categories))].sort((a, b) =>
    a.localeCompare(b),
  );
}
