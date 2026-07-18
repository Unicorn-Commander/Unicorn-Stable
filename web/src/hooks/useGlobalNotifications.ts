import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/stores/appStore";
import { useIncomingCallStore } from "@/stores/incomingCallStore";
import {
  ws,
  WsCallStartedEvent,
  WsEventPayload,
  WsMessageEvent,
} from "@/services/websocket";
import { loadPrefs } from "@/components/Layout/SettingsModal";
import { getNotifyLevel } from "@/utils/mute";
import { playCue } from "@/lib/sounds";
import { ensurePushSubscription } from "@/lib/webpush";

/**
 * Does this message @-mention the current user? Matches @here / @channel
 * (broad) or @<username> (word-boundary, case-insensitive). Used to gate
 * pings for rooms set to the "mentions only" notification level.
 */
function messageMentionsUser(
  content: string | undefined,
  username: string | undefined,
): boolean {
  if (!content) return false;
  if (/@channel\b|@here\b/i.test(content)) return true;
  if (!username) return false;
  const esc = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${esc}\\b`, "i").test(content);
}

interface RoomInvitedEvent {
  room_id: string;
  inviter_name: string | null;
}

/**
 * Global WebSocket listeners: unread counts, toasts, and invite refreshes.
 * Mounted once at the app shell level so it runs regardless of active room.
 */
export function useGlobalNotifications() {
  const currentUser = useAppStore((s) => s.currentUser);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const incrementUnread = useAppStore((s) => s.incrementUnread);
  const pushToast = useAppStore((s) => s.pushToast);
  const rooms = useAppStore((s) => s.rooms);
  const queryClient = useQueryClient();

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

      // Ignore messages from self (for unread/toast purposes)
      if (event.message.sender_id && event.message.sender_id === currentUser?.id) {
        return;
      }

      // Don't increment for the room that's currently open (user is seeing it)
      if (event.room_id === activeRoomId && document.visibilityState === "visible") {
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

      // For "mentions only" rooms, a ping requires the message to mention us.
      const mentionOk =
        level === "all" ||
        messageMentionsUser(event.message.content, currentUser?.username);

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
        pushToast({
          title: `${event.message.sender_name} in ${room?.name ?? "a room"}`,
          body: event.message.content.slice(0, 120),
          roomId: event.room_id,
        });
      }

      // Backgrounded tab: the in-app toast is invisible, so surface a real OS
      // notification when the user has granted permission. Best-effort — the
      // installed-PWA / closed-app (web-push) path is a separate build.
      if (
        shouldNotify &&
        document.hidden &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        const room = rooms.find((r) => r.id === event.room_id);
        try {
          const n = new Notification(
            `${event.message.sender_name} in ${room?.name ?? "a room"}`,
            {
              body: event.message.content.slice(0, 140),
              icon: "/icon-192.png",
              tag: event.room_id,
            },
          );
          n.onclick = () => {
            window.focus();
            n.close();
          };
        } catch {
          /* Notification constructor throws on some mobile browsers */
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
          title: "You were added to a channel",
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
        playCue("notify");
        if (loadPrefs().inAppToasts) {
          pushToast({
            title: `${event.caller.display_name} started a call`,
            body: `in #${event.room_name}`,
            roomId: event.room_id,
          });
        }
        return;
      }
      // dm/group_dm → the ringing banner. The store applies the suppression
      // policy (already in a call, already seen, etc.).
      useIncomingCallStore.getState().ingest(event);
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

    const unsubAgentTyping = ws.on("agent_typing", (data: WsEventPayload) => {
      const e = data as unknown as {
        room_id: string;
        brigade_agent_id: string;
        typing: boolean;
      };
      if (!e?.room_id || !e?.brigade_agent_id) return;
      const display = e.brigade_agent_id
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      const fakeUser = `agent:${e.brigade_agent_id}`;
      const store = useAppStore.getState();
      if (e.typing) {
        // Use the existing typing system. timeout is required by TypingUser.
        const timeout = setTimeout(() => {
          useAppStore.getState().removeTypingUser(e.room_id, fakeUser);
        }, 60_000);
        store.addTypingUser(e.room_id, {
          user_id: fakeUser,
          username: display,
          timeout,
        });
      } else {
        store.removeTypingUser(e.room_id, fakeUser);
      }
    });

    const unsubReaction = ws.on(
      "message_reaction",
      (data: WsEventPayload) => {
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
      },
    );

    return () => {
      unsubMessage();
      unsubInvited();
      unsubCallStarted();
      unsubReaction();
      unsubRead();
      unsubMsgUpdate();
      unsubAgentTyping();
    };
  }, [
    currentUser?.id,
    activeRoomId,
    rooms,
    incrementUnread,
    pushToast,
    queryClient,
  ]);
}
