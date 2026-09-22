import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ws } from "@/services/websocket";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import { useRecordingStore } from "@/stores/recordingStore";
import { playCue } from "@/lib/sounds";
import {
  recordingSystemLine,
  starterDisplayName,
  type RecordingState,
} from "@/lib/recording";
import type { Message } from "@/services/api";

/**
 * One listener for the whole app. Every participant — not just the person who
 * pressed Record — gets the pill state, the chime, and a system line.
 * `playCue` itself checks the sound-cues preference.
 */
export function useRecordingReceipts(): void {
  const qc = useQueryClient();
  useEffect(() => {
    return ws.on("recording_state", (data) => {
      const fallback =
        useCallUiStore.getState().activeCallRoomId ??
        useAppStore.getState().activeRoomId;
      const result = useRecordingStore
        .getState()
        .applyFrame(fallback ?? "", data);
      if (!result || result.transition === "none") return;
      playCue(result.transition === "start" ? "rec-start" : "rec-stop");
      const subject: RecordingState =
        result.transition === "stop" ? result.prev : result.next;
      const members = useAppStore.getState().participants[result.roomId];
      const line = recordingSystemLine(
        result.transition,
        subject,
        starterDisplayName(subject, members),
      );
      if (line) appendSystemLine(result.roomId, result.transition, subject, line);
      void qc.invalidateQueries({ queryKey: ["recordings", result.roomId] });
    });
  }, [qc]);
}

function appendSystemLine(
  roomId: string,
  transition: "start" | "stop",
  state: RecordingState,
  content: string,
): void {
  const store = useAppStore.getState();
  const recent = store.messages[roomId]?.items.slice(-20) ?? [];
  if (recent.some((message) => message.content === content && message.sender_type === "system")) {
    return;
  }
  const stamp = state.startedAt ?? "none";
  const now = new Date().toISOString();
  const message: Message = {
    id: `recording:${roomId}:${transition}:${stamp}`,
    room_id: roomId,
    sender_id: "system",
    sender_type: "system",
    sender_name: "Stable",
    sender_avatar: null,
    content,
    content_type: "system",
    thread_id: null,
    reply_count: 0,
    edited: false,
    created_at: now,
    updated_at: now,
    metadata: { recording_receipt: true },
  };
  store.addMessage(roomId, message);
}
