/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuestSession } from "@/lib/guest";

const livekitHarness = vi.hoisted(() => ({
  rooms: [] as Array<{
    localParticipant: {
      setScreenShareEnabled: ReturnType<typeof vi.fn>;
    };
  }>,
}));

vi.mock("livekit-client", () => {
  class FakeLocalVideoTrack {
    attach = vi.fn();
    detach = vi.fn();
  }

  class FakeRemoteVideoTrack {}

  class FakeRoom {
    remoteParticipants = new Map();
    activeSpeakers: Array<{ identity: string }> = [];
    private handlers = new Map<string, (...args: unknown[]) => void>();
    private publications = new Map<
      string,
      { track: FakeLocalVideoTrack; isMuted: boolean }
    >();
    localParticipant: {
      identity: string;
      getTrackPublication: (
        source: string,
      ) => { track: FakeLocalVideoTrack; isMuted: boolean } | undefined;
      setCameraEnabled: ReturnType<typeof vi.fn>;
      setMicrophoneEnabled: ReturnType<typeof vi.fn>;
      setScreenShareEnabled: ReturnType<typeof vi.fn>;
    };

    constructor() {
      const setScreenShareEnabled = vi.fn(async (enabled: boolean) => {
        if (enabled) {
          this.publications.set("screen_share", {
            track: new FakeLocalVideoTrack(),
            isMuted: false,
          });
          this.emit("localTrackPublished");
        } else {
          this.publications.delete("screen_share");
          this.emit("localTrackUnpublished");
        }
      });
      this.localParticipant = {
        identity: "guest-fake",
        getTrackPublication: (source) => this.publications.get(source),
        setCameraEnabled: vi.fn(),
        setMicrophoneEnabled: vi.fn(),
        setScreenShareEnabled,
      };
      livekitHarness.rooms.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      this.handlers.get(event)?.(...args);
    }

    async connect() {}

    async disconnect() {}
  }

  return {
    LocalVideoTrack: FakeLocalVideoTrack,
    RemoteVideoTrack: FakeRemoteVideoTrack,
    Room: FakeRoom,
    RoomEvent: {
      ParticipantConnected: "participantConnected",
      ParticipantDisconnected: "participantDisconnected",
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
      TrackPublished: "trackPublished",
      TrackUnpublished: "trackUnpublished",
      TrackMuted: "trackMuted",
      TrackUnmuted: "trackUnmuted",
      LocalTrackPublished: "localTrackPublished",
      LocalTrackUnpublished: "localTrackUnpublished",
      ActiveSpeakersChanged: "activeSpeakersChanged",
      Reconnected: "reconnected",
      Disconnected: "disconnected",
    },
    Track: {
      Source: {
        Camera: "camera",
        Microphone: "microphone",
        ScreenShare: "screen_share",
      },
    },
  };
});

vi.mock("@/services/guestApi", () => ({
  GuestSessionEnded: class GuestSessionEnded extends Error {},
  getGuestLiveKitToken: vi.fn().mockResolvedValue({
    ws_url: "wss://livekit.example.test",
    token: "fake-livekit-token",
  }),
}));

vi.mock("@/components/Room/VideoGrid", () => ({
  VideoGrid: ({
    items,
  }: {
    items: Array<{ key: string; node: ReactNode }>;
  }) => (
    <div data-testid="video-grid">
      {items.map((item) => (
        <div key={item.key}>{item.node}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/hooks/useTileFullscreen", () => ({
  useTileFullscreen: () => ({
    ref: vi.fn(),
    videoRef: vi.fn(),
    isFullscreen: false,
    supported: false,
    toggle: vi.fn(),
  }),
}));

vi.mock("@/components/ui/Identity", () => ({
  Identity: () => <span data-testid="identity" />,
}));

import { GuestVideoStage } from "./GuestVideoStage";

const SESSION_BASE: GuestSession = {
  token: "sgs-fictional-test-token",
  sessionId: "session-fictional",
  participantId: "participant-fictional",
  displayName: "Fictional Guest",
  roomId: "room-fictional",
  roomName: "Fictional Room",
  canPublish: true,
  expiresAt: null,
  historyFromMs: null,
  capabilities: {},
  inviteKey: "invite-fictional",
  recordingPolicy: null,
  recordingActive: null,
};

function renderStage(canPublish: boolean) {
  return render(
    <GuestVideoStage
      session={{ ...SESSION_BASE, canPublish }}
      members={[]}
      onSessionEnded={vi.fn()}
    />,
  );
}

function latestRoom() {
  const room = livekitHarness.rooms.at(-1);
  if (!room) throw new Error("GuestVideoStage did not create a LiveKit room");
  return room;
}

afterEach(() => {
  cleanup();
  livekitHarness.rooms.length = 0;
  vi.clearAllMocks();
});

describe("GuestVideoStage screen sharing", () => {
  it("enables screen sharing for a publishing guest and shows the local preview", async () => {
    renderStage(true);

    const shareButton = await screen.findByRole("button", {
      name: "Share screen",
    });
    await waitFor(() => expect(shareButton).toBeEnabled());

    fireEvent.click(shareButton);

    await waitFor(() =>
      expect(
        latestRoom().localParticipant.setScreenShareEnabled,
      ).toHaveBeenCalledWith(true, { audio: true }),
    );
    expect(
      await screen.findByRole("button", { name: "Stop sharing" }),
    ).toBeEnabled();
    expect(
      screen.getByTestId("video-grid").querySelector("video"),
    ).not.toBeNull();
  });

  it("shows a disabled screen-share control with the invite reason for watch-only guests", async () => {
    renderStage(false);

    const shareButton = await screen.findByRole("button", {
      name: "Sharing is off for guests in this room",
    });
    expect(shareButton).toBeDisabled();
    expect(shareButton).toHaveAttribute(
      "title",
      "Sharing is off for guests in this room",
    );
    expect(
      latestRoom().localParticipant.setScreenShareEnabled,
    ).not.toHaveBeenCalled();
  });

  it("keeps a browser screen-share rejection inline", async () => {
    renderStage(true);

    const shareButton = await screen.findByRole("button", {
      name: "Share screen",
    });
    await waitFor(() => expect(shareButton).toBeEnabled());
    latestRoom().localParticipant.setScreenShareEnabled.mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), {
        name: "NotAllowedError",
      }),
    );

    fireEvent.click(shareButton);

    expect(
      await screen.findByText(
        "Screen sharing isn’t available or was blocked by your browser.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
