/**
 * @vitest-environment happy-dom
 *
 * The composite page is what an egress Chrome records. These tests drive it
 * with a fake Room so START_RECORDING / END_RECORDING and the url+token
 * fallback can be asserted without a LiveKit server.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisconnectReason, RoomEvent } from "livekit-client";
import { CompositePage } from "./CompositePage";
import { END_RECORDING, START_RECORDING } from "@/lib/composite";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type FakeTrack = {
  id: string;
  attached: HTMLMediaElement[];
  played: HTMLMediaElement[];
  attach: (el: HTMLMediaElement) => HTMLMediaElement;
  detach: (el: HTMLMediaElement) => HTMLMediaElement[];
};

type FakeParticipant = {
  identity: string;
  name: string;
  joinedAt?: Date;
  trackPublications: Map<string, {
    kind: string;
    source: string;
    isMuted: boolean;
    trackSid: string;
    track: FakeTrack | null;
    isSubscribed: boolean;
    setSubscribed: (value: boolean) => void;
    setVideoQuality: () => void;
  }>;
};

type FakeRoom = {
  connectArgs: { url: string; token: string } | null;
  emit: (event: string, ...args: unknown[]) => void;
};

const harness = vi.hoisted(() => ({
  seed: [] as FakeParticipant[],
  rooms: [] as FakeRoom[],
}));

vi.mock("livekit-client", () => {
  const RoomEvent = {
    ParticipantConnected: "participantConnected",
    ParticipantDisconnected: "participantDisconnected",
    TrackPublished: "trackPublished",
    TrackUnpublished: "trackUnpublished",
    TrackMuted: "trackMuted",
    TrackUnmuted: "trackUnmuted",
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    Reconnected: "reconnected",
    Disconnected: "disconnected",
    AudioPlaybackStatusChanged: "audioPlaybackStatusChanged",
  };
  const DisconnectReason = {
    ROOM_DELETED: "roomDeleted",
    PARTICIPANT_REMOVED: "participantRemoved",
  };
  const Track = {
    Kind: { Video: "video", Audio: "audio" },
    Source: {
      Camera: "camera",
      Microphone: "microphone",
      ScreenShare: "screen_share",
      ScreenShareAudio: "screen_share_audio",
    },
  };
  class Room {
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    remoteParticipants = new Map<string, FakeParticipant>();
    connectArgs: { url: string; token: string } | null = null;
    constructor() {
      for (const participant of harness.seed) {
        this.remoteParticipants.set(participant.identity, participant);
      }
      harness.rooms.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
    async connect(url: string, token: string) {
      this.connectArgs = { url, token };
    }
    async startAudio() {}
    disconnect() {
      this.emit(RoomEvent.Disconnected);
    }
  }
  return { Room, RoomEvent, DisconnectReason, Track, VideoQuality: { HIGH: "high" } };
});

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

function track(id: string, options: { firstFrame?: boolean } = {}): FakeTrack {
  const attached: HTMLMediaElement[] = [];
  const played: HTMLMediaElement[] = [];
  const firstFrame = options.firstFrame ?? true;
  return {
    id,
    attached,
    played,
    attach(el) {
      attached.push(el);
      el.play = vi.fn(async () => {
        played.push(el);
      });
      if (firstFrame && el instanceof HTMLVideoElement) {
        el.dispatchEvent(new Event("loadeddata"));
      }
      return el;
    },
    detach() {
      return [];
    },
  };
}

function participant(input: {
  identity: string;
  name?: string;
  joinedAt?: Date;
  pubs: Array<{ kind: string; source: string; sid: string; track: FakeTrack | null; muted?: boolean }>;
}): FakeParticipant {
  const publications: FakeParticipant["trackPublications"] = new Map();
  for (const pub of input.pubs) {
    const row = {
      kind: pub.kind,
      source: pub.source,
      isMuted: Boolean(pub.muted),
      trackSid: pub.sid,
      track: pub.track,
      isSubscribed: false,
      setSubscribed(value: boolean) {
        row.isSubscribed = value;
      },
      setVideoQuality() {},
    };
    publications.set(pub.sid, row);
  }
  return {
    identity: input.identity,
    name: input.name ?? "",
    joinedAt: input.joinedAt,
    trackPublications: publications,
  };
}

function joinResponse(overrides?: { mode?: string }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      livekit_url: "wss://livekit.example/ws",
      token: "lk-from-join",
      room_name: "room-1",
      participant_identity: "*",
      participant_label: "recorder",
      allow_audio: true,
      expires_at: "2027-01-01T00:00:00.000Z",
      mode: overrides?.mode ?? "composite",
    }),
  };
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function signalCount(line: string): number {
  return vi
    .mocked(console.log)
    .mock.calls.filter((args) => args[0] === line).length;
}

beforeEach(() => {
  harness.seed = [];
  harness.rooms = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CompositePage", () => {
  it("logs START once for an audio-only room and END once on disconnect", async () => {
    const mic = track("mic-1");
    harness.seed = [
      participant({
        identity: "agent-persephone",
        name: "Persephone",
        pubs: [
          { kind: "audio", source: "microphone", sid: "mic-1", track: mic },
        ],
      }),
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      joinResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(
      {},
      "",
      "/broadcast/room-1/composite?rt=recorder-token&layout=grid",
    );

    const view = render(<CompositePage />);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/broadcast/join");
    expect(JSON.parse(String(init?.body))).toEqual({ token: "recorder-token" });
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(harness.rooms[0]?.connectArgs).toEqual({
      url: "wss://livekit.example/ws",
      token: "lk-from-join",
    });

    expect(view.querySelectorAll("[data-testid='composite-tile']")).toHaveLength(1);
    expect(view.querySelector("[data-testid='composite-initials']")?.textContent).toBe(
      "PE",
    );
    expect(view.querySelector("[data-testid='composite-plate']")?.textContent).toBe(
      "Persephone",
    );
    expect(view.querySelector("[data-testid='composite-video']")).toBeNull();
    expect(view.querySelectorAll("[data-testid='composite-audio']")).toHaveLength(1);
    expect(mic.attached).toHaveLength(1);
    expect(mic.attached[0]?.muted).toBe(false);
    expect(mic.played).toHaveLength(1);
    expect(view.querySelector("button")).toBeNull();
    expect(view.textContent ?? "").not.toMatch(/error|failed|login|keycloak/i);
    expect(signalCount(START_RECORDING)).toBe(1);

    const room = harness.rooms[0];
    await act(async () => {
      room?.emit(RoomEvent.Disconnected, DisconnectReason.ROOM_DELETED);
    });
    await act(async () => {
      room?.emit(RoomEvent.Disconnected, DisconnectReason.ROOM_DELETED);
    });
    expect(signalCount(END_RECORDING)).toBe(1);
    expect(signalCount(START_RECORDING)).toBe(1);
  });

  it("prefers the rt exchange over LiveKit's appended url and token", async () => {
    const fetchMock = vi.fn(async () => joinResponse());
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(
      {},
      "",
      "/broadcast/room-1/composite?rt=recorder-token&url=wss%3A%2F%2Fevil.example%2Fws&token=evil-jwt&layout=speaker",
    );

    const view = render(<CompositePage />);
    await settle();

    expect(harness.rooms[0]?.connectArgs).toEqual({
      url: "wss://livekit.example/ws",
      token: "lk-from-join",
    });
    expect(
      view.querySelector("[data-testid='composite-root']")?.getAttribute("data-layout"),
    ).toBe("grid");
    expect(signalCount(START_RECORDING)).toBe(1);
  });

  it("connects with url and token when rt is absent", async () => {
    harness.seed = [
      participant({
        identity: "ada",
        name: "Ada",
        pubs: [
          { kind: "video", source: "camera", sid: "cam-1", track: track("cam-1") },
          { kind: "audio", source: "microphone", sid: "mic-1", track: track("mic-1") },
        ],
      }),
      participant({
        identity: "majik",
        name: "Majik",
        pubs: [
          { kind: "video", source: "camera", sid: "cam-2", track: track("cam-2") },
        ],
      }),
    ];
    const fetchMock = vi.fn(async () => {
      throw new Error("join must not be called without rt");
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(
      {},
      "",
      "/broadcast/room-1/composite?url=wss%3A%2F%2Flk.example%2Fws&token=lk-direct&layout=single-speaker",
    );

    const view = render(<CompositePage />);
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.rooms).toHaveLength(1);
    expect(harness.rooms[0]?.connectArgs).toEqual({
      url: "wss://lk.example/ws",
      token: "lk-direct",
    });
    expect(view.querySelectorAll("[data-testid='composite-tile']")).toHaveLength(2);
    const videos = view.querySelectorAll("[data-testid='composite-video']");
    expect(videos).toHaveLength(2);
    expect((videos[0] as HTMLVideoElement).style.objectFit).toBe("contain");
    expect(view.querySelectorAll("[data-testid='composite-audio']")).toHaveLength(1);
    expect(
      view.querySelector("[data-testid='composite-root']")?.getAttribute("data-layout"),
    ).toBe("grid");
    expect(view.querySelector("button")).toBeNull();
    expect(signalCount(START_RECORDING)).toBe(1);
  });

  it("does not connect or start when the exchanged token is not composite", async () => {
    const fetchMock = vi.fn(async () => joinResponse({ mode: "participant" }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(
      {},
      "",
      "/broadcast/room-1/composite?rt=not-a-recorder",
    );

    const view = render(<CompositePage />);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.rooms).toHaveLength(0);
    expect(view.querySelector("[data-testid='composite-tile']")).toBeNull();
    expect(view.querySelector("button")).toBeNull();
    expect(view.textContent?.trim()).toBe("");
    expect(signalCount(START_RECORDING)).toBe(0);
    expect(signalCount(END_RECORDING)).toBe(0);
  });

  it("waits for a video track subscribed after connect and starts by the two-second bound", async () => {
    vi.useFakeTimers();
    const delayed = track("late-cam", { firstFrame: false });
    const late = track("published-after-connect", { firstFrame: false });
    const person = participant({
      identity: "late",
      name: "Late",
      pubs: [{ kind: "video", source: "camera", sid: "initial-cam", track: delayed }],
    });
    harness.seed = [person];
    vi.stubGlobal("fetch", vi.fn(async () => joinResponse()));
    window.history.replaceState({}, "", "/broadcast/room-1/composite?rt=recorder-token");
    const view = render(<CompositePage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(signalCount(START_RECORDING)).toBe(0);

    person.trackPublications.set("late-cam", {
      kind: "video",
      source: "camera",
      isMuted: false,
      trackSid: "late-cam",
      track: late,
      isSubscribed: false,
      setSubscribed(value) {
        this.isSubscribed = value;
      },
      setVideoQuality() {},
    });
    const room = harness.rooms[0];
    await act(async () => {
      room?.emit(RoomEvent.TrackPublished);
    });
    expect(view.querySelectorAll("[data-testid='composite-video']")).toHaveLength(1);
    expect(signalCount(START_RECORDING)).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(2100);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(signalCount(START_RECORDING)).toBe(1);
  });

  it("re-exchanges and reconnects after an unexpected disconnect without END", async () => {
    const fetchMock = vi.fn(async () => joinResponse());
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/broadcast/room-1/composite?rt=recorder-token");
    render(<CompositePage />);
    await settle();
    vi.useFakeTimers();
    await act(async () => {
      harness.rooms[0]?.emit(RoomEvent.Disconnected, "networkError");
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.rooms).toHaveLength(2);
    expect(signalCount(END_RECORDING)).toBe(0);
  });

  it.each([
    ["room deletion", DisconnectReason.ROOM_DELETED],
    ["participant removal", DisconnectReason.PARTICIPANT_REMOVED],
  ])("logs END once for %s", async (_label, reason) => {
    vi.stubGlobal("fetch", vi.fn(async () => joinResponse()));
    window.history.replaceState({}, "", "/broadcast/room-1/composite?rt=recorder-token");
    render(<CompositePage />);
    await settle();
    const room = harness.rooms[0];
    await act(async () => {
      room?.emit(RoomEvent.Disconnected, reason);
      room?.emit(RoomEvent.Disconnected, reason);
    });
    expect(signalCount(END_RECORDING)).toBe(1);
  });

  it("ends once when a later token exchange is refused", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(joinResponse())
      .mockResolvedValueOnce({ status: 403, ok: false });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/broadcast/room-1/composite?rt=recorder-token");
    render(<CompositePage />);
    await settle();
    vi.useFakeTimers();
    await act(async () => {
      harness.rooms[0]?.emit(RoomEvent.Disconnected, "networkError");
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(signalCount(END_RECORDING)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("switches from grid to speaker for a share and back when it ends", async () => {
    const camera = track("camera");
    const share = track("share");
    const sharePerson = participant({ identity: "share", name: "Screen", pubs: [] });
    harness.seed = [
      participant({
        identity: "camera",
        name: "Camera",
        pubs: [{ kind: "video", source: "camera", sid: "camera", track: camera }],
      }),
      sharePerson,
    ];
    vi.stubGlobal("fetch", vi.fn(async () => joinResponse()));
    window.history.replaceState({}, "", "/broadcast/room-1/composite?rt=recorder-token");
    const view = render(<CompositePage />);
    await settle();
    const gridWidth = Number.parseInt(
      (view.querySelectorAll("[data-testid='composite-video']")[0] as HTMLElement).style.width,
      10,
    );
    sharePerson.trackPublications.set("share", {
      kind: "video",
      source: "screen_share",
      isMuted: false,
      trackSid: "share",
      track: share,
      isSubscribed: false,
      setSubscribed(value) {
        this.isSubscribed = value;
      },
      setVideoQuality() {},
    });
    await act(async () => {
      harness.rooms[0]?.emit(RoomEvent.TrackPublished);
    });
    const speakerVideos = view.querySelectorAll("[data-testid='composite-video']");
    expect(speakerVideos).toHaveLength(2);
    expect(Number.parseInt((speakerVideos[0] as HTMLElement).style.width, 10)).toBeGreaterThan(gridWidth);
    sharePerson.trackPublications.delete("share");
    await act(async () => {
      harness.rooms[0]?.emit(RoomEvent.TrackUnpublished);
    });
    expect(view.querySelectorAll("[data-testid='composite-video']")).toHaveLength(1);
    expect(Number.parseInt(
      (view.querySelector("[data-testid='composite-video']") as HTMLElement).style.width,
      10,
    )).toBe(gridWidth);
  });
});
