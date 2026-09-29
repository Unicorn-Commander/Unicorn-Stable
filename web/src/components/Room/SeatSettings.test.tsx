import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { api, type Room } from "@/services/api";
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

let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Harness({ room, match, onNoSeat }: { room: Room; match: SeatMemberMatch; onNoSeat?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <QueryClientProvider client={client}>
      <SeatSettings roomId={room.id} room={room} match={match} open={open} onOpenChange={setOpen} onNoSeat={onNoSeat} />
    </QueryClientProvider>
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("SeatSettings", () => {
  const room = hub();
  const match = findSeatMember(room, [PERSEPHONE_MEMBER], CREW_FIXTURE)!;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useAppStore.setState({ rooms: [room], participants: { [room.id]: [PERSEPHONE_MEMBER] } });
  });

  afterEach(() => {
    // Unmount before the store reset, or the reset is a state update on a
    // mounted component outside act().
    cleanup();
    vi.restoreAllMocks();
    useAppStore.setState({ rooms: [], participants: {}, toasts: [] });
  });

  it("shows the default brain and names it in the popover", () => {
    render(<Harness room={room} match={match} />);
    const chip = screen.getByTestId("seat-chip");
    expect(chip).toHaveTextContent("Fable 5.1 · high");
    expect(chip.getAttribute("data-editable")).toBe("true");
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Seat settings" });
    expect(dialog).toBeTruthy();
    expect(screen.getByTestId("seat-default")).toHaveTextContent("Default (Fable 5.1 · high)");
    expect(screen.getByTestId("seat-default").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("seat-effort-high").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("seat-mode-answers_all").getAttribute("aria-checked")).toBe("true");
  });

  it("writes model then effort through PATCH /rooms/{id} and updates the chip optimistically", async () => {
    const update = vi
      .spyOn(api, "updateRoom")
      .mockImplementation(async (_id, patch) => hub({ metadata_: patch.metadata ?? {} }));
    render(<Harness room={room} match={match} />);
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
    expect(screen.getByTestId("seat-default").getAttribute("aria-checked")).toBe("false");
    // Default clears both.
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-default"));
    });
    expect(update).toHaveBeenLastCalledWith(PERSEPHONE_HUB_ID, {
      metadata: { seats: { persephone: { model: null, effort: null } } },
    });
    await waitFor(() => expect(screen.getByTestId("seat-chip")).toHaveTextContent("Fable 5.1 · high"));
  });

  it("writes the mode through the member row", async () => {
    const setMode = vi
      .spyOn(api, "setAgentMode")
      .mockImplementation(async (_room, pid, mode) => ({ ...PERSEPHONE_MEMBER, participant_id: pid, agent_mode: mode }));
    render(<Harness room={room} match={match} />);
    fireEvent.click(screen.getByTestId("seat-chip"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-mode-listening"));
    });
    expect(setMode).toHaveBeenCalledWith(PERSEPHONE_HUB_ID, "p-persephone", "listening");
    await waitFor(() =>
      expect(screen.getByTestId("seat-mode-listening").getAttribute("aria-checked")).toBe("true"),
    );
    expect(useAppStore.getState().participants[PERSEPHONE_HUB_ID]?.[0]?.agent_mode).toBe("listening");
  });

  it("reverts and hands back a 409, and toasts a 403", async () => {
    const onNoSeat = vi.fn();
    vi.spyOn(api, "updateRoom").mockRejectedValueOnce({ status: 409, message: "Conflict", detail: "no seat" });
    render(<Harness room={room} match={match} onNoSeat={onNoSeat} />);
    fireEvent.click(screen.getByTestId("seat-chip"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-model-claude-opus-5-5"));
    });
    await waitFor(() => expect(onNoSeat).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().rooms[0]?.metadata_).toEqual({});
    expect(screen.getByTestId("seat-chip")).toHaveTextContent("Fable 5.1 · high");
    expect(useAppStore.getState().toasts).toHaveLength(0);

    vi.spyOn(api, "updateRoom").mockRejectedValueOnce({ status: 403, message: "Forbidden", detail: "not allowed" });
    fireEvent.click(screen.getByTestId("seat-chip"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("seat-effort-max"));
    });
    await waitFor(() => expect(useAppStore.getState().toasts.length).toBe(1));
    expect(useAppStore.getState().toasts[0]?.title).toBe("Only the seat's owner can change this");
    expect(useAppStore.getState().rooms[0]?.metadata_).toEqual({});
  });

  it("shows a partner's seat read-only", () => {
    const flow = CREW_FIXTURE.find((m) => m.agent_id === "shafen-claude-code")!;
    const partner: SeatMemberMatch = { member: flow, participantId: flow.participant_id, editable: false, agentMode: null };
    render(<SeatSettings roomId={room.id} room={room} match={partner} open={false} onOpenChange={() => {}} />, {
      wrapper: Wrapper,
    });
    const chip = screen.getByTestId("seat-chip");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("data-editable")).toBe("false");
    expect(chip).toHaveTextContent("Fable 5.1 · high");
    expect(chip.getAttribute("title")).toContain("Shafen’s seat");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
