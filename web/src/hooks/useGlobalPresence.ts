import { useEffect } from "react";
import { ws, type WsEventPayload, type WsPresenceEvent } from "@/services/websocket";
import { usePresenceStore } from "@/stores/presenceStore";

/**
 * Wire instance-scoped presence fanout into presenceStore.
 *
 * Mount once at the app shell (alongside useGlobalNotifications) so directory
 * / People UIs receive online/offline for everyone on this server without
 * sharing a room. Room-scoped presence continues to flow through usePresence.
 */
export function useGlobalPresence(): void {
  useEffect(() => {
    const apply = (data: WsEventPayload): void => {
      const event = data as WsPresenceEvent;
      const id = event.participant_id ?? event.user_id;
      if (!id) return;
      const online =
        typeof event.is_online === "boolean"
          ? event.is_online
          : event.status === "online";
      usePresenceStore.getState().applyEvent(id, online);
    };

    // Instance channel and room channels both emit type "presence" with the
    // same payload shape. Applying both is idempotent and keeps the global
    // store current even if only room-scoped events arrive (older servers).
    const unsubPresence = ws.on("presence", apply);

    // A dropped socket means every live claim may be stale. We do NOT wipe
    // the store here: directory snapshot + reconnect re-publish will correct
    // it, and clearing would flash everyone offline on a blip. Federation
    // switch is the hard wipe (presenceStore.reset in switchInstance).
    return () => {
      unsubPresence();
    };
  }, []);
}
