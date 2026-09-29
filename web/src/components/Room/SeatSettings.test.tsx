import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { api, type Room, type RoomMember } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { CREW_FIXTURE, PERSEPHONE_HUB_ID, PERSEPHONE_MEMBER } from "@/mocks/crewFixture";
import { findSeatMember, type SeatMemberMatch } from "@/lib/seatSettings";
import { SeatSettings } from "./SeatSettings";

function hub(over: Partial<Room> = {}): Room {
  return {
    id: PERSEPHONE_HUB_ID,
    name: "Persephone",
    description: "",
    type: "agent_hub",
    created_at: "",
    updated_at: "",
    member_count: 2,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
    counterpart: {
      participant_id: "p-persephone",
      kind: "agent",
      display_name: "Persephone",
      agent_id: "persephone",
    },
    agent_members: [
      { participant_id: "p-persephone", agent_id: "persephone", display_name: "Persephone", agent_mode: "answers_all" },
    ],
    metadata_: {},
    ...over,
  };
}

/** The members row as the server sent it before Lane A's fix: no agent_mode, no metadata. */
const BARE_MEMBER: RoomMember = {
  participant_id: "p-persephone",
  username: "agent-persephone",
  display_name: "Persephone",
  avatar_url: null,
  role: "member",
  participant_type: "agent",
  is_online: true,
  joined_at: "2026-09-03T15:00:00Z",
};

let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
// Only our own spies are restored: vi.restoreAllMocks() would also wipe the
// setup file's matchMedia / getComputedStyle stubs, which role queries need.
const spies: Array<{ mockRestore: () => void }> = [];
function spy<T extends { mockRestore: () => void }>(s: T): T {
  spies.push(s);
  return s;
}

function Harness({
  match,
  onNoSeat,
  canEditMode = true,
  labelled = false,
}: {
  match: SeatMemberMatch;
  onNoSeat?: () => void;
  canEditMode?: boolean;
  labelled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The room detail as RoomView passes it: a live subscription to the query,
  // so a setQueryData re-renders here exactly as it does in the room.
  const { data: room = null } = useQuery({
    queryKey: ["room", PERSEPHONE_HUB_ID],
    queryFn: async () => hub(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <SeatSettings
      roomId={PERSEPHONE_HUB_ID}
      room={room}
      match={match}
      open={open}
      onOpenChange={setOpen}
      onNoSeat={onNoSeat}
      canEditMode={canEditMode}
      labelled={labelled}
    />
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderSeat(props: Omit<Parameters<typeof Harness>[0], "match"> & { match?: SeatMemberMatch }) {
  const match = props.match ?? findSeatMember(hub(), [PERSEPHONE_MEMBER], CREW_FIXTURE)!;
  return render(<Harness {...props} match={match} />, { wrapper: Wrapper });
}

describe("SeatSettings", () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["room", PERSEPHONE_HUB_ID], hub());
    useAppStore.setState({ rooms: [hub()], participants: { [PERSEPHONE_HUB_ID]: [PERSEPHONE_MEMBER] }, toasts: [] });
  });

  afterEach(() => {
    // Unmount before the store reset, or the reset is a state update on a
    // mounted component outside act().
    cleanup();
    for (const item of spies.splice(0)) item.mockRestore();
    useAppStore.setState({ rooms: [], participants: {}, toasts: [] });
  });

  it("shows the default brain and names it in the popover, with radios in a dialog", () => {
    renderSeat({});
    const chip = screen.getByTestId("seat-chip");
    expect(chip).toHaveTextContent("Fable 5.1 · high");
    expect(chip.getAttribute("data-editable")).toBe("true");
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Seat settings for Persephone" });
    expect(dialog).toBeTruthy();
    expect(screen.getByTestId("seat-default")).toHaveTextContent("Default (Fable 5.1 · high)");
    expect(screen.getByTestId("seat-default")).toHaveTextContent("Persephone's own settings");
    expect(screen.getByTestId("seat-default")).not.toHaveTextContent("claude-code");
    expect(screen.getByTestId("seat-default").getAttribute("role")).toBe("radio");
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    expect(screen.getAllByRole("radiogroup")).toHaveLength(2);
    expect(screen.getByTestId("seat-default").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("seat-mode-answers_all").getAttribute("aria-checked")).toBe("true");
  });

  it("writes model then effort through PATCH /rooms/{id} and updates the chip optimistically", async () => {
    const update = spy(vi.spyOn(api, "updateRoom")).mockImplementation(
      async (_id, patch) => hub({ metadata_: patch.metadata ?? {} }),
    );
    renderSeat({});
    fireEvent.click(screen.getByTestId("seat-chip"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-model-claude-opus-5-5"));
    });
    expect(update).toHaveBeenLastCalledWith(PERSEPHONE_HUB_ID, {
      metadata: { seats: { persephone: { model: "claude-opus-5-5", effort: null } } },
    });
    await waitFor(() => expect(screen.getByTestId("seat-chip")).toHaveTextContent("Opus 5.5 · high"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-effort-medium"));
    });
    expect(update).toHaveBeenLastCalledWith(PERSEPHONE_HUB_ID, {
      metadata: { seats: { persephone: { model: "claude-opus-5-5", effort: "medium" } } },
    });
    await waitFor(() => expect(screen.getByTestId("seat-chip")).toHaveTextContent("Opus 5.5 · medium"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-default"));
    });
    expect(update).toHaveBeenLastCalledWith(PERSEPHONE_HUB_ID, {
      metadata: { seats: { persephone: { model: null, effort: null } } },
    });
    await waitFor(() => expect(screen.getByTestId("seat-chip")).toHaveTextContent("Fable 5.1 · high"));
  });

  it("mode survives a members refetch shaped like the real server (no agent_mode on the rows)", async () => {
    // The PATCH answers with the bare row; the members refetch replaces the
    // roster with bare rows. The mode lives on the room's own agents[] row,
    // so it neither crashes nor reverts.
    const setMode = spy(vi.spyOn(api, "setAgentMode")).mockResolvedValue({ ...BARE_MEMBER });
    useAppStore.setState({ participants: { [PERSEPHONE_HUB_ID]: [BARE_MEMBER] } });
    renderSeat({});
    fireEvent.click(screen.getByTestId("seat-chip"));
    expect(screen.getByTestId("seat-mode-answers_all").getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-mode-listening"));
    });
    expect(setMode).toHaveBeenCalledWith(PERSEPHONE_HUB_ID, "p-persephone", "listening");
    await waitFor(() =>
      expect(screen.getByTestId("seat-mode-listening").getAttribute("aria-checked")).toBe("true"),
    );
    // The members refetch lands with bare rows.
    await act(async () => {
      useAppStore.getState().setParticipants(PERSEPHONE_HUB_ID, [{ ...BARE_MEMBER }]);
    });
    expect(screen.getByTestId("seat-mode-listening").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("seat-mode-answers_all").getAttribute("aria-checked")).toBe("false");
    const roomRow = client.getQueryData<Room>(["room", PERSEPHONE_HUB_ID]);
    expect(roomRow?.agent_members?.[0]?.agent_mode).toBe("listening");
    expect(useAppStore.getState().rooms[0]?.agent_members?.[0]?.agent_mode).toBe("listening");
  });

  it("mode with the post-fix members shape: the row's agent_mode is written and read back", async () => {
    const setMode = spy(vi.spyOn(api, "setAgentMode")).mockImplementation(
      async (_room, pid, mode) => ({ ...PERSEPHONE_MEMBER, participant_id: pid, agent_mode: mode }),
    );
    renderSeat({});
    fireEvent.click(screen.getByTestId("seat-chip"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-mode-muted"));
    });
    expect(setMode).toHaveBeenCalledWith(PERSEPHONE_HUB_ID, "p-persephone", "muted");
    await waitFor(() => expect(screen.getByTestId("seat-mode-muted").getAttribute("aria-checked")).toBe("true"));
    expect(useAppStore.getState().participants[PERSEPHONE_HUB_ID]?.[0]?.agent_mode).toBe("muted");
  });

  it("a failed mode write reverts every copy", async () => {
    spy(vi.spyOn(api, "setAgentMode")).mockRejectedValueOnce({ status: 403, message: "Forbidden", detail: "Not authorized" });
    renderSeat({});
    fireEvent.click(screen.getByTestId("seat-chip"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-mode-listening"));
    });
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    expect(screen.getByTestId("seat-mode-answers_all").getAttribute("aria-checked")).toBe("true");
    expect(client.getQueryData<Room>(["room", PERSEPHONE_HUB_ID])?.agent_members?.[0]?.agent_mode).toBe("answers_all");
  });

  it("offers Mode only to a room owner or admin; others read it", () => {
    renderSeat({ canEditMode: false });
    fireEvent.click(screen.getByTestId("seat-chip"));
    expect(screen.queryByTestId("seat-mode-listening")).toBeNull();
    expect(screen.getByTestId("seat-mode-readonly")).toHaveTextContent("Answers everyone");
    expect(screen.getAllByRole("radiogroup")).toHaveLength(1);
  });

  it("409: 'no seat' reverts and hands back; 'archived' keeps the chip and says so; 403 toasts", async () => {
    const onNoSeat = vi.fn();
    spy(vi.spyOn(api, "updateRoom")).mockRejectedValueOnce({ status: 409, message: "Conflict", detail: "no runner seat in this room" });
    renderSeat({ onNoSeat });
    fireEvent.click(screen.getByTestId("seat-chip"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-model-claude-opus-5-5"));
    });
    await waitFor(() => expect(onNoSeat).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().rooms[0]?.metadata_).toEqual({});
    expect(screen.getByTestId("seat-chip")).toHaveTextContent("Fable 5.1 · high");
    expect(useAppStore.getState().toasts).toHaveLength(0);

    spy(vi.spyOn(api, "updateRoom")).mockRejectedValueOnce({ status: 409, message: "Conflict", detail: "room is archived" });
    fireEvent.click(screen.getByTestId("seat-chip"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-effort-max"));
    });
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    expect(useAppStore.getState().toasts[0]?.title).toBe("This room is archived — its seats can't change here");
    expect(onNoSeat).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("seat-chip")).toBeTruthy();

    spy(vi.spyOn(api, "updateRoom")).mockRejectedValueOnce({ status: 403, message: "Forbidden", detail: "ask the seat's owner" });
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-effort-max"));
    });
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(2));
    expect(useAppStore.getState().toasts[1]?.title).toBe("Only the seat's owner can change this");
    expect(useAppStore.getState().rooms[0]?.metadata_).toEqual({});
  });

  it("labels the chip with the seat's name when the room holds several seats", () => {
    renderSeat({ labelled: true });
    expect(screen.getByTestId("seat-chip")).toHaveTextContent("Persephone · Fable 5.1 · high");
  });

  it("shows a partner's seat locked, with the owner's name in the text", () => {
    const flow = CREW_FIXTURE.find((m) => m.agent_id === "shafen-claude-code")!;
    const partner: SeatMemberMatch = { member: flow, participantId: flow.participant_id, editable: false, agentMode: null };
    render(
      <SeatSettings
        roomId={PERSEPHONE_HUB_ID}
        room={hub()}
        match={partner}
        open={false}
        onOpenChange={() => {}}
        canEditMode
        labelled
      />,
      { wrapper: Wrapper },
    );
    const chip = screen.getByTestId("seat-chip");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("data-editable")).toBe("false");
    expect(chip).toHaveTextContent("Shafen’s Flow · Fable 5.1 · high");
    expect(chip.querySelector('[data-testid="seat-chip-lock"]')).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
