import type {
  Agent,
  CrewMember,
  Message,
  Room,
  RoomMember,
} from "@/services/api";

/**
 * Presenter mode is a display filter only. This module is deliberately pure:
 * it has no store, browser, URL, or server concerns. Every surface that wants
 * to decide whether a room or identity may be painted should use this rule.
 */

export interface PresenterUser {
  id?: string | null;
  participantId?: string | null;
  username?: string | null;
  displayName?: string | null;
  email?: string | null;
}

export interface PresenterContext {
  enabled: boolean;
  openRoomId: string | null;
  safeRoomIds: readonly string[];
  rooms: readonly Room[];
  participantsByRoom?: Readonly<Record<string, readonly RoomMember[]>>;
  currentUser?: PresenterUser | null;
  crew?: readonly CrewMember[];
  agents?: readonly Agent[];
}

export interface PresenterRule {
  enabled: boolean;
  allowedRoomIds: ReadonlySet<string>;
  allowedNames: ReadonlySet<string>;
  allowedIdentityIds: ReadonlySet<string>;
  isOpenRoom: (roomId: string | null | undefined) => boolean;
  isRoomAllowed: (roomId: string | null | undefined) => boolean;
  isNameAllowed: (name: string | null | undefined) => boolean;
  isIdentityAllowed: (
    id: string | null | undefined,
    name?: string | null,
  ) => boolean;
}

const normalize = (value: string | null | undefined): string =>
  (value ?? "").trim().toLocaleLowerCase();

function addName(set: Set<string>, value: string | null | undefined): void {
  const key = normalize(value);
  if (key) set.add(key);
}

function addId(set: Set<string>, value: string | null | undefined): void {
  const key = (value ?? "").trim();
  if (key) set.add(key);
}

function roomMembers(
  room: Room,
  participantsByRoom: Readonly<Record<string, readonly RoomMember[]>> | undefined,
): readonly RoomMember[] {
  const loaded = participantsByRoom?.[room.id];
  return loaded && loaded.length > 0 ? loaded : room.members;
}

function addMemberIdentity(
  names: Set<string>,
  ids: Set<string>,
  member: Partial<RoomMember> & {
    participant_id?: string | null;
    user_id?: string | null;
    id?: string | null;
    display_name?: string | null;
    username?: string | null;
  },
): void {
  addName(names, member.display_name);
  addName(names, member.username);
  addId(ids, member.participant_id);
  addId(ids, member.user_id);
  addId(ids, member.id);
}

/**
 * The main-pane room and its descendants are open-room content. Safe rooms
 * are exact per-device selections; their own threads are not implicitly
 * selected because the product control stores room IDs, not a hierarchy.
 */
export function allowedRoomIds(
  rooms: readonly Room[],
  openRoomId: string | null,
  safeRoomIds: readonly string[],
): Set<string> {
  const ids = new Set(safeRoomIds.filter(Boolean));
  if (!openRoomId) return ids;

  const byId = new Map(rooms.map((room) => [room.id, room]));
  for (const room of rooms) {
    let cursor: Room | undefined = room;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (cursor.id === openRoomId) {
        ids.add(room.id);
        break;
      }
      const parentId = cursor.parent_room_id ?? null;
      cursor = parentId ? byId.get(parentId) : undefined;
    }
  }
  return ids;
}

function addRoomIdentities(
  names: Set<string>,
  ids: Set<string>,
  room: Room,
  context: PresenterContext,
): void {
  // A room's name is the one room field the rule permits. Descriptions and
  // message previews intentionally do not enter this set.
  addName(names, room.name);
  addName(names, room.display_name);

  for (const member of roomMembers(room, context.participantsByRoom)) {
    addMemberIdentity(names, ids, member);
  }
  if (room.counterpart) {
    addName(names, room.counterpart.display_name);
    addName(names, room.counterpart.username);
    addId(ids, room.counterpart.participant_id);
    addId(ids, room.counterpart.agent_id);
  }
  for (const member of room.agent_members ?? []) {
    addName(names, member.display_name);
    addId(ids, member.participant_id);
    addId(ids, member.agent_id);
  }
  for (const agent of room.agents) {
    addName(names, agent.display_name || agent.name);
    addId(ids, agent.id);
    addName(names, agent.name);
  }
}

function addOwnIdentities(
  names: Set<string>,
  ids: Set<string>,
  context: PresenterContext,
): void {
  const user = context.currentUser;
  addName(names, user?.displayName);
  addName(names, user?.username);
  addName(names, user?.email);
  addId(ids, user?.id);
  addId(ids, user?.participantId);

  // This is the same ownership fact used by CrewSection/sidebarModel:
  // `group === "own_seat"`, not a guess based on an agent label.
  for (const member of context.crew ?? []) {
    if (member.group !== "own_seat") continue;
    addName(names, member.display_name);
    addId(ids, member.agent_id);
    addId(ids, member.participant_id);
  }
}

export function presenterRule(context: PresenterContext): PresenterRule {
  const allowedIds = allowedRoomIds(
    context.rooms,
    context.openRoomId,
    context.safeRoomIds,
  );
  const names = new Set<string>();
  const identityIds = new Set<string>();
  addOwnIdentities(names, identityIds, context);

  for (const room of context.rooms) {
    if (allowedIds.has(room.id)) {
      addRoomIdentities(names, identityIds, room, context);
    }
  }

  const openRoom = context.openRoomId
    ? context.rooms.find((room) => room.id === context.openRoomId)
    : undefined;
  const openRoomIds = new Set<string>();
  if (openRoom) {
    for (const room of context.rooms) {
      let cursor: Room | undefined = room;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        if (cursor.id === openRoom.id) {
          openRoomIds.add(room.id);
          break;
        }
        const parentId = cursor.parent_room_id ?? null;
        cursor = parentId
          ? context.rooms.find((candidate) => candidate.id === parentId)
          : undefined;
      }
    }
  }

  const isOpenRoom = (roomId: string | null | undefined): boolean =>
    !!roomId && openRoomIds.has(roomId);
  const isRoomAllowed = (roomId: string | null | undefined): boolean =>
    !!roomId && allowedIds.has(roomId);
  const isNameAllowed = (name: string | null | undefined): boolean => {
    if (!context.enabled) return true;
    return names.has(normalize(name));
  };
  const isIdentityAllowed = (
    id: string | null | undefined,
    name?: string | null,
  ): boolean => {
    if (!context.enabled) return true;
    return (!!id && identityIds.has(id)) || isNameAllowed(name);
  };

  return {
    enabled: context.enabled,
    allowedRoomIds: allowedIds,
    allowedNames: names,
    allowedIdentityIds: identityIds,
    isOpenRoom,
    isRoomAllowed,
    isNameAllowed,
    isIdentityAllowed,
  };
}

export function filterRooms(
  rooms: readonly Room[],
  rule: PresenterRule,
): Room[] {
  if (!rule.enabled) return [...rooms];
  return rooms.filter((room) => rule.isRoomAllowed(room.id));
}

/** List surfaces may show an allowed room's name, but not its message preview. */
export function messageForList(
  roomId: string,
  message: Message | null | undefined,
  rule: PresenterRule,
): Message | null {
  if (!message) return null;
  return rule.isOpenRoom(roomId) ? message : null;
}

/** Room detail is the one surface explicitly exempted by P5. */
export function messageForRoom(
  roomId: string,
  message: Message,
  rule: PresenterRule,
): Message | null {
  return rule.isOpenRoom(roomId) ? message : null;
}

export function nameForNotification(
  roomId: string | null | undefined,
  rule: PresenterRule,
): string {
  return rule.isRoomAllowed(roomId) ? "New message" : "New message";
}
