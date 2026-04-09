import { useEffect, useCallback, useRef } from "react";
import { ws } from "@/services/websocket";
import type { WsTypingEvent, WsPresenceEvent, WsEventPayload } from "@/services/websocket";
import { useAppStore } from "@/stores/appStore";

const TYPING_TIMEOUT_MS = 3000;
const TYPING_SEND_THROTTLE_MS = 2000;

interface UsePresenceReturn {
  typingUsers: Array<{ user_id: string; username: string }>;
  sendTypingIndicator: () => void;
  isUserOnline: (userId: string) => boolean;
}

export function usePresence(roomId: string | null): UsePresenceReturn {
  const typing = useAppStore((s) => (roomId ? (s.typing[roomId] ?? []) : []));
  const addTypingUser = useAppStore((s) => s.addTypingUser);
  const removeTypingUser = useAppStore((s) => s.removeTypingUser);
  const addOnlineUser = useAppStore((s) => s.addOnlineUser);
  const removeOnlineUser = useAppStore((s) => s.removeOnlineUser);
  const updateParticipantOnline = useAppStore((s) => s.updateParticipantOnline);
  const onlineUsers = useAppStore((s) => s.onlineUsers);
  const currentUser = useAppStore((s) => s.currentUser);
  const lastTypingSent = useRef(0);

  useEffect(() => {
    if (!roomId) return;

    const unsubTyping = ws.on("typing", (data: WsEventPayload) => {
      const event = data as WsTypingEvent;
      if (event.room_id !== roomId) return;
      if (event.user_id === currentUser?.id) return;

      if (event.is_typing) {
        const timeout = setTimeout(() => {
          removeTypingUser(roomId, event.user_id);
        }, TYPING_TIMEOUT_MS);

        addTypingUser(roomId, {
          user_id: event.user_id,
          username: event.username,
          timeout,
        });
      } else {
        removeTypingUser(roomId, event.user_id);
      }
    });

    const unsubPresence = ws.on("presence", (data: WsEventPayload) => {
      const event = data as WsPresenceEvent;
      if (event.is_online) {
        addOnlineUser(event.user_id);
      } else {
        removeOnlineUser(event.user_id);
      }
      updateParticipantOnline(event.user_id, event.is_online);
    });

    return () => {
      unsubTyping();
      unsubPresence();
    };
  }, [
    roomId,
    currentUser?.id,
    addTypingUser,
    removeTypingUser,
    addOnlineUser,
    removeOnlineUser,
    updateParticipantOnline,
  ]);

  const sendTypingIndicator = useCallback(() => {
    if (!roomId) return;

    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_SEND_THROTTLE_MS) return;

    lastTypingSent.current = now;
    ws.send("typing", {
      room_id: roomId,
      is_typing: true,
    });
  }, [roomId]);

  const isUserOnline = useCallback(
    (userId: string) => onlineUsers.has(userId),
    [onlineUsers],
  );

  const typingUsers = typing.map((t) => ({
    user_id: t.user_id,
    username: t.username,
  }));

  return {
    typingUsers,
    sendTypingIndicator,
    isUserOnline,
  };
}
