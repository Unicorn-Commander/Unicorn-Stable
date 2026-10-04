import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Room, type RoomMember } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { RecordingSettingsModal } from "./RecordingSettingsModal";

const ROOM_ID = "room-1";
const OWNER: RoomMember = {
  participant_id: "p-aaron",
  username: "aaron",
  display_name: "Aaron",
  role: "owner",
  is_self: true,
  joined_at: "2026-09-21T18:00:00Z",
};

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: ROOM_ID,
    name: "general",
    description: "",
    type: "channel",
    created_at: "",
    updated_at: "",
    member_count: 1,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
    recording_policy: "always",
    recording_kind: "audio",
    ...overrides,
  };
}

let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const spies: Array<{ mockRestore: () => void }> = [];

function spy<T extends { mockRestore: () => void }>(value: T): T {
  spies.push(value);
  return value;
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderModal() {
  return render(
    <RecordingSettingsModal roomId={ROOM_ID} roomName="general" onClose={vi.fn()} />,
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const currentRoom = room();
  client.setQueryData(["room", ROOM_ID], currentRoom);
  client.setQueryData(["room-members", ROOM_ID], [OWNER]);
  useAppStore.setState({ rooms: [currentRoom], toasts: [] });
  spy(vi.spyOn(api, "getRoom")).mockResolvedValue(currentRoom);
  spy(vi.spyOn(api, "getRoomMembers")).mockResolvedValue([OWNER]);
});

afterEach(() => {
  cleanup();
  for (const item of spies.splice(0)) item.mockRestore();
  useAppStore.setState({ rooms: [], participants: {}, toasts: [] });
});

describe("RecordingSettingsModal format", () => {
  it("offers Audio and Video, never track, and PATCHes composite for Video", async () => {
    const update = spy(vi.spyOn(api, "updateRecordingKind")).mockResolvedValue({
      recording_kind: "composite",
    });
    renderModal();

    expect(screen.getByRole("radio", { name: "Audio" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Video" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Track" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Video" }));

    expect(update).toHaveBeenCalledWith(ROOM_ID, "composite");
    await waitFor(() =>
      expect(client.getQueryData<Room>(["room", ROOM_ID])?.recording_kind).toBe("composite"),
    );
  });

  it("rolls a failed Video PATCH back to Audio in the query and store", async () => {
    spy(vi.spyOn(api, "updateRecordingKind")).mockRejectedValue({
      status: 503,
      message: "Unavailable",
      detail: "Recording service is unavailable",
    });
    renderModal();
    fireEvent.click(screen.getByRole("radio", { name: "Video" }));

    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    expect(client.getQueryData<Room>(["room", ROOM_ID])?.recording_kind).toBe("audio");
    expect(useAppStore.getState().rooms[0]?.recording_kind).toBe("audio");
    expect(screen.getByRole("radio", { name: "Audio" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("does not show the format choice when recording is off", () => {
    const currentRoom = room({ recording_policy: "off" });
    client.setQueryData(["room", ROOM_ID], currentRoom);
    useAppStore.setState({ rooms: [currentRoom] });
    renderModal();

    expect(screen.queryByTestId("recording-format")).toBeNull();
  });
});
