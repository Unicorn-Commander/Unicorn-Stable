import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import { useFederationStore } from "@/stores/federationStore";
import { useIncomingCallStore } from "@/stores/incomingCallStore";
import { useOutgoingCallStore } from "@/stores/outgoingCallStore";
import {
  ws,
  WsCallOccupancyEvent,
  WsCallStartedEvent,
  WsCallResolvedEvent,
  WsCallRingStateEvent,
  WsEventPayload,
  WsMessageEvent,
} from "@/services/websocket";
import type { HomeSummary } from "@/services/api";
import { loadPrefs } from "@/components/Layout/SettingsModal";
import { getNotifyLevel } from "@/utils/mute";
import { messageMentionsUser } from "@/utils/unreadModel";
import {
  applyOccupancyEvent,
  isFreshCallStart,
  shouldToastCallStart,
} from "@/lib/callAwareness";
import { homeSummaryQueryKey } from "@/hooks/useLiveCalls";
import { playCue } from "@/lib/sounds";
import { ensurePushSubscription } from "@/lib/webpush";
import { resolveIdentity } from "@/lib/identity";
import { useGlobalPresence } from "@/hooks/useGlobalPresence";
import { api } from "@/services/api";
import { noteThreadOnParent, threadStubFromEvent, type ThreadCreatedEvent } from "@/lib/conversation";
import { useConversationUi } from "@/stores/conversationUiStore";
import { usePresenterStore } from "@/stores/presenterStore";
import { presenterRule } from "@/lib/presenterMode";

/**
 * Hard ceilings for a server-asserted agent state held locally.
 *
 * These are BACKSTOPS, not the mechanism: the state is meant to be cleared by
 * an explicit event from the server. If that event is lost, these bound how
 * long a stale claim can survive. A generating reply that has produced nothing
 * for two minutes is not worth asserting; an uncollected bridge message is
 * capped at the server's own marker TTL.
 */
const AGENT_THINKING_MAX_MS = 120_000;
const AGENT_RELAY_MAX_MS = 300_000;

interface RoomInvitedEvent {
  room_id: string;
  inviter_name: string | null;
}

/**
 * Global WebSocket listeners: unread counts, toasts, and invite refreshes.
 * Mounted once at the app shell level so it runs regardless of active room.
 */
export function useGlobalNotifications() {
  const announcedStarts = useRef(new Set<string>());
  // Instance-scoped presence for People directory / drawer (not room-only).
  useGlobalPresence();

  const currentUser = useAppStore((s) => s.currentUser);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const incrementUnread = useAppStore((s) => s.incrementUnread);
  const markMentionUnread = useAppStore((s) => s.markMentionUnread);
  const pushToast = useAppStore((s) => s.pushToast);
  const rooms = useAppStore((s) => s.rooms);
  const queryClient = useQueryClient();

  function maskTransientRoom(roomId: string): boolean {
    const app = useAppStore.getState();
    const presenter = usePresenterStore.getState();
    if (!presenter.enabled) return false;
    // Safe rooms may show their names in lists, but message previews and
    // transient notification detail remain off-screen. Only the open room and
    // its own threads retain the full room experience (P5).
    const rule = presenterRule({
      enabled: true,
      openRoomId: app.activeRoomId,
      safeRoomIds: presenter.safeRoomIds,
      rooms: app.rooms,
    });
    return !rule.isOpenRoom(roomId);
  }

  // Ask for OS-notification permission ONCE, on the user's first click after
  // load — Chrome requires a genuine user gesture, so we can't prompt on mount.
  // Silent if the user already granted or denied.
  useEffect(() => {
    // Already granted (e.g. returning user): register web-push now.
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      void ensurePushSubscription();
    }
    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "default"
    ) {
      return;
    }
    const ask = () => {
      Notification.requestPermission()
        .then((p) => {
          if (p === "granted") void ensurePushSubscription();
        })
        .catch(() => {});
    };
    window.addEventListener("pointerdown", ask, { once: true });
    return () => window.removeEventListener("pointerdown", ask);
  }, []);

  useEffect(() => {
    const unsubMessage = ws.on("message", (data: WsEventPayload) => {
      const event = data as WsMessageEvent;
      if (!event?.message || !event.room_id) return;

      // Keep the conversation-list preview fresh for EVERY room — active,
      // muted, or background — regardless of sender. The sidebar + home feed
      // read room.last_message, and the global handler is the only listener
      // that sees messages for rooms other than the one currently open.
      useAppStore
        .getState()
        .updateRoom(event.room_id, { last_message: event.message });

      // Ignore messages from self (for unread/toast purposes). sender_id is a
      // PARTICIPANT id, so compare against the participant identity learned
      // from the websocket auth_ok ack; the Keycloak-sub comparison is kept as
      // a harmless fallback but never matched on its own (different id space —
      // that mismatch is exactly how self-messages used to toast and bump
      // unread counts).
      const selfParticipantId = useAppStore.getState().currentParticipantId;
      if (
        event.message.sender_id &&
        (event.message.sender_id === selfParticipantId ||
          event.message.sender_id === currentUser?.id)
      ) {
        return;
      }

      // Don't increment for the room that's currently open (user is seeing it)
      if (
        event.room_id === activeRoomId &&
        document.visibilityState === "visible"
      ) {
        return;
      }

      // Per-room notification level (Discord-style):
      //  - "muted"    → skip entirely: no unread badge, no ping
      //  - "mentions" → still badge the room, but only ping on an @-mention
      //  - "all"      → badge + ping (default)
      const level = getNotifyLevel(event.room_id);
      if (level === "muted") {
        return;
      }

      incrementUnread(event.room_id);

      const mentioned = messageMentionsUser(
        event.message.content,
        currentUser?.username,
      );
      if (mentioned) {
        markMentionUnread(event.room_id);
      }

      // For "mentions only" rooms, a ping requires the message to mention us.
      const mentionOk = level === "all" || mentioned;

      // Notify (toast + sound) only if the room isn't the active one (or the
      // tab is hidden). The sound cue rides the same mute/self/active checks
      // as the toast but has its OWN pref (playCue checks soundCues itself),
      // so it stays independent of the inAppToasts toggle.
      const shouldNotify =
        mentionOk &&
        (event.room_id !== activeRoomId ||
          document.visibilityState !== "visible");
      if (shouldNotify) {
        playCue("notify");
      }
      if (loadPrefs().inAppToasts && shouldNotify) {
        const room = rooms.find((r) => r.id === event.room_id);
        const masked = maskTransientRoom(event.room_id);
        const face = masked ? null : resolveIdentity(event.message);
        pushToast({
          title: masked
            ? "New message"
            : `${event.message.sender_name} in ${room?.name ?? "a room"}`,
          body: masked ? undefined : event.message.content.slice(0, 120),
          roomId: event.room_id,
          icon: face?.src,
        });
      }

      // Backgrounded tab: the in-app toast is invisible, so surface a real OS
      // notification when the user has granted permission. Best-effort — the
      // installed-PWA / closed-app (web-push) path is a separate build.
      if (
        shouldNotify &&
        document.hidden &&
        "serviceWorker" in navigator &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        const room = rooms.find((r) => r.id === event.room_id);
        const masked = maskTransientRoom(event.room_id);
        const face = masked ? null : resolveIdentity(event.message);
        try {
          void navigator.serviceWorker.ready.then((registration) =>
            registration.showNotification(
              masked
                ? "New message"
                : `${event.message.sender_name} in ${room?.name ?? "a room"}`,
              {
                body: masked ? undefined : event.message.content.slice(0, 140),
                icon: masked ? "/icon-192.png" : face?.src || "/icon-192.png",
                tag: event.room_id,
                data: { url: `/?room=${event.room_id}` },
              },
            ),
          );
        } catch {
          /* Service-worker notifications are best-effort. */
        }
      }
    });

    const unsubInvited = ws.on("room_invited", (data: WsEventPayload) => {
      const event = data as unknown as RoomInvitedEvent;
      // Invites are always notable — sound cue regardless of the toast pref
      // (playCue gates on soundCues itself).
      playCue("notify");
      if (loadPrefs().inAppToasts) {
        pushToast({
          title: "You were added to a room",
          body: event.inviter_name
            ? `${event.inviter_name} invited you.`
            : "Click here to open it.",
          roomId: event.room_id,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
    });

    const unsubCallStarted = ws.on("call_started", (data: WsEventPayload) => {
      const event = data as unknown as WsCallStartedEvent;
      if (!event?.room_id || !event?.caller?.id) return;
      // Our own call echoing back — nothing to announce.
      if (event.caller.id === currentUser?.id) return;
      if (event.room_type === "channel") {
        // Channel calls don't RING (too broad an audience for an interruptive
        // banner) — downgrade to the regular toast + notify cue.
        // NOTE: currently UNREACHABLE — the only call_started producer is the
        // DM ring (api/calls.py 400s channels), and channel call starts are
        // announced by the `call_occupancy` handler below instead. Kept as a
        // defensive downgrade against an older/other server; if a channel
        // ring producer ever appears, reconcile with the occupancy toast so
        // one call start cannot announce twice.
        playCue("notify");
        if (loadPrefs().inAppToasts) {
          const masked = maskTransientRoom(event.room_id);
          const face = resolveIdentity({
            id: event.caller.id,
            display_name: event.caller.display_name,
            avatar_url: event.caller.avatar_url,
            participant_type: "human",
          });
          pushToast({
            title: masked ? "Incoming call" : `${event.caller.display_name} started a call`,
            body: masked ? undefined : `in #${event.room_name}`,
            roomId: event.room_id,
            icon: masked ? null : face.src,
          });
        }
        return;
      }
      // dm/group_dm → the ringing banner. The store applies the suppression
      // policy (already in a call, already seen, etc.).
      useIncomingCallStore.getState().ingest(event);
    });

    // CALLER feedback. Without this the caller's card would ring until its
    // own backstop fired, no matter what the callee actually did.
    const settleOutgoingFromResolution = (
      callId: string,
      state: string,
      byName?: string | null,
    ) => {
      const who = byName || "They";
      const settle = useOutgoingCallStore.getState().settle;
      switch (state) {
        case "accepted":
          settle("accepted", `${who} answered.`, { callId });
          playCue("call-join");
          break;
        case "declined":
          settle("declined", `${who} declined the call.`, { callId });
          playCue("notify");
          break;
        case "timeout":
          settle("no_answer", "They didn't pick up.", { callId });
          break;
        case "canceled":
          settle("canceled", "The call was cancelled.", { callId });
          break;
        default:
          break;
      }
    };

    const unsubRingState = ws.on("call_ring_state", (data: WsEventPayload) => {
      const e = data as unknown as WsCallRingStateEvent;
      if (!e?.call_id || !e?.state) return;
      settleOutgoingFromResolution(
        String(e.call_id),
        e.state,
        e.by?.display_name,
      );
    });

    // CALLEE side, EVERY device of this identity: the call is over, whoever
    // ended it. This is what makes "answer on the phone, laptop stops ringing"
    // work — both sockets subscribe to the same `user:{id}` Redis channel.
    // ALSO delivered to the CALLER (server dual-publish) as a backup for
    // call_ring_state — settle is idempotent once the phase is terminal.
    const unsubCallResolved = ws.on("call_resolved", (data: WsEventPayload) => {
      const e = data as unknown as WsCallResolvedEvent;
      if (!e?.call_id) return;
      useIncomingCallStore.getState().resolve(String(e.call_id));
      if (e.reason) {
        settleOutgoingFromResolution(String(e.call_id), e.reason, null);
      }
    });

    // Room-scoped occupancy nudges from the LiveKit webhook — the realtime
    // half of the shared live-calls source of truth (useLiveCalls owns the
    // 30s poll half). ONE listener app-wide: it patches the shared query
    // cache, so the sidebar badges, the in-room banner and Home all move
    // together, immediately, with no per-surface polling. This event is a
    // FACT, not an offer — it must never touch the incoming-call store.
    const unsubCallOccupancy = ws.on("call_occupancy", (data: WsEventPayload) => {
      const e = data as unknown as WsCallOccupancyEvent;
      if (!e?.room_id || typeof e.participant_count !== "number") return;
      const key = homeSummaryQueryKey(
        useFederationStore.getState().activeInstanceId,
      );
      const cached = queryClient.getQueryData<HomeSummary>(key);

      // The cross-room "a call started" toast (only a JOIN by the FIRST
      // participant of a room the cache didn't list as live qualifies —
      // never the poll, never a mid-call join, never a webhook retry).
      // Decided BEFORE the cache patch, against what we believed until now.
      const app = useAppStore.getState();
      const toastable = shouldToastCallStart({
        freshStart: isFreshCallStart(cached?.live_calls, e),
        roomId: e.room_id,
        byParticipantId: e.by?.id ?? null,
        selfParticipantId: app.currentParticipantId,
        selfUserId: app.currentUser?.id ?? null,
        connectedCallRoomId: app.voiceActive
          ? useCallUiStore.getState().activeCallRoomId
          : null,
        viewingRoomId: app.activeRoomId,
        documentVisible: document.visibilityState === "visible",
        ringingRoomId: useIncomingCallStore.getState().call?.roomId ?? null,
        notifyLevel: getNotifyLevel(e.room_id),
      });
      if (e.participant_count === 0) announcedStarts.current.delete(e.room_id);
      if (toastable && !announcedStarts.current.has(e.room_id)) {
        announcedStarts.current.add(e.room_id);
        playCue("notify");
        if (loadPrefs().inAppToasts) {
          const who = e.by?.display_name || "Someone";
          const room = e.room_name || "a room";
          const masked = maskTransientRoom(e.room_id);
          pushToast({
            title: masked ? "Incoming call" : `${who} started a call`,
            body: masked
              ? undefined
              : `in ${e.room_type === "channel" ? `#${room}` : room} — tap to open and join`,
            roomId: e.room_id,
          });
        }
      }

      // Patch the shared cache from the event itself (it carries the full
      // entry), so every consumer updates without a refetch round-trip. If no
      // summary has landed yet there is nothing to patch — inventing one
      // would hand Home's other widgets fake-empty data; the first poll is
      // already in flight and will carry this room.
      if (cached) {
        queryClient.setQueryData<HomeSummary>(key, {
          ...cached,
          live_calls: applyOccupancyEvent(cached.live_calls ?? [], e),
        });
      }
    });

    // Occupancy nudges are lossy across a socket gap. On every RE-connect,
    // refetch the shared summary so a call that started or ended while we
    // were offline is reflected promptly instead of at the next 30s poll.
    // The first connection of the app's life skips it — the initial fetch is
    // the same request.
    let occupancySynced = ws.connected;
    const unsubOccupancyResync = ws.on("connected", () => {
      if (occupancySynced) {
        void queryClient.invalidateQueries({ queryKey: ["home-summary"] });
      }
      occupancySynced = true;
    });

    const unsubRead = ws.on("read_receipt", (data: WsEventPayload) => {
      const e = data as unknown as {
        room_id: string;
        participant_id: string;
        at: string;
      };
      if (!e?.room_id || !e?.participant_id) return;
      useAppStore.getState().setReadReceipt(e.room_id, e.participant_id, e.at);
    });

    const unsubMsgUpdate = ws.on("message_updated", (data: WsEventPayload) => {
      const e = data as unknown as {
        message_id: string;
        room_id: string;
        content: string;
        finalize?: boolean;
      };
      if (!e?.message_id || !e?.room_id) return;
      useAppStore.getState().updateMessage(e.room_id, e.message_id, {
        content: e.content,
      });
    });

    // A GENUINE agent-working signal, emitted by the backend around the actual
    // Brigade call (services/agent_chat_responder.py). It is recorded per agent
    // in its own store slice — not smuggled into the human `typing` list — so
    // the UI can name exactly which agent is working, and an agent is never
    // conflated with a person who is typing.
    const unsubAgentTyping = ws.on("agent_typing", (data: WsEventPayload) => {
      const e = data as unknown as {
        room_id: string;
        brigade_agent_id: string;
        typing: boolean;
        agent_label?: string | null;
        participant_id?: string | null;
      };
      if (!e?.room_id || !e?.brigade_agent_id) return;
      const store = useAppStore.getState();
      if (!e.typing) {
        store.clearAgentActivity(e.room_id, e.brigade_agent_id);
        return;
      }
      // Prefer the server-supplied display name; fall back to prettifying the
      // agent id so an older backend still names someone rather than nobody.
      const label =
        e.agent_label ||
        e.brigade_agent_id
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
      // Client-side backstop: if the matching typing=false is never delivered
      // (worker crash, dropped frame) this row expires on its own.
      const timeout = setTimeout(() => {
        useAppStore
          .getState()
          .clearAgentActivity(e.room_id, e.brigade_agent_id);
      }, AGENT_THINKING_MAX_MS);
      store.setAgentActivity(e.room_id, {
        agent_id: e.brigade_agent_id,
        label,
        kind: "thinking",
        participant_id: e.participant_id ?? null,
        since: Date.now(),
        timeout,
      });
    });

    // Gateway/bridge agents have no thinking signal — they are external
    // processes that poll. The backend therefore reports the only observable
    // fact: a message is sitting UNCOLLECTED by that bridge. Cleared as soon as
    // the bridge reads or posts, and expired locally if that event is missed.
    const unsubAgentRelay = ws.on("agent_relay", (data: WsEventPayload) => {
      const e = data as unknown as {
        room_id: string;
        agent_id: string;
        pending: boolean;
        agent_label?: string | null;
        participant_id?: string | null;
        ttl_seconds?: number | null;
      };
      if (!e?.room_id || !e?.agent_id) return;
      const store = useAppStore.getState();
      if (!e.pending) {
        store.clearAgentActivity(e.room_id, e.agent_id);
        return;
      }
      const label =
        e.agent_label ||
        e.agent_id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      // Mirror the server's TTL locally so both sides expire together.
      const ttlMs = Math.min(
        Math.max((e.ttl_seconds ?? 300) * 1000, 10_000),
        AGENT_RELAY_MAX_MS,
      );
      const timeout = setTimeout(() => {
        useAppStore.getState().clearAgentActivity(e.room_id, e.agent_id);
      }, ttlMs);
      store.setAgentActivity(e.room_id, {
        agent_id: e.agent_id,
        label,
        kind: "relay",
        participant_id: e.participant_id ?? null,
        since: Date.now(),
        timeout,
      });
    });

    // If the socket drops we can no longer hear the clearing events, so every
    // asserted agent state becomes unverifiable. Drop them all rather than keep
    // claiming work is happening across a gap we cannot see.
    const unsubAgentStatusReset = ws.on("disconnected", () => {
      useAppStore.getState().clearAllAgentActivity();
    });

    const unsubReaction = ws.on("message_reaction", (data: WsEventPayload) => {
      const event = data as unknown as {
        message_id: string;
        room_id: string;
        reactions: Record<string, string[]>;
      };
      if (!event?.message_id || !event?.room_id) return;
      const updateMessage = useAppStore.getState().updateMessage;
      const room = useAppStore.getState().messages[event.room_id];
      const existing = room?.items.find((m) => m.id === event.message_id);
      const oldMeta =
        (existing?.metadata as Record<string, unknown> | undefined) ?? {};
      updateMessage(event.room_id, event.message_id, {
        metadata: { ...oldMeta, reactions: event.reactions },
      });
    });

    const unsubThread = ws.on("thread_created", (data: WsEventPayload) => {
      const event = data as unknown as ThreadCreatedEvent;
      if (!event?.room_id || !event.parent_room_id) return;
      const state = useAppStore.getState();
      const parent = state.rooms.find((r) => r.id === event.parent_room_id);
      const stub = threadStubFromEvent(event, parent);
      state.setRooms(noteThreadOnParent(state.rooms, event.parent_room_id, stub));
      void api.getRoom(event.room_id).then((room) => {
        useAppStore.getState().upsertRoom({
          ...room,
          parent_room_id: room.parent_room_id ?? event.parent_room_id,
          display_name: room.display_name || event.display_name || room.name,
        });
      }).catch(() => {
        /* The stub already put the row on screen. */
      });
    });

    const unsubVisibility = ws.on("room_visibility", (data: WsEventPayload) => {
      const event = data as unknown as { room_id?: string; visibility?: "public" | "private" };
      if (!event?.room_id || !event.visibility) return;
      useAppStore.getState().updateRoom(event.room_id, { visibility: event.visibility });
    });

    const unsubInvite = ws.on("invite_created", (data: WsEventPayload) => {
      const event = data as unknown as { room_id?: string; token_prefix?: string; role?: string };
      if (!event?.room_id) return;
      const id = `${event.room_id}:${event.token_prefix ?? "invite"}`;
      useConversationUi.getState().noteInvite({
        id,
        roomId: event.room_id,
        label: `Pending invite · ${event.token_prefix ?? event.role ?? "link"}`,
        at: Date.now(),
      });
      if (loadPrefs().inAppToasts) {
        pushToast({
          title: "Invite link is live",
          body: "It is waiting in the sidebar until you dismiss it.",
          roomId: event.room_id,
        });
      }
    });

    const unsubMode = ws.on("member_mode", (data: WsEventPayload) => {
      const event = data as unknown as {
        room_id?: string;
        participant_id?: string;
        agent_mode?: string | null;
      };
      if (!event?.room_id || !event.participant_id) return;
      const roster = useAppStore.getState().participants[event.room_id];
      if (!roster) return;
      useAppStore.getState().setParticipants(
        event.room_id,
        roster.map((member) =>
          (member.participant_id || member.user_id) === event.participant_id
            ? { ...member, agent_mode: event.agent_mode as typeof member.agent_mode }
            : member,
        ),
      );
    });

    return () => {
      unsubMessage();
      unsubThread();
      unsubVisibility();
      unsubInvite();
      unsubMode();
      unsubInvited();
      unsubCallStarted();
      unsubRingState();
      unsubCallResolved();
      unsubCallOccupancy();
      unsubOccupancyResync();
      unsubReaction();
      unsubRead();
      unsubMsgUpdate();
      unsubAgentTyping();
      unsubAgentRelay();
      unsubAgentStatusReset();
    };
  }, [
    currentUser?.id,
    currentUser?.username,
    activeRoomId,
    rooms,
    incrementUnread,
    markMentionUnread,
    pushToast,
    queryClient,
  ]);
}
