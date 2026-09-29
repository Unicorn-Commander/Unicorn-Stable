import { create } from "zustand";
import {
  loadFocusMode,
  saveFocusMode,
  type FocusMode,
} from "@/utils/unreadModel";

/**
 * Sidebar view state that changes WHICH ROWS ARE ON SCREEN.
 *
 * Both of these used to be RoomList's local component state, which was fine
 * while RoomList was the only thing that cared. It is not: Alt+↑/↓ walks the
 * visible order (see sidebarModel.flattenSidebarOrder), so a search that hides
 * rows and an expanded person that reveals threads both have to be visible to
 * the keyboard too. Anything that only affects appearance — hover, menus, draft
 * text — stays local to the component.
 *
 * Search + expanded people are session-local (not persisted). Focused/All is
 * light localStorage so the preference survives a refresh (slice 3). Folder
 * collapse state lives in categoryStore.
 */
interface SidebarUiState {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  /** personKey -> is the thread history open. Collapsed by default. */
  expandedPeople: Record<string, boolean>;
  togglePersonExpanded: (key: string) => void;
  /**
   * Focused = DMs with unread + rooms with unread mentions (mentions-first).
   * All = full list. Shared with AppShell keyboard order via this store.
   */
  focusMode: FocusMode;
  setFocusMode: (mode: FocusMode) => void;
  /**
   * Crew section past its first eight rows ("More"). Changes what is on
   * screen, so the keyboard order reads it here too.
   */
  crewShowAll: boolean;
  setCrewShowAll: (showAll: boolean) => void;
  /** Wipe on a server switch. Person keys are NAMES, not server-unique ids, so
   *  an expanded "person:Dana" would otherwise arrive pre-expanded on the next
   *  backend's unrelated Dana; a search for the old server's rooms is just as
   *  stale. Focused/All is a user preference, not instance data — kept. */
  resetForServer: () => void;
}

export const useSidebarUi = create<SidebarUiState>((set) => ({
  searchQuery: "",
  setSearchQuery: (q) => set({ searchQuery: q }),
  expandedPeople: {},
  togglePersonExpanded: (key) =>
    set((s) => {
      const next = { ...s.expandedPeople };
      if (next[key]) delete next[key];
      else next[key] = true;
      return { expandedPeople: next };
    }),
  focusMode: loadFocusMode(),
  setFocusMode: (mode) => {
    saveFocusMode(mode);
    set({ focusMode: mode });
  },
  crewShowAll: false,
  setCrewShowAll: (showAll) => set({ crewShowAll: showAll }),
  resetForServer: () => set({ searchQuery: "", expandedPeople: {}, crewShowAll: false }),
}));
