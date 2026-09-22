import { create } from "zustand";
import type { Room, Message, Agent, RoomMember } from "@/services/api";
import {
  dismissPhotoNudge as persistPhotoNudgeDismissal,
  isPhotoNudgeDismissed,
  type SafeAvatarSrc,
} from "@/lib/identity";

export interface TypingUser {
  user_id: string;
  username: string;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * A REAL, server-asserted agent state — never an optimistic guess.
 *
 * `kind: "thinking"` comes from the backend's agent_typing event, emitted
 * around the actual Brigade call, so it is true only while something is
 * genuinely running. `kind: "relay"` is for gateway/bridge agents, which have
 * no thinking signal at all; it asserts only that a message is sitting
 * uncollected by that bridge, and is retracted on delivery.
 *
 * Keyed per agent so the UI can NAME whoever is actually working. Every entry
 * carries its own `timeout` as a client-side backstop: if the clearing event
 * is lost (worker crash, dropped socket) the row expires by itself rather than
 * asserting activity forever — the failure this whole state exists to prevent.
 */
export interface AgentActivity {
  agent_id: string;
  label: string;
  kind: "thinking" | "relay";
  /** Participant UUID when known — drives the identity hue. */
  participant_id?: string | null;
  since: number;
  timeout: ReturnType<typeof setTimeout>;
}

interface RoomMessages {
  items: Message[];
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
  /** Initial page failed; ChatPanel offers a retry. */
  error?: boolean;
}

interface UIState {
  sidebarOpen: boolean;
  participantPanelOpen: boolean;
  // Lifted to the store (was Header-local) so the mobile account section in the
  // sidebar drawer can open Saved messages while the Header bar is hidden.
  savedOpen: boolean;
  settingsOpen: boolean;
  /** Pane to land on when Settings opens. Null keeps the modal's default. */
  settingsPane: "account" | "appearance" | "devices" | "notifications" | "agents" | "instance" | "help" | null;
  cheatsheetOpen: boolean;
  threadMessageId: string | null;
  stageAgentId: string | null;
  createRoomModalOpen: boolean;
  /** Global People directory drawer (Header button; not the room participant panel). */
  peopleDrawerOpen: boolean;
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
  /** Semantic tone. When absent, ToastStack falls back to reading the title —
   * callers reporting a FAILURE should always pass "error" so the toast
   * doesn't render as an info chirp (and so it lingers long enough to read). */
  kind?: "success" | "error" | "info";
  /** Never auto-dismiss (user must close). For failures that need action. */
  sticky?: boolean;
  /** Allowlisted face URL. Absent, rejected, or broken → the bell chip. */
  icon?: SafeAvatarSrc | null;
}

interface AppState {
  currentUser: CurrentUser | null;
  /** The signed-in user's PARTICIPANT id — the id space room events use for
   * sender_id. Distinct from currentUser.id (the Keycloak sub); comparing the
   * two silently never matches, which is how self-messages once toasted and
   * bumped unread. Learned from the websocket auth_ok ack. */
  currentParticipantId: string | null;
  rooms: Room[];
  /**
   * True once the initial rooms payload has landed (from the AppShell rooms
   * refetch). Lets the sidebar/Home distinguish "loading" from "genuinely
   * empty" so they don't flash empty-state CTAs and zero stats mid-load.
   */
  roomsLoaded: boolean;
  activeRoomId: string | null;
  messages: Record<string, RoomMessages>;
  participants: Record<string, RoomMember[]>;
  agents: Agent[];
  // The user's chosen default agent for the "New chat" button (server-side
  // preference, so it follows them across devices). null = not yet set →
  // callers fall back to the built-in default agent.
  defaultAgentId: string | null;
  typing: Record<string, TypingUser[]>;
  /** Per-room, per-agent genuine activity. See AgentActivity. */
  agentActivity: Record<string, AgentActivity[]>;
  onlineUsers: string[];
  unreadCounts: Record<string, number>;
  /**
   * Rooms where at least one unread message @-mentioned me. Client-tracked
   * (WS path); cleared with clearUnread. Feeds Focused sidebar mode.
   */
  mentionUnreads: Record<string, boolean>;
  // Per-room: { participant_id → last_read_at iso }
  readReceipts: Record<string, Record<string, string>>;
  // Per-room LLM override for the mid-conversation model switcher:
  // { roomId → model id }. Absent key = use the agent's default model.
  modelOverrides: Record<string, string>;
  toasts: Toast[];
  ui: UIState;
  voiceActive: boolean;
  /**
   * Avatar sync. `idle`/`pending` means the Keycloak claim is all we have;
   * the photo nudge stays hidden until `settled`. `resolvedAvatarUrl` is the
   * picture to render once settled (the server effective URL, or the claim
   * when the server had nothing newer).
   */
  avatarSync: "idle" | "pending" | "settled";
  resolvedAvatarUrl: string | null;
  /** Shared across Header, the phone drawer, and Settings. */
  photoNudgeDismissed: boolean;

  setCurrentUser: (user: CurrentUser | null) => void;
  setCurrentParticipantId: (id: string | null) => void;
  setRooms: (rooms: Room[]) => void;
  setRoomsLoaded: (loaded: boolean) => void;
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
  /** Drop every typing row for a room and clear its timers. Room switch,
   * unmount, socket drop. */
  clearRoomTyping: (roomId: string) => void;
  setAgentActivity: (roomId: string, activity: AgentActivity) => void;
  clearAgentActivity: (roomId: string, agentId: string) => void;
  /** Drop every agent-activity row (all rooms). Used on socket disconnect: if
   * we cannot hear the clearing event we must not keep asserting the state. */
  clearAllAgentActivity: () => void;
  setOnlineUsers: (userIds: string[]) => void;
  addOnlineUser: (userId: string) => void;
  removeOnlineUser: (userId: string) => void;
  setVoiceActive: (active: boolean) => void;
  resetForServer: () => void;

  toggleSidebar: () => void;
  toggleParticipantPanel: () => void;
  setParticipantPanelOpen: (open: boolean) => void;
  toggleSettings: () => void;
  /** Open Settings on a pane. The photo nudge uses "appearance". */
  openSettings: (
    pane?: "account" | "appearance" | "devices" | "notifications" | "agents" | "instance" | "help",
  ) => void;
  toggleCheatsheet: () => void;
  setThreadMessageId: (id: string | null) => void;
  setStageAgentId: (id: string | null) => void;
  setCreateRoomModalOpen: (open: boolean) => void;
  setSavedOpen: (open: boolean) => void;
  setPeopleDrawerOpen: (open: boolean) => void;
  togglePeopleDrawer: () => void;

  incrementUnread: (roomId: string, by?: number) => void;
  clearUnread: (roomId: string) => void;
  /** Flag room as having an unread @-mention (Focused mode + sort). */
  markMentionUnread: (roomId: string) => void;
  setReadReceipt: (roomId: string, participantId: string, at: string) => void;
  // Set (modelId) or clear (null) the per-room LLM override.
  setModelOverride: (roomId: string, modelId: string | null) => void;
  pushToast: (toast: Omit<Toast, "id" | "createdAt">) => void;
  dismissToast: (id: string) => void;
  beginAvatarSync: () => void;
  /** `url` is the server effective picture. Null keeps the claim. */
  settleAvatarSync: (url: string | null) => void;
  dismissPhotoNudge: () => void;

  // Transient: when set, the active room's MessageInput will prepend this
  // text into its draft and clear the slot. Used by Quote-reply.
  pendingInsert: { roomId: string; text: string } | null;
  requestInsert: (roomId: string, text: string) => void;
  consumeInsert: (roomId: string) => string | null;
}

export const useAppStore = create<AppState>((set) => ({
  currentUser: null,
  currentParticipantId: null,
  rooms: [],
  roomsLoaded: false,
  activeRoomId: null,
  messages: {},
  participants: {},
  agents: [],
  defaultAgentId: null,
  typing: {},
  agentActivity: {},
  onlineUsers: [],
  unreadCounts: {},
  mentionUnreads: {},
  readReceipts: {},
  modelOverrides: {},
  toasts: [],
  avatarSync: "idle",
  resolvedAvatarUrl: null,
  photoNudgeDismissed: isPhotoNudgeDismissed(),
  pendingInsert: null,
  ui: {
    // On phones (<768px) the sidebar is an off-canvas overlay drawer; default
    // it CLOSED so the app opens to content (welcome / active room) with the
    // hamburger to reveal it — otherwise the 280px drawer covers the whole
    // screen on load. Desktop keeps it open in-flow.
    sidebarOpen: typeof window !== "undefined" ? window.innerWidth >= 768 : true,
    // The conversation is the primary surface. Members are one click away,
    // but defaulting this open squeezed chat before the user asked for it.
    participantPanelOpen: false,
    savedOpen: false,
    settingsOpen: false,
    settingsPane: null,
    cheatsheetOpen: false,
    threadMessageId: null,
    stageAgentId: null,
    createRoomModalOpen: false,
    peopleDrawerOpen: false,
  },
  voiceActive: false,

  setCurrentUser: (user) => set({ currentUser: user }),
  setCurrentParticipantId: (id) => set({ currentParticipantId: id }),

  setRooms: (rooms) =>
    set((state) => {
      const prevById = new Map(state.rooms.map((r) => [r.id, r]));
      const nextUnread = { ...state.unreadCounts };
      const nextMentions = { ...state.mentionUnreads };
      const merged = rooms.map((r) => {
        // Seed the live unread map from the backend's cold-load count the
        // FIRST time we see a room (so badges show on login, before any WS
        // traffic); never clobber a count we're already tracking live.
        if (!(r.id in nextUnread)) nextUnread[r.id] = r.unread_count ?? 0;
        if (!(r.id in nextMentions)) {
          nextMentions[r.id] = r.has_unread_mention === true || (r.mention_count ?? 0) > 0;
        }
        // Preserve the conversation-list preview across the 60s refetch: if
        // this payload has no last_message (older backend), keep whatever the
        // live WS path set. Without this, every refetch blanks the previews.
        const prev = prevById.get(r.id);
        return prev ? { ...r, last_message: r.last_message ?? prev.last_message } : r;
      });
      // Any payload is evidence the backend answered — the list is "loaded"
      // even when it comes back empty (that's the honest empty state).
      return {
        rooms: merged,
        unreadCounts: nextUnread,
        mentionUnreads: nextMentions,
        roomsLoaded: true,
      };
    }),

  setRoomsLoaded: (loaded) => set({ roomsLoaded: loaded }),

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

  setActiveRoomId: (id) =>
    set((state) => ({
      activeRoomId: id,
      // A thread belongs to one room. Carrying its message id into another
      // room produced an empty, contextless column.
      ui:
        state.activeRoomId !== id
          ? { ...state.ui, threadMessageId: null }
          : state.ui,
    })),

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

  // Upsert one human's typing row. Replacing by user_id AND clearing the
  // superseded row's timer keeps exactly one live timer per typist, so a
  // continuously-typing person's keepalives push the expiry out instead of
  // stacking timers. Dropping the clearTimeout is not a leak you can shrug at:
  // the orphaned timer keeps its original deadline and later fires
  // removeTypingUser against someone who is STILL typing, blinking the row off
  // mid-sentence until the next keepalive puts it back. Ownership rule, shared
  // with setAgentActivity below: whoever removes a row from the array clears
  // that row's timer.
  addTypingUser: (roomId, user) =>
    set((state) => {
      const roomTyping = state.typing[roomId] ?? [];
      for (const t of roomTyping) {
        if (t.user_id === user.user_id && t.timeout !== user.timeout) {
          clearTimeout(t.timeout);
        }
      }
      const filtered = roomTyping.filter((t) => t.user_id !== user.user_id);
      return {
        typing: {
          ...state.typing,
          [roomId]: [...filtered, user],
        },
      };
    }),

  // Drop every typing row for one room, clearing each row's timer. This is the
  // teardown for a room switch, an unmount, or a dropped socket: without it the
  // armed expiry timers outlive the room they belong to and fire into state
  // nobody is looking at any more.
  clearRoomTyping: (roomId) =>
    set((state) => {
      const roomTyping = state.typing[roomId];
      if (!roomTyping || roomTyping.length === 0) return state;
      for (const t of roomTyping) clearTimeout(t.timeout);
      const next = { ...state.typing };
      delete next[roomId];
      return { typing: next };
    }),

  // Drop one human's typing row. Every exit returns state UNTOUCHED unless a
  // row actually went away: the consumer selector is
  // `s.typing[roomId] ?? EMPTY_TYPING` (hooks/usePresence.ts), so writing a
  // freshly-minted `[]` for a room that had no entry — the common case, since
  // an expiry timer and an explicit typing:false routinely race and the loser
  // finds nothing to remove — hands that selector a new array identity every
  // time and re-renders the whole room for a no-op. Letting the key stay
  // ABSENT is what keeps EMPTY_TYPING's stable identity worth having, which
  // is the same discipline clearRoomTyping was careful to observe.
  removeTypingUser: (roomId, userId) =>
    set((state) => {
      const roomTyping = state.typing[roomId];
      if (!roomTyping || roomTyping.length === 0) return state;
      const user = roomTyping.find((t) => t.user_id === userId);
      // Not here — nothing to clear, nothing to write.
      if (!user) return state;
      clearTimeout(user.timeout);
      const remaining = roomTyping.filter((t) => t.user_id !== userId);
      const next = { ...state.typing };
      if (remaining.length === 0) {
        // Last typist left: delete the key rather than parking an empty array,
        // so the selector falls through to the shared EMPTY_TYPING constant.
        delete next[roomId];
      } else {
        next[roomId] = remaining;
      }
      return { typing: next };
    }),

  // Upsert one agent's activity row. Replacing by agent_id (and clearing the
  // superseded row's timer) keeps exactly one state per agent, so a thinking
  // signal arriving for an agent that had a relay marker cleanly supersedes it
  // instead of showing two contradictory lines.
  setAgentActivity: (roomId, activity) =>
    set((state) => {
      const rows = state.agentActivity[roomId] ?? [];
      for (const r of rows) {
        if (r.agent_id === activity.agent_id) clearTimeout(r.timeout);
      }
      return {
        agentActivity: {
          ...state.agentActivity,
          [roomId]: [
            ...rows.filter((r) => r.agent_id !== activity.agent_id),
            activity,
          ],
        },
      };
    }),

  clearAgentActivity: (roomId, agentId) =>
    set((state) => {
      const rows = state.agentActivity[roomId];
      if (!rows || rows.length === 0) return {};
      const next = rows.filter((r) => {
        if (r.agent_id !== agentId) return true;
        clearTimeout(r.timeout);
        return false;
      });
      if (next.length === rows.length) return {};
      return {
        agentActivity: { ...state.agentActivity, [roomId]: next },
      };
    }),

  clearAllAgentActivity: () =>
    set((state) => {
      let any = false;
      for (const rows of Object.values(state.agentActivity)) {
        for (const r of rows) {
          clearTimeout(r.timeout);
          any = true;
        }
      }
      return any ? { agentActivity: {} } : {};
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
      for (const rows of Object.values(state.agentActivity)) {
        for (const r of rows) clearTimeout(r.timeout);
      }
      return {
        rooms: [],
        roomsLoaded: false,
        activeRoomId: null,
        messages: {},
        participants: {},
        agents: [],
        defaultAgentId: null,
        typing: {},
        agentActivity: {},
        onlineUsers: [],
        unreadCounts: {},
        mentionUnreads: {},
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
  setParticipantPanelOpen: (open) =>
    set((state) => ({
      ui: { ...state.ui, participantPanelOpen: open },
    })),
  toggleSettings: () =>
    set((state) => ({
      ui: {
        ...state.ui,
        settingsOpen: !state.ui.settingsOpen,
        // The gear always opens on Account. openSettings picks a pane.
        settingsPane: null,
      },
    })),
  openSettings: (pane = "account") =>
    set((state) => ({
      ui: { ...state.ui, settingsOpen: true, settingsPane: pane },
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
  setPeopleDrawerOpen: (open) =>
    set((state) => ({
      ui: { ...state.ui, peopleDrawerOpen: open },
    })),
  togglePeopleDrawer: () =>
    set((state) => ({
      ui: { ...state.ui, peopleDrawerOpen: !state.ui.peopleDrawerOpen },
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
      const next: Partial<AppState> = {};
      if (state.unreadCounts[roomId] !== 0) {
        next.unreadCounts = { ...state.unreadCounts, [roomId]: 0 };
      }
      if (state.mentionUnreads[roomId]) {
        const mentions = { ...state.mentionUnreads };
        delete mentions[roomId];
        next.mentionUnreads = mentions;
      }
      return next;
    }),
  markMentionUnread: (roomId) =>
    set((state) => {
      if (state.mentionUnreads[roomId]) return {} as Partial<AppState>;
      return {
        mentionUnreads: { ...state.mentionUnreads, [roomId]: true },
      };
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
  beginAvatarSync: () => set({ avatarSync: "pending" }),
  settleAvatarSync: (url) =>
    set((state) => {
      const resolved = url ?? state.currentUser?.avatarUrl ?? null;
      return {
        avatarSync: "settled",
        resolvedAvatarUrl: resolved,
        currentUser:
          url && state.currentUser
            ? { ...state.currentUser, avatarUrl: url }
            : state.currentUser,
      };
    }),
  dismissPhotoNudge: () => {
    persistPhotoNudgeDismissal();
    set({ photoNudgeDismissed: true });
  },

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
