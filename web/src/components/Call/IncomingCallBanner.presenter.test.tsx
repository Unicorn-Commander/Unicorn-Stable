import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncomingCallBanner } from "./IncomingCallBanner";
import { useAppStore } from "@/stores/appStore";
import { useIncomingCallStore } from "@/stores/incomingCallStore";
import { usePresenterStore } from "@/stores/presenterStore";

vi.mock("@/contexts/VoiceProvider", () => ({
  useVoice: () => ({ connect: vi.fn(), isConnecting: false }),
}));

vi.mock("@/hooks/useCrew", () => ({
  useCrew: () => ({
    crew: [],
    loaded: true,
    fromRoster: false,
    crewAnswered: true,
    isPending: false,
    unavailable: false,
  }),
}));

vi.mock("@/lib/sounds", () => ({
  cueBlockedReason: () => "Audio is unavailable",
  playCue: vi.fn(),
}));

describe("IncomingCallBanner presenter masking", () => {
  beforeEach(() => {
    usePresenterStore.setState({
      enabled: true,
      safeRoomIds: ["safe"],
      scopedUserId: null,
    });
    useAppStore.setState({
      currentUser: {
        id: "me",
        username: "aaron",
        displayName: "Aaron",
        email: "a@b.test",
        avatarUrl: null,
        roles: [],
      },
      activeRoomId: "open",
      rooms: [
        {
          id: "open",
          name: "ZZROOM_ALLOWED_A",
          display_name: "ZZROOM_ALLOWED_A",
          description: "",
          type: "channel",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          member_count: 0,
          unread_count: 0,
          last_message: null,
          members: [],
          agents: [],
        },
        {
          id: "private",
          name: "ZZROOM_PRIVATE_1",
          display_name: "ZZROOM_PRIVATE_1",
          description: "",
          type: "channel",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          member_count: 0,
          unread_count: 0,
          last_message: null,
          members: [],
          agents: [],
        },
        {
          id: "safe",
          name: "ZZROOM_ALLOWED_B",
          display_name: "ZZROOM_ALLOWED_B",
          description: "",
          type: "channel",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          member_count: 0,
          unread_count: 0,
          last_message: null,
          members: [],
          agents: [],
        },
      ],
    });
    useIncomingCallStore.setState({
      call: {
        callId: "call-private",
        roomId: "private",
        roomType: "dm",
        roomName: "ZZROOM_PRIVATE_1",
        callerId: "private-person",
        callerName: "ZZPERSON_PRIVATE_1",
        callerAvatarUrl: "https://example.invalid/private.png",
        startedAt: "2026-01-01T00:00:00Z",
        expiresAt: null,
      },
    });
  });

  afterEach(() => {
    cleanup();
    useIncomingCallStore.setState({ call: null });
    useAppStore.setState({ currentUser: null, activeRoomId: null, rooms: [] });
    usePresenterStore.setState({
      enabled: false,
      safeRoomIds: [],
      scopedUserId: null,
    });
  });

  it("keeps the banner actionable while removing the caller, room, and face", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <IncomingCallBanner />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("Incoming call")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("ZZPERSON_PRIVATE_1");
    expect(document.body.innerHTML).not.toContain("ZZROOM_PRIVATE_1");
    expect(document.body.querySelector("img")).toBeNull();
  });

  it("masks a safe-room caller whose membership is not known", async () => {
    useIncomingCallStore.setState({
      call: {
        callId: "call-safe-unknown",
        roomId: "safe",
        roomType: "channel",
        roomName: "ZZROOM_ALLOWED_B",
        callerId: "safe-unknown-person",
        callerName: "ZZPERSON_SAFE_UNKNOWN",
        callerAvatarUrl: "https://example.invalid/safe.png",
        startedAt: "2026-01-01T00:00:00Z",
        expiresAt: null,
      },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <IncomingCallBanner />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("Incoming call")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("ZZPERSON_SAFE_UNKNOWN");
    expect(document.body.querySelector("img")).toBeNull();
  });
});
