import { describe, expect, it } from "vitest";
import {
  dropSupersededReceipts,
  hasPersistedRecordingNotice,
  lastLinePreview,
  isSupersededReceipt,
  isSystemLine,
  memberName,
  recordingNoticeOf,
  recordingNoticeText,
  systemLineText,
  threadStartedOf,
  threadStartedText,
} from "./systemLines";

const members = [
  { participant_id: "p-aaron", display_name: "Aaron Stransky", username: "aaron" },
  { participant_id: "p-jason", display_name: "", username: "jason" },
];

function notice(content: string, metadata: Record<string, unknown>, created_at = "2026-09-29T01:00:00Z") {
  return { id: "m", content, sender_type: "system", content_type: "system", created_at, metadata };
}

describe("recording notices", () => {
  it("names the starter from metadata.started_by and says the reason in words", () => {
    const started = (reason: string, started_by: string | null = "p-aaron") =>
      notice("Audio recording started", { kind: "recording", event: "started", recording_kind: "audio", started_by, reason });
    expect(recordingNoticeText(started("user"), members)).toBe("Audio recording started · by Aaron Stransky");
    expect(recordingNoticeText(started("manual"), members)).toBe("Audio recording started · by Aaron Stransky");
    expect(recordingNoticeText(started("policy always"), members)).toBe(
      "Audio recording started · by Aaron Stransky · this room always records",
    );
    expect(recordingNoticeText(started("record_my_calls"), members)).toBe(
      "Audio recording started · Aaron Stransky records their calls",
    );
    // A policy start has no starter: nothing is invented.
    expect(recordingNoticeText(started("policy always", null), members)).toBe(
      "Audio recording started · this room always records",
    );
    expect(recordingNoticeText(started("record_my_calls", null), members)).toBe(
      "Audio recording started · record my calls is on",
    );
  });

  it("falls back to nothing when the roster cannot resolve the id", () => {
    const line = notice("Video recording started", { kind: "recording", event: "started", started_by: "p-unknown", reason: "user" });
    expect(recordingNoticeText(line, members)).toBe("Video recording started");
    expect(recordingNoticeText(line, null)).toBe("Video recording started");
    expect(recordingNoticeText(line, [])).toBe("Video recording started");
    // A roster row with no display name still has a username.
    const jason = notice("Audio recording started", { kind: "recording", event: "started", started_by: "p-jason", reason: "user" });
    expect(recordingNoticeText(jason, members)).toBe("Audio recording started · by jason");
  });

  it("says why a recording stopped", () => {
    const stopped = (reason: string) =>
      notice("Audio recording stopped", { kind: "recording", event: "stopped", started_by: "p-aaron", reason });
    expect(recordingNoticeText(stopped("stop_requested"), members)).toBe(
      "Audio recording stopped · on request · started by Aaron Stransky",
    );
    expect(recordingNoticeText(stopped("room_idle"), members)).toBe(
      "Audio recording stopped · the room went idle · started by Aaron Stransky",
    );
    expect(recordingNoticeText(stopped("room_finished"), members)).toContain("the call ended");
    expect(recordingNoticeText(stopped("ended"), members)).toContain("the call ended");
    expect(recordingNoticeText(stopped("failed"), members)).toContain("the recorder failed");
    expect(recordingNoticeText(stopped("egress_lost"), null)).toBe("Audio recording stopped · egress lost");
  });

  it("shows a failure's error string as written, capped", () => {
    const failed = notice("Recording failed", { kind: "recording", event: "failed", reason: "egress crashed: no track" });
    expect(recordingNoticeText(failed, members)).toBe("Recording failed · egress crashed: no track");
    const long = notice("Recording failed", { kind: "recording", event: "failed", reason: "x".repeat(500) });
    expect(recordingNoticeText(long, members)!.length).toBe("Recording failed · ".length + 200);
    expect(recordingNoticeText(notice("Recording failed", { kind: "recording", event: "failed" }), members)).toBe(
      "Recording failed",
    );
  });

  it("is nothing for any other line, and never throws on a missing metadata", () => {
    expect(recordingNoticeOf({ metadata: null })).toBeNull();
    expect(recordingNoticeOf({})).toBeNull();
    expect(recordingNoticeOf({ metadata: { kind: "recording", event: "paused" } })).toBeNull();
    expect(recordingNoticeText({ content: "hello", metadata: { kind: "thread_seed" } }, members)).toBeNull();
    expect(systemLineText({ content: "Majik joined" }, members)).toBeNull();
  });
});

describe("the parent's thread line", () => {
  const line = (over: Record<string, unknown> = {}, sender_name: string | null = "Aaron Stransky") => ({
    content: "Hub thread started",
    sender_type: "human",
    content_type: "system",
    sender_name,
    metadata: {
      kind: "thread_started",
      thread_room_id: "hub-1-t-1",
      thread_title: "Launch checklist",
      created_by: "p-aaron",
      seed_message_id: null,
      ...over,
    },
  });

  it("reads 'Aaron started a thread: <title>' from thread_title and created_by", () => {
    expect(threadStartedText(line(), members)).toBe("Aaron Stransky started a thread: Launch checklist");
    expect(systemLineText(line(), members)).toBe("Aaron Stransky started a thread: Launch checklist");
    expect(threadStartedOf(line())).toEqual({
      title: "Launch checklist",
      createdBy: "p-aaron",
      threadRoomId: "hub-1-t-1",
    });
  });

  it("falls back to the line's sender, then to the title alone", () => {
    expect(threadStartedText(line({ created_by: "p-unknown" }), members)).toBe(
      "Aaron Stransky started a thread: Launch checklist",
    );
    expect(threadStartedText(line({ created_by: "p-unknown" }, null), members)).toBe(
      "Thread started: Launch checklist",
    );
    expect(threadStartedText(line({ thread_title: "" }), members)).toBe("Aaron Stransky started a thread");
    expect(threadStartedText(line({ thread_title: null, created_by: null }, null), [])).toBeNull();
  });

  it("is a system line by its content type, whoever sent it", () => {
    expect(isSystemLine(line())).toBe(true);
    expect(isSystemLine({ sender_type: "system", content_type: "text" })).toBe(true);
    expect(isSystemLine({ sender_type: "human", content_type: "text" })).toBe(false);
    expect(isSystemLine({})).toBe(false);
  });
});

describe("member names", () => {
  it("resolves by any of the row's ids", () => {
    expect(memberName("p-aaron", members)).toBe("Aaron Stransky");
    expect(memberName("u-1", [{ user_id: "u-1", display_name: "U One" }])).toBe("U One");
    expect(memberName("i-1", [{ id: "i-1", username: "ione" }])).toBe("ione");
    expect(memberName(null, members)).toBeNull();
    expect(memberName("p-aaron", undefined)).toBeNull();
  });
});

describe("the local receipt yields to the persisted notice", () => {
  const at = Date.parse("2026-09-29T01:00:00Z");
  const persisted = notice("Audio recording started", { kind: "recording", event: "started", started_by: "p-aaron", reason: "user" });
  const receipt = {
    id: "recording:room-1:start:2026-09-29T01:00:00Z",
    content: "Recording started · audio · started by Aaron",
    sender_type: "system",
    content_type: "system",
    created_at: "2026-09-29T01:00:02Z",
    metadata: { recording_receipt: true },
  };

  it("finds the same transition within the window, not another one", () => {
    expect(hasPersistedRecordingNotice([persisted], "start", at)).toBe(true);
    expect(hasPersistedRecordingNotice([persisted], "stop", at)).toBe(false);
    expect(hasPersistedRecordingNotice([persisted], "start", at + 10 * 60_000)).toBe(false);
    expect(hasPersistedRecordingNotice([], "start", at)).toBe(false);
    expect(hasPersistedRecordingNotice(null, "start", at)).toBe(false);
  });

  it("supersedes the local receipt, in either arrival order", () => {
    expect(isSupersededReceipt(receipt, [receipt, persisted])).toBe(true);
    expect(isSupersededReceipt(receipt, [persisted, receipt])).toBe(true);
    expect(isSupersededReceipt(receipt, [receipt])).toBe(false);
    // An old server writes no persisted notice: the receipt stays.
    expect(isSupersededReceipt(receipt, [{ ...persisted, metadata: {} }])).toBe(false);
    // A persisted line is never a receipt.
    expect(isSupersededReceipt(persisted, [receipt, persisted])).toBe(false);
  });

  it("matches on the recording's id when both carry one, whatever the clocks say", () => {
    const mine = { ...receipt, created_at: "2026-09-29T03:00:00Z", metadata: { recording_receipt: true, recording_id: "rec-1" } };
    const same = { ...persisted, metadata: { ...persisted.metadata, recording_id: "rec-1" } };
    const other = { ...persisted, metadata: { ...persisted.metadata, recording_id: "rec-2" } };
    // Two hours apart by the clocks, the same recording by its id.
    expect(isSupersededReceipt(mine, [mine, same])).toBe(true);
    // Seconds apart, but another recording.
    expect(isSupersededReceipt({ ...mine, created_at: "2026-09-29T01:00:01Z" }, [other])).toBe(false);
    expect(hasPersistedRecordingNotice([same], "start", at, "rec-1")).toBe(true);
    expect(hasPersistedRecordingNotice([same], "start", at, "rec-2")).toBe(false);
    // One side without an id: the window decides.
    expect(hasPersistedRecordingNotice([persisted], "start", at, "rec-1")).toBe(true);
    expect(hasPersistedRecordingNotice([same], "start", at + 10 * 60_000, null)).toBe(false);
    expect(dropSupersededReceipts([mine], same)).toEqual([]);
    expect(dropSupersededReceipts([mine], other)).toEqual([mine]);
    // A receipt never supersedes a receipt.
    expect(hasPersistedRecordingNotice([{ ...mine, metadata: { kind: "recording", event: "started" } }], "start", at)).toBe(false);
  });

  it("drops the receipt from a list when the persisted notice is added", () => {
    const other = { id: "m-1", content: "hello", sender_type: "human", content_type: "text", created_at: "2026-09-29T00:59:00Z" };
    const stopReceipt = { ...receipt, id: "recording:room-1:stop:2026-09-29T01:00:00Z" };
    const list = [other, receipt, stopReceipt];
    expect(dropSupersededReceipts(list, persisted)).toEqual([other, stopReceipt]);
    // Nothing to drop: the very same array, so the store pays nothing.
    expect(dropSupersededReceipts(list, other)).toBe(list);
    expect(dropSupersededReceipts([other], persisted)).toEqual([other]);
    const failed = notice("Recording failed", { kind: "recording", event: "failed", reason: "boom" });
    expect(dropSupersededReceipts(list, failed)).toBe(list);
    // An old receipt from an earlier recording stays.
    const old = { ...receipt, id: "recording:room-1:start:2026-09-28T20:00:00Z", created_at: "2026-09-28T20:00:00Z" };
    expect(dropSupersededReceipts([old], persisted)).toEqual([old]);
  });
});

describe("a room's last line as a preview", () => {
  it("puts no name before a system line, and says its sentence", () => {
    expect(
      lastLinePreview({
        content: "Channel thread started",
        sender_type: "human",
        content_type: "system",
        sender_name: "Aaron Stransky",
        metadata: { kind: "thread_started", thread_title: "Launch checklist", created_by: "p-aaron" },
      }),
    ).toEqual({ sender: null, text: "Aaron Stransky started a thread: Launch checklist" });
    expect(
      lastLinePreview({
        content: "Audio recording started",
        sender_type: "system",
        content_type: "system",
        sender_name: "",
        metadata: { kind: "recording", event: "started", started_by: "p-aaron", reason: "policy always" },
      }),
    ).toEqual({ sender: null, text: "Audio recording started · this room always records" });
  });

  it("keeps the sender's name before anybody's own message", () => {
    expect(lastLinePreview({ content: "hello", sender_type: "human", content_type: "text", sender_name: "Aaron" })).toEqual({
      sender: "Aaron",
      text: "hello",
    });
    expect(lastLinePreview({ content: "hello", sender_type: "agent", content_type: "text", sender_name: "" })).toEqual({
      sender: null,
      text: "hello",
    });
  });
});
