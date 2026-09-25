import { beforeEach, describe, expect, it } from "vitest";
import { buildCallTranscriptExportLines } from "@/lib/compactTranscriptExport";
import { MAX_TRANSCRIPT_LINES, useCallUiStore } from "./callUiStore";
import type { TranscriptMessage } from "@/lib/roomDataProtocol";

function ingest(over: Partial<TranscriptMessage> & Pick<TranscriptMessage, "text" | "ts">): void {
  useCallUiStore.getState().ingestTranscript({
    type: "transcript",
    participantId: "ada",
    name: "Ada",
    isFinal: true,
    source: "local_mic",
    ...over,
  });
}

describe("call transcript export buffer", () => {
  beforeEach(() => {
    useCallUiStore.getState().clearTranscript();
  });

  it("a 700-line call exports all 700 lines", () => {
    for (let i = 0; i < 700; i++) {
      ingest({
        text: `utterance-${i}`,
        ts: 8_000_000_000 + i * 1_500,
        segmentId: `seg-${i}`,
      });
    }
    const state = useCallUiStore.getState();
    const exported = buildCallTranscriptExportLines(state.exportTranscript);
    expect(exported).toHaveLength(700);
    expect(exported[0]?.text).toBe("utterance-0");
    expect(exported[0]?.segment_id).toBe("seg-0");
    expect(exported[699]?.text).toBe("utterance-699");
    expect(state.exportTranscript).toHaveLength(700);
  });

  it("keeps the on-screen list capped at 500", () => {
    expect(MAX_TRANSCRIPT_LINES).toBe(500);
    for (let i = 0; i < 700; i++) {
      ingest({
        text: `utterance-${i}`,
        ts: 8_000_000_000 + i * 1_500,
        segmentId: `seg-${i}`,
      });
    }
    const shown = useCallUiStore.getState().transcript;
    expect(shown).toHaveLength(500);
    expect(shown[0]?.text).toBe("utterance-200");
    expect(shown[499]?.text).toBe("utterance-699");
    expect(shown.some((line) => line.text === "utterance-0")).toBe(false);
  });

  it("a 5000-line call with alternating speakers exports ≤ 2000 lines containing every word in order", () => {
    for (let i = 0; i < 5000; i++) {
      const second = i % 2 === 1;
      ingest({
        participantId: second ? "bea" : "ada",
        name: second ? "Bea" : "Ada",
        text: `w${i}`,
        ts: 9_000_000_000 + i * 1_500,
        segmentId: `seg-${i}`,
      });
    }
    const state = useCallUiStore.getState();
    expect(state.transcript).toHaveLength(500);
    expect(state.exportTranscript).toHaveLength(5000);
    const exported = buildCallTranscriptExportLines(state.exportTranscript);
    expect(exported.length).toBeLessThanOrEqual(2000);
    expect(exported.every((line) => line.text.length <= 8000)).toBe(true);
    for (const participantId of ["ada", "bea"]) {
      const before = state.exportTranscript
        .filter((line) => line.participantId === participantId)
        .map((line) => line.text)
        .join(" ");
      const after = exported
        .filter((line) => line.participant_id === participantId)
        .map((line) => line.text)
        .join(" ");
      expect(after).toBe(before);
    }
  });

  it("keeps interim lines out of the export and does not replace an earlier final", () => {
    ingest({
      text: "hello wor",
      ts: 1_000,
      isFinal: false,
      segmentId: "seg-1",
    });
    ingest({
      text: "hello world",
      ts: 1_100,
      isFinal: false,
      segmentId: "seg-1",
    });
    expect(useCallUiStore.getState().transcript).toHaveLength(1);
    expect(useCallUiStore.getState().exportTranscript).toHaveLength(0);
    ingest({
      text: "hello world",
      ts: 1_200,
      isFinal: true,
      segmentId: "seg-1",
    });
    ingest({
      text: "and another sentence",
      ts: 5_000,
      isFinal: true,
      segmentId: "seg-2",
    });
    const exported = useCallUiStore.getState().exportTranscript;
    expect(exported.map((line) => line.text)).toEqual([
      "hello world",
      "and another sentence",
    ]);
    expect(exported.every((line) => line.isFinal)).toBe(true);
  });

  it("drops a remote echo from the export buffer", () => {
    ingest({
      participantId: "shafen",
      name: "Shafen",
      text: "can you hear me clearly now",
      ts: 2_000,
      source: "local_mic",
    });
    ingest({
      participantId: "aaron",
      name: "Aaron",
      text: "can you hear me clearly now",
      ts: 2_100,
      source: "local_mic",
    });
    const exported = useCallUiStore.getState().exportTranscript;
    expect(exported).toHaveLength(1);
    expect(exported[0]?.participantId).toBe("shafen");
  });

  it("drops an echo of a final that has scrolled off the on-screen list", () => {
    for (let i = 0; i < 501; i++) {
      ingest({
        text: `word${i}z`,
        ts: 10_000 + i,
        segmentId: `seg-${i}`,
      });
    }
    const before = useCallUiStore.getState();
    expect(before.transcript.some((line) => line.text === "word0z")).toBe(false);
    expect(before.exportTranscript[0]?.text).toBe("word0z");
    ingest({
      participantId: "bea",
      name: "Bea",
      text: "word0z",
      ts: 10_050,
      segmentId: "echo",
    });
    const after = useCallUiStore.getState();
    expect(after.exportTranscript).toHaveLength(501);
    expect(after.exportTranscript.some((line) => line.participantId === "bea")).toBe(false);
    expect(after.transcript).toHaveLength(500);
  });

  it("keeps the browser line and not the server duplicate", () => {
    ingest({
      text: "caption this from the server",
      ts: 6_000,
      source: "server",
      segmentId: "server-1",
    });
    ingest({
      text: "caption this from the server",
      ts: 6_200,
      source: "local_mic",
      segmentId: "browser-1",
    });
    const exported = useCallUiStore.getState().exportTranscript;
    expect(exported).toHaveLength(1);
    expect(exported[0]?.source).toBe("local_mic");
    expect(exported[0]?.id).toBe("browser-1");
  });

  it("resets the export buffer between calls", () => {
    ingest({ text: "first call", ts: 1_000, segmentId: "a" });
    expect(useCallUiStore.getState().exportTranscript).toHaveLength(1);
    useCallUiStore.getState().beginCallTranscriptSession();
    expect(useCallUiStore.getState().exportTranscript).toEqual([]);
    expect(useCallUiStore.getState().transcript).toEqual([]);

    ingest({ text: "second call", ts: 2_000, segmentId: "b" });
    useCallUiStore.getState().resetForServer();
    expect(useCallUiStore.getState().exportTranscript).toEqual([]);
    expect(useCallUiStore.getState().transcript).toEqual([]);

    ingest({ text: "cleared by hand", ts: 3_000, segmentId: "c" });
    useCallUiStore.getState().clearTranscript();
    expect(useCallUiStore.getState().exportTranscript).toEqual([]);
    expect(useCallUiStore.getState().transcript).toEqual([]);
  });
});
