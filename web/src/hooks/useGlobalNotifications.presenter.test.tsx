import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { usePresenterStore } from "@/stores/presenterStore";

const wsHandlers = vi.hoisted(
  () => new Map<string, (payload: unknown) => void>(),
);
const showNotification = vi.hoisted(() => vi.fn());

vi.mock("@/services/websocket", () => ({
  ws: {
    connected: false,
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      wsHandlers.set(event, handler);
      return () => {
        if (wsHandlers.get(event) === handler) wsHandlers.delete(event);
      };
    }),
  },
}));

vi.mock("@/hooks/useGlobalPresence", () => ({
  useGlobalPresence: vi.fn(),
}));

vi.mock("@/components/Layout/SettingsModal", () => ({
  loadPrefs: () => ({
    inAppToasts: true,
    soundCues: false,
    emailOnInvite: true,
    emailOnMention: false,
  }),
}));

vi.mock("@/lib/sounds", () => ({
  playCue: vi.fn(),
}));

vi.mock("@/lib/webpush", () => ({
  ensurePushSubscription: vi.fn(),
}));

import { useGlobalNotifications } from "./useGlobalNotifications";

function room(id: string, name: string): Room {
  return {
    id,
    name,
    display_name: name,
    description: "",
    type: "channel",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    member_count: 1,
    unread_count: 0,
    last_message: null,
    members: [],
    agents: [],
  };
}

function Harness() {
  useGlobalNotifications();
  return null;
}

describe("useGlobalNotifications presenter masking", () => {
  let serviceWorkerDescriptor: PropertyDescriptor | undefined;
  let hiddenDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    wsHandlers.clear();
    showNotification.mockReset();
    serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "serviceWorker",
    );
    hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
    const registration = { showNotification };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve(registration) },
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    vi.stubGlobal("Notification", { permission: "granted" });
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
      currentParticipantId: "me-participant",
      activeRoomId: "open",
      rooms: [
        room("open", "ZZROOM_ALLOWED_A"),
        room("safe", "ZZROOM_ALLOWED_B"),
        room("private", "ZZROOM_PRIVATE_1"),
      ],
      toasts: [],
    });
  });

  afterEach(() => {
    cleanup();
    wsHandlers.clear();
    vi.unstubAllGlobals();
    if (serviceWorkerDescriptor) {
      Object.defineProperty(navigator, "serviceWorker", serviceWorkerDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
    if (hiddenDescriptor) {
      Object.defineProperty(document, "hidden", hiddenDescriptor);
    } else {
      Reflect.deleteProperty(document, "hidden");
    }
    useAppStore.setState({
      currentUser: null,
      currentParticipantId: null,
      activeRoomId: null,
      rooms: [],
      toasts: [],
    });
    usePresenterStore.setState({
      enabled: false,
      safeRoomIds: [],
      scopedUserId: null,
    });
  });

  it("uses neutral OS notification copy and the generic icon for a hidden room", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );

    await act(async () => {
      wsHandlers.get("message")?.({
        room_id: "private",
        message: {
          id: "message-private",
          sender_id: "private-person",
          sender_name: "ZZPERSON_PRIVATE_1",
          content: "ZZPREVIEW_PRIVATE_1",
          created_at: "2026-01-01T00:00:00Z",
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
    expect(showNotification).toHaveBeenCalledWith(
      "New message",
      expect.objectContaining({
        body: undefined,
        icon: "/icon-192.png",
        data: { url: "/?room=private" },
      }),
    );
    expect(JSON.stringify(showNotification.mock.calls)).not.toContain(
      "ZZPERSON_PRIVATE_1",
    );
    expect(JSON.stringify(showNotification.mock.calls)).not.toContain(
      "ZZPREVIEW_PRIVATE_1",
    );
  });
});
