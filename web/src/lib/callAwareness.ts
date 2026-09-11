import type { NotifyLevel } from "@/utils/mute";

/**
 * Pure decision logic for ongoing-call awareness.
 *
 * Three surfaces tell the user "a call is live somewhere":
 *   1. the floating CallDock (this DEVICE is connected, viewing another room),
 *   2. the sidebar live badge + in-room banner (a call is live in a room the
 *      user belongs to, this device NOT necessarily connected),
 *   3. the cross-room call-started toast.
 *
 * They must all agree, so every gate is a pure function here — testable
 * without React, LiveKit, or a socket — and the components just render the
 * verdicts. The DATA the gates consume comes from one source of truth: the
 * `live_calls` block of /home/summary held in the shared react-query cache
 * (see hooks/useLiveCalls), nudged by `call_occupancy` WS events.
 */

/** One live call, as reported by /home/summary (server-probed occupancy). */
export interface LiveCallEntry {
  room_id: string;
  display_name: string;
  room_type: string;
  participant_count: number;
  has_agent: boolean;
}

/**
 * Room-scoped occupancy nudge broadcast by the server's LiveKit webhook
 * (`call_occupancy`). `participant_count` is the room's occupancy AFTER the
 * join/leave; `by` names the participant who JOINED (null on leaves), which is
 * what lets the toast suppress your own call starts.
 */
export interface CallOccupancyEvent {
  room_id: string;
  room_type: string;
  room_name: string;
  participant_count: number;
  has_agent?: boolean;
  by?: { id: string | null; display_name: string | null } | null;
}

/** Index a live-calls list by room id (what every row lookup wants). */
export function liveCallsByRoom(
  list: readonly LiveCallEntry[] | undefined,
): Record<string, LiveCallEntry> {
  const out: Record<string, LiveCallEntry> = {};
  for (const entry of list ?? []) out[entry.room_id] = entry;
  return out;
}

/**
 * Fold a `call_occupancy` event into the cached live-calls list.
 *
 * Count >= 1 upserts the room's entry (the event carries everything the entry
 * needs, so a join in a room the poll hasn't seen yet still lights up
 * immediately); count 0 removes it. Pure — returns a new array, never mutates.
 */
export function applyOccupancyEvent(
  list: readonly LiveCallEntry[],
  event: CallOccupancyEvent,
): LiveCallEntry[] {
  const rest = list.filter((c) => c.room_id !== event.room_id);
  if (event.participant_count < 1) return rest;
  const prev = list.find((c) => c.room_id === event.room_id);
  return [
    ...rest,
    {
      room_id: event.room_id,
      display_name: event.room_name || prev?.display_name || "",
      room_type: event.room_type || prev?.room_type || "channel",
      participant_count: event.participant_count,
      has_agent: event.has_agent ?? prev?.has_agent ?? false,
    },
  ];
}

/**
 * Is this event the START of a call, as far as this client can know?
 *
 * Deliberately strict — all three must hold:
 *   - someone JOINED (`by` present; leaves can never start a call),
 *   - they are the FIRST participant (count 1 — a later join is someone
 *     joining an existing call, not a start),
 *   - the cache did not already list the room as live (dedupes a webhook
 *     retry / double delivery).
 *
 * The 30s poll NEVER produces starts: discovering an already-running call on
 * app load must badge the sidebar, not fire a toast for a call that may be an
 * hour old.
 */
export function isFreshCallStart(
  cachedList: readonly LiveCallEntry[] | undefined,
  event: CallOccupancyEvent,
): boolean {
  if (!event.by?.id) return false;
  if (event.participant_count !== 1) return false;
  return !(cachedList ?? []).some((c) => c.room_id === event.room_id);
}

/** Everything the cross-room toast policy needs, already resolved. */
export interface CallStartToastArgs {
  /** Verdict of {@link isFreshCallStart} for this event. */
  freshStart: boolean;
  roomId: string;
  /** Who joined (participant-id space), null when the server couldn't name them. */
  byParticipantId: string | null;
  /** Our own PARTICIPANT id (from the ws auth_ok ack) — the id space `by` uses. */
  selfParticipantId: string | null;
  /** Keycloak id, kept as a harmless fallback comparison (never matches `by`
   * on a current server, but a defensive equal-means-self is free). */
  selfUserId: string | null;
  /** The room this device's live call is in (null when not on a call). */
  connectedCallRoomId: string | null;
  /** The room currently on screen. */
  viewingRoomId: string | null;
  /** document.visibilityState === "visible". */
  documentVisible: boolean;
  /** Room the incoming-call (ringing) banner is currently up for, if any. */
  ringingRoomId: string | null;
  /** Per-room notification level (utils/mute.ts). */
  notifyLevel: NotifyLevel;
}

/**
 * Cross-room "a call started" toast policy.
 *
 * No toast for: non-starts; calls YOU started (either id space); a room whose
 * call this device is already on; the room you are looking at (the in-room
 * banner covers it — same rule as message toasts, so a hidden tab still
 * toasts); a room that is actively RINGING you (the ring banner IS the
 * notification); and rooms not at notify level "all" — "mentions" means the
 * user asked this room to speak up only when it names them, and a call
 * doesn't.
 */
export function shouldToastCallStart(args: CallStartToastArgs): boolean {
  if (!args.freshStart) return false;
  if (
    args.byParticipantId !== null &&
    (args.byParticipantId === args.selfParticipantId ||
      args.byParticipantId === args.selfUserId)
  ) {
    return false;
  }
  if (args.connectedCallRoomId === args.roomId) return false;
  if (args.viewingRoomId === args.roomId && args.documentVisible) return false;
  if (args.ringingRoomId === args.roomId) return false;
  if (args.notifyLevel !== "all") return false;
  return true;
}

/**
 * CallDock gate — the floating pill stands in for the call ONLY when this
 * device's call is live and its room is not the one on screen (there, the full
 * call surface renders instead).
 */
export function shouldShowCallDock(state: {
  isConnected: boolean;
  activeCallRoomId: string | null;
  activeRoomId: string | null;
}): boolean {
  if (!state.isConnected || !state.activeCallRoomId) return false;
  return state.activeRoomId !== state.activeCallRoomId;
}

/**
 * In-room banner gate — "Call in progress · N in call — Join" at the top of a
 * room's chat. Shows only when the room genuinely has a live call this device
 * is NOT part of, and nothing else is already representing that call:
 *   - connected here (or connecting) → the call surface / join flow owns it,
 *   - ringing here → the incoming-call banner owns it.
 */
export function shouldShowLiveCallBanner(state: {
  liveCall: LiveCallEntry | undefined;
  roomId: string;
  isConnected: boolean;
  isConnecting: boolean;
  activeCallRoomId: string | null;
  ringingRoomId: string | null;
}): boolean {
  if (!state.liveCall || state.liveCall.participant_count < 1) return false;
  if (state.isConnected && state.activeCallRoomId === state.roomId) {
    return false;
  }
  if (state.isConnecting) return false;
  if (state.ringingRoomId === state.roomId) return false;
  return true;
}
