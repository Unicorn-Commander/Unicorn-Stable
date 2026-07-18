import { create } from "zustand";
import type { WsCallStartedEvent } from "@/services/websocket";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";

/**
 * Incoming-call ringing state — a SINGLE slot holding the call currently being
 * offered to the user (the IncomingCallBanner renders it). Kept out of the big
 * {@link useAppStore} for the same reason as callUiStore: the ringing surface
 * is its own small concern and nothing else should re-render on it.
 *
 * A newer incoming call replaces an older one (one banner, most recent wins).
 * `ingest` applies the suppression policy for RINGING:
 *   - never ring for a call the user started themselves,
 *   - never ring while the user is already in a live call,
 *   - never ring for the room the user is currently looking at when that
 *     room's call UI is already on screen,
 *   - never RE-ring the same call (room + started_at) this session, even
 *     after a dismiss/timeout — the seen-keys set below is the latch.
 * (Channel calls never reach this store — the global notification hook downgrades
 * them to a toast.)
 */

export interface IncomingCall {
  roomId: string;
  roomType: "dm" | "group_dm" | "channel";
  roomName: string;
  callerId: string;
  callerName: string;
  startedAt: string;
}

/** Calls (roomId:startedAt) already offered this session — never ring twice. */
const seenCallKeys = new Set<string>();

interface IncomingCallState {
  call: IncomingCall | null;
  ingest: (event: WsCallStartedEvent) => void;
  dismiss: () => void;
}

export const useIncomingCallStore = create<IncomingCallState>((set) => ({
  call: null,

  ingest: (event) => {
    const key = `${event.room_id}:${event.started_at}`;
    if (seenCallKeys.has(key)) return;

    const app = useAppStore.getState();
    // Our own call echoing back — nothing to answer.
    if (app.currentUser && event.caller.id === app.currentUser.id) return;
    // Already in a live call — don't ring over it.
    if (app.voiceActive) return;
    // Looking at the room whose call UI is already on screen — redundant ring.
    // (Subsumed by the in-call check today — the call surface only renders for
    // the call you're in — but kept explicit so the policy survives a future
    // lurk-mode call bar.)
    const callUi = useCallUiStore.getState();
    if (
      event.room_id === app.activeRoomId &&
      callUi.activeCallRoomId === event.room_id
    ) {
      return;
    }

    seenCallKeys.add(key);
    set({
      call: {
        roomId: event.room_id,
        roomType: event.room_type,
        roomName: event.room_name,
        callerId: event.caller.id,
        callerName: event.caller.display_name,
        startedAt: event.started_at,
      },
    });
  },

  dismiss: () => set({ call: null }),
}));
