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
  settingsOpen: boolean;
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

interface AppState {
  currentUser: CurrentUser | null;
  rooms: Room[];
  activeRoomId: string | null;
  messages: Record<string, RoomMessages>;
  participants: Record<string, RoomMember[]>;
  agents: Agent[];
  typing: Record<string, TypingUser[]>;
  onlineUsers: string[];
  ui: UIState;
  voiceActive: boolean;

  setCurrentUser: (user: CurrentUser | null) => void;
  setRooms: (rooms: Room[]) => void;
  updateRoom: (roomId: string, updates: Partial<Room>) => void;
  setActiveRoomId: (id: string | null) => void;
  setMessages: (roomId: string, data: RoomMessages) => void;
  prependMessages: (roomId: string, messages: Message[], nextCursor: string | null, hasMore: boolean) => void;
  addMessage: (roomId: string, message: Message) => void;
  updateMessage: (roomId: string, messageId: string, updates: Partial<Message>) => void;
  removeMessage: (roomId: string, messageId: string) => void;
  setParticipants: (roomId: string, members: RoomMember[]) => void;
  updateParticipantOnline: (userId: string, isOnline: boolean) => void;
  setAgents: (agents: Agent[]) => void;
  addTypingUser: (roomId: string, user: TypingUser) => void;
  removeTypingUser: (roomId: string, userId: string) => void;
  setOnlineUsers: (userIds: string[]) => void;
  addOnlineUser: (userId: string) => void;
  removeOnlineUser: (userId: string) => void;
  setVoiceActive: (active: boolean) => void;

  toggleSidebar: () => void;
  toggleParticipantPanel: () => void;
  toggleSettings: () => void;
  setThreadMessageId: (id: string | null) => void;
  setStageAgentId: (id: string | null) => void;
  setCreateRoomModalOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentUser: null,
  rooms: [],
  activeRoomId: null,
  messages: {},
  participants: {},
  agents: [],
  typing: {},
  onlineUsers: [],
  ui: {
    sidebarOpen: true,
    participantPanelOpen: true,
    settingsOpen: false,
    threadMessageId: null,
    stageAgentId: null,
    createRoomModalOpen: false,
  },
  voiceActive: false,

  setCurrentUser: (user) => set({ currentUser: user }),

  setRooms: (rooms) => set({ rooms }),

  updateRoom: (roomId, updates) =>
    set((state) => ({
      rooms: state.rooms.map((r) =>
        r.id === roomId ? { ...r, ...updates } : r,
      ),
    })),

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
    set((state) => ({
      participants: { ...state.participants, [roomId]: members },
    })),

  updateParticipantOnline: (userId, isOnline) =>
    set((state) => {
      const updated: Record<string, RoomMember[]> = {};
      for (const [roomId, members] of Object.entries(state.participants)) {
        updated[roomId] = members.map((m) =>
          m.user_id === userId ? { ...m, is_online: isOnline } : m,
        );
      }
      return { participants: { ...state.participants, ...updated } };
    }),

  setAgents: (agents) => set({ agents }),

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
}));
