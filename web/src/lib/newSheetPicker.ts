/**
 * The New sheet's first step is one "To:" box (Nav v3 §2.1): type a name and
 * pick a crew member, a person, or a channel. Pure filtering lives here so
 * the order and the caps are testable without React.
 *
 *   Crew → People → Channels, in that order, always.
 *   The crew comes first, then every entitled roster agent not already in
 *   it — a house agent you have never talked to (Harmony) is still one
 *   "To:" away, which is what the old Talk-to-an-agent list did.
 *   Empty query: the first rows of that pool (the six actions sit below).
 *   A query: every group, matched on name / id / username / role line.
 */

/** The crew, then the entitled roster agents it does not already hold. */
export function crewWithRoster(
  crew: readonly CrewMember[],
  roster: readonly Agent[] | null | undefined,
): CrewMember[] {
  const seen = new Set(crew.map((member) => member.agent_id));
  const extras = crewFromRoster(roster ?? []).filter((member) => !seen.has(member.agent_id));
  return [...crew, ...extras];
}

export type ToPickKind = "crew" | "person" | "channel";

/** One row of the flat, keyboard-walkable list: the groups in order. */
export interface ToPickRef {
  kind: ToPickKind;
  key: string;
  index: number;
}
import type { Agent, CrewMember, PeopleDirectoryEntry, Room } from "@/services/api";
import { crewRowMatches } from "@/components/Sidebar/sidebarModel";
import { crewFromRoster } from "@/lib/crew";
import { roomLabel } from "@/lib/conversation";

export interface ChannelPick {
  room: Room;
  /** Already a member — open it. Otherwise join, then open. */
  joined: boolean;
}

export interface ToPicks {
  crew: CrewMember[];
  people: PeopleDirectoryEntry[];
  channels: ChannelPick[];
  /** Nothing in any group. */
  empty: boolean;
  /** Every row in display order, for arrow keys and Enter. */
  flat: ToPickRef[];
}

export interface ToPicksInput {
  crew: readonly CrewMember[];
  /** Brigade roster: entitled agents not already in the crew are appended. */
  roster?: readonly Agent[] | null;
  people: readonly PeopleDirectoryEntry[];
  /** Rooms the user is in; only channels are offered. */
  rooms: readonly Room[];
  /** Joinable channels from GET /rooms/browse, already filtered by the server. */
  browsable?: readonly Room[];
  query: string;
  caps?: { crew?: number; people?: number; channels?: number; idle?: number };
}

const DEFAULT_CAPS = { crew: 6, people: 6, channels: 6, idle: 6 } as const;

function personMatches(person: PeopleDirectoryEntry, q: string): boolean {
  const hay = `${person.display_name} ${person.username} ${person.id}`.toLowerCase();
  return hay.includes(q);
}

function channelMatches(room: Room, q: string): boolean {
  const hay = `${roomLabel(room)} ${room.name} ${room.description || ""}`.toLowerCase();
  return hay.includes(q);
}

function isOfferedChannel(room: Room): boolean {
  return room.type === "channel" && !room.parent_room_id && !room.is_archived;
}

function flatten(crew: CrewMember[], people: PeopleDirectoryEntry[], channels: ChannelPick[]): ToPickRef[] {
  const flat: ToPickRef[] = [];
  for (const member of crew) flat.push({ kind: "crew", key: member.agent_id, index: flat.length });
  for (const person of people) flat.push({ kind: "person", key: person.id, index: flat.length });
  for (const pick of channels) flat.push({ kind: "channel", key: pick.room.id, index: flat.length });
  return flat;
}

/** Arrow-key step over the flat list, wrapping at both ends. */
export function stepPick(count: number, index: number | null, delta: -1 | 1): number | null {
  if (count <= 0) return null;
  if (index === null) return delta === 1 ? 0 : count - 1;
  return (index + delta + count) % count;
}

export function buildToPicks(input: ToPicksInput): ToPicks {
  const caps = { ...DEFAULT_CAPS, ...input.caps };
  const q = input.query.trim().toLowerCase();
  const pool = crewWithRoster(input.crew, input.roster);
  if (!q) {
    const crew = pool.slice(0, caps.idle);
    return { crew, people: [], channels: [], empty: crew.length === 0, flat: flatten(crew, [], []) };
  }
  const crew = pool.filter((member) => crewRowMatches(member, q)).slice(0, caps.crew);
  // The directory search is server-side; a client pass keeps a stale page honest.
  const people = input.people.filter((person) => personMatches(person, q)).slice(0, caps.people);
  const joinedIds = new Set<string>();
  const channels: ChannelPick[] = [];
  for (const room of input.rooms) {
    if (!isOfferedChannel(room) || !channelMatches(room, q)) continue;
    joinedIds.add(room.id);
    channels.push({ room, joined: true });
  }
  for (const room of input.browsable ?? []) {
    if (joinedIds.has(room.id) || !isOfferedChannel(room) || !channelMatches(room, q)) continue;
    channels.push({ room, joined: false });
  }
  const shownChannels = channels.slice(0, caps.channels);
  return {
    crew,
    people,
    channels: shownChannels,
    empty: crew.length === 0 && people.length === 0 && shownChannels.length === 0,
    flat: flatten(crew, people, shownChannels),
  };
}
