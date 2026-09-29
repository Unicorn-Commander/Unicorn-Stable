import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useRecordingStore } from "@/stores/recordingStore";
import { useRecordingReceipts } from "./useRecordingReceipts";

const { listeners } = vi.hoisted(() => ({
  listeners: new Map<string, (data: unknown) => void>(),
}));
vi.mock("@/services/websocket", () => ({
  ws: {
    on: (event: string, callback: (data: unknown) => void) => {
      listeners.set(event, callback);
      return () => listeners.delete(event);
    },
  },
}));
vi.mock("@/lib/sounds", () => ({ playCue: vi.fn() }));

const ROOM = "room-ops";

function Probe() {
  useRecordingReceipts();
  return null;
}

function mount() {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
}

/** The frame as the server sends it: the starter is {id, display_name}. */
function frame(active: boolean, recordingId: string | null = "rec-1") {
  act(() => {
    listeners.get("recording_state")?.({
      room_id: ROOM,
      active,
      kind: "audio",
      started_by: { id: "p-aaron", display_name: "Aaron Stransky" },
      started_at: "2026-09-29T01:00:00Z",
      ...(recordingId ? { recording_id: recordingId } : {}),
      reason: active ? "user" : "stop_requested",
    });
  });
}

function persisted(
  event: "started" | "stopped",
  over: { at?: string; recordingId?: string | null } = {},
): Message {
  const now = over.at ?? new Date().toISOString();
  const recordingId = over.recordingId === undefined ? "rec-1" : over.recordingId;
  return {
    id: `msg-${event}`,
    room_id: ROOM,
    sender_id: "",
    sender_type: "system",
    sender_name: "",
    sender_avatar: null,
    content: `Audio recording ${event}`,
    content_type: "system",
    thread_id: null,
    reply_count: 0,
    edited: false,
    created_at: now,
    updated_at: now,
    metadata: {
      kind: "recording",
      event,
      recording_kind: "audio",
      started_by: "p-aaron",
      reason: "user",
      ...(recordingId ? { recording_id: recordingId } : {}),
    },
  } as Message;
}

const lines = () => (useAppStore.getState().messages[ROOM]?.items ?? []).map((m) => m.id);

beforeEach(() => {
  listeners.clear();
  useAppStore.setState({ messages: {}, participants: {} });
  useRecordingStore.setState({ byRoom: {} });
});
afterEach(cleanup);

describe("the local recording receipt and the server's persisted notice", () => {
  it("draws the receipt when the server writes no notice (an older server)", () => {
    mount();
    frame(true);
    expect(lines()).toEqual([`recording:${ROOM}:start:2026-09-29T01:00:00Z`]);
  });

  it("adds no receipt when the persisted notice is already in the room", () => {
    mount();
    useAppStore.getState().addMessage(ROOM, persisted("started"));
    frame(true);
    expect(lines()).toEqual(["msg-started"]);
  });

  it("drops the receipt when the persisted notice arrives after it", () => {
    mount();
    frame(true);
    expect(lines()).toHaveLength(1);
    act(() => useAppStore.getState().addMessage(ROOM, persisted("started")));
    expect(lines()).toEqual(["msg-started"]);
    // The stop is its own transition with its own pair.
    frame(false);
    expect(lines()).toEqual(["msg-started", `recording:${ROOM}:stop:2026-09-29T01:00:00Z`]);
    act(() => useAppStore.getState().addMessage(ROOM, persisted("stopped")));
    expect(lines()).toEqual(["msg-started", "msg-stopped"]);
  });

  it("names the starter from the frame's {id, display_name}", () => {
    mount();
    frame(true);
    expect(useAppStore.getState().messages[ROOM]?.items[0]?.content).toBe(
      "Recording started · audio · started by Aaron Stransky",
    );
  });

  it("finds its notice by the recording's id when the clocks disagree", () => {
    mount();
    frame(true);
    // The server's clock is two hours from this device's.
    act(() =>
      useAppStore
        .getState()
        .addMessage(ROOM, persisted("started", { at: new Date(Date.now() - 2 * 3_600_000).toISOString() })),
    );
    expect(lines()).toEqual(["msg-started"]);
  });

  it("keeps the receipt of another recording", () => {
    mount();
    frame(true, "rec-2");
    act(() =>
      useAppStore.getState().addMessage(ROOM, { ...persisted("started"), id: "msg-other" }),
    );
    expect(lines()).toEqual([`recording:${ROOM}:start:2026-09-29T01:00:00Z`, "msg-other"]);
  });
});
