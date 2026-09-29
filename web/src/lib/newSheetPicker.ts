/**
 * The New sheet's first step is one "To:" box (Nav v3 §2.1): type a name and
 * pick a crew member, a person, or a channel. Pure filtering lives here so
 * the order and the caps are testable without React.
 *
 *   Crew → People → Channels, in that order, always.
 *   Empty query: the crew's first rows only (the six actions sit below).
 *   A query: every group, matched on name / id / username / role line.
 */
import type { CrewMember, PeopleDirectoryEntry, Room } from "@/services/api";
import { crewRowMatches } from "@/components/Sidebar/sidebarModel";
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
}

export interface ToPicksInput {
  crew: readonly CrewMember[];
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

export function buildToPicks(input: ToPicksInput): ToPicks {
  const caps = { ...DEFAULT_CAPS, ...input.caps };
  const q = input.query.trim().toLowerCase();
  if (!q) {
    const crew = input.crew.slice(0, caps.idle);
    return { crew, people: [], channels: [], empty: crew.length === 0 };
  }
  const crew = input.crew.filter((member) => crewRowMatches(member, q)).slice(0, caps.crew);
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
  };
}
