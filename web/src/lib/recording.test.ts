import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_RECORDING,
  formatRecElapsed,
  formatRecPill,
  formatRecordingDuration,
  guestRecordingConsent,
  mayDownloadRecording,
  meetingOpsHref,
  parseRecordingFrame,
  recordingSystemLine,
  recordingWho,
  reduceRecordingState,
  shouldAutoStartRecording,
  showRecordControl,
  starterDisplayName,
  type RecordingState,
} from "./recording";
import { loadRecordMyCalls, saveRecordMyCalls } from "./recordMyCalls";
import { useRecordingStore } from "@/stores/recordingStore";

const NOW = Date.parse("2026-09-21T18:12:04Z");
const STARTED = new Date(NOW - (12 * 60 + 4) * 1000).toISOString();

function active(over: Partial<RecordingState> = {}): RecordingState {
  return {
    active: true,
    kind: "audio",
    startedBy: "p-aaron",
    startedByName: null,
    startedAt: STARTED,
    ...over,
  };
}

describe("recording pill reducer", () => {
  it("ignores a frame that does not say whether recording is on", () => {
    expect(parseRecordingFrame(null)).toBeNull();
    expect(parseRecordingFrame({ kind: "audio" })).toBeNull();
    expect(parseRecordingFrame({ active: "yes" })).toBeNull();
  });

  it("reads the contract fields, including an optional room id and name", () => {
    expect(
      parseRecordingFrame({
        active: true,
        kind: "composite",
        started_by: "p-aaron",
        started_by_name: "Aaron",
        started_at: STARTED,
        room_id: "room-1",
      }),
    ).toEqual({
      roomId: "room-1",
      state: {
        active: true,
        kind: "composite",
        startedBy: "p-aaron",
        startedByName: "Aaron",
        startedAt: STARTED,
      },
    });
  });

  it("starts from idle, and a repeat of the same recording does not chime again", () => {
    const first = reduceRecordingState(IDLE_RECORDING, active());
    expect(first.transition).toBe("start");
    expect(first.next.active).toBe(true);

    const again = reduceRecordingState(first.next, active());
    expect(again.transition).toBe("none");
    expect(again.next.startedAt).toBe(STARTED);
  });

  it("fills in a name without treating it as a new recording", () => {
    const started = reduceRecordingState(IDLE_RECORDING, active());
    const named = reduceRecordingState(
      started.next,
      active({ startedByName: "Aaron" }),
    );
    expect(named.transition).toBe("none");
    expect(named.next.startedByName).toBe("Aaron");
  });

  it("stops back to idle and keeps the previous recording for the chat line", () => {
    const started = reduceRecordingState(IDLE_RECORDING, active({ startedByName: "Aaron" }));
    const stopped = reduceRecordingState(started.next, {
      ...IDLE_RECORDING,
      active: false,
    });
    expect(stopped.transition).toBe("stop");
    expect(stopped.next).toEqual(IDLE_RECORDING);
    expect(stopped.prev.startedByName).toBe("Aaron");
  });

  it("a second start with a different clock is a new recording", () => {
    const started = reduceRecordingState(IDLE_RECORDING, active());
    const later = new Date(NOW).toISOString();
    const again = reduceRecordingState(started.next, active({ startedAt: later }));
    expect(again.transition).toBe("start");
    expect(again.next.startedAt).toBe(later);
  });
});

describe("REC pill text", () => {
  it("renders the receipt everyone in the call can read", () => {
    expect(formatRecElapsed(STARTED, NOW)).toBe("12:04");
    expect(formatRecPill({ startedAt: STARTED }, "Aaron", NOW)).toBe(
      "● REC 12:04 · started by Aaron",
    );
  });

  it("rolls past an hour and never goes negative", () => {
    const start = new Date(NOW - (1 * 3600 + 2 * 60 + 3) * 1000).toISOString();
    expect(formatRecElapsed(start, NOW)).toBe("1:02:03");
    expect(formatRecElapsed(new Date(NOW + 10_000).toISOString(), NOW)).toBe("00:00");
    expect(formatRecElapsed(null, NOW)).toBe("00:00");
  });

  it("formats a stored duration the same way", () => {
    expect(formatRecordingDuration(12 * 60 + 4)).toBe("12:04");
    expect(formatRecordingDuration(null)).toBe("—");
  });

  it("resolves the starter from the roster when the frame has only an id", () => {
    expect(
      starterDisplayName(active(), [
        { participant_id: "p-aaron", display_name: "Aaron" },
      ]),
    ).toBe("Aaron");
    expect(starterDisplayName(active({ startedByName: "Aaron S." }), [])).toBe(
      "Aaron S.",
    );
    expect(starterDisplayName(IDLE_RECORDING, [])).toBe("someone");
  });
});

describe("record control and consent", () => {
  it("shows Record only when the person is entitled and the room allows it", () => {
    expect(
      showRecordControl({ roles: ["stable-recorder"], policy: "on_request" }),
    ).toBe(true);
    expect(showRecordControl({ roles: ["stable-recorder"], policy: "always" })).toBe(
      true,
    );
    expect(showRecordControl({ roles: ["stable-recorder"], policy: "off" })).toBe(
      false,
    );
    expect(showRecordControl({ roles: ["user"], policy: "always" })).toBe(false);
    expect(showRecordControl({ roles: null, policy: "on_request" })).toBe(false);
  });

  it("auto-starts only calls this person started, in an Ask room", () => {
    const base = {
      recordMyCalls: true,
      entitled: true,
      policy: "on_request" as const,
    };
    expect(shouldAutoStartRecording({ ...base, callResult: "joined_ringing" })).toBe(
      true,
    );
    expect(shouldAutoStartRecording({ ...base, callResult: "joined_channel" })).toBe(
      true,
    );
    expect(shouldAutoStartRecording({ ...base, callResult: "joined_in_call" })).toBe(
      false,
    );
    expect(shouldAutoStartRecording({ ...base, callResult: "backed_out" })).toBe(false);
    expect(
      shouldAutoStartRecording({ ...base, policy: "always", callResult: "joined_ringing" }),
    ).toBe(false);
    expect(
      shouldAutoStartRecording({ ...base, policy: "off", callResult: "joined_ringing" }),
    ).toBe(false);
    expect(
      shouldAutoStartRecording({
        ...base,
        recordMyCalls: false,
        callResult: "joined_ringing",
      }),
    ).toBe(false);
    expect(
      shouldAutoStartRecording({ ...base, entitled: false, callResult: "joined_ringing" }),
    ).toBe(false);
  });

  it("writes a system line on start and stop", () => {
    expect(recordingSystemLine("start", { kind: "composite" }, "Aaron")).toBe(
      "Recording started · video · started by Aaron",
    );
    expect(recordingSystemLine("stop", { kind: "audio" }, "Aaron")).toBe(
      "Recording stopped · started by Aaron",
    );
    expect(recordingSystemLine("none", { kind: "audio" }, "Aaron")).toBeNull();
  });

  it("shows the guest consent line only when the room records", () => {
    expect(guestRecordingConsent({ policy: null, active: null })).toBeNull();
    expect(guestRecordingConsent({ policy: "off", active: false })).toBeNull();
    expect(guestRecordingConsent({ policy: "always", active: false })).toMatch(/records every call/);
    expect(guestRecordingConsent({ policy: "on_request", active: false })).toMatch(/can record/);
    expect(guestRecordingConsent({ policy: "off", active: true })).toMatch(/recording is on/i);
  });
});

describe("recordings list permissions", () => {
  it("lets the owner, an admin, and the recorder download a real file", () => {
    const storageUrl = "https://storage.example/rec.ogg";
    expect(
      mayDownloadRecording({
        myRole: "member",
        myParticipantId: "p-aaron",
        startedBy: "p-aaron",
        storageUrl,
      }),
    ).toBe(true);
    expect(
      mayDownloadRecording({
        myRole: "owner",
        myParticipantId: "p-other",
        startedBy: "p-aaron",
        storageUrl,
      }),
    ).toBe(true);
    expect(
      mayDownloadRecording({
        myRole: "member",
        myParticipantId: "p-other",
        startedBy: "p-aaron",
        storageUrl,
      }),
    ).toBe(false);
    expect(
      mayDownloadRecording({
        myRole: "owner",
        myParticipantId: "p-other",
        startedBy: "p-aaron",
        storageUrl: "/var/egress/rec.ogg",
      }),
    ).toBe(false);
  });

  it("opens Meeting-Ops only from an http(s) link", () => {
    expect(meetingOpsHref({ session_url: "https://meetingops.example/sessions/mo-1" })).toBe(
      "https://meetingops.example/sessions/mo-1",
    );
    expect(meetingOpsHref({ mo_session_id: "mo-1" })).toBeNull();
  });

  it("names the person who started the row", () => {
    expect(
      recordingWho({ started_by: "p-aaron" }, [
        { participant_id: "p-aaron", display_name: "Aaron" },
      ]),
    ).toBe("Aaron");
  });
});

describe("recording store", () => {
  afterEach(() => {
    useRecordingStore.setState({ byRoom: {} });
  });

  it("keeps one state per room and does not chime on a duplicate frame", () => {
    const store = useRecordingStore.getState();
    const first = store.applyFrame("room-1", {
      active: true,
      kind: "audio",
      started_by: "p-aaron",
      started_by_name: "Aaron",
      started_at: STARTED,
    });
    expect(first?.transition).toBe("start");
    expect(useRecordingStore.getState().byRoom["room-1"]?.active).toBe(true);

    const second = useRecordingStore.getState().applyFrame("room-1", {
      active: true,
      kind: "audio",
      started_by: "p-aaron",
      started_at: STARTED,
    });
    expect(second?.transition).toBe("none");

    const other = useRecordingStore.getState().applyFrame("room-2", {
      active: false,
      room_id: "room-9",
    });
    expect(other?.roomId).toBe("room-9");
    expect(useRecordingStore.getState().byRoom["room-1"]?.active).toBe(true);
  });
});

describe("record calls I start", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults off and remembers an explicit choice on this device", () => {
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => void mem.set(key, value),
      removeItem: (key: string) => void mem.delete(key),
    });
    expect(loadRecordMyCalls()).toBe(false);
    saveRecordMyCalls(true);
    expect(loadRecordMyCalls()).toBe(true);
    saveRecordMyCalls(false);
    expect(loadRecordMyCalls()).toBe(false);
  });
});
