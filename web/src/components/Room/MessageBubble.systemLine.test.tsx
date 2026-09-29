import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Message, RoomMember } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { MessageBubble } from "./MessageBubble";

const ROOM = "room-ops";
const AARON: RoomMember = {
  participant_id: "p-aaron",
  username: "aaron",
  display_name: "Aaron Stransky",
  role: "owner",
  participant_type: "human",
  joined_at: "",
};

function line(over: Partial<Message>): Message {
  return {
    id: "m-1",
    room_id: ROOM,
    // A notice is a NULL-sender line: the server sends null, not "".
    sender_id: null as unknown as string,
    sender_type: "system",
    sender_name: "",
    sender_avatar: null,
    content: "Audio recording started",
    content_type: "system",
    thread_id: null,
    reply_count: 0,
    edited: false,
    created_at: "2026-09-29T01:00:00Z",
    updated_at: "2026-09-29T01:00:00Z",
    ...over,
  } as Message;
}

function show(message: Message) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MessageBubble
          message={message}
          isOwn={false}
          showAvatar
          onEdit={async () => true}
          onDelete={async () => undefined}
          onReply={() => undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAppStore.setState({ participants: { [ROOM]: [AARON] } });
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ participants: {} });
});

describe("a system line in the member room", () => {
  it("names a recording's starter from metadata.started_by and says the reason", () => {
    show(
      line({
        metadata: { kind: "recording", event: "started", recording_kind: "audio", started_by: "p-aaron", reason: "user" },
      }),
    );
    expect(screen.getByTestId("system-line").textContent).toBe("Audio recording started · by Aaron Stransky");
  });

  it("says why it stopped, and what failed", () => {
    const { unmount } = show(
      line({
        content: "Video recording stopped",
        metadata: { kind: "recording", event: "stopped", recording_kind: "composite", started_by: "p-aaron", reason: "room_idle" },
      }),
    );
    expect(screen.getByTestId("system-line").textContent).toBe(
      "Video recording stopped · the room went idle · started by Aaron Stransky",
    );
    unmount();
    show(
      line({
        content: "Recording failed",
        metadata: { kind: "recording", event: "failed", recording_id: "r", egress_id: "EG_1", reason: "egress crashed: no track" },
      }),
    );
    expect(screen.getByTestId("system-line").textContent).toBe("Recording failed · egress crashed: no track");
  });

  it("falls back to the server's words when the roster cannot resolve the id", () => {
    useAppStore.setState({ participants: {} });
    show(
      line({
        metadata: { kind: "recording", event: "started", recording_kind: "audio", started_by: "p-aaron", reason: "user" },
      }),
    );
    expect(screen.getByTestId("system-line").textContent).toBe("Audio recording started");
  });

  it("draws the parent's thread line from thread_title and created_by, under a real sender", () => {
    show(
      line({
        sender_id: "p-aaron",
        sender_type: "human",
        sender_name: "Aaron Stransky",
        content: "Channel thread started",
        metadata: {
          kind: "thread_started",
          thread_room_id: "room-ops-t-1",
          thread_title: "Launch checklist",
          created_by: "p-aaron",
          seed_message_id: null,
        },
      }),
    );
    expect(screen.getByTestId("system-line").textContent).toBe(
      "Aaron Stransky started a thread: Launch checklist",
    );
    // Not the creator's bubble with the server's closed-vocabulary words.
    expect(screen.queryByText("Channel thread started")).toBeNull();
  });

  it("draws any other system line as it is", () => {
    show(line({ content: "Majik Mane joined the room", metadata: {} }));
    expect(screen.getByTestId("system-line").textContent).toBe("Majik Mane joined the room");
  });
});
