import { describe, expect, it } from "vitest";
import { mapRoomListItem, type RawRoomListItem } from "./api";

function raw(over: Partial<RawRoomListItem> = {}): RawRoomListItem {
  return {
    id: "room-1",
    name: "dm-a-b",
    display_name: "Chat with Majik",
    description: null,
    room_type: "dm",
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T01:00:00Z",
    member_count: 2,
    ...over,
  };
}

describe("mapRoomListItem", () => {
  it("reads is_archived from the server row instead of stamping it", () => {
    // The original archived mapper hardcoded is_archived: true onto whatever
    // the server returned — with the (then-ignored) query param, that stamped
    // the caller's ENTIRE live room list as archived.
    expect(mapRoomListItem(raw({ is_archived: true })).is_archived).toBe(true);
    expect(mapRoomListItem(raw({ is_archived: false })).is_archived).toBe(false);
    expect(mapRoomListItem(raw()).is_archived).toBe(false);
  });

  it("carries metadata_ through for persisted-flag guards (auto_titled)", () => {
    const room = mapRoomListItem(
      raw({ metadata_: { auto_titled: true, brigade_agent_id: "majik" } }),
    );
    expect(room.metadata_).toEqual({
      auto_titled: true,
      brigade_agent_id: "majik",
    });
    expect(mapRoomListItem(raw()).metadata_).toBeNull();
  });

  it("extracts brigade_agent_id only when it is a string", () => {
    expect(
      mapRoomListItem(raw({ metadata_: { brigade_agent_id: "majik" } }))
        .brigade_agent_id,
    ).toBe("majik");
    expect(
      mapRoomListItem(raw({ metadata_: { brigade_agent_id: 42 } }))
        .brigade_agent_id,
    ).toBeNull();
    expect(mapRoomListItem(raw()).brigade_agent_id).toBeNull();
  });

  it("maps display_name into name with slug fallback and defaults extras", () => {
    const room = mapRoomListItem(raw());
    expect(room.name).toBe("Chat with Majik");
    expect(room.display_name).toBe("Chat with Majik");
    expect(room.unread_count).toBe(0);
    expect(room.online_count).toBe(0);
    expect(room.last_message).toBeNull();
    expect(room.members).toEqual([]);
    expect(room.agents).toEqual([]);
    expect(mapRoomListItem(raw({ display_name: "" })).name).toBe("dm-a-b");
  });

  it("reads the recording policy and defaults a missing one to off", () => {
    expect(mapRoomListItem(raw({ recording_policy: "always" })).recording_policy).toBe(
      "always",
    );
    expect(mapRoomListItem(raw({ recording_kind: "composite" })).recording_kind).toBe(
      "composite",
    );
    expect(mapRoomListItem(raw()).recording_policy).toBe("off");
    expect(mapRoomListItem(raw({ recording_policy: "sometimes" })).recording_policy).toBe(
      "off",
    );
  });

  it("flags conference rooms from metadata", () => {
    expect(
      mapRoomListItem(raw({ metadata_: { conference: true } })).is_conference,
    ).toBe(true);
    expect(mapRoomListItem(raw()).is_conference).toBe(false);
  });
});
