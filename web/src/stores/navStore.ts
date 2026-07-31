import { create } from "zustand";
import type { Room } from "@/services/api";

/**
 * View-based sidebar destinations (Slice 2 — human-first nav).
 *
 * People is intentionally NOT a destination here: it lives in the top-bar
 * drawer. These five views replace the single long People/Groups/Channels
 * tree when the nav-v1 flag is on.
 */
export type NavView = "home" | "chats" | "channels" | "meetings" | "agents";

export const NAV_VIEWS: readonly NavView[] = [
  "home",
  "chats",
  "channels",
  "meetings",
  "agents",
] as const;

/** localStorage key for the nav-v1 feature flag. */
export const NAV_V1_FLAG_KEY = "stable_nav_v1";

/**
 * Whether the view-based sidebar shell is enabled.
 *
 * Priority:
 *   1. localStorage `stable_nav_v1` — "0"/"false" off, "1"/"true" on
 *   2. `import.meta.env.VITE_NAV_V1` — "0"/"false" off
 *   3. default **true** on this feature branch
 */
export function isNavV1Enabled(): boolean {
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(NAV_V1_FLAG_KEY);
      if (raw === "0" || raw === "false") return false;
      if (raw === "1" || raw === "true") return true;
    } catch {
      // private mode / blocked storage — fall through to env
    }
  }
  const env = import.meta.env.VITE_NAV_V1;
  if (env === "0" || env === "false") return false;
  return true;
}

/**
 * Which destination a room belongs to. Used for deep-link view selection and
 * last-room memory. Conference channels map to meetings; agent DMs to agents;
 * human DMs + group DMs to chats; plain channels to channels.
 */
export function viewForRoom(room: Room): NavView {
  if (room.is_conference) return "meetings";
  if (room.brigade_agent_id) return "agents";
  if (room.type === "dm" || room.type === "group_dm") return "chats";
  return "channels";
}

interface NavState {
  activeView: NavView;
  /**
   * Last opened room per (server, view). Survives view switches so returning
   * to a destination can restore (when no room is open) or highlight.
   * Home is never recorded.
   */
  lastRoomByViewByServer: Record<string, Partial<Record<NavView, string>>>;
  setActiveView: (view: NavView) => void;
  rememberRoom: (serverId: string, view: NavView, roomId: string) => void;
  lastRoomFor: (serverId: string | null, view: NavView) => string | null;
  /** Land on Home after a server switch (URL already goes to `/`). */
  resetForServer: () => void;
}

export const useNavStore = create<NavState>((set, get) => ({
  activeView: "home",
  lastRoomByViewByServer: {},

  setActiveView: (view) => set({ activeView: view }),

  rememberRoom: (serverId, view, roomId) => {
    if (!serverId || view === "home" || !roomId) return;
    set((s) => ({
      lastRoomByViewByServer: {
        ...s.lastRoomByViewByServer,
        [serverId]: {
          ...s.lastRoomByViewByServer[serverId],
          [view]: roomId,
        },
      },
    }));
  },

  lastRoomFor: (serverId, view) => {
    if (!serverId || view === "home") return null;
    return get().lastRoomByViewByServer[serverId]?.[view] ?? null;
  },

  resetForServer: () => set({ activeView: "home" }),
}));
