import { describe, expect, it } from "vitest";
import { runnerVoiceCanonicalRoom, type Room, type RoomMember } from "./api";

const room = (agent_members: Room["agent_members"] = []): Room => ({
  id: "hub-1",
  name: "runner-thread",
  description: "",
  type: "agent_hub",
  created_at: "",
  updated_at: "",
  member_count: 2,
  unread_count: 0,
  last_message: null,
  members: [],
  agents: [],
  agent_members,
});

describe("runnerVoiceCanonicalRoom", () => {
  it("uses the server-resolved room on the room agent summary", () => {
    expect(
      runnerVoiceCanonicalRoom(
        room([
          {
            participant_id: "p-seat",
            agent_id: "persephone",
            display_name: "Persephone",
            voice_canonical_room: { id: "canonical-1", name: "Persephone · Desk" },
          },
        ]),
      ),
    ).toEqual({ id: "canonical-1", name: "Persephone · Desk" });
  });

  it("falls back to the active room member payload", () => {
    const members = [
      {
        participant_id: "p-seat",
        username: "persephone",
        display_name: "Persephone",
        participant_type: "agent",
        role: "member",
        joined_at: "",
        voice_canonical_room: { id: "canonical-1", name: "Persephone · Desk" },
      } as RoomMember,
    ];
    expect(runnerVoiceCanonicalRoom(room(), members)).toEqual({
      id: "canonical-1",
      name: "Persephone · Desk",
    });
  });
});
