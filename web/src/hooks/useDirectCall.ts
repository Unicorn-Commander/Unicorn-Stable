import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/services/api";
import {
  residentAgentIds,
  type VoiceCanonicalRoom,
} from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useVoice, type ConnectOptions } from "@/contexts/VoiceProvider";
import { useOutgoingCallStore } from "@/stores/outgoingCallStore";
import { runStartCall } from "@/lib/directCall";
import {
  autoStartKind,
  shouldAutoStartRecording,
  userMayRecord,
} from "@/lib/recording";
import { loadRecordMyCalls } from "@/lib/recordMyCalls";

/**
 * The single seam for STARTING a call.
 *
 * Two shapes of "start a call":
 *   * a CHANNEL call is an open door — you walk in, and anyone who cares is
 *     told by a toast. Nothing rings.
 *   * a DM / group-DM call is a CALL — the other human(s) are rung on every
 *     device they have open, and the caller is told what happened.
 *
 * ORDER MATTERS and is pinned by `lib/directCall.test.ts`: connect first
 * (device check, or straight in when the "join immediately" preference / a
 * deep link says so), ring only once we are actually on the line. The old
 * order — ring, THEN open the device dialog — is why "when I dial in it keeps
 * calling": the callee rang and the caller's card pulsed while the caller
 * was still choosing a mic, and cancelling the dialog rang on regardless.
 *
 * NOTE on `connect()`: it reads `activeRoomId` from the app store, not an
 * argument. Every call site acts on the room in view, so that holds — it is
 * why `startCall` takes the room id only to decide POLICY and never to pick
 * the LiveKit room.
 */
export interface StartCallOptions extends ConnectOptions {
  /** DM / group DM only: false joins silently (deep link `ring=0`). */
  ring?: boolean;
}

export type CanonicalCallTarget = VoiceCanonicalRoom;

export function useDirectCall() {
  const {
    connect,
    disconnect,
    showRunnerVoiceCanonicalOnly,
    clearRunnerVoiceCanonicalOnly,
  } = useVoice();
  const navigate = useNavigate();

  const startCall = useCallback(
    async (roomId: string, opts?: StartCallOptions) => {
      const state = useAppStore.getState();
      const room = state.rooms.find((r) => r.id === roomId);
      const out = useOutgoingCallStore.getState();
      const { ring, ...connectOpts } = opts ?? {};
      const result = await runStartCall(
        {
          roomId,
          // A hub is a 1:1 with an agent: same ring policy as a DM.
          roomType:
            room?.type === "group_dm"
              ? "group_dm"
              : room?.type === "dm" || room?.type === "agent_hub"
                ? "dm"
                : "channel",
          hasAgents: residentAgentIds(room).length > 0,
          label: room?.name || "them",
          ring,
        },
        {
          connect: () => connect(connectOpts),
          ringRoom: (id) => api.ringRoom(id),
          ring: out.ring,
          showOutcome: out.showOutcome,
          disconnect,
          showRunnerVoiceCanonicalOnly,
        },
      );
      if (
        shouldAutoStartRecording({
          recordMyCalls: loadRecordMyCalls(),
          entitled: userMayRecord(useAppStore.getState().currentUser?.roles),
          policy: room?.recording_policy,
          callResult: result,
        })
      ) {
        // Ask + "record calls I start". A 409 (L8s not wired, or already
        // recording) stays quiet — the pill arrives on recording_state.
        void api
          .startRecording(roomId, autoStartKind(room?.recording_kind))
          .catch(() => {});
      }
      return result;
    },
    [connect, disconnect, showRunnerVoiceCanonicalOnly],
  );

  /**
   * Open a server-resolved canonical runner room through the same deep-link
   * call-start path used by native controls. `ring=0` is intentional: the
   * runner gateway is already attached to its canonical room and has no phone
   * endpoint to ring.
   */
  const startCanonicalCall = useCallback(
    async (target: CanonicalCallTarget, kind: "voice" | "video" = "voice") => {
      clearRunnerVoiceCanonicalOnly();
      let room = useAppStore.getState().rooms.find((item) => item.id === target.id);
      if (!room) {
        try {
          room = await api.getRoom(target.id);
          useAppStore.getState().upsertRoom(room);
        } catch (error) {
          const detail = (error as { detail?: unknown } | null)?.detail;
          useAppStore.getState().pushToast({
            title: "Couldn't open the call room",
            body: typeof detail === "string" ? detail : "The canonical room could not be loaded.",
            kind: "error",
          });
          return;
        }
      }
      navigate(`/c/${room.id}?join=1&kind=${kind}&ring=0`);
    },
    [clearRunnerVoiceCanonicalOnly, navigate],
  );

  return { startCall, startCanonicalCall };
}
