import { create } from "zustand";
import type { Room } from "@/services/api";

/**
 * View-based sidebar destinations (nav v1, the five-view shell).
 *
 * Direct is people and agent hubs (threads live under the row). Channels,
 * Meetings, and Agents stay their own destinations. People-as-a-directory
 * still lives in the top-bar drawer.
 *
 * Nav v2 replaces this shell with Home · Conversations · Directory. The
 * five views stay so `stable_nav_v2=0` restores them. They are not filters.
 */
export type NavView = "home" | "direct" | "channels" | "meetings" | "agents";

/**
 * Rail destinations when the one-list shell is on. Not a filter.
 *
 * `crew` and `calls` are the phone's Crew and Calls tabs (Nav v3 §2.6): on a
 * desktop the crew is a section above Conversations and calls are channel
 * rows, so the rail treats both as Conversations there.
 */
export type ShellDestination =
  | "home"
  | "conversations"
  | "directory"
  | "crew"
  | "calls";

/** Phone bottom tabs (Nav v3 §2.6): Home · Chats · Crew · Calls · Me. */
export type PhoneTab = "home" | "chats" | "crew" | "calls" | "me";

export const PHONE_TABS: readonly {
  id: PhoneTab;
  label: string;
  /** Rail destination the tab selects; Me opens settings instead. */
  destination: ShellDestination | null;
  testId: string;
}[] = [
  { id: "home", label: "Home", destination: "home", testId: "nav-home" },
  { id: "chats", label: "Chats", destination: "conversations", testId: "nav-conversations" },
  { id: "crew", label: "Crew", destination: "crew", testId: "nav-crew" },
  { id: "calls", label: "Calls", destination: "calls", testId: "nav-calls" },
  { id: "me", label: "Me", destination: null, testId: "nav-me" },
] as const;

/** The phone tab that owns a rail destination. Directory lives under Crew. */
export function phoneTabForDestination(destination: ShellDestination): PhoneTab {
  switch (destination) {
    case "home":
      return "home";
    case "crew":
    case "directory":
      return "crew";
    case "calls":
      return "calls";
    default:
      return "chats";
  }
}

/** Phone-only destinations read as Conversations on a desktop rail. */
export function railDestination(destination: ShellDestination): "home" | "conversations" | "directory" {
  if (destination === "crew" || destination === "calls") return "conversations";
  return destination;
}

/**
 * Narrows the one Conversations list. A filter is not a destination: it
 * never gets a route, a rail button, or a last-room slot.
 */
export type ConversationFilter = "all" | "unread" | "people" | "channels";

export const CONVERSATION_FILTERS: readonly ConversationFilter[] = [
  "all",
  "unread",
  "people",
  "channels",
] as const;

export const NAV_VIEWS: readonly NavView[] = [
  "home",
  "direct",
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

/** localStorage key for the one-list shell. `"0"` / `"false"` restores nav v1. */
export const NAV_V2_FLAG_KEY = "stable_nav_v2";

/**
 * Whether the one Conversations list is on.
 *
 * An explicit nav-v1 opt-out wins first. `stable_nav_v1` `"0"` / `"false"`,
 * or `VITE_NAV_V1` `"0"` / `"false"`, restores the classic tree and keeps
 * this shell off even when `stable_nav_v2` is `"1"`. Otherwise v2's default
 * would swallow that choice.
 *
 * Then:
 *   1. localStorage `stable_nav_v2` — "0"/"false" off, "1"/"true" on
 *   2. `import.meta.env.VITE_NAV_V2` — "0"/"false" off
 *   3. default **on**
 *
 * Off with nav v1 still on is the five-view shell (Home / Direct / Channels /
 * Meetings / Agents). Off because nav v1 is off is the classic tree.
 */
export function isNavV2Enabled(): boolean {
  if (!isNavV1Enabled()) return false;
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(NAV_V2_FLAG_KEY);
      if (raw === "0" || raw === "false") return false;
      if (raw === "1" || raw === "true") return true;
    } catch {
      // private mode / blocked storage — fall through to env
    }
  }
  const env = import.meta.env.VITE_NAV_V2;
  if (env === "0" || env === "false") return false;
  return true;
}

/** `/agents` and anything under it. Not a stored rail choice. */
export function isDirectoryPath(pathname: string): boolean {
  return pathname === "/agents" || pathname.startsWith("/agents/");
}

/**
 * Rail selection for a URL.
 *
 * Directory is the agents route. A room URL is Conversations. Anywhere else,
 * a stored "directory" is stale (back from /agents used to leave it selected
 * on Home) and reads as Home. Conversations can still sit on `/` with no room.
 */
export function shellDestinationForPath(
  pathname: string,
  stored: ShellDestination,
): ShellDestination {
  if (isDirectoryPath(pathname)) return "directory";
  if (pathname.startsWith("/c/")) {
    // A room opened from the phone's Crew or Calls tab keeps that tab, so
    // the drawer reopens where the user came from. Anything else is the list.
    return stored === "crew" || stored === "calls" ? stored : "conversations";
  }
  if (stored === "directory") return "home";
  return stored;
}

function initialShellDestination(): ShellDestination {
  if (typeof window === "undefined") return "home";
  return shellDestinationForPath(window.location.pathname, "home");
}

/**
 * Which v1 destination a room belongs to. Used for deep-link view selection
 * and last-room memory when the five-view shell is showing.
 *
 * Hubs and DMs land on Direct (the Agents destination is the same hubs,
 * filtered). Conference rooms still map to Meetings so the flag-off shell
 * keeps today's routing. The one-list shell does not call this to pick a
 * destination — a standing room is just a channel row.
 */
export function viewForRoom(room: Room): NavView {
  if (room.is_conference) return "meetings";
  if (room.type === "agent_hub" || room.brigade_agent_id) return "direct";
  if (room.type === "dm" || room.type === "group_dm") return "direct";
  if (room.parent_room_id) {
    if (room.type === "channel") return "channels";
    return "direct";
  }
  return "channels";
}

interface NavState {
  activeView: NavView;
  /** Rail selection for the one-list shell. Ignored while nav v2 is off. */
  v2Destination: ShellDestination;
  /** Which slice of the one list is showing. Not a destination. */
  conversationFilter: ConversationFilter;
  /**
   * Last opened room per (server, view). Survives view switches so returning
   * to a destination can restore (when no room is open) or highlight.
   * Home is never recorded.
   */
  lastRoomByViewByServer: Record<string, Partial<Record<NavView, string>>>;
  setActiveView: (view: NavView) => void;
  setV2Destination: (destination: ShellDestination) => void;
  setConversationFilter: (filter: ConversationFilter) => void;
  rememberRoom: (serverId: string, view: NavView, roomId: string) => void;
  lastRoomFor: (serverId: string | null, view: NavView) => string | null;
  /** Land on Home after a server switch (URL already goes to `/`). */
  resetForServer: () => void;
}

export const useNavStore = create<NavState>((set, get) => ({
  activeView: "home",
  v2Destination: initialShellDestination(),
  conversationFilter: "all",
  lastRoomByViewByServer: {},

  setActiveView: (view) => set({ activeView: view }),

  setV2Destination: (destination) => set({ v2Destination: destination }),

  setConversationFilter: (filter) => set({ conversationFilter: filter }),

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

  resetForServer: () =>
    set({ activeView: "home", v2Destination: "home", conversationFilter: "all" }),
}));
