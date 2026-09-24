import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { api, type RecordingListItem, type RoomMember } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import {
  formatRecordingDuration,
  formatRecordingWhen,
  httpUrl,
  mayDownloadRecording,
  meetingOpsHref,
  recordingKindLabel,
  recordingWho,
} from "@/lib/recording";

/**
 * The fact of a recording, for every member. The file and the Meeting-Ops
 * session open only when this person is allowed to have them.
 */
export function RecordingsList({
  rows,
  members,
  myRole,
  myParticipantId,
}: {
  rows: RecordingListItem[];
  members: readonly RoomMember[] | null | undefined;
  myRole: string | null;
  myParticipantId: string | null;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-1 text-[11px] leading-relaxed text-slate-500" data-testid="recordings-list">
        No recordings yet. When a call in this room is recorded, it shows up here.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5" data-testid="recordings-list">
      {rows.map((row) => {
        const who = recordingWho(row, members);
        const when = formatRecordingWhen(row.started_at);
        const duration = formatRecordingDuration(row.duration_seconds);
        const href = meetingOpsHref(row);
        const file = httpUrl(row.storage_url);
        const canDownload = mayDownloadRecording({
          myRole,
          myParticipantId,
          startedBy: row.started_by,
          storageUrl: row.storage_url,
        });
        return (
          <li
            key={row.id}
            className="rounded-lg border border-line bg-surface-2/40 px-2.5 py-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-slate-100">
                {recordingKindLabel(row.kind)}
              </span>
              <span className="shrink-0 text-[10px] text-slate-500">{duration}</span>
            </div>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {when}
              <span className="text-slate-600"> · </span>
              {who}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-stable-cyan hover:underline"
                >
                  Open in Meeting-Ops
                </a>
              ) : row.mo_session_id ? (
                <span className="text-slate-500">In Meeting-Ops</span>
              ) : null}
              {canDownload && file ? (
                <a href={file} className="font-medium text-slate-300 hover:underline" download>
                  Download
                </a>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Recordings for the open room.
 *
 * The Meetings body always shows the section. The one-list sidebar passes
 * `relevantOnly` (standing room, or a room that already has recordings) and
 * `collapsible`. Those props stay off on the flag-off path.
 */
export function MeetingsRecordings({
  roomId,
  collapsible = false,
  relevantOnly = false,
  standing = false,
}: {
  roomId: string | null;
  collapsible?: boolean;
  relevantOnly?: boolean;
  standing?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const members = useAppStore((s) => (roomId ? s.participants[roomId] : undefined));
  const myParticipantId = useAppStore((s) => s.currentParticipantId);
  const myRole = members?.find((member) => member.is_self)?.role ?? null;
  const { data, isLoading, isError } = useQuery({
    queryKey: ["recordings", roomId],
    queryFn: () => api.listRecordings(roomId!),
    enabled: !!roomId,
    staleTime: 15_000,
  });
  const rows = data ?? [];
  if (relevantOnly) {
    if (!roomId) return null;
    if (!standing && rows.length === 0) return null;
  }

  const body = !roomId ? (
        <p className="px-1 text-[11px] leading-relaxed text-slate-500">
          Open a meeting to see its recordings.
        </p>
      ) : isLoading ? (
        <p className="px-1 text-[11px] text-slate-500">Loading recordings…</p>
      ) : isError ? (
        <p className="px-1 text-[11px] text-slate-500">
          Recordings aren't available right now.
        </p>
      ) : (
        <RecordingsList
          rows={rows}
          members={members}
          myRole={myRole}
          myParticipantId={myParticipantId}
        />
      );

  return (
    <section
      className="mx-2 mb-3"
      aria-label="Recordings"
      data-testid="room-recordings"
    >
      {collapsible ? (
        <button
          type="button"
          className="focus-ring mb-1.5 flex w-full items-center gap-1 rounded-md px-0.5 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 hover:text-slate-300"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown
            className={
              "h-3 w-3 shrink-0 transition-transform" +
              (open ? "" : " -rotate-90")
            }
          />
          Recordings
        </button>
      ) : (
        <p className="mb-1.5 px-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Recordings
        </p>
      )}
      {(!collapsible || open) && body}
    </section>
  );
}
