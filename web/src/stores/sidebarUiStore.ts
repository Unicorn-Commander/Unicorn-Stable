import { create } from "zustand";

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
 * Deliberately NOT persisted: like scroll position, a search box and an opened
 * thread history are session-local. Folder collapse state, which the user does
 * mean to keep, lives in categoryStore instead.
 */
interface SidebarUiState {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  /** personKey -> is the thread history open. Collapsed by default. */
  expandedPeople: Record<string, boolean>;
  togglePersonExpanded: (key: string) => void;
  /** Wipe on a server switch. Person keys are NAMES, not server-unique ids, so
   *  an expanded "person:Dana" would otherwise arrive pre-expanded on the next
   *  backend's unrelated Dana; a search for the old server's rooms is just as
   *  stale. Both are ephemeral, so dropping them is free. */
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
  resetForServer: () => set({ searchQuery: "", expandedPeople: {} }),
}));
