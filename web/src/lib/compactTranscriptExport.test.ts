import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPT_EXPORT_MAX_CHARS,
  TRANSCRIPT_EXPORT_MAX_LINES,
  buildCallTranscriptExportLines,
  compactTranscriptForExport,
  withVoiceHistoryLines,
  type CompactTranscriptLine,
  type ExportableTranscriptLine,
} from "./compactTranscriptExport";

function line(
  over: Partial<CompactTranscriptLine> &
    Pick<CompactTranscriptLine, "participantId" | "text">,
): CompactTranscriptLine {
  return {
    name: over.name ?? over.participantId,
    ts: over.ts ?? 0,
    segmentId: over.segmentId ?? "seg",
    ...over,
  };
}

function many(
  count: number,
  make: (index: number) => CompactTranscriptLine,
): CompactTranscriptLine[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

function wordsOf(lines: { text: string }[]): string[] {
  return lines.flatMap((entry) => entry.text.split(/\s+/).filter(Boolean));
}

describe("compactTranscriptForExport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("locks the Stable and Meeting-Ops contract", () => {
    expect(TRANSCRIPT_EXPORT_MAX_LINES).toBe(2000);
    expect(TRANSCRIPT_EXPORT_MAX_CHARS).toBe(8000);
  });

  it("returns a call at or under 2000 lines unchanged, including a 700-line run", () => {
    const lines = many(700, (index) =>
      line({
        participantId: "ada",
        name: "Ada",
        text: `utterance-${index}`,
        ts: index,
        segmentId: `seg-${index}`,
      }),
    );
    const out = compactTranscriptForExport(lines);
    expect(out).toHaveLength(700);
    expect(out.map((entry) => entry.text)).toEqual(lines.map((entry) => entry.text));
    expect(out[0]?.segmentId).toBe("seg-0");
    expect(out[699]?.segmentId).toBe("seg-699");
  });

  it("a 5000-line call with alternating speakers exports ≤ 2000 lines containing every word in order", () => {
    const lines = many(5000, (index) =>
      line({
        participantId: index % 2 === 0 ? "ada" : "bea",
        name: index % 2 === 0 ? "Ada" : "Bea",
        text: `w${index}`,
        ts: 1_000_000 + index * 1_500,
        segmentId: `seg-${index}`,
        source: "local_mic",
      }),
    );
    const warn = vi.fn();
    const out = compactTranscriptForExport(lines, { warn });
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.length).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
    expect(out.every((entry) => entry.text.length <= 8000)).toBe(true);
    for (const participantId of ["ada", "bea"]) {
      expect(wordsOf(out.filter((entry) => entry.participantId === participantId))).toEqual(
        wordsOf(lines.filter((entry) => entry.participantId === participantId)),
      );
    }
    expect(wordsOf(out)).toContain("w0");
    expect(wordsOf(out)).toContain("w4999");
  });

  it("merges a same-speaker overflow, keeping the first ts and segment id", () => {
    const lines = many(2001, (index) =>
      line({
        participantId: "ada",
        name: index === 0 ? "Ada" : "Renamed",
        text: "x",
        ts: 10_000 + index,
        segmentId: `seg-${index}`,
        source: index === 0 ? "local_mic" : "server",
      }),
    );
    const snapshot = JSON.stringify(lines);
    const out = compactTranscriptForExport(lines);
    expect(JSON.stringify(lines)).toBe(snapshot);
    expect(out).toHaveLength(1);
    expect(out[0]?.ts).toBe(10_000);
    expect(out[0]?.segmentId).toBe("seg-0");
    expect(out[0]?.name).toBe("Ada");
    expect(out[0]?.source).toBe("local_mic");
    expect(out[0]?.text).toBe(lines.map((entry) => entry.text).join(" "));
    expect(out[0]?.text.length).toBeLessThanOrEqual(8000);
  });

  it("never produces a line over 8000 characters", () => {
    const chunk = "a".repeat(3999);
    const lines = many(2001, (index) =>
      line({
        participantId: "ada",
        name: "Ada",
        text: chunk,
        ts: index,
        segmentId: `seg-${index}`,
      }),
    );
    const warn = vi.fn();
    const out = compactTranscriptForExport(lines, { warn });
    expect(out.every((entry) => entry.text.length <= 8000)).toBe(true);
    expect(out).toHaveLength(1001);
    expect(out[0]?.text.length).toBe(3999 + 1 + 3999);
    expect(out[0]?.segmentId).toBe("seg-0");
    expect(out[0]?.ts).toBe(0);
    expect(out[1]?.segmentId).toBe("seg-2");
    expect(warn).not.toHaveBeenCalled();
    const kept = out.reduce((total, entry) => total + entry.text.replace(/ /g, "").length, 0);
    expect(kept).toBe(3999 * 2001);
  });

  it("splits a single line that is already over 8000 characters and keeps every word", () => {
    const text = Array.from({ length: 2000 }, () => "word").join(" ");
    expect(text.length).toBeGreaterThan(8000);
    const out = compactTranscriptForExport([
      line({
        participantId: "ada",
        name: "Ada",
        text,
        ts: 42,
        segmentId: "only",
      }),
    ]);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((entry) => entry.text.length <= 8000)).toBe(true);
    expect(out.map((entry) => entry.text).join(" ")).toBe(text);
    expect(out[0]?.ts).toBe(42);
    expect(out[0]?.segmentId).toBe("only");
  });

  it("keeps the newest 2000 and warns when nothing can merge", () => {
    const lines = many(2500, (index) =>
      line({
        participantId: index % 2 === 0 ? "ada" : "bea",
        name: index % 2 === 0 ? "Ada" : "Bea",
        text: "b".repeat(5000),
        ts: index,
        segmentId: `seg-${index}`,
      }),
    );
    const warnings: string[] = [];
    const out = compactTranscriptForExport(lines, {
      warn: (message) => warnings.push(message),
    });
    expect(out).toHaveLength(2000);
    expect(out.every((entry) => entry.text.length <= 8000)).toBe(true);
    expect(out[0]?.segmentId).toBe("seg-500");
    expect(out[1999]?.segmentId).toBe("seg-2499");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dropped 500");
  });

  it("warns through console.warn when no logger is passed", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lines = many(2001, (index) =>
      line({
        participantId: index % 2 === 0 ? "ada" : "bea",
        text: "c".repeat(5000),
        ts: index,
        segmentId: `seg-${index}`,
      }),
    );
    const out = compactTranscriptForExport(lines);
    expect(out).toHaveLength(2000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("dropped 1");
  });
});

describe("withVoiceHistoryLines", () => {
  it("inserts a voice turn the caption buffer does not already have", () => {
    const buffer: ExportableTranscriptLine[] = [
      {
        id: "cap-1",
        participantId: "ada",
        name: "Ada",
        text: "hello",
        ts: 100,
        isFinal: true,
        source: "local_mic",
      },
    ];
    const displayed: ExportableTranscriptLine[] = [
      ...buffer,
      {
        id: "voice:m-1",
        participantId: "bea",
        name: "Bea",
        text: "from chat",
        ts: 50,
        isFinal: true,
        source: "captioner",
      },
      {
        id: "voice:m-2",
        participantId: "bea",
        name: "Bea",
        text: "hello",
        ts: 150,
        isFinal: true,
        source: "captioner",
      },
      {
        id: "voice:m-3",
        participantId: "bea",
        name: "Bea",
        text: "   ",
        ts: 160,
        isFinal: true,
      },
      {
        id: "live-interim",
        participantId: "ada",
        name: "Ada",
        text: "not a voice id",
        ts: 10,
        isFinal: true,
      },
    ];
    const merged = withVoiceHistoryLines(buffer, displayed);
    expect(merged.map((entry) => entry.id)).toEqual(["voice:m-1", "cap-1"]);
  });
});

describe("buildCallTranscriptExportLines", () => {
  it("drops interims and blank finals and maps the wire fields", () => {
    const out = buildCallTranscriptExportLines([
      {
        id: "i-1",
        participantId: "ada",
        name: "Ada",
        text: "partial",
        ts: 1,
        isFinal: false,
        source: "local_mic",
      },
      {
        id: "f-1",
        participantId: "ada",
        name: "Ada",
        text: "  committed  ",
        ts: 2,
        isFinal: true,
        source: "captioner",
      },
      {
        id: "f-2",
        participantId: "bea",
        name: "Bea",
        text: "   ",
        ts: 3,
        isFinal: true,
        source: "server",
      },
    ]);
    expect(out).toEqual([
      {
        participant_id: "ada",
        name: "Ada",
        text: "committed",
        ts: 2,
        is_final: true,
        segment_id: "f-1",
        source: "agent_stt",
      },
    ]);
  });
});
