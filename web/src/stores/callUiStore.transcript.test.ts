import { beforeEach, describe, expect, it } from "vitest";
import { useCallUiStore } from "./callUiStore";

describe("ingestTranscript speaker authority", () => {
  beforeEach(() => {
    useCallUiStore.getState().clearTranscript();
  });

  it("drops agent_stt that matches a local_mic line for a different speaker", () => {
    const store = useCallUiStore.getState();
    store.ingestTranscript({
      type: "transcript",
      participantId: "aaron",
      name: "Aaron",
      text: "let us ship the polish pack today",
      isFinal: true,
      ts: 1000,
      source: "local_mic",
    });
    store.ingestTranscript({
      type: "transcript",
      participantId: "shafen",
      name: "Shafen",
      text: "let us ship the polish pack today",
      isFinal: true,
      ts: 1050,
      source: "agent_stt",
    });
    const lines = useCallUiStore.getState().transcript;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.participantId).toBe("aaron");
    expect(lines[0]?.source).toBe("local_mic");
  });

  it("drops local_mic echo when remote local_mic already claimed the utterance", () => {
    const store = useCallUiStore.getState();
    store.ingestTranscript({
      type: "transcript",
      participantId: "shafen",
      name: "Shafen",
      text: "can you hear me clearly now",
      isFinal: true,
      ts: 2000,
      source: "local_mic",
    });
    // Local browser also "heard" far-end audio through speakers
    store.ingestTranscript({
      type: "transcript",
      participantId: "aaron",
      name: "Aaron",
      text: "can you hear me clearly now",
      isFinal: true,
      ts: 2100,
      source: "local_mic",
    });
    const lines = useCallUiStore.getState().transcript;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.participantId).toBe("shafen");
  });

  it("drops unidentified agent_stt frames", () => {
    useCallUiStore.getState().ingestTranscript({
      type: "transcript",
      participantId: "human",
      name: "Unidentified speaker",
      text: "mystery words",
      isFinal: true,
      ts: 3000,
      source: "agent_stt",
    });
    expect(useCallUiStore.getState().transcript).toHaveLength(0);
  });
});
