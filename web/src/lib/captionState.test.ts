import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeRoomData } from "@/lib/roomDataProtocol";
import {
  CAPTION_IDLE_FACTS,
  browserCanFollowInput,
  captionFacts,
  captionToggleTitle,
  electedCaptionerName,
  linesWithVoiceHistory,
  readServerCaptionEnabled,
  reduceCaptionState,
  serverLaneWanted,
  writeServerCaptionEnabled,
  type CaptionFacts,
  type CaptionLine,
} from "./captionState";

function state(over: Partial<CaptionFacts> = {}) {
  return reduceCaptionState(captionFacts(over));
}

describe("reduceCaptionState", () => {
  it("uses the browser when the default mic can be followed", () => {
    const caption = state();
    expect(caption.lane).toBe("browser");
    expect(caption.reason).toBeNull();
    expect(caption.summary).toBe(
      "Captions are coming from this browser's microphone",
    );
    expect(caption.actions).toEqual([]);
  });

  it("a selected non-default mic is off, reason mic-pinned, with the device named", () => {
    const caption = state({
      audioInputId: "zoom-ams-44",
      audioInputLabel: "ZOOM AMS-44",
    });
    expect(caption.lane).toBe("off");
    expect(caption.reason).toBe("mic-pinned");
    expect(caption.summary).toBe(
      "Captions need the default mic or an agent in the call — you picked ZOOM AMS-44",
    );
    expect(caption.actions).toEqual(["use-default-mic", "invite-agent"]);
    expect(browserCanFollowInput("zoom-ams-44")).toBe(false);
    expect(browserCanFollowInput("default")).toBe(true);
    expect(browserCanFollowInput("")).toBe(true);
  });

  it("names a pinned mic even when the browser has no label yet", () => {
    const caption = state({ audioInputId: "zoom-ams-44", audioInputLabel: "" });
    expect(caption.reason).toBe("mic-pinned");
    expect(caption.summary).toContain("a selected microphone");
  });

  it("an agent captioner wins, including over a pinned mic", () => {
    const pinned = state({
      audioInputId: "zoom-ams-44",
      audioInputLabel: "ZOOM AMS-44",
      agentName: "Persephone",
    });
    expect(pinned.lane).toBe("agent");
    expect(pinned.reason).toBeNull();
    expect(pinned.summary).toBe(
      "Captions are coming from Persephone's mic feed",
    );
    expect(pinned.agentName).toBe("Persephone");

    const browserToo = state({ agentName: "Persephone" });
    expect(browserToo.lane).toBe("agent");
  });

  it("server captions cover a pinned mic when the user opted in", () => {
    const caption = state({
      audioInputId: "zoom-ams-44",
      audioInputLabel: "ZOOM AMS-44",
      serverCaptionEnabled: true,
    });
    expect(caption.lane).toBe("server");
    expect(caption.reason).toBeNull();
    expect(caption.summary).toBe(
      "Captions are coming from the server, using ZOOM AMS-44. This is transcription, not a recording.",
    );
    expect(serverLaneWanted(captionFacts({
      audioInputId: "zoom-ams-44",
      serverCaptionEnabled: true,
    }))).toBe(true);
  });

  it("keeps the server lane when a clip fails and says so", () => {
    const caption = state({
      audioInputId: "zoom-ams-44",
      audioInputLabel: "ZOOM AMS-44",
      serverCaptionEnabled: true,
      serverLastError: true,
    });
    expect(caption.lane).toBe("server");
    expect(caption.summary).toContain("still trying");
    expect(caption.summary).toContain("not a recording");
  });

  it("does not start server captions just because the preference is on", () => {
    const caption = state({ serverCaptionEnabled: true });
    expect(caption.lane).toBe("browser");
    expect(serverLaneWanted(captionFacts({ serverCaptionEnabled: true }))).toBe(
      false,
    );
  });

  it("does not start server captions during a remote-speaker pause", () => {
    const facts = captionFacts({
      remoteDominant: true,
      serverCaptionEnabled: true,
    });
    expect(serverLaneWanted(facts)).toBe(false);
    expect(reduceCaptionState(facts).reason).toBe("remote-dominant");
  });

  it("server capture missing on a pinned mic is server-unavailable", () => {
    const caption = state({
      audioInputId: "zoom-ams-44",
      audioInputLabel: "ZOOM AMS-44",
      serverCaptionEnabled: true,
      serverCaptureAvailable: false,
    });
    expect(caption.lane).toBe("off");
    expect(caption.reason).toBe("server-unavailable");
    expect(caption.actions).toEqual(["use-default-mic", "invite-agent"]);
  });

  it("pauses for a remote human instead of labelling their words as yours", () => {
    const caption = state({ remoteDominant: true });
    expect(caption.lane).toBe("off");
    expect(caption.reason).toBe("remote-dominant");
    expect(caption.summary).toContain("someone else is speaking");
    expect(caption.actions).toEqual([]);
  });

  it("says when this browser has no speech recognition", () => {
    const caption = state({ speechRecognitionAvailable: false });
    expect(caption.lane).toBe("off");
    expect(caption.reason).toBe("speech-unavailable");
    expect(caption.actions).toEqual(["invite-agent"]);
  });

  it("uses the server when speech recognition is missing and the user opted in", () => {
    const caption = state({
      speechRecognitionAvailable: false,
      serverCaptionEnabled: true,
    });
    expect(caption.lane).toBe("server");
  });

  it("says when the microphone is muted", () => {
    const caption = state({ micEnabled: false });
    expect(caption.lane).toBe("off");
    expect(caption.reason).toBe("mic-muted");
  });

  it("a muted mic still yields to an agent captioner", () => {
    const caption = state({ micEnabled: false, agentName: "Rook" });
    expect(caption.lane).toBe("agent");
    expect(caption.summary).toBe("Captions are coming from Rook's mic feed");
  });

  it("is not-in-call before a call, even if an agent name was left behind", () => {
    const caption = reduceCaptionState({
      ...CAPTION_IDLE_FACTS,
      agentName: "Persephone",
    });
    expect(caption.lane).toBe("off");
    expect(caption.reason).toBe("not-in-call");
    expect(caption.summary).toBe("Captions start when a call starts.");
  });

  it("prefers mic-pinned over the remote-speaker pause", () => {
    const caption = state({
      audioInputId: "zoom-ams-44",
      audioInputLabel: "ZOOM AMS-44",
      remoteDominant: true,
    });
    expect(caption.reason).toBe("mic-pinned");
  });
});

describe("elected captioner", () => {
  it("names the lexicographically first real agent, not a cast puppet", () => {
    expect(
      electedCaptionerName([
        { identity: "aaron_1", name: "Aaron", agent: false },
        { identity: "agent-rook", name: "Rook", agent: true },
        { identity: "agent-persephone", name: "Persephone", agent: true },
        {
          identity: "agent-majik-cast",
          name: "Majik",
          agent: true,
          cast: true,
        },
      ]),
    ).toBe("Persephone");
  });

  it("prettifies an agent identity when the participant has no display name", () => {
    expect(
      electedCaptionerName([
        { identity: "agent-the-general", name: "", agent: true },
      ]),
    ).toBe("The General");
  });
});

describe("voice history lines", () => {
  const live: CaptionLine[] = [];

  it("renders a captioner's persisted voice line for the local human", () => {
    const started = 1_000_000;
    const lines = linesWithVoiceHistory(
      live,
      [
        {
          id: "m1",
          senderId: "p-aaron",
          senderName: "Aaron",
          text: "the studio mic is live",
          createdAtMs: started + 1500,
          viaVoice: true,
        },
        {
          id: "typed",
          senderId: "p-aaron",
          senderName: "Aaron",
          text: "this was typed",
          createdAtMs: started + 2000,
          viaVoice: false,
        },
      ],
      started,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("the studio mic is live");
    expect(lines[0]?.name).toBe("Aaron");
    expect(lines[0]?.source).toBe("captioner");
  });

  it("does not repeat a voice message the live buffer already has", () => {
    const started = 1_000_000;
    const lines = linesWithVoiceHistory(
      [
        {
          id: "live-1",
          participantId: "aaron_1",
          name: "Aaron",
          text: "the studio mic is live",
          isFinal: true,
          ts: started + 1200,
          source: "captioner",
        },
      ],
      [
        {
          id: "m1",
          senderId: "p-aaron",
          senderName: "Aaron",
          text: "the studio mic is live",
          createdAtMs: started + 1800,
          viaVoice: true,
        },
      ],
      started,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.id).toBe("live-1");
  });
});

describe("caption preference and toggle copy", () => {
  /* The repo's unit suite runs without a Storage (see talkingFaceFlag.test.ts,
   * which supplies its own for the same reason). The preference reads
   * localStorage, so give this suite one rather than a whole DOM. */
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as unknown as Storage;
  const hadStorage = "localStorage" in globalThis;
  const previous = hadStorage ? globalThis.localStorage : undefined;

  beforeAll(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: fakeStorage,
    });
  });
  afterAll(() => {
    if (hadStorage) {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: previous,
      });
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });
  beforeEach(() => {
    store.clear();
  });

  it("server captions default off and stay per user", () => {
    expect(readServerCaptionEnabled("aaron")).toBe(false);
    writeServerCaptionEnabled("aaron", true);
    expect(readServerCaptionEnabled("aaron")).toBe(true);
    expect(readServerCaptionEnabled("shafen")).toBe(false);
  });

  it("puts the reason on the captions toggle", () => {
    const summary = state({
      audioInputId: "zoom-ams-44",
      audioInputLabel: "ZOOM AMS-44",
    }).summary;
    expect(captionToggleTitle(true, summary)).toBe(
      `Hide live transcript — ${summary}`,
    );
    expect(captionToggleTitle(false, "")).toBe("Show live transcript");
  });
});

describe("captioner packets", () => {
  it("keeps an agent captioner transcript the panel can render", () => {
    const raw = JSON.stringify({
      type: "transcript",
      participantId: "aaron_1",
      name: "Aaron",
      text: "the studio mic is live",
      isFinal: true,
      ts: 10,
      source: "captioner",
    });
    const decoded = decodeRoomData(new TextEncoder().encode(raw));
    expect(decoded && "type" in decoded && decoded.type).toBe("transcript");
    if (decoded && "type" in decoded && decoded.type === "transcript") {
      expect(decoded.source).toBe("captioner");
    }
  });

  it("keeps a server caption packet", () => {
    const raw = JSON.stringify({
      type: "transcript",
      participantId: "aaron_1",
      name: "Aaron",
      text: "server heard this",
      isFinal: true,
      ts: 11,
      source: "server",
    });
    const decoded = decodeRoomData(new TextEncoder().encode(raw));
    expect(decoded && "type" in decoded && decoded.type).toBe("transcript");
    if (decoded && "type" in decoded && decoded.type === "transcript") {
      expect(decoded.source).toBe("server");
    }
  });
});
