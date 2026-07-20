import { create } from "zustand";
import type { Room, Message, Agent, RoomMember } from "@/services/api";

export interface TypingUser {
  user_id: string;
  username: string;
  timeout: ReturnType<typeof setTimeout>;
}

interface RoomMessages {
  items: Message[];
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
}

interface UIState {
  sidebarOpen: boolean;
  participantPanelOpen: boolean;
  // Lifted to the store (was Header-local) so the mobile account section in the
  // sidebar drawer can open Saved messages while the Header bar is hidden.
  savedOpen: boolean;
  settingsOpen: boolean;
  cheatsheetOpen: boolean;
  threadMessageId: string | null;
  stageAgentId: string | null;
  createRoomModalOpen: boolean;
}

interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  roles: string[];
}

export interface Toast {
  id: string;
  title: string;
  body?: string;
  roomId?: string;
  createdAt: number;
}

interface AppState {
  currentUser: CurrentUser | null;
  rooms: Room[];
  activeRoomId: string | null;
  messages: Record<string, RoomMessages>;
  participants: Record<string, RoomMember[]>;
  agents: Agent[];
  // The user's chosen default agent for the "New chat" button (server-side
  // preference, so it follows them across devices). null = not yet set →
  // callers fall back to the built-in default agent.
  defaultAgentId: string | null;
  typing: Record<string, TypingUser[]>;
  onlineUsers: string[];
  unreadCounts: Record<string, number>;
  // Per-room: { participant_id → last_read_at iso }
  readReceipts: Record<string, Record<string, string>>;
  // Per-room LLM override for the mid-conversation model switcher:
  // { roomId → model id }. Absent key = use the agent's default model.
  modelOverrides: Record<string, string>;
  toasts: Toast[];
  ui: UIState;
  voiceActive: boolean;

  setCurrentUser: (user: CurrentUser | null) => void;
  setRooms: (rooms: Room[]) => void;
  updateRoom: (roomId: string, updates: Partial<Room>) => void;
  removeRoom: (roomId: string) => void;
  setActiveRoomId: (id: string | null) => void;
  setMessages: (roomId: string, data: RoomMessages) => void;
  prependMessages: (roomId: string, messages: Message[], nextCursor: string | null, hasMore: boolean) => void;
  addMessage: (roomId: string, message: Message) => void;
  updateMessage: (roomId: string, messageId: string, updates: Partial<Message>) => void;
  removeMessage: (roomId: string, messageId: string) => void;
  setParticipants: (roomId: string, members: RoomMember[]) => void;
  updateParticipantOnline: (userId: string, isOnline: boolean) => void;
  setAgents: (agents: Agent[]) => void;
  setDefaultAgentId: (id: string | null) => void;
  addTypingUser: (roomId: string, user: TypingUser) => void;
  removeTypingUser: (roomId: string, userId: string) => void;
  setOnlineUsers: (userIds: string[]) => void;
  addOnlineUser: (userId: string) => void;
  removeOnlineUser: (userId: string) => void;
  setVoiceActive: (active: boolean) => void;
  resetForServer: () => void;

  toggleSidebar: () => void;
  toggleParticipantPanel: () => void;
  toggleSettings: () => void;
  toggleCheatsheet: () => void;
  setThreadMessageId: (id: string | null) => void;
  setStageAgentId: (id: string | null) => void;
  setCreateRoomModalOpen: (open: boolean) => void;
  setSavedOpen: (open: boolean) => void;

  incrementUnread: (roomId: string, by?: number) => void;
  clearUnread: (roomId: string) => void;
  setReadReceipt: (roomId: string, participantId: string, at: string) => void;
  // Set (modelId) or clear (null) the per-room LLM override.
  setModelOverride: (roomId: string, modelId: string | null) => void;
  pushToast: (toast: Omit<Toast, "id" | "createdAt">) => void;
  dismissToast: (id: string) => void;

  // Transient: when set, the active room's MessageInput will prepend this
  // text into its draft and clear the slot. Used by Quote-reply.
  pendingInsert: { roomId: string; text: string } | null;
  requestInsert: (roomId: string, text: string) => void;
  consumeInsert: (roomId: string) => string | null;
}

export const useAppStore = create<AppState>((set) => ({
  currentUser: null,
  rooms: [],
  activeRoomId: null,
  messages: {},
  participants: {},
  agents: [],
  defaultAgentId: null,
  typing: {},
  onlineUsers: [],
  unreadCounts: {},
  readReceipts: {},
  modelOverrides: {},
  toasts: [],
  pendingInsert: null,
  ui: {
    // On phones (<768px) the sidebar is an off-canvas overlay drawer; default
    // it CLOSED so the app opens to content (welcome / active room) with the
    // hamburger to reveal it — otherwise the 280px drawer covers the whole
    // screen on load. Desktop keeps it open in-flow.
    sidebarOpen: typeof window !== "undefined" ? window.innerWidth >= 768 : true,
    participantPanelOpen: typeof window !== "undefined" ? window.innerWidth >= 768 : true,
    savedOpen: false,
    settingsOpen: false,
    cheatsheetOpen: false,
    threadMessageId: null,
    stageAgentId: null,
    createRoomModalOpen: false,
  },
  voiceActive: false,

  setCurrentUser: (user) => set({ currentUser: user }),

  setRooms: (rooms) =>
    set((state) => {
      const prevById = new Map(state.rooms.map((r) => [r.id, r]));
      const nextUnread = { ...state.unreadCounts };
      const merged = rooms.map((r) => {
        // Seed the live unread map from the backend's cold-load count the
        // FIRST time we see a room (so badges show on login, before any WS
        // traffic); never clobber a count we're already tracking live.
        if (!(r.id in nextUnread)) nextUnread[r.id] = r.unread_count ?? 0;
        // Preserve the conversation-list preview across the 60s refetch: if
        // this payload has no last_message (older backend), keep whatever the
        // live WS path set. Without this, every refetch blanks the previews.
        const prev = prevById.get(r.id);
        return prev ? { ...r, last_message: r.last_message ?? prev.last_message } : r;
      });
      return { rooms: merged, unreadCounts: nextUnread };
    }),

  updateRoom: (roomId, updates) =>
    set((state) => ({
      rooms: state.rooms.map((r) =>
        r.id === roomId ? { ...r, ...updates } : r,
      ),
    })),

  removeRoom: (roomId) =>
    set((state) => {
      const nextUnread = { ...state.unreadCounts };
      delete nextUnread[roomId];
      const nextMessages = { ...state.messages };
      delete nextMessages[roomId];
      const nextParticipants = { ...state.participants };
      delete nextParticipants[roomId];
      return {
        rooms: state.rooms.filter((r) => r.id !== roomId),
        unreadCounts: nextUnread,
        messages: nextMessages,
        participants: nextParticipants,
        activeRoomId:
          state.activeRoomId === roomId ? null : state.activeRoomId,
      };
    }),

  setActiveRoomId: (id) => set({ activeRoomId: id }),

  setMessages: (roomId, data) =>
    set((state) => ({
      messages: { ...state.messages, [roomId]: data },
    })),

  prependMessages: (roomId, messages, nextCursor, hasMore) =>
    set((state) => {
      const existing = state.messages[roomId];
      return {
        messages: {
          ...state.messages,
          [roomId]: {
            items: [...messages, ...(existing?.items ?? [])],
            nextCursor,
            hasMore,
            loading: false,
          },
        },
      };
    }),

  addMessage: (roomId, message) =>
    set((state) => {
      const existing = state.messages[roomId];
      const items = existing?.items ?? [];
      const alreadyExists = items.some((m) => m.id === message.id);
      if (alreadyExists) return state;

      return {
        messages: {
          ...state.messages,
          [roomId]: {
            items: [...items, message],
            nextCursor: existing?.nextCursor ?? null,
            hasMore: existing?.hasMore ?? true,
            loading: false,
          },
        },
        rooms: state.rooms.map((r) =>
          r.id === roomId
            ? {
                ...r,
                last_message: message,
                unread_count:
                  state.activeRoomId === roomId
                    ? r.unread_count
                    : r.unread_count + 1,
              }
            : r,
        ),
      };
    }),

  updateMessage: (roomId, messageId, updates) =>
    set((state) => {
      const existing = state.messages[roomId];
      if (!existing) return state;
      return {
        messages: {
          ...state.messages,
          [roomId]: {
            ...existing,
            items: existing.items.map((m) =>
              m.id === messageId ? { ...m, ...updates } : m,
            ),
          },
        },
      };
    }),

  removeMessage: (roomId, messageId) =>
    set((state) => {
      const existing = state.messages[roomId];
      if (!existing) return state;
      return {
        messages: {
          ...state.messages,
          [roomId]: {
            ...existing,
            items: existing.items.filter((m) => m.id !== messageId),
          },
        },
      };
    }),

  setParticipants: (roomId, members) =>
    set((state) => {
      // Reconcile presence from the /members snapshot (refetched ~30s). The
      // server derives presence purely from Redis, so this snapshot is
      // authoritative in BOTH directions: it may add AND remove.
      //
      // It is applied UNCONDITIONALLY. An earlier revision suppressed the
      // snapshot for a few seconds after a live WS delta, to stop a poll that
      // was already in flight from flipping a dot back. That guard was wrong
      // twice over: it keyed off when the delta was RECEIVED rather than when
      // the poll was ISSUED (so a strictly fresher poll was suppressed just
      // like a stale one), and — because TanStack Query's structural sharing
      // hands back the PREVIOUS object reference when a refetch deep-equals
      // the cached data — a suppressed update had no recovery edge and could
      // stick forever. The race it defended against costs a wrong dot until
      // the next poll; the guard cost a wrong dot indefinitely. Losing the
      // race is the cheaper failure, so we take it.
      //
      // RoomView re-delivers on every successful fetch (it keys the effect on
      // dataUpdatedAt, not on the data reference), so a store diverged by a WS
      // delta is always re-settled by the next poll even when the payload is
      // byte-identical to the cached one.
      const online = new Set(state.onlineUsers);
      const reconciled = members.map((m) => {
        const id = m.participant_id || m.user_id;
        if (!id) return m;
        // Wire-format carries live presence as the `is_online` boolean, with
        // `status` ("online"/"offline") mirroring the same fact. Honor either.
        const snapshotOnline =
          typeof m.is_online === "boolean"
            ? m.is_online
            : m.status
              ? m.status === "online"
              : undefined;
        if (snapshotOnline === undefined) return m;

        if (snapshotOnline) online.add(id);
        else online.delete(id);
        return { ...m, is_online: snapshotOnline };
      });
      return {
        participants: { ...state.participants, [roomId]: reconciled },
        onlineUsers: Array.from(online),
      };
    }),

  updateParticipantOnline: (userId, isOnline) =>
    set((state) => {
      // Called from the WS presence handler. Member rows are keyed by
      // Participant.id and never carry `user_id`, so matching on `user_id`
      // alone never hit -- `is_online` on the roster stayed stale until the
      // next poll. Match either identity.
      const updated: Record<string, RoomMember[]> = {};
      for (const [roomId, members] of Object.entries(state.participants)) {
        updated[roomId] = members.map((m) =>
          (m.participant_id || m.user_id) === userId
            ? { ...m, is_online: isOnline }
            : m,
        );
      }
      return { participants: { ...state.participants, ...updated } };
    }),

  setAgents: (agents) => set({ agents }),
  setDefaultAgentId: (id) => set({ defaultAgentId: id }),

  addTypingUser: (roomId, user) =>
    set((state) => {
      const roomTyping = state.typing[roomId] ?? [];
      const filtered = roomTyping.filter((t) => t.user_id !== user.user_id);
      return {
        typing: {
          ...state.typing,
          [roomId]: [...filtered, user],
        },
      };
    }),

  removeTypingUser: (roomId, userId) =>
    set((state) => {
      const roomTyping = state.typing[roomId] ?? [];
      const user = roomTyping.find((t) => t.user_id === userId);
      if (user) {
        clearTimeout(user.timeout);
      }
      return {
        typing: {
          ...state.typing,
          [roomId]: roomTyping.filter((t) => t.user_id !== userId),
        },
      };
    }),

  setOnlineUsers: (userIds) => set({ onlineUsers: userIds }),
  addOnlineUser: (userId) =>
    set((state) => ({
      onlineUsers: state.onlineUsers.includes(userId)
        ? state.onlineUsers
        : [...state.onlineUsers, userId],
    })),
  removeOnlineUser: (userId) =>
    set((state) => ({
      onlineUsers: state.onlineUsers.filter((id) => id !== userId),
    })),

  setVoiceActive: (active) => set({ voiceActive: active }),
  // Wipe all server-scoped state when switching federated instances so no room,
  // message, agent, or per-server preference bleeds into the next server. The
  // persisted UI chrome (drawer open, panel widths) is intentionally kept.
  resetForServer: () =>
    set((state) => {
      // Clear pending typing-indicator timers so they don't fire into the
      // freshly-reset store after a server switch.
      for (const users of Object.values(state.typing)) {
        for (const u of users) clearTimeout(u.timeout);
      }
      return {
        rooms: [],
        activeRoomId: null,
        messages: {},
        participants: {},
        agents: [],
        defaultAgentId: null,
        typing: {},
        onlineUsers: [],
        unreadCounts: {},
        readReceipts: {},
        modelOverrides: {},
        toasts: [],
        pendingInsert: null,
        voiceActive: false,
        ui: { ...state.ui, threadMessageId: null, stageAgentId: null },
      };
    }),

  toggleSidebar: () =>
    set((state) => ({
      ui: { ...state.ui, sidebarOpen: !state.ui.sidebarOpen },
    })),
  toggleParticipantPanel: () =>
    set((state) => ({
      ui: {
        ...state.ui,
        participantPanelOpen: !state.ui.participantPanelOpen,
      },
    })),
  toggleSettings: () =>
    set((state) => ({
      ui: { ...state.ui, settingsOpen: !state.ui.settingsOpen },
    })),
  toggleCheatsheet: () =>
    set((state) => ({
      ui: { ...state.ui, cheatsheetOpen: !state.ui.cheatsheetOpen },
    })),
  setThreadMessageId: (id) =>
    set((state) => ({
      ui: { ...state.ui, threadMessageId: id },
    })),
  setStageAgentId: (id) =>
    set((state) => ({
      ui: { ...state.ui, stageAgentId: id },
    })),
  setCreateRoomModalOpen: (open) =>
    set((state) => ({
      ui: { ...state.ui, createRoomModalOpen: open },
    })),
  setSavedOpen: (open) =>
    set((state) => ({
      ui: { ...state.ui, savedOpen: open },
    })),

  incrementUnread: (roomId, by = 1) =>
    set((state) => ({
      unreadCounts: {
        ...state.unreadCounts,
        [roomId]: (state.unreadCounts[roomId] ?? 0) + by,
      },
    })),
  clearUnread: (roomId) =>
    set((state) => {
      // Set to 0 (not delete) so the count stays authoritatively cleared: the
      // display reads `unreadCounts[id] ?? room.unread_count`, and deleting
      // would let it fall back to a stale backend cold-load seed.
      if (state.unreadCounts[roomId] === 0) return {} as Partial<AppState>;
      return { unreadCounts: { ...state.unreadCounts, [roomId]: 0 } };
    }),
  setReadReceipt: (roomId, participantId, at) =>
    set((state) => ({
      readReceipts: {
        ...state.readReceipts,
        [roomId]: {
          ...(state.readReceipts[roomId] ?? {}),
          [participantId]: at,
        },
      },
    })),
  setModelOverride: (roomId, modelId) =>
    set((state) => {
      const next = { ...state.modelOverrides };
      if (modelId) {
        next[roomId] = modelId;
      } else {
        // null clears the override → fall back to the agent's default model.
        delete next[roomId];
      }
      return { modelOverrides: next };
    }),
  pushToast: (toast) =>
    set((state) => ({
      toasts: [
        ...state.toasts,
        {
          ...toast,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          createdAt: Date.now(),
        },
      ],
    })),
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  requestInsert: (roomId, text) =>
    set({ pendingInsert: { roomId, text } }),
  consumeInsert: (roomId) => {
    let out: string | null = null;
    set((state) => {
      const p = state.pendingInsert;
      if (!p || p.roomId !== roomId) return {} as Partial<AppState>;
      out = p.text;
      return { pendingInsert: null };
    });
    return out;
  },
}));
