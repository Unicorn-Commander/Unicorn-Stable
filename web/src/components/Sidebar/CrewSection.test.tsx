import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Room } from "@/services/api";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useSidebarUi } from "@/stores/sidebarUiStore";
import { CREW_FIXTURE, PERSEPHONE_HUB_ID } from "@/mocks/crewFixture";
import { CrewSection, SEAT_CALL_UNAVAILABLE } from "./CrewSection";

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
  unread_count: 1,
  counterpart: { participant_id: "p-persephone", kind: "agent", display_name: "Persephone", agent_id: "persephone" },
  metadata_: { agent_hub: { human_id: "p-aaron", agent_id: "persephone" } },
});
const thread = room({
  id: `${PERSEPHONE_HUB_ID}-t-1`,
  name: "Kitchen panel plan",
  type: "agent_hub",
  parent_room_id: PERSEPHONE_HUB_ID,
  unread_count: 2,
});
const taxsq = room({
  id: "room-taxsq",
  name: "taxsq-portal",
  display_name: "taxsq-portal",
  brigade_agent_ids: ["shafen-claude-code"],
});

let client: QueryClient;
let getCrew: ReturnType<typeof vi.spyOn>;
// useMenuKeyboard keeps only items with an offsetParent; jsdom has no layout,
// so every element reports null. Give it one for the menu's key model.
const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");

function renderCrew(variant: "section" | "page" = "page") {
  const onOpenRoom = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CrewSection variant={variant} onOpenRoom={onOpenRoom} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onOpenRoom };
}

describe("CrewSection", () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getCrew = vi.spyOn(api, "getCrew").mockResolvedValue(CREW_FIXTURE);
    Object.defineProperty(HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get() {
        return document.body;
      },
    });
    useAppStore.setState({
      rooms: [hub, thread, taxsq],
      unreadCounts: {},
      currentParticipantId: "p-aaron",
      agents: [],
      toasts: [],
    });
    useSidebarUi.setState({ searchQuery: "", crewShowAll: false });
  });

  afterEach(() => {
    cleanup();
    // Only our spies: restoreAllMocks would also wipe the setup file's matchMedia stub.
    getCrew.mockRestore();
    if (offsetParent) Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
    useAppStore.setState({ rooms: [], unreadCounts: {}, currentParticipantId: null, toasts: [] });
  });

  it("gives a partner's row the shared room, names it, and offers no actions there", async () => {
    renderCrew();
    const row = await screen.findByTestId("crew-open-shafen-claude-code");
    expect(row).toHaveTextContent("Flow");
    expect(row).toHaveTextContent("#taxsq-portal");
    expect(row.getAttribute("title")).toBe("Open #taxsq-portal with Flow");
    expect(screen.queryByTestId("crew-menu-shafen-claude-code")).toBeNull();
    // A partner you share nothing with: no room, a word, no server call.
    const shox = screen.getByTestId("crew-open-shox");
    expect(shox.getAttribute("title")).toBe("No room shared with ShOX yet");
    const ensure = vi.spyOn(api, "ensureAgentHub");
    await act(async () => {
      fireEvent.click(shox);
    });
    expect(ensure).not.toHaveBeenCalled();
    ensure.mockRestore();
    expect(useAppStore.getState().toasts[0]?.title).toBe("No room with ShOX yet");
  });

  it("opens the shared room for a partner and the hub for your seat", async () => {
    const { onOpenRoom } = renderCrew();
    fireEvent.click(await screen.findByTestId("crew-open-shafen-claude-code"));
    await waitFor(() => expect(onOpenRoom).toHaveBeenCalledWith("room-taxsq"));
    fireEvent.click(screen.getByTestId("crew-open-persephone"));
    await waitFor(() => expect(onOpenRoom).toHaveBeenCalledWith(PERSEPHONE_HUB_ID));
  });

  it("menus: Settings only on your seats, Call disabled on a seat with the reason, house agents get New + Call", async () => {
    renderCrew();
    fireEvent.click(await screen.findByTestId("crew-menu-persephone"));
    const seatMenu = screen.getByRole("menu", { name: "Options for Persephone" });
    expect(within(seatMenu).getByTestId("crew-menu-new")).toBeTruthy();
    const call = within(seatMenu).getByTestId("crew-menu-call") as HTMLButtonElement;
    expect(call.disabled).toBe(true);
    expect(call.getAttribute("title")).toBe(SEAT_CALL_UNAVAILABLE);
    expect(within(seatMenu).getByTestId("crew-menu-settings")).toBeTruthy();
    // Escape closes it (the menu keyboard model).
    fireEvent.keyDown(seatMenu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Options for Persephone" })).toBeNull());

    // … and from the trigger, before focus has moved into the menu.
    const trigger = screen.getByTestId("crew-menu-persephone");
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Options for Persephone" })).toBeTruthy();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Options for Persephone" })).toBeNull();
    // … and a press anywhere outside it, while a press inside keeps it.
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("menu", { name: "Options for Persephone" }));
    expect(screen.getByRole("menu", { name: "Options for Persephone" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Options for Persephone" })).toBeNull();

    fireEvent.click(screen.getByTestId("crew-menu-majik"));
    const houseMenu = screen.getByRole("menu", { name: "Options for Majik Mane" });
    expect((within(houseMenu).getByTestId("crew-menu-call") as HTMLButtonElement).disabled).toBe(false);
    expect(within(houseMenu).queryByTestId("crew-menu-settings")).toBeNull();
  });

  it("badges the hub plus its threads, and draws the presence dot as an image with the runner wording", async () => {
    useAppStore.setState({ unreadCounts: { [PERSEPHONE_HUB_ID]: 1, [thread.id]: 2 } });
    renderCrew();
    const row = await screen.findByTestId("crew-open-persephone");
    expect(within(row).getByTestId("crew-unread")).toHaveTextContent("3");
    expect(within(row).getByRole("img", { name: "Runner online" })).toBeTruthy();
    // Grok never called the gateway: the plain offline label. Zen has, so
    // its dot says when it was last seen.
    const grok = screen.getByTestId("crew-open-grok");
    expect(within(grok).getByRole("img", { name: "Runner offline — no gateway call in the last 3 min" })).toBeTruthy();
    const zen = screen.getByTestId("crew-open-zen");
    expect(within(zen).getByRole("img", { name: /^Runner last seen .+ ago$/ })).toBeTruthy();
  });

  it("draws no dot for a presence nobody measured", async () => {
    getCrew.mockResolvedValue([
      { ...CREW_FIXTURE.find((m) => m.agent_id === "majik")!, presence: "unknown" },
    ]);
    renderCrew();
    const row = await screen.findByTestId("crew-open-majik");
    expect(within(row).queryByTestId("crew-presence")).toBeNull();
  });
});
