/**
 * @vitest-environment happy-dom
 *
 * The broadcast page is a captured feed. With no opt-in it must not grow a
 * name, a button, or any other text.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const livekitHarness = vi.hoisted(() => ({ rooms: [] as unknown[] }));

vi.mock("livekit-client", () => {
  class FakeRoom {
    remoteParticipants = new Map<string, unknown>();
    activeSpeakers: unknown[] = [];
    private handlers = new Map<string, (...args: unknown[]) => void>();

    constructor() {
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
    Room: FakeRoom,
    RoomEvent: {
      ParticipantConnected: "participantConnected",
      ParticipantDisconnected: "participantDisconnected",
      TrackPublished: "trackPublished",
      TrackUnpublished: "trackUnpublished",
      TrackMuted: "trackMuted",
      TrackUnmuted: "trackUnmuted",
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
      Reconnected: "reconnected",
      ActiveSpeakersChanged: "activeSpeakersChanged",
      Disconnected: "disconnected",
    },
    Track: { Kind: { Video: "video", Audio: "audio" } },
    VideoQuality: { HIGH: "high" },
  };
});

import { BroadcastPage } from "./BroadcastPage";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

function render(node: ReactNode) {
  cleanup();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

afterEach(cleanup);

afterEach(() => {
  livekitHarness.rooms.length = 0;
  vi.unstubAllGlobals();
});

function latestRoom() {
  const room = livekitHarness.rooms.at(-1);
  if (!room) throw new Error("BroadcastPage did not create a LiveKit room");
  return room as {
    remoteParticipants: Map<string, { identity: string; trackPublications: Map<string, unknown> }>;
    emit: (event: string, ...args: unknown[]) => void;
  };
}

function publication(
  source: string,
  track: { attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> },
  opts?: { isMuted?: boolean },
) {
  return {
    kind: source === "microphone" || source === "screen_share_audio" ? "audio" : "video",
    source,
    track,
    isMuted: opts?.isMuted,
    isSubscribed: false,
    setSubscribed: vi.fn(),
    setVideoQuality: vi.fn(),
  };
}

function joinResponse() {
  return {
    livekit_url: "wss://livekit.test",
    token: "lk-token",
    room_name: "room",
    participant_identity: "target",
    participant_label: "Target",
    allow_audio: false,
    expires_at: "2099-01-01T00:00:00.000Z",
    mode: "participant",
  };
}

async function settleJoin() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("BroadcastPage", () => {
  it("renders nothing extra unless the room opts in", () => {
    window.history.replaceState({}, "", "/broadcast/room/person");
    const view = render(<BroadcastPage />);
    expect(view.querySelector("[data-testid='lower-third']")).toBeNull();
    expect(view.querySelector("button")).toBeNull();
    expect(view.textContent?.trim()).toBe("");
  });

  it("still renders nothing when the token URL has not opted in and nobody is speaking", () => {
    window.history.replaceState({}, "", "/broadcast/room/person?lowerThird=0");
    const view = render(<BroadcastPage />);
    expect(view.querySelector("[data-testid='lower-third']")).toBeNull();
    expect(view.querySelector("button")).toBeNull();
    expect(view.textContent?.trim()).toBe("");
  });

  it("source=screen subscribes to and attaches the share while the camera is live", async () => {
    window.history.replaceState(
      {},
      "",
      "/broadcast/room/person?token=sbt-test&source=screen",
    );
    const cameraTrack = { attach: vi.fn(), detach: vi.fn() };
    const screenTrack = { attach: vi.fn(), detach: vi.fn() };
    const camera = publication("camera", cameraTrack);
    const screen = publication("screen_share", screenTrack);
    const participant = {
      identity: "target",
      trackPublications: new Map([
        ["camera", camera],
        ["screen", screen],
      ]),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => joinResponse(),
      }),
    );

    const view = render(<BroadcastPage />);
    await settleJoin();
    const room = latestRoom();
    room.remoteParticipants.set("target", participant);
    await act(async () => {
      room.emit("participantConnected");
      await Promise.resolve();
    });

    expect(camera.setSubscribed).not.toHaveBeenCalled();
    expect(screen.setSubscribed).toHaveBeenCalledWith(true);
    expect(screenTrack.attach).toHaveBeenCalled();
    expect(cameraTrack.attach).not.toHaveBeenCalled();
    expect(view.querySelector("video")).not.toBeNull();
  });

  it("source=camera does not fall back to a live screen when the camera is unavailable", async () => {
    window.history.replaceState(
      {},
      "",
      "/broadcast/room/person?token=sbt-test&source=camera",
    );
    const cameraTrack = { attach: vi.fn(), detach: vi.fn() };
    const screenTrack = { attach: vi.fn(), detach: vi.fn() };
    const camera = publication("camera", cameraTrack, { isMuted: true });
    const screen = publication("screen_share", screenTrack);
    const participant = {
      identity: "target",
      trackPublications: new Map([
        ["camera", camera],
        ["screen", screen],
      ]),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => joinResponse(),
      }),
    );

    const view = render(<BroadcastPage />);
    await settleJoin();
    const room = latestRoom();
    room.remoteParticipants.set("target", participant);
    await act(async () => {
      room.emit("participantConnected");
      await Promise.resolve();
    });

    expect(screen.setSubscribed).not.toHaveBeenCalled();
    expect(screenTrack.attach).not.toHaveBeenCalled();
    expect(view.querySelector("video")).toBeNull();
  });
});
