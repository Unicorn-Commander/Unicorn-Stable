import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Room } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { usePanelChromeStore } from "@/stores/panelChromeStore";
import { usePresenterStore } from "@/stores/presenterStore";
import { RoomHeader, type RoomHeaderProps } from "./RoomHeader";

vi.mock("@/hooks/useDirectCall", () => ({
  useDirectCall: () => ({ startCall: vi.fn(), startCanonicalCall: vi.fn() }),
}));

function room(policy: Room["recording_policy"]): Room {
  return {
    id: "room-1",
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
    recording_policy: policy,
  };
}

let client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await act(async () => {
    await Promise.resolve();
  });
}

function renderHeader(extra: Partial<RoomHeaderProps> = {}) {
  const props: RoomHeaderProps = {
    roomId: "room-1",
    membersOpen: false,
    onToggleMembers: vi.fn(),
    showTasks: false,
    showInvite: true,
    onInvite: vi.fn(),
    onNewThread: vi.fn(),
    pinsOpen: false,
    onTogglePins: vi.fn(),
    canvasOpen: false,
    canvasCount: 0,
    canvasUnseen: 0,
    onToggleCanvas: vi.fn(),
    knowledgeOpen: false,
    onToggleKnowledge: vi.fn(),
    onOpenSearch: vi.fn(),
    showRename: false,
    onStartRename: vi.fn(),
    showGuestAccess: false,
    onOpenGuestAccess: vi.fn(),
    showRecordingSettings: false,
    onOpenRecordingSettings: vi.fn(),
    showVoiceSettings: false,
    onOpenVoiceSettings: vi.fn(),
    showStartGroup: false,
    startGroupLabel: "Ada",
    onStartGroup: vi.fn(),
    onLeave: vi.fn(),
    leaving: false,
    roomAgent: null,
    onStartGroupWithAgent: vi.fn(),
    ...extra,
    children: extra.children ?? <span>general</span>,
  };
  return render(<RoomHeader {...props} />, { wrapper: Wrapper });
}

describe("RoomHeader", () => {
  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    usePanelChromeStore.getState().ensureRoom("room-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "offline" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    useAppStore.setState({
      currentUser: {
        id: "u",
        username: "aaron",
        displayName: "Aaron",
        email: "a@b.c",
        avatarUrl: null,
        roles: ["admin"],
      },
      rooms: [room("off")],
    });
    usePresenterStore.setState({ enabled: false, safeRoomIds: [], scopedUserId: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAppStore.setState({ currentUser: null, rooms: [] });
    usePresenterStore.setState({ enabled: false, safeRoomIds: [], scopedUserId: null });
  });

  it("is one 44px row whose primary actions are Call, Members, Threads, Pop out, More", async () => {
    renderHeader();
    await settle();
    const header = screen.getByTestId("room-header");
    expect(header.className).toContain("h-11");
    expect(header.className).toContain("max-h-11");
    const actions = within(screen.getByTestId("room-header-actions"));
    const labels = actions
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Call",
      "Members",
      "Threads",
      "Pop out",
      "More room actions",
    ]);
    expect(
      actions.queryByRole("button", {
        name: "Switch model for this conversation",
      }),
    ).toBeNull();
    expect(actions.queryByRole("button", { name: "Search" })).toBeNull();
  });

  it("puts Record between Call and Members when the caller may record", async () => {
    useAppStore.setState({
      currentUser: {
        id: "u",
        username: "aaron",
        displayName: "Aaron",
        email: "a@b.c",
        avatarUrl: null,
        roles: ["stable-recorder"],
      },
      rooms: [room("on_request")],
    });
    renderHeader();
    await settle();
    const labels = within(screen.getByTestId("room-header-actions"))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Call",
      "Record",
      "Members",
      "Threads",
      "Pop out",
      "More room actions",
    ]);
  });

  it("keeps Voice and Video inside the one Call menu", async () => {
    renderHeader();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Call" }));
    const menu = screen.getByRole("menu", { name: "Call" });
    expect(within(menu).getByRole("menuitem", { name: "Voice" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Video" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Call" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Video call" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Voice call" })).toBeNull();
  });

  it("moves the model switcher into More and keeps it out of the primary row", async () => {
    renderHeader();
    await settle();
    expect(
      screen.queryByRole("button", { name: "Switch model for this conversation" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More room actions" }));
    expect(
      screen.getByRole("button", { name: "Switch model for this conversation" }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Search" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Invite members" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Call" })).toHaveLength(1);
  });

  it("persists the per-device safe-room check in the room menu", async () => {
    renderHeader();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "More room actions" }));
    const safe = screen.getByRole("menuitemcheckbox", {
      name: "Safe to show while presenting",
    });
    expect(safe).toHaveAttribute("aria-checked", "false");
    fireEvent.click(safe);
    expect(usePresenterStore.getState().safeRoomIds).toEqual(["room-1"]);
    fireEvent.click(screen.getByRole("button", { name: "More room actions" }));
    expect(screen.getByRole("menuitemcheckbox", {
      name: "Safe to show while presenting",
    })).toHaveAttribute("aria-checked", "true");
  });
});
