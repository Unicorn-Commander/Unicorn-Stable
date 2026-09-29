import { describe, expect, it } from "vitest";
import type { Message, Room } from "@/services/api";
import { toMarkdown } from "./exportRoom";

const room = {
  id: "room-ops",
  name: "ops",
  display_name: "ops",
  members: [
    { participant_id: "p-aaron", username: "aaron", display_name: "Aaron Stransky", role: "owner", joined_at: "" },
  ],
} as unknown as Room;

function message(over: Partial<Message>): Message {
  return {
    id: "m",
    room_id: "room-ops",
    sender_id: "p-aaron",
    sender_type: "human",
    sender_name: "Aaron Stransky",
    sender_avatar: null,
    content: "hello",
    content_type: "text",
    thread_id: null,
    reply_count: 0,
    edited: false,
    created_at: "2026-09-29T01:00:00Z",
    updated_at: "2026-09-29T01:00:00Z",
    ...over,
  } as Message;
}

describe("the room export", () => {
  it("writes a system line as the sentence the room draws", () => {
    const md = toMarkdown(room, [
      message({ id: "1" }),
      message({
        id: "2",
        content: "Channel thread started",
        content_type: "system",
        metadata: { kind: "thread_started", thread_title: "Launch checklist", created_by: "p-aaron" },
      }),
      message({
        id: "3",
        sender_id: "",
        sender_type: "system",
        sender_name: "",
        content: "Audio recording stopped",
        content_type: "system",
        metadata: { kind: "recording", event: "stopped", started_by: "p-aaron", reason: "room_idle" },
      }),
      message({ id: "4", sender_id: "", sender_type: "system", sender_name: "", content: "Majik joined", content_type: "system" }),
    ]);
    expect(md).toContain("> _Aaron Stransky started a thread: Launch checklist_");
    expect(md).toContain("> _Audio recording stopped · the room went idle · started by Aaron Stransky_");
    expect(md).toContain("> _Majik joined_");
    expect(md).not.toContain("Channel thread started");
    expect(md).toContain("**Aaron Stransky** ·");
  });
});
