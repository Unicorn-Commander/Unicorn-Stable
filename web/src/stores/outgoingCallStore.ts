import { create } from "zustand";

/**
 * The CALLER's half of a direct call.
 *
 * The receive side (incomingCallStore + IncomingCallBanner) has always been
 * the loud half; this is the quiet half that was missing entirely, and its
 * absence is the specific failure this store exists to prevent: you press
 * call, and then you stare at nothing. Every outcome the server can produce —
 * ringing, declined, no answer, busy, offline, could-not-determine, cancelled,
 * answered — lands here as a named phase with a sentence a person can read.
 *
 * Single slot, like incomingCallStore: you can be in one outgoing call.
 */

/** Per-callee reachability as the SERVER determined it at ring time. */
export interface OutgoingTarget {
  id: string;
  display_name: string;
  /** ringing | offline | busy | unknown */
  state: string;
}

export type OutgoingPhase =
  /** Ringing on at least one of their devices. */
  | "ringing"
  /** They pressed decline. */
  | "declined"
  /** Rang out — nobody picked up before the server's deadline. */
  | "no_answer"
  /** Already on another call. */
  | "busy"
  /** Presence says they have no session open — we never rang. */
  | "offline"
  /** Presence could NOT be read. Distinct from offline on purpose. */
  | "unknown"
  /** You cancelled. */
  | "canceled"
  /** They answered. */
  | "accepted"
  /** The ring request itself failed (network / 403 / rate limit). */
  | "failed";

/** Phases after which nothing more will happen — safe to self-dismiss. */
const TERMINAL: ReadonlySet<OutgoingPhase> = new Set<OutgoingPhase>([
  "declined",
  "no_answer",
  "busy",
  "offline",
  "unknown",
  "canceled",
  "accepted",
  "failed",
]);

export interface OutgoingCall {
  /** null when the ring never became a live call (offline/busy/failed). */
  callId: string | null;
  roomId: string;
  /** Who we're calling, for the headline. */
  label: string;
  phase: OutgoingPhase;
  /** Human sentence rendered under the headline. Always set. */
  detail: string;
  targets: OutgoingTarget[];
  /** Server's ring deadline (ISO). The caller's backstop derives from this. */
  expiresAt: string | null;
}

interface OutgoingCallState {
  call: OutgoingCall | null;
  /** Begin (or replace) an outgoing call in the ringing phase. */
  ring: (call: Omit<OutgoingCall, "phase" | "detail"> & { detail?: string }) => void;
  /** Move the current call to a terminal phase. No-op for a stale call_id. */
  settle: (
    phase: OutgoingPhase,
    detail: string,
    opts?: { callId?: string | null; roomId?: string },
  ) => void;
  /** Show a terminal outcome for a ring that never became a call. */
  showOutcome: (call: OutgoingCall) => void;
  clear: () => void;
}

export const isTerminalPhase = (p: OutgoingPhase): boolean => TERMINAL.has(p);

export const useOutgoingCallStore = create<OutgoingCallState>((set, get) => ({
  call: null,

  ring: (call) =>
    set({
      call: {
        ...call,
        phase: "ringing",
        detail: call.detail ?? `Ringing ${call.label}…`,
      },
    }),

  settle: (phase, detail, opts) => {
    const cur = get().call;
    if (!cur) return;
    // A resolution for a call we are no longer making must not overwrite the
    // one we ARE making — the caller redialling immediately after a decline is
    // the ordinary way to produce that race.
    // Coerce ids to strings: Redis/JSON sometimes rehydrate UUID-like values
    // with different string forms; a strict !== left "Calling…" stuck forever.
    if (
      opts?.callId != null &&
      cur.callId != null &&
      String(opts.callId) !== String(cur.callId)
    ) {
      return;
    }
    if (opts?.roomId && !cur.callId && opts.roomId !== cur.roomId) return;
    if (isTerminalPhase(cur.phase)) return;
    set({ call: { ...cur, phase, detail } });
  },

  showOutcome: (call) => set({ call }),

  clear: () => set({ call: null }),
}));
