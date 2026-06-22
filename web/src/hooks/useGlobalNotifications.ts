import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/stores/appStore";
import { ws, WsEventPayload, WsMessageEvent } from "@/services/websocket";
import { loadPrefs } from "@/components/Layout/SettingsModal";
import { isMuted } from "@/utils/mute";

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

      // Skip muted channels entirely — no badge, no toast
      if (isMuted(event.room_id)) {
        return;
      }

      incrementUnread(event.room_id);

      // Toast only if the room isn't the active one (or tab is hidden)
      if (
        loadPrefs().inAppToasts &&
        (event.room_id !== activeRoomId ||
          document.visibilityState !== "visible")
      ) {
        const room = rooms.find((r) => r.id === event.room_id);
        pushToast({
          title: `${event.message.sender_name} in ${room?.name ?? "a room"}`,
          body: event.message.content.slice(0, 120),
          roomId: event.room_id,
        });
      }
    });

    const unsubInvited = ws.on("room_invited", (data: WsEventPayload) => {
      const event = data as unknown as RoomInvitedEvent;
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
