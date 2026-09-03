import type { RingResponse } from "@/services/api";
import type { OutgoingCall } from "@/stores/outgoingCallStore";

/**
 * The policy half of "start a call", with every side effect injected so the
 * ORDER of those effects is a unit-tested fact rather than a hope.
 *
 * The order is the bug. Measured on dogfood (room 3878dd2f "Build In Public —
 * E04", 2026-09-01 22:17 and 2026-09-02 22:59): the ring went out the instant
 * the phone button was pressed, BEFORE the device-check dialog even opened —
 * so the callee's devices rang and the caller's card pulsed every 2.4 s while
 * the caller was still picking a mic, and cancelling that dialog left the
 * ring running for the rest of the 45 s window. Both rings in the log were
 * ended by the caller pressing Cancel (+21 s, +10 s); neither was answered.
 *
 * Now: connect FIRST (device check or immediate join), and ring only once
 * this client is actually on the line. Cancelling the dialog rings nobody.
 */

export type RoomKind = "channel" | "group_dm" | "dm";

export interface StartCallInput {
  roomId: string;
  roomType: RoomKind;
  /** Room has resident agents — it is a place, not just a phone line. */
  hasAgents: boolean;
  label: string;
  /** From a deep link / preference: ring=0 joins silently. */
  ring?: boolean;
}

export interface StartCallDeps {
  /** Connect to the room's call. Resolves true once connected, false if the user backed out. */
  connect: () => Promise<boolean>;
  ringRoom: (roomId: string) => Promise<RingResponse>;
  /** Show the "Ringing X…" card. */
  ring: (call: Omit<OutgoingCall, "phase" | "detail"> & { detail?: string }) => void;
  /** Show a terminal outcome card (offline/busy/failed). */
  showOutcome: (call: OutgoingCall) => void;
  /** Leave the call we just joined (used when nobody could be rung in a 1:1 DM). */
  disconnect: () => void;
}

export type StartCallResult =
  | "joined_channel"
  | "backed_out"
  | "joined_no_ring"
  | "joined_ringing"
  | "joined_in_call"
  | "joined_unreachable"
  | "left_unreachable"
  | "joined_ring_failed";

interface ApiErrorLike {
  status?: number;
  detail?: string;
}

export async function runStartCall(
  input: StartCallInput,
  deps: StartCallDeps,
): Promise<StartCallResult> {
  const { roomId, roomType, label } = input;

  // Channels keep their existing behaviour exactly: join, no ring.
  if (roomType === "channel") {
    await deps.connect();
    return "joined_channel";
  }

  // Connect FIRST. A cancelled device check must ring nobody.
  const joined = await deps.connect();
  if (!joined) return "backed_out";

  if (input.ring === false) return "joined_no_ring";

  try {
    const res = await deps.ringRoom(roomId);

    // Everyone we would ring is already on the line — this was a (re)join.
    if (res.state === "in_call") return "joined_in_call";

    if (res.state !== "ringing") {
      const offline = res.targets.filter((t) => t.state === "offline");
      const busy = res.targets.filter((t) => t.state === "busy");
      const phase = busy.length > 0 ? "busy" : "offline";
      const detail =
        busy.length > 0
          ? `${busy.map((t) => t.display_name).join(", ")} is already on a call.`
          : `${offline.map((t) => t.display_name).join(", ") || label} isn't online right now.`;
      deps.showOutcome({
        callId: null,
        roomId,
        label,
        phase,
        detail,
        targets: res.targets,
        expiresAt: null,
      });
      // A 1:1 DM with nobody reachable is an empty room — the "staring at
      // nothing" failure, so leave it. A group DM / a room with agents is a
      // place (the show room is one): stay, the agents are already here.
      if (roomType === "dm" && !input.hasAgents) {
        deps.disconnect();
        return "left_unreachable";
      }
      return "joined_unreachable";
    }

    const uncertain = res.targets.filter((t) => t.state === "unknown");
    deps.ring({
      callId: res.call_id,
      roomId,
      label,
      detail:
        uncertain.length > 0
          ? `Ringing ${label}… (couldn't confirm they're online)`
          : `Ringing ${label}…`,
      targets: res.targets,
      expiresAt: res.expires_at,
    });
    return "joined_ringing";
  } catch (err) {
    const e = err as ApiErrorLike;
    // 409 = nobody human to ring (agent DMs). Not a failure: we are in, and
    // the agents are dispatched by the LiveKit room itself.
    if (e?.status === 409) return "joined_no_ring";
    deps.showOutcome({
      callId: null,
      roomId,
      label,
      phase: "failed",
      detail:
        e?.detail ||
        (e?.status === 403
          ? "You're not a member of this conversation."
          : "Couldn't ring them. You're in the call; they weren't told."),
      targets: [],
      expiresAt: null,
    });
    return "joined_ring_failed";
  }
}
