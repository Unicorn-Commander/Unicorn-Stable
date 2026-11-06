import type { Room, RoomMember } from "@/services/api";
import { roomTitle } from "@/lib/conversation";

/** Member snapshots are loaded per room, while some room-list responses carry
 * a partial member summary. Search accepts both without making either source
 * authoritative. */
export type MembersByRoom = Readonly<
  Record<string, readonly RoomMember[] | undefined>
>;

export type RoomSearchField = "title" | "name" | "member" | "description";

export interface ScoredRoom {
  room: Room;
  score: number;
  field: RoomSearchField;
}

/** The switcher's original fuzzy behaviour, kept pure for all non-room rows. */
export function fuzzyScore(needle: string, haystack: string): number {
  const n = needle.trim().toLowerCase();
  const h = haystack.toLowerCase();
  if (!n) return 0;
  if (h.startsWith(n)) return 1000 + (1000 - h.length);
  if (h.includes(n)) return 500 - h.indexOf(n);

  let i = 0;
  let score = 0;
  for (const character of h) {
    if (character === n[i]) {
      i += 1;
      score += 5;
      if (i === n.length) break;
    }
  }
  return i === n.length ? score : 0;
}

/**
 * Search terms are intentionally ORed. A person typing "Bureau" or
 * "Readiness" must find a bridge-created room whose title contains both;
 * requiring the whole title/query string made those useful single-word
 * searches miss. A multi-word query still gets a small bonus for each word.
 */
function textScore(query: string, text: string): number {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return 0;
  const scores = terms.map((term) => fuzzyScore(term, text)).filter((score) => score > 0);
  if (scores.length === 0) return 0;
  return Math.max(...scores) + (scores.length - 1) * 25;
}

function addName(names: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const name = value.trim();
  if (name && !names.includes(name)) names.push(name);
}

/** All display-name sources currently available to a room-list consumer. */
export function roomMemberNames(
  room: Room,
  loadedMembers: readonly RoomMember[] | undefined = undefined,
): string[] {
  const names: string[] = [];
  for (const member of room.members ?? []) addName(names, member.display_name);
  for (const member of loadedMembers ?? []) addName(names, member.display_name);
  for (const member of room.agent_members ?? []) addName(names, member.display_name);
  addName(names, room.counterpart?.display_name);
  for (const agent of room.agents ?? []) {
    addName(names, agent.display_name);
    addName(names, agent.name);
  }
  return names;
}

/**
 * Score one room. The large field bands are deliberate: any title match is
 * ranked above a slug/member match, even when the lower-priority field is an
 * exact prefix. This makes the displayed title the primary search contract.
 */
export function roomSearchScore(
  room: Room,
  query: string,
  loadedMembers: readonly RoomMember[] | undefined = undefined,
): ScoredRoom | null {
  if (!query.trim()) return null;

  const titleScore = textScore(query, roomTitle(room));
  if (titleScore > 0) {
    return { room, score: 3_000_000 + titleScore, field: "title" };
  }

  const nameScore = textScore(query, room.name);
  if (nameScore > 0) {
    return { room, score: 2_000_000 + nameScore, field: "name" };
  }

  const memberScore = Math.max(
    0,
    ...roomMemberNames(room, loadedMembers).map((name) => textScore(query, name)),
  );
  if (memberScore > 0) {
    return { room, score: 1_000_000 + memberScore, field: "member" };
  }

  const descriptionScore = textScore(query, room.description || "");
  if (descriptionScore > 0) {
    return { room, score: 100_000 + descriptionScore, field: "description" };
  }
  return null;
}

export function searchRooms(
  rooms: readonly Room[],
  query: string,
  membersByRoom: MembersByRoom = {},
): ScoredRoom[] {
  return rooms
    .map((room, index) => ({
      result: roomSearchScore(room, query, membersByRoom[room.id]),
      index,
    }))
    .filter((entry): entry is { result: ScoredRoom; index: number } => entry.result !== null)
    .sort((a, b) => b.result.score - a.result.score || a.index - b.index)
    .map((entry) => entry.result);
}
