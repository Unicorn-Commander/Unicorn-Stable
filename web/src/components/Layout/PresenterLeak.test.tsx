import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Room } from "@/services/api";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { usePresenterStore } from "@/stores/presenterStore";
import { ToastStack } from "./ToastStack";
import { QuickSwitcher } from "./QuickSwitcher";
import { GlobalSearchModal } from "./GlobalSearchModal";

function room(id: string, name: string, memberName: string): Room {
  return {
    id,
    name,
    display_name: name,
    description: `ZZDESCRIPTION_${id}`,
    type: "channel",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    member_count: 1,
    unread_count: 0,
    last_message: null,
    members: [
      {
        participant_id: `${id}-member`,
        display_name: memberName,
        username: memberName.toLowerCase(),
        role: "member",
        joined_at: "2026-01-01T00:00:00Z",
      },
    ],
    agents: [],
  };
}

function renderToast() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastStack />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderSwitcher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <QuickSwitcher onClose={vi.fn()} onOpenGlobalSearch={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderSearch() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobalSearchModal onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("presenter display leak seam", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    spies.push(vi.spyOn(api, "getCrew").mockResolvedValue([]));
    spies.push(vi.spyOn(api, "getBrigadeAgents").mockResolvedValue([]));
    usePresenterStore.setState({ enabled: true, safeRoomIds: ["safe"], scopedUserId: null });
    useAppStore.setState({
      currentUser: { id: "me", username: "aaron", displayName: "Aaron", email: "a@b.test", avatarUrl: null, roles: [] },
      activeRoomId: "open",
      rooms: [
        room("open", "ZZROOM_ALLOWED_A", "ZZPERSON_ALLOWED_A"),
        room("safe", "ZZROOM_ALLOWED_B", "ZZPERSON_ALLOWED_B"),
        room("private", "ZZROOM_PRIVATE_1", "ZZPERSON_PRIVATE_1"),
      ],
      toasts: [],
    });
  });

  afterEach(() => {
    cleanup();
    for (const spy of spies.splice(0)) spy.mockRestore();
    document.title = "Stable";
    useAppStore.setState({ currentUser: null, activeRoomId: null, rooms: [], toasts: [] });
    usePresenterStore.setState({ enabled: false, safeRoomIds: [], scopedUserId: null });
  });

  it("masks a hidden-room toast while preserving an allowed-room toast", async () => {
    useAppStore.getState().pushToast({
      title: "ZZPERSON_PRIVATE_1 in ZZROOM_PRIVATE_1",
      body: "ZZPREVIEW_PRIVATE_1",
      roomId: "private",
    });
    useAppStore.getState().pushToast({
      title: "ZZROOM_ALLOWED_A",
      body: "ZZPREVIEW_ALLOWED_A",
      roomId: "open",
    });
    renderToast();
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    const html = document.body.innerHTML;
    expect(html).not.toContain("ZZROOM_PRIVATE_1");
    expect(html).not.toContain("ZZPERSON_PRIVATE_1");
    expect(html).not.toContain("ZZPREVIEW_PRIVATE_1");
    expect(html).toContain("ZZROOM_ALLOWED_A");
    expect(html).toContain("ZZPREVIEW_ALLOWED_A");
    expect(screen.getByText("New message")).toBeTruthy();
  });

  it("leaves the same hidden-room toast visible when presenter mode is off", async () => {
    usePresenterStore.setState({ enabled: false, safeRoomIds: [], scopedUserId: null });
    useAppStore.getState().pushToast({
      title: "ZZPERSON_PRIVATE_1 in ZZROOM_PRIVATE_1",
      body: "ZZPREVIEW_PRIVATE_1",
      roomId: "private",
    });
    renderToast();
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(document.body.innerHTML).toContain("ZZROOM_PRIVATE_1");
    expect(document.body.innerHTML).toContain("ZZPERSON_PRIVATE_1");
    expect(document.body.innerHTML).toContain("ZZPREVIEW_PRIVATE_1");
  });

  it("keeps only the allowed room names in a display title", () => {
    document.title = "ZZROOM_ALLOWED_A — Stable";
    expect(document.title).toContain("ZZROOM_ALLOWED_A");
    expect(document.title).not.toContain("ZZROOM_PRIVATE_1");
  });

  it("does not show quick-switcher suggestions until typing, then filters rooms", async () => {
    renderSwitcher();
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Quick switcher" })).toBeTruthy());
    expect(screen.queryByText("ZZROOM_ALLOWED_A")).toBeNull();
    expect(screen.queryByText("ZZROOM_PRIVATE_1")).toBeNull();

    fireEvent.change(screen.getByRole("dialog", { name: "Quick switcher" }).querySelector("input")!, {
      target: { value: "ZZROOM_ALLOWED_A" },
    });
    await waitFor(() => expect(screen.getByText("ZZROOM_ALLOWED_A")).toBeTruthy());
    expect(document.body.innerHTML).not.toContain("ZZROOM_PRIVATE_1");
    expect(document.body.innerHTML).not.toContain("ZZDESCRIPTION_private");
  });

  it("filters global search rooms and masks safe-room message previews", async () => {
    spies.push(vi.spyOn(api, "searchAllMessages").mockResolvedValue([
      {
        id: "message-open",
        room_id: "open",
        sender_id: "open-member",
        sender_name: "ZZPERSON_ALLOWED_A",
        content: "ZZPREVIEW_ALLOWED_A",
        created_at: "2026-01-01T00:00:00Z",
      } as Message,
      {
        id: "message-safe",
        room_id: "safe",
        sender_id: "safe-member",
        sender_name: "ZZPERSON_ALLOWED_B",
        content: "ZZPREVIEW_SAFE_B",
        created_at: "2026-01-01T00:00:00Z",
      } as Message,
      {
        id: "message-private",
        room_id: "private",
        sender_id: "private-member",
        sender_name: "ZZPERSON_PRIVATE_1",
        content: "ZZPREVIEW_PRIVATE_1",
        created_at: "2026-01-01T00:00:00Z",
      } as Message,
    ]));
    renderSearch();
    const dialog = screen.getByRole("dialog", { name: "Search all messages" });
    fireEvent.change(dialog.querySelector("input")!, { target: { value: "search" } });
    await waitFor(() => expect(screen.getByText("ZZPREVIEW_ALLOWED_A")).toBeTruthy());
    const html = document.body.innerHTML;
    expect(html).not.toContain("ZZPERSON_PRIVATE_1");
    expect(html).not.toContain("ZZPREVIEW_PRIVATE_1");
    expect(html).toContain("ZZROOM_ALLOWED_A");
    expect(html).toContain("Message hidden while presenting");
    expect(html).not.toContain("ZZPREVIEW_SAFE_B");
  });
});
