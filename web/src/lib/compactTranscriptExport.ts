import { exportCaptionSource } from "@/lib/captionState";

/**
 * Stable's export route and Meeting-Ops ingest both refuse a payload over
 * these limits. Compaction fits a longer call into the contract; it does
 * not raise the contract.
 */
export const TRANSCRIPT_EXPORT_MAX_LINES = 2000;
export const TRANSCRIPT_EXPORT_MAX_CHARS = 8000;

/** Spans tried, shortest first, when same-speaker runs are still over the line cap. */
const TRANSCRIPT_EXPORT_WINDOW_STEPS_MS: readonly number[] = [
  1_000,
  5_000,
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  Number.POSITIVE_INFINITY,
];

export interface CompactTranscriptLine {
  participantId: string;
  name: string;
  text: string;
  ts: number;
  /** Becomes segment_id. A merged run keeps the first line's id. */
  segmentId: string;
  source?: string;
}

export interface ExportableTranscriptLine {
  id: string;
  participantId: string;
  name: string;
  text: string;
  ts: number;
  isFinal?: boolean;
  source?: string;
}

export interface CallTranscriptExportLine {
  participant_id: string;
  name: string;
  text: string;
  ts: number;
  is_final: true;
  segment_id: string;
  source: "local_mic" | "agent_stt" | "agent" | "unknown";
}

export interface CompactTranscriptOptions {
  /** Called only when the last-resort trim actually drops lines. */
  warn?: (message: string) => void;
}

function defaultWarn(message: string): void {
  console.warn(message);
}

function continuationSegmentId(segmentId: string, part: number): string {
  const suffix = `~${part}`;
  const room = Math.max(1, 256 - suffix.length);
  const base = segmentId.length > room ? segmentId.slice(0, room) : segmentId;
  return `${base}${suffix}`;
}

function splitLine(line: CompactTranscriptLine): CompactTranscriptLine[] {
  if (line.text.length <= TRANSCRIPT_EXPORT_MAX_CHARS) return [line];
  const parts: CompactTranscriptLine[] = [];
  let rest = line.text;
  let part = 0;
  while (rest.length > TRANSCRIPT_EXPORT_MAX_CHARS) {
    let cut = rest.lastIndexOf(" ", TRANSCRIPT_EXPORT_MAX_CHARS);
    if (cut <= 0) cut = TRANSCRIPT_EXPORT_MAX_CHARS;
    const piece = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).trimStart();
    parts.push({
      ...line,
      text: piece,
      segmentId: part === 0 ? line.segmentId : continuationSegmentId(line.segmentId, part),
    });
    part += 1;
  }
  if (rest) {
    parts.push({
      ...line,
      text: rest,
      segmentId: part === 0 ? line.segmentId : continuationSegmentId(line.segmentId, part),
    });
  }
  return parts;
}

function normalize(lines: readonly CompactTranscriptLine[]): CompactTranscriptLine[] {
  const out: CompactTranscriptLine[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    out.push({ ...line, text });
  }
  return out;
}

function canJoin(left: string, right: string): boolean {
  return left.length + 1 + right.length <= TRANSCRIPT_EXPORT_MAX_CHARS;
}

/** Adjacent lines from one participant, in input order. Stops before 8000 characters. */
function mergeConsecutive(lines: readonly CompactTranscriptLine[]): CompactTranscriptLine[] {
  const out: CompactTranscriptLine[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev && prev.participantId === line.participantId && canJoin(prev.text, line.text)) {
      out[out.length - 1] = { ...prev, text: `${prev.text} ${line.text}` };
      continue;
    }
    out.push({ ...line });
  }
  return out;
}

function sortByTime(lines: readonly CompactTranscriptLine[]): CompactTranscriptLine[] {
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => a.line.ts - b.line.ts || a.index - b.index)
    .map((item) => item.line);
}

/**
 * Per participant, fold lines whose timestamps fall in a window anchored on
 * the group's first line. Other speakers stay on their own lines. Words of
 * one participant stay in input order. The group's ts and segment id stay
 * with the first line.
 */
function mergeWindows(
  lines: readonly CompactTranscriptLine[],
  windowMs: number,
): CompactTranscriptLine[] {
  const groups = new Map<string, CompactTranscriptLine[]>();
  for (const line of lines) {
    const list = groups.get(line.participantId);
    if (list) list.push(line);
    else groups.set(line.participantId, [{ ...line }]);
  }
  const merged: CompactTranscriptLine[] = [];
  for (const group of groups.values()) {
    let open: CompactTranscriptLine | null = null;
    for (const line of group) {
      if (
        open &&
        line.ts >= open.ts &&
        line.ts - open.ts <= windowMs &&
        canJoin(open.text, line.text)
      ) {
        open = { ...open, text: `${open.text} ${line.text}` };
      } else {
        if (open) merged.push(open);
        open = { ...line };
      }
    }
    if (open) merged.push(open);
  }
  return sortByTime(merged);
}

/**
 * Fit final caption lines into the 2000 × 8000 export contract.
 *
 * At or under 2000 lines (and 8000 characters each), the input is returned
 * unchanged apart from a trim of surrounding whitespace. Over the line cap,
 * consecutive same-participant lines merge first. If that is not enough,
 * each participant's lines merge inside widening time windows. Dropping the
 * oldest lines is the last resort, and it warns with the dropped count.
 */
export function compactTranscriptForExport(
  lines: readonly CompactTranscriptLine[],
  options?: CompactTranscriptOptions,
): CompactTranscriptLine[] {
  const warn = options?.warn ?? defaultWarn;
  let current = normalize(lines);
  current = current.flatMap(splitLine);
  if (current.length > TRANSCRIPT_EXPORT_MAX_LINES) {
    current = mergeConsecutive(current);
  }
  if (current.length > TRANSCRIPT_EXPORT_MAX_LINES) {
    for (const windowMs of TRANSCRIPT_EXPORT_WINDOW_STEPS_MS) {
      current = mergeWindows(current, windowMs);
      if (current.length <= TRANSCRIPT_EXPORT_MAX_LINES) break;
    }
  }
  if (current.length > TRANSCRIPT_EXPORT_MAX_LINES) {
    const ordered = sortByTime(current);
    const dropped = ordered.length - TRANSCRIPT_EXPORT_MAX_LINES;
    warn(
      `call transcript export dropped ${dropped} lines to fit the ${TRANSCRIPT_EXPORT_MAX_LINES}-line contract; kept the newest ${TRANSCRIPT_EXPORT_MAX_LINES}`,
    );
    current = ordered.slice(ordered.length - TRANSCRIPT_EXPORT_MAX_LINES);
  }
  return current;
}

/**
 * Persisted voice-chat turns (id prefix `voice:`) are not caption packets.
 * Manual Send still includes ones the export buffer does not already have.
 * Buffer order is preserved; extras are inserted by timestamp.
 */
export function withVoiceHistoryLines(
  buffer: readonly ExportableTranscriptLine[],
  displayed: readonly ExportableTranscriptLine[],
): ExportableTranscriptLine[] {
  const known = new Set<string>();
  for (const line of buffer) {
    const text = line.text.trim();
    if (text) known.add(text);
  }
  const extras: ExportableTranscriptLine[] = [];
  for (const line of displayed) {
    if (!line.id.startsWith("voice:")) continue;
    if (line.isFinal === false) continue;
    const text = line.text.trim();
    if (!text || known.has(text)) continue;
    known.add(text);
    extras.push(line);
  }
  if (extras.length === 0) return [...buffer];
  const pending = [...extras].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const merged: ExportableTranscriptLine[] = [];
  let extraIndex = 0;
  for (const line of buffer) {
    while (extraIndex < pending.length && pending[extraIndex].ts <= line.ts) {
      merged.push(pending[extraIndex]);
      extraIndex += 1;
    }
    merged.push(line);
  }
  while (extraIndex < pending.length) {
    merged.push(pending[extraIndex]);
    extraIndex += 1;
  }
  return merged;
}

/** Map store lines (or a voice-history merge of them) onto the export request. */
export function buildCallTranscriptExportLines(
  lines: readonly ExportableTranscriptLine[],
  options?: CompactTranscriptOptions,
): CallTranscriptExportLine[] {
  const compactInput: CompactTranscriptLine[] = [];
  for (const line of lines) {
    if (line.isFinal === false) continue;
    const text = line.text.trim();
    if (!text) continue;
    compactInput.push({
      participantId: line.participantId,
      name: line.name,
      text,
      ts: line.ts,
      segmentId: line.id,
      source: line.source,
    });
  }
  return compactTranscriptForExport(compactInput, options).map((line) => ({
    participant_id: line.participantId,
    name: line.name,
    text: line.text,
    ts: line.ts,
    is_final: true,
    segment_id: line.segmentId,
    source: exportCaptionSource(line.source),
  }));
}
