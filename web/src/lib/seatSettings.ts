/**
 * Seat settings — the brain of one conversation (Nav v3 §2.4, C2).
 *
 * A room with runner-backed seats carries `metadata.seats[agent_id] =
 * {model, effort}` — per seat, so a room with two of your seats has two
 * chips. Null on both means the seat's own defaults, which the popover
 * names so the default is never a mystery. Only YOUR seat takes a change
 * (the server 403s anyone else): a partner's seat shows the chip read-only,
 * a house agent keeps the Brigade switcher.
 *
 * Pure state here; SeatSettings.tsx does the rendering and the writes.
 */
import type {
  CrewMember,
  Room,
  RoomMember,
  RoomSeat,
  SeatCapabilities,
  SeatModel,
} from "@/services/api";
import type { AgentMode } from "@/lib/conversation";
import {
  brainLabel,
  canEditSeat,
  defaultBrainLabel,
  readRoomSeat,
  readRoomSeats,
  seatIndex,
} from "@/lib/crew";

export const SEAT_EFFORTS = ["low", "medium", "high", "max"] as const;
export type SeatEffort = (typeof SEAT_EFFORTS)[number];

export interface SeatMemberMatch {
  /** The crew row for the seat in this room. */
  member: CrewMember;
  /** The seat's participant in THIS room — the target of the mode PATCH. */
  participantId: string;
  /** Your own seat. A partner's seat is shown, not changed. */
  editable: boolean;
  agentMode: AgentMode | null;
}

function asMode(value: unknown): AgentMode | null {
  return value === "answers_all" || value === "when_named" || value === "listening" || value === "muted"
    ? value
    : null;
}

/**
 * Every runner seat in this room, yours first. RoomResponse.agents[] has no
 * backend field, so the answer comes from matching the room's agent rows
 * (and its counterpart, its members and its resident id) against the crew
 * list's seats. No crew loaded yet → no seat known yet.
 */
export function findSeatMembers(
  room: Room | null | undefined,
  members: readonly RoomMember[] | null | undefined,
  crew: readonly CrewMember[],
): SeatMemberMatch[] {
  if (!room) return [];
  const { byAgent, byParticipant } = seatIndex(crew);
  if (byAgent.size === 0 && byParticipant.size === 0) return [];
  const found = new Map<string, SeatMemberMatch>();

  const build = (member: CrewMember, participantId: string): SeatMemberMatch => {
    const fromRoom = room.agent_members?.find(
      (row) => row.participant_id === participantId || (row.agent_id && row.agent_id === member.agent_id),
    );
    const fromMembers = members?.find(
      (row) => (row.participant_id || row.id || row.user_id) === participantId,
    );
    return {
      member,
      participantId,
      editable: canEditSeat(member),
      agentMode: asMode(fromRoom?.agent_mode ?? fromMembers?.agent_mode ?? null),
    };
  };

  const add = (hit: CrewMember | undefined, participantId: string | undefined) => {
    if (!hit || found.has(hit.agent_id)) return;
    found.set(hit.agent_id, build(hit, participantId || hit.participant_id));
  };
  for (const row of room.agent_members ?? []) {
    add(
      (row.agent_id ? byAgent.get(row.agent_id) : undefined) ?? byParticipant.get(row.participant_id),
      row.participant_id,
    );
  }
  const counterpart = room.counterpart;
  if (counterpart) {
    add(
      (counterpart.agent_id ? byAgent.get(counterpart.agent_id) : undefined) ??
        byParticipant.get(counterpart.participant_id),
      counterpart.participant_id,
    );
  }
  for (const row of members ?? []) {
    if ((row.participant_type ?? "human") !== "agent") continue;
    const pid = row.participant_id || row.id || row.user_id;
    if (pid) add(byParticipant.get(pid), pid);
  }
  if (room.brigade_agent_id) add(byAgent.get(room.brigade_agent_id), undefined);
  for (const id of room.brigade_agent_ids ?? []) add(byAgent.get(id), undefined);
  const all = [...found.values()];
  all.sort((a, b) => Number(b.editable) - Number(a.editable));
  return all;
}

/** The first seat in the room — yours when you have one there. */
export function findSeatMember(
  room: Room | null | undefined,
  members: readonly RoomMember[] | null | undefined,
  crew: readonly CrewMember[],
): SeatMemberMatch | null {
  return findSeatMembers(room, members, crew)[0] ?? null;
}

/** A 409 on the seat write has two meanings on the server. */
export type SeatRefusal = "archived" | "no_seat";

export function seatRefusalKind(detail: string | null | undefined): SeatRefusal {
  return /archiv/i.test(detail ?? "") ? "archived" : "no_seat";
}

/**
 * The Brigade model switcher (client-side override for Brigade chat and
 * voice) stays while any agent member is NOT a runner seat — in a group
 * with Persephone and Majik, Majik's model is still set there. It goes only
 * when every agent member is a seat, whose brain is the chip's popover.
 */
export function shouldShowModelSwitcher(
  room: Room | null | undefined,
  members: readonly RoomMember[] | null | undefined,
  crew: readonly CrewMember[],
): boolean {
  const { byAgent, byParticipant } = seatIndex(crew);
  const isSeat = (agentId: string | null | undefined, participantId: string | null | undefined) =>
    (!!agentId && byAgent.has(agentId)) || (!!participantId && byParticipant.has(participantId));
  const seen = new Set<string>();
  let agentRows = 0;
  let nonSeat = 0;
  for (const row of room?.agent_members ?? []) {
    const key = row.participant_id || row.agent_id || "";
    if (seen.has(key)) continue;
    seen.add(key);
    agentRows += 1;
    if (!isSeat(row.agent_id, row.participant_id)) nonSeat += 1;
  }
  for (const row of members ?? []) {
    if ((row.participant_type ?? "human") !== "agent") continue;
    const pid = row.participant_id || row.id || row.user_id || "";
    if (seen.has(pid)) continue;
    seen.add(pid);
    agentRows += 1;
    if (!isSeat(null, pid)) nonSeat += 1;
  }
  if (agentRows === 0) {
    for (const id of [room?.brigade_agent_id, ...(room?.brigade_agent_ids ?? [])]) {
      if (!id) continue;
      agentRows += 1;
      if (!byAgent.has(id)) nonSeat += 1;
    }
  }
  return agentRows === 0 || nonSeat > 0;
}

/** The models the popover offers: what the seat announced. */
export function seatModelOptions(caps: SeatCapabilities | null | undefined): SeatModel[] {
  return caps?.models ?? [];
}

/** The efforts the popover offers: the seat's list, else the four. */
export function seatEffortOptions(caps: SeatCapabilities | null | undefined): string[] {
  const announced = (caps?.efforts ?? []).filter((effort) => typeof effort === "string" && effort);
  return announced.length > 0 ? announced : [...SEAT_EFFORTS];
}

export function isDefaultSeat(seat: RoomSeat): boolean {
  return seat.model === null && seat.effort === null;
}

/** "Fable 5.1 · high": the override where set, else the seat's default. */
export function seatChipLabel(seat: RoomSeat, caps: SeatCapabilities | null | undefined): string | null {
  return brainLabel(seat, caps);
}

/** "Default (Fable 5.1 · high)" — the null state, named. */
export function seatDefaultLabel(caps: SeatCapabilities | null | undefined): string {
  const named = defaultBrainLabel(caps);
  return named ? `Default (${named})` : "Default (seat's own settings)";
}

/** The current effort the popover highlights: the override, else the default. */
export function effectiveEffort(seat: RoomSeat, caps: SeatCapabilities | null | undefined): string | null {
  return seat.effort ?? caps?.default_effort ?? null;
}

/** The current model the popover highlights: the override, else the default. */
export function effectiveModel(seat: RoomSeat, caps: SeatCapabilities | null | undefined): string | null {
  return seat.model ?? caps?.default_model ?? null;
}

export function pickModel(seat: RoomSeat, model: string | null): RoomSeat {
  return { model, effort: seat.effort };
}

export function pickEffort(seat: RoomSeat, effort: string | null): RoomSeat {
  return { model: seat.model, effort };
}

export function resetSeat(): RoomSeat {
  return { model: null, effort: null };
}

/** True when the pick is one the seat can honour (the runner logs and ignores the rest). */
export function validateSeat(seat: RoomSeat, caps: SeatCapabilities | null | undefined): boolean {
  const models = seatModelOptions(caps);
  if (seat.model !== null && models.length > 0 && !models.some((m) => m.id === seat.model)) return false;
  if (seat.effort !== null && !seatEffortOptions(caps).includes(seat.effort)) return false;
  return true;
}

/** The C2 write: `PATCH /rooms/{id}` `{metadata: {seats: {<agent_id>: {model, effort}}}}`. */
export function seatPatchBody(
  agentId: string,
  seat: RoomSeat,
): { metadata: { seats: Record<string, RoomSeat> } } {
  return { metadata: { seats: { [agentId]: { model: seat.model, effort: seat.effort } } } };
}

/** The room as it reads after the write — the optimistic update; other seats stay. */
export function applySeatToRoom<T extends { metadata_?: Record<string, unknown> | null }>(
  room: T,
  agentId: string,
  seat: RoomSeat,
): T {
  const seats = readRoomSeats(room);
  return {
    ...room,
    metadata_: {
      ...(room.metadata_ ?? {}),
      seats: { ...seats, [agentId]: { model: seat.model, effort: seat.effort } },
    },
  };
}

export { readRoomSeat };
