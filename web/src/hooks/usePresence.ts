import { useEffect, useCallback, useRef, useMemo } from "react";
import { ws } from "@/services/websocket";
import type { WsTypingEvent, WsPresenceEvent, WsEventPayload } from "@/services/websocket";
import { useAppStore, type TypingUser } from "@/stores/appStore";
import { EMPTY_MEMBERS } from "@/stores/selectors";

/**
 * Typing timings, and why each one is what it is.
 *
 * The server holds a typing key for TYPING_TTL (5s) and re-broadcasts at most
 * once a second per room. Our keepalive has to sit comfortably inside the
 * server's TTL so a continuously-typing person never flickers, and comfortably
 * outside the server's floor so our own keepalives are not silently thrown
 * away. 2s is in that gap — and it is a keepalive, not a per-keystroke event:
 * a fast typist at 300 keystrokes/min puts 30 frames/min on the wire, not 300.
 *
 * IDLE_STOP is how long after the last keystroke we declare you done and send
 * an explicit stop. Short enough that a stale row doesn't linger, long enough
 * to survive a pause for thought mid-sentence.
 *
 * EXPIRY_FALLBACK is the LAST-RESORT client backstop for a row we were told
 * about but never told to clear (sender's tab killed mid-word, socket dropped
 * with no close frame). The server's own TTL is the real answer and rides on
 * the wire as `ttl_seconds`; this only applies when that is absent.
 */
const TYPING_KEEPALIVE_MS = 2000;
const TYPING_IDLE_STOP_MS = 3500;
const TYPING_EXPIRY_FALLBACK_MS = 6000;

const EMPTY_TYPING: TypingUser[] = [];

interface UsePresenceReturn {
  typingUsers: Array<{ user_id: string; username: string }>;
  /** Call on every keystroke — throttled internally, safe to spam. */
  sendTypingIndicator: () => void;
  /** Retract immediately: on send, on composer blur, on room switch. */
  clearTypingIndicator: () => void;
  isUserOnline: (userId: string) => boolean;
}

export function usePresence(roomId: string | null): UsePresenceReturn {
  const typing = useAppStore((s) => (roomId ? (s.typing[roomId] ?? EMPTY_TYPING) : EMPTY_TYPING));
  const addTypingUser = useAppStore((s) => s.addTypingUser);
  const removeTypingUser = useAppStore((s) => s.removeTypingUser);
  const addOnlineUser = useAppStore((s) => s.addOnlineUser);
  const removeOnlineUser = useAppStore((s) => s.removeOnlineUser);
  const updateParticipantOnline = useAppStore((s) => s.updateParticipantOnline);
  const onlineUsers = useAppStore((s) => s.onlineUsers);
  const currentUser = useAppStore((s) => s.currentUser);

  // "Which of these member rows is me."
  //
  // NOT currentUser.id: that is the Keycloak subject, while the server keys
  // rooms on the Participant UUID, and the two are never equal — which is why
  // the old `event.user_id === currentUser?.id` self-check could not match and
  // never once suppressed an echo. `is_self` is the server-set marker for
  // exactly this (the moderation UI resolves "me" the same way). The server
  // also drops self-echoes before they reach this socket; this is the second
  // belt, for a rolling deploy where the other end is still the old backend.
  const myParticipantId = useAppStore(
    (s) =>
      (roomId ? (s.participants[roomId] ?? EMPTY_MEMBERS) : EMPTY_MEMBERS).find(
        (m) => m.is_self,
      )?.participant_id ?? null,
  );

  /** Last keepalive we actually put on the wire, for throttling. */
  const lastSentAt = useRef(0);
  /** True while we are asserting "I am typing" to the server and therefore owe
   *  it a stop. This is what makes clearing idempotent: retracting when we
   *  never started is a no-op, so every clearing path can fire unconditionally
   *  without first checking whether it needs to. */
  const isAssertingRef = useRef(false);
  /** Fires an explicit stop once the keystrokes dry up. */
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The room we are asserting in — a room switch has to retract the OLD room,
   *  not whichever one has since rendered. */
  const assertedRoomRef = useRef<string | null>(null);

  const stopAsserting = useCallback((): void => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    const room = assertedRoomRef.current;
    const wasAsserting = isAssertingRef.current;
    isAssertingRef.current = false;
    assertedRoomRef.current = null;
    lastSentAt.current = 0;
    if (wasAsserting && room) {
      ws.send("typing_stop", { room_id: room });
    }
  }, []);

  const clearTypingIndicator = useCallback(() => {
    stopAsserting();
  }, [stopAsserting]);

  const sendTypingIndicator = useCallback(() => {
    if (!roomId) return;

    // Switched rooms mid-assertion: retract there before claiming here, or the
    // old room keeps a row until its TTL lapses.
    if (assertedRoomRef.current && assertedRoomRef.current !== roomId) {
      stopAsserting();
    }

    // Re-arm the idle stop on EVERY keystroke, including throttled ones. The
    // throttle governs bandwidth; the stop governs truthfulness, and the two
    // must not share a clock — otherwise pausing right after a throttled
    // keystroke schedules the stop off a stale timestamp.
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      stopAsserting();
    }, TYPING_IDLE_STOP_MS);

    const now = Date.now();
    if (isAssertingRef.current && now - lastSentAt.current < TYPING_KEEPALIVE_MS) {
      return;
    }

    // Record the assertion only if the frame actually left. A send onto a
    // closed socket must not leave us believing the room knows.
    if (ws.send("typing_start", { room_id: roomId })) {
      lastSentAt.current = now;
      isAssertingRef.current = true;
      assertedRoomRef.current = roomId;
    }
  }, [roomId, stopAsserting]);

  // --- inbound -------------------------------------------------------------

  useEffect(() => {
    if (!roomId) return;

    const unsubTyping = ws.on("typing", (data: WsEventPayload) => {
      const event = data as WsTypingEvent;
      if (event.room_id !== roomId) return;

      const id = event.participant_id ?? event.user_id;
      if (!id) return;

      // Never render yourself.
      if (id === myParticipantId) return;
      if (currentUser?.id && id === currentUser.id) return;

      // Humans only. Agents have their own honest states — real `agent_typing`
      // around a live Brigade call, `agent_relay` for a gateway bridge holding
      // an uncollected message (services/agent_status.py, lib/agentStatus.ts) —
      // and folding an agent into "…is typing" would retell exactly the lie
      // those two states were built to replace. Today's server never emits this
      // for an agent identity; this keeps that true regardless of what does.
      if (event.participant_type === "agent") return;

      if (event.is_typing) {
        // Client-side backstop, sized from the server's own key TTL. If the
        // clearing event is lost (tab killed, socket dropped with no close
        // frame) the row expires by itself rather than asserting forever.
        const ttlMs = event.ttl_seconds
          ? event.ttl_seconds * 1000
          : TYPING_EXPIRY_FALLBACK_MS;
        const timeout = setTimeout(() => {
          removeTypingUser(roomId, id);
        }, ttlMs);

        // addTypingUser replaces any existing row for this user AND clears the
        // superseded row's timer, so repeated keepalives push the expiry out
        // rather than leaking a timer per keepalive.
        addTypingUser(roomId, {
          user_id: id,
          username: event.username || "Someone",
          timeout,
        });
      } else {
        removeTypingUser(roomId, id);
      }
    });

    const unsubPresence = ws.on("presence", (data: WsEventPayload) => {
      const event = data as WsPresenceEvent;
      // Resolve the identity the roster matches on (Participant.id). The server
      // sends it as participant_id (canonical) and mirrors it as user_id —
      // accept either. Older/alt shapes carry a `status` string instead of the
      // is_online boolean — accept both so we reconcile regardless of pairing.
      const id = event.participant_id ?? event.user_id;
      if (!id) return;
      const online =
        typeof event.is_online === "boolean"
          ? event.is_online
          : event.status === "online";
      if (online) {
        addOnlineUser(id);
      } else {
        removeOnlineUser(id);
      }
      updateParticipantOnline(id, online);

      // Someone went offline mid-word. They can never retract their own typing
      // row now, so retract it here instead of waiting out the TTL.
      if (!online) {
        removeTypingUser(roomId, id);
      }
    });

    // A dropped socket invalidates BOTH directions of this state.
    //
    // Inbound: every row on screen was asserted by a server we can no longer
    // hear from, so any of them may already be stale. We drop them all rather
    // than show state we have no way to refute; a sender who really is still
    // typing reappears within one keepalive of reconnecting.
    //
    // Outbound: our own assertion died with the socket. We reset the local
    // flags WITHOUT sending a stop (there is nothing to send it down), so the
    // first keystroke after a reconnect re-asserts from scratch instead of
    // being swallowed by a throttle that still believes the server knows.
    const unsubDisconnected = ws.on("disconnected", () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      isAssertingRef.current = false;
      assertedRoomRef.current = null;
      lastSentAt.current = 0;
      for (const t of useAppStore.getState().typing[roomId] ?? EMPTY_TYPING) {
        removeTypingUser(roomId, t.user_id);
      }
    });

    return () => {
      unsubTyping();
      unsubPresence();
      unsubDisconnected();
    };
  }, [
    roomId,
    currentUser?.id,
    myParticipantId,
    addTypingUser,
    removeTypingUser,
    addOnlineUser,
    removeOnlineUser,
    updateParticipantOnline,
  ]);

  // Leaving the room (or unmounting the chat entirely) retracts our assertion.
  // Without this, switching rooms mid-word leaves a phantom "…is typing" in the
  // room you just left for the length of the server TTL.
  useEffect(() => {
    return () => {
      stopAsserting();
    };
  }, [roomId, stopAsserting]);

  // Backgrounding the tab, locking the phone, or switching apps is not typing.
  // This matters most on mobile, where a tab is frozen without the composer
  // ever firing blur — the assertion would otherwise sit there until the server
  // TTL lapsed, and `pagehide` is the only teardown iOS Safari reliably gives
  // us at all (it does not fire `unload`).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") stopAsserting();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", stopAsserting);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", stopAsserting);
    };
  }, [stopAsserting]);

  const isUserOnline = useCallback(
    (userId: string) => onlineUsers.includes(userId),
    [onlineUsers],
  );

  const typingUsers = useMemo(
    () => typing.map((t) => ({ user_id: t.user_id, username: t.username })),
    [typing],
  );

  return {
    typingUsers,
    sendTypingIndicator,
    clearTypingIndicator,
    isUserOnline,
  };
}
