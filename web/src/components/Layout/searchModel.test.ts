import { describe, expect, it } from "vitest";
import type { Room, RoomMember } from "@/services/api";
import { roomMemberNames, roomSearchScore, searchRooms } from "./searchModel";

function room(over: Partial<Room> = {}): Room {
  return {
    id: "room-1",
    name: "room-1",
    display_name: "Operations",
    description: "A fictional workspace",
    type: "channel",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    member_count: 2,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
    ...over,
  };
}

function member(display_name: string, participant_type: RoomMember["participant_type"]): RoomMember {
  return {
    participant_id: display_name.toLowerCase().replaceAll(" ", "-"),
    username: display_name.toLowerCase().replaceAll(" ", "-"),
    display_name,
    participant_type,
    role: "member",
    joined_at: "2026-01-01T00:00:00Z",
  };
}

describe("room search", () => {
  it("ranks the displayed title above a slug or member hit", () => {
    const titled = room({
      id: "titled",
      name: "ops-bureau",
      display_name: "Bureau of Readiness · Magic Unicorn",
    });
    const slugHit = room({
      id: "slug",
      name: "bureau-room",
      display_name: "Operations",
      members: [member("Bureau Helper", "human")],
    });

    expect(searchRooms([slugHit, titled], "Bureau").map((hit) => hit.room.id)).toEqual([
      "titled",
      "slug",
    ]);
    expect(roomSearchScore(titled, "Bureau")?.field).toBe("title");
    expect(roomSearchScore(slugHit, "Bureau")?.field).toBe("name");
  });

  it("finds every word of a bridge-created title", () => {
    const bridge = room({
      id: "bridge-room",
      name: "bureau-of-readiness-magic-unicorn",
      display_name: "Bureau of Readiness · Magic Unicorn",
      type: "group_dm",
      metadata_: {
        bridge_pair: "fictional-human:fictional-agent",
        bridge_purpose: "readiness",
      },
    });

    expect(searchRooms([bridge], "Bureau")[0]?.room.id).toBe("bridge-room");
    expect(searchRooms([bridge], "Readiness")[0]?.room.id).toBe("bridge-room");
  });

  it("matches human and agent display names from both member snapshots", () => {
    const ops = room({
      id: "ops",
      members: [member("Morgan Vale", "human")],
      agent_members: [
        {
          participant_id: "agent-persephone",
          agent_id: "persephone",
          display_name: "Persephone",
        },
      ],
    });
    const loaded = member("Rook", "agent");

    expect(roomMemberNames(ops, [loaded])).toEqual([
      "Morgan Vale",
      "Rook",
      "Persephone",
    ]);
    expect(searchRooms([ops], "Morgan")[0]?.field).toBe("member");
    expect(searchRooms([ops], "Persephone")[0]?.field).toBe("member");
    expect(searchRooms([ops], "Rook", { ops: [loaded] })[0]?.field).toBe("member");
  });
});
