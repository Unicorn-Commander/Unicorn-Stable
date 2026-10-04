import type { CrewMember, Room } from "@/services/api";
import { presenterRule } from "./presenterMode";

const room = (overrides: Partial<Room>): Room =>
  ({
    id: "room",
    name: "Room",
    display_name: "Room",
    description: "private description",
    type: "channel",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    member_count: 2,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
    parent_room_id: null,
    ...overrides,
  }) as Room;

const ownSeat: CrewMember = {
  agent_id: "agent-own",
  participant_id: "participant-own",
  display_name: "Own Seat",
  avatar_url: null,
  role_line: null,
  backend: "runner",
  kind: "seat",
  owner: "aaron",
  group: "own_seat",
  presence: "online",
  hub_room_id: "open",
  seat_capabilities: null,
  last_line: null,
  last_at: null,
  last_seen_at: null,
  unread: 0,
};

describe("presenter rule", () => {
  const rooms = [
    room({
      id: "open",
      name: "OPEN_ROOM",
      members: [
        {
          participant_id: "person-open",
          username: "open-person",
          display_name: "Open Person",
          role: "member",
          joined_at: "2026-01-01T00:00:00Z",
        },
      ],
    }),
    room({
      id: "thread",
      name: "OPEN_THREAD",
      parent_room_id: "open",
    }),
    room({
      id: "safe",
      name: "SAFE_ROOM",
      members: [
        {
          participant_id: "person-safe",
          username: "safe-person",
          display_name: "Safe Person",
          role: "member",
          joined_at: "2026-01-01T00:00:00Z",
        },
      ],
    }),
    room({
      id: "private",
      name: "PRIVATE_ROOM",
      members: [
        {
          participant_id: "person-private",
          username: "private-person",
          display_name: "Private Person",
          role: "member",
          joined_at: "2026-01-01T00:00:00Z",
        },
      ],
    }),
  ];

  it("allows the open room, its threads, and selected safe rooms only", () => {
    const rule = presenterRule({
      enabled: true,
      openRoomId: "open",
      safeRoomIds: ["safe"],
      rooms,
      currentUser: { id: "me", displayName: "Signed-in User" },
      crew: [ownSeat],
    });

    expect([...rule.allowedRoomIds]).toEqual(["safe", "open", "thread"]);
    expect(rule.isRoomAllowed("open")).toBe(true);
    expect(rule.isRoomAllowed("thread")).toBe(true);
    expect(rule.isRoomAllowed("safe")).toBe(true);
    expect(rule.isRoomAllowed("private")).toBe(false);
  });

  it("allows member names and the signed-in user's own crew, but not others", () => {
    const rule = presenterRule({
      enabled: true,
      openRoomId: "open",
      safeRoomIds: ["safe"],
      rooms,
      currentUser: { id: "me", username: "aaron", displayName: "Signed-in User" },
      crew: [ownSeat],
    });

    expect(rule.isNameAllowed("Open Person")).toBe(true);
    expect(rule.isNameAllowed("Safe Person")).toBe(true);
    expect(rule.isNameAllowed("Signed-in User")).toBe(true);
    expect(rule.isNameAllowed("Own Seat")).toBe(true);
    expect(rule.isNameAllowed("Private Person")).toBe(false);
    expect(rule.isIdentityAllowed("person-private", "Private Person")).toBe(false);
  });

  it("keeps presenter mode off as a no-op rule", () => {
    const rule = presenterRule({
      enabled: false,
      openRoomId: "open",
      safeRoomIds: [],
      rooms,
    });

    expect(rule.isRoomAllowed("private")).toBe(false);
    expect(rule.isNameAllowed("Private Person")).toBe(true);
    expect(rule.isIdentityAllowed("person-private", "Private Person")).toBe(true);
  });
});

