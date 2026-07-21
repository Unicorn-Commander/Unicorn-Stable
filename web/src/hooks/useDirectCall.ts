import { useCallback } from "react";
import { api, type ApiError } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useVoice } from "@/contexts/VoiceProvider";
import { useOutgoingCallStore } from "@/stores/outgoingCallStore";

/**
 * The single seam for STARTING a call.
 *
 * Two shapes of "start a call" used to be one shape:
 *   * a CHANNEL call is an open door — you walk in, and anyone who cares is
 *     told by a toast. Nothing rings. Fifty people do not get an interruptive
 *     banner because one of them clicked a phone icon.
 *   * a DM call is a CALL — a named person is rung on every device they have
 *     open, and the caller is told what happened.
 *
 * Both used to do the same thing (`VoiceProvider.connect()`), which is why
 * nobody has ever been rung. This hook keeps `connect()` as the channel path
 * untouched and routes DMs through POST /rooms/{id}/call/ring first.
 *
 * NOTE on `connect()`: it reads `activeRoomId` from the app store, not an
 * argument. Both call sites (Header, MessageInput) act on the room in view, so
 * that holds — but it is why `startCall` takes the room id only to decide
 * POLICY and never to pick the LiveKit room.
 */
export function useDirectCall() {
  const { connect } = useVoice();

  const startCall = useCallback(
    async (roomId: string) => {
      const state = useAppStore.getState();
      const room = state.rooms.find((r) => r.id === roomId);
      const roomType = room?.type ?? "channel";

      // Channels keep their existing behaviour exactly: join, no ring.
      if (roomType === "channel") {
        await connect();
        return;
      }

      const out = useOutgoingCallStore.getState();
      const label = room?.name || "them";

      try {
        const res = await api.ringRoom(roomId);

        if (res.state !== "ringing") {
          // Nobody was rung. Say WHY, per person, and do not join an empty
          // room — a caller alone in a LiveKit room with no explanation is
          // the exact "staring at nothing" failure.
          const offline = res.targets.filter((t) => t.state === "offline");
          const busy = res.targets.filter((t) => t.state === "busy");
          const phase = busy.length > 0 ? "busy" : "offline";
          const detail =
            busy.length > 0
              ? `${busy.map((t) => t.display_name).join(", ")} is already on a call.`
              : `${offline.map((t) => t.display_name).join(", ") || label} isn't online right now.`;
          out.showOutcome({
            callId: null,
            roomId,
            label,
            phase,
            detail,
            targets: res.targets,
            expiresAt: null,
          });
          return;
        }

        // "unknown" means presence could not be READ — we rang anyway, and we
        // say so rather than promising a ring we can't confirm.
        const uncertain = res.targets.filter((t) => t.state === "unknown");
        const detail =
          uncertain.length > 0
            ? `Ringing ${label}… (couldn't confirm they're online)`
            : `Ringing ${label}…`;

        out.ring({
          callId: res.call_id,
          roomId,
          label,
          detail,
          targets: res.targets,
          expiresAt: res.expires_at,
        });

        // Join our own room so we're already there when they pick up.
        await connect();
      } catch (err) {
        const e = err as ApiError;
        out.showOutcome({
          callId: null,
          roomId,
          label,
          phase: "failed",
          detail:
            e?.detail ||
            (e?.status === 403
              ? "You're not a member of this conversation."
              : "Couldn't start the call. Check your connection."),
          targets: [],
          expiresAt: null,
        });
      }
    },
    [connect],
  );

  return { startCall };
}
