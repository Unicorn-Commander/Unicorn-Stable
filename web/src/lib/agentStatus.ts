/**
 * The three presence states this UI is allowed to claim, and the single place
 * that decides which one to show.
 *
 * They are genuinely different facts and must not collapse into one dot:
 *
 *  - `connected`  a client is attached RIGHT NOW — a human's WebSocket, or an
 *                 agent that has actually joined the LiveKit call. Redis-backed
 *                 (`is_online`).
 *  - `available`  an agent that holds no socket but CAN be invoked: Brigade has
 *                 it registered and enabled, or a bridge session is actively
 *                 polling the gateway. Server-computed (`availability`).
 *  - `unknown`    everything else, including "we could not reach Brigade to
 *                 ask". Deliberately not styled as either of the above.
 *
 * Most agents are invoked on demand and hold nothing, so judging them by the
 * human `connected` rule reports every one of them offline forever — exactly as
 * false as the old rule that painted them all permanently online. Humans keep
 * the connected/offline model unchanged; only agents get availability.
 */

export type Availability = "available" | "unavailable" | "unknown";

export type PresenceKind = "connected" | "available" | "unknown";

export interface PresenceBadge {
  kind: PresenceKind;
  /** Short label for aria-label / title. */
  label: string;
  /**
   * The precise state, for UIs that print a word rather than a dot. `kind`
   * folds "unavailable" and "unknown" into one VISUAL bucket deliberately —
   * both mean "do not expect an answer" — but they are different claims and a
   * text label must not report one as the other.
   */
  stateText: "in this room" | "available" | "unavailable" | "unknown";
  /** Tailwind classes for the small corner dot. */
  dotClass: string;
}

/**
 * Why an agent is in the state it is in, in words. An un-lit agent that can
 * explain itself reads as a fact; one that just sits dark reads as broken.
 */
const REASON_TEXT: Record<string, string> = {
  brigade_registered: "registered and enabled in Brigade",
  bridge_session_active: "bridge session is live",
  brigade_disabled: "disabled in Brigade",
  brigade_unreachable: "can't reach Brigade to check",
  not_in_brigade_roster: "not in the Brigade roster and no live bridge",
  no_brigade_identity: "no Brigade identity on this participant",
};

/**
 * Filled mint + pulse is reserved for `connected` — it is the strongest claim
 * and the one humans already read that way. `available` is a calmer hollow cyan
 * ring: clearly a live state, clearly not the same one. `unknown` is a dim
 * hollow grey ring, present rather than absent so the tooltip has somewhere to
 * live and so "we checked and it isn't available" is distinguishable from "we
 * never looked".
 */
const DOT: Record<PresenceKind, string> = {
  connected: "bg-stable-mint border-slate-900 animate-live",
  available: "bg-transparent border-stable-cyan",
  unknown: "bg-transparent border-slate-600",
};

/** Humans: connected or nothing. Unchanged behaviour, stated explicitly. */
export function humanPresence(isOnline?: boolean): PresenceBadge | null {
  if (!isOnline) return null;
  return {
    kind: "connected",
    label: "Online",
    stateText: "in this room",
    dotClass: DOT.connected,
  };
}

export function agentPresence(opts: {
  /** Redis presence — true only if the agent really joined the call. */
  isOnline?: boolean;
  /** Server-computed availability; undefined when we have no row yet. */
  availability?: Availability | string | null;
  availabilityReason?: string | null;
  /** Used in the tooltip, e.g. "Majik is available". */
  name?: string;
}): PresenceBadge {
  const who = opts.name ? `${opts.name} ` : "";

  // Connected outranks available: if the agent is genuinely in the call, say
  // the stronger true thing.
  if (opts.isOnline) {
    return {
      kind: "connected",
      label: `${who}is in this room now`.trim(),
      stateText: "in this room",
      dotClass: DOT.connected,
    };
  }

  const reason = opts.availabilityReason
    ? REASON_TEXT[opts.availabilityReason] ?? opts.availabilityReason
    : null;

  if (opts.availability === "available") {
    return {
      kind: "available",
      label: reason
        ? `${who}is available — ${reason}`.trim()
        : `${who}is available`.trim(),
      stateText: "available",
      dotClass: DOT.available,
    };
  }

  if (opts.availability === "unavailable") {
    return {
      kind: "unknown",
      label: reason
        ? `${who}is unavailable — ${reason}`.trim()
        : `${who}is unavailable`.trim(),
      stateText: "unavailable",
      dotClass: DOT.unknown,
    };
  }

  // Includes "unknown" and the undefined case (no members row yet, or an older
  // server that does not send the field). Never guess upward from here.
  return {
    kind: "unknown",
    label: reason
      ? `${who}availability unknown — ${reason}`.trim()
      : `${who}availability unknown`.trim(),
    stateText: "unknown",
    dotClass: DOT.unknown,
  };
}
