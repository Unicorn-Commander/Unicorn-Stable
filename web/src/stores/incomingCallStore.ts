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
 *   - never RE-ring the same call this session, even after a dismiss/timeout
 *     — the seen-keys set below is the latch.
 * (Channel calls never reach this store — the global notification hook downgrades
 * them to a toast.)
 *
 * MULTI-DEVICE. `resolve` is the other end of that latch: the server publishes
 * `call_resolved` on `user:{participant_id}`, and EVERY socket that identity
 * has open subscribes to that channel (ws/handler._subscribe_to_rooms), so
 * answering on the phone takes the banner down on the laptop. It is matched on
 * call id and is safe to receive on the device that caused it.
 */

export interface IncomingCall {
  /**
   * Server call id. Required to accept/decline — those are real transitions on
   * a real server-side call, not local dismissals. Older servers (which never
   * emitted this event at all) would omit it; a call with no id degrades to
   * join/dismiss-only rather than showing dead buttons.
   */
  callId: string | null;
  roomId: string;
  roomType: "dm" | "group_dm" | "channel";
  roomName: string;
  callerId: string;
  callerName: string;
  /** Caller's resolved avatar (Stable override → Keycloak picture → null). */
  callerAvatarUrl: string | null;
  startedAt: string;
  /**
   * The SERVER's ring deadline (ISO). The banner's timeout is derived from
   * this rather than from a private client constant, so the two ends cannot
   * disagree about when the call stopped ringing. Null → fall back to the
   * legacy local constant.
   */
  expiresAt: string | null;
}

/** Calls already offered this session — never ring twice for the same one. */
const seenCallKeys = new Set<string>();

interface IncomingCallState {
  call: IncomingCall | null;
  ingest: (event: WsCallStartedEvent) => void;
  /** Take the banner down because the SERVER says this call is over. */
  resolve: (callId: string) => void;
  dismiss: () => void;
}

export const useIncomingCallStore = create<IncomingCallState>((set, get) => ({
  call: null,

  ingest: (event) => {
    // Prefer the server call id as the identity — `started_at` was only ever a
    // stand-in for one. Falls back so an id-less event still de-dupes.
    const key = event.call_id ?? `${event.room_id}:${event.started_at}`;
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
        callId: event.call_id ?? null,
        roomId: event.room_id,
        roomType: event.room_type,
        roomName: event.room_name,
        callerId: event.caller.id,
        callerName: event.caller.display_name,
        callerAvatarUrl: event.caller.avatar_url ?? null,
        startedAt: event.started_at,
        expiresAt: event.expires_at ?? null,
      },
    });
  },

  resolve: (callId) => {
    const cur = get().call;
    if (!cur) return;
    // Only the call actually on screen. A late frame for a previous call must
    // not blank the banner of the one currently ringing.
    if (cur.callId && cur.callId !== callId) return;
    set({ call: null });
  },

  dismiss: () => set({ call: null }),
}));
