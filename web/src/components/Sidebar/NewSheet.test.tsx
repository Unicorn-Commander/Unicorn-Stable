import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { Agent, PeopleDirectoryEntry, Room } from "@/services/api";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useConversationUi } from "@/stores/conversationUiStore";
import { CREW_FIXTURE, PERSEPHONE_HUB_ID } from "@/mocks/crewFixture";
import { NewSheet } from "./NewSheet";

function room(over: Partial<Room> & { id: string }): Room {
  return {
    name: over.id,
    description: "",
    type: "channel",
    created_at: "2026-09-28T00:00:00Z",
    updated_at: "2026-09-28T00:00:00Z",
    member_count: 2,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
    ...over,
  };
}

const hub = room({
  id: PERSEPHONE_HUB_ID,
  name: "Persephone",
  type: "agent_hub",
  counterpart: { participant_id: "p-persephone", kind: "agent", display_name: "Persephone", agent_id: "persephone" },
  metadata_: { agent_hub: { human_id: "p-aaron", agent_id: "persephone" } },
});
const taxsq = room({ id: "room-taxsq", name: "taxsq-portal", display_name: "taxsq-portal", brigade_agent_ids: ["shafen-claude-code"] });
const harmony = {
  id: "harmony",
  name: "Harmony",
  display_name: "Harmony",
  description: "",
  avatar_url: null,
  status: "active",
  capabilities: [],
  model: "",
  title: "Voice of the house",
  availability: "available",
} as Agent;
const shafen = { id: "u-shafen", username: "shafen", display_name: "Shafen Khan", avatar_url: null, is_online: true } as unknown as PeopleDirectoryEntry;

function Probe() {
  return <span data-testid="probe-path">{useLocation().pathname}</span>;
}

let client: QueryClient;
const spies: Array<{ mockRestore: () => void }> = [];
function spy<T extends { mockRestore: () => void }>(s: T): T {
  spies.push(s);
  return s;
}

function renderSheet() {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <NewSheet />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("New sheet To box", () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    spy(vi.spyOn(api, "getCrew")).mockResolvedValue(CREW_FIXTURE);
    spy(vi.spyOn(api, "getPeopleDirectory")).mockResolvedValue([shafen]);
    spy(vi.spyOn(api, "browseChannels")).mockResolvedValue([]);
    useAppStore.setState({ rooms: [hub, taxsq], agents: [harmony], currentParticipantId: "p-aaron", toasts: [] });
    useConversationUi.getState().openNewSheet();
  });

  afterEach(() => {
    cleanup();
    for (const item of spies.splice(0)) item.mockRestore();
    useConversationUi.getState().closeNewSheet();
    useAppStore.setState({ rooms: [], agents: [], currentParticipantId: null, toasts: [] });
  });

  it("opens on one To box with the crew first and the six starts beneath it", async () => {
    renderSheet();
    const input = await screen.findByTestId("new-sheet-to");
    expect(input.getAttribute("role")).toBe("combobox");
    const crewGroup = await screen.findByTestId("new-sheet-picks-crew");
    const names = within(crewGroup).getAllByRole("option").map((el) => el.textContent ?? "");
    expect(names[0]).toContain("Persephone");
    expect(names).toHaveLength(6);
    for (const id of ["person", "agent", "thread", "channel", "project", "call"]) {
      expect(screen.getByTestId(`new-sheet-action-${id}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("new-sheet-picks-people")).toBeNull();
  });

  it("finds a house agent you have never talked to, from the roster, after the crew", async () => {
    renderSheet();
    const input = await screen.findByTestId("new-sheet-to");
    fireEvent.change(input, { target: { value: "harm" } });
    const crewGroup = await screen.findByTestId("new-sheet-picks-crew");
    expect(within(crewGroup).getAllByRole("option").map((el) => el.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Harmony")]),
    );
    expect(screen.queryByTestId("new-sheet-no-match")).toBeNull();
  });

  it("debounces the directory search and walks the matches with the keyboard", async () => {
    renderSheet();
    const input = await screen.findByTestId("new-sheet-to");
    fireEvent.change(input, { target: { value: "s" } });
    fireEvent.change(input, { target: { value: "sh" } });
    fireEvent.change(input, { target: { value: "sha" } });
    // Crew filters at once; the directory waits for the query to hold still.
    expect(within(screen.getByTestId("new-sheet-picks-crew")).getAllByRole("option")).toHaveLength(3);
    expect(api.getPeopleDirectory).not.toHaveBeenCalled();
    await screen.findByTestId("new-sheet-picks-people");
    expect(api.getPeopleDirectory).toHaveBeenCalledTimes(1);
    expect(api.getPeopleDirectory).toHaveBeenCalledWith("sha");

    // ArrowDown lands on Flow; the input points at it; Enter opens the shared room.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const flow = document.getElementById("new-sheet-pick-crew-shafen-claude-code");
    expect(flow?.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe("new-sheet-pick-crew-shafen-claude-code");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(document.getElementById("new-sheet-pick-person-u-shafen")?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(screen.getByTestId("probe-path")).toHaveTextContent("/c/room-taxsq"));
    expect(useConversationUi.getState().newSheetOpen).toBe(false);
  });

  it("leaves Enter to an IME that is composing (review 2, P2-4)", async () => {
    renderSheet();
    const input = await screen.findByTestId("new-sheet-to");
    fireEvent.change(input, { target: { value: "persephone" } });
    await screen.findByTestId("new-sheet-picks-crew");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    });
    expect(screen.getByTestId("probe-path")).toHaveTextContent("/");
    expect(screen.getByTestId("probe-path")).not.toHaveTextContent(PERSEPHONE_HUB_ID);
    expect(useConversationUi.getState().newSheetOpen).toBe(true);
  });

  it("Enter with nothing highlighted opens the first match", async () => {
    renderSheet();
    const input = await screen.findByTestId("new-sheet-to");
    fireEvent.change(input, { target: { value: "persephone" } });
    await screen.findByTestId("new-sheet-picks-crew");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(screen.getByTestId("probe-path")).toHaveTextContent(`/c/${PERSEPHONE_HUB_ID}`));
  });
});
