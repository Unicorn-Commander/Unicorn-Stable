import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Per-user channel categories — a personal way to group the sidebar's channels
 * ("conversations under the channels"). Stored client-side (this is a view
 * preference, not a shared room property, so it needs no permissions and never
 * conflicts between users); the shape is backend-syncable later if we want it to
 * follow you across devices.
 */
interface CategoryState {
  // roomId -> category name
  categories: Record<string, string>;
  // category name -> collapsed?
  collapsed: Record<string, boolean>;
  setCategory: (roomId: string, category: string | null) => void;
  toggleCollapsed: (category: string) => void;
}

export const useChannelCategories = create<CategoryState>()(
  persist(
    (set) => ({
      categories: {},
      collapsed: {},
      setCategory: (roomId, category) =>
        set((s) => {
          const next = { ...s.categories };
          const name = category?.trim();
          if (name) next[roomId] = name;
          else delete next[roomId];
          return { categories: next };
        }),
      toggleCollapsed: (category) =>
        set((s) => ({
          collapsed: { ...s.collapsed, [category]: !s.collapsed[category] },
        })),
    }),
    { name: "stable-channel-categories" },
  ),
);

/** Distinct category names currently in use, sorted. */
export function distinctCategories(categories: Record<string, string>): string[] {
  return [...new Set(Object.values(categories))].sort((a, b) =>
    a.localeCompare(b),
  );
}
