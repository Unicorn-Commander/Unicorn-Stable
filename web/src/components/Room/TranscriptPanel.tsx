import { useEffect, useMemo, useRef, useState } from "react";
import {
  Captions,
  Check,
  ExternalLink,
  Loader2,
  Send,
  X,
  Sparkles,
} from "lucide-react";
import { identityFor, resolveIdentity } from "@/lib/identity";
import { Identity } from "@/components/ui/Identity";
import { useCallUiStore } from "@/stores/callUiStore";
import { useAppStore } from "@/stores/appStore";
import { usePresenterStore } from "@/stores/presenterStore";
import { useConversationUi } from "@/stores/conversationUiStore";
import {
  linesWithVoiceHistory,
  type CaptionVoiceMessage,
} from "@/lib/captionState";
import {
  buildCallTranscriptExportLines,
  withVoiceHistoryLines,
} from "@/lib/compactTranscriptExport";
import {
  isDevTranscriptEnabled,
  seedSampleTranscript,
} from "@/lib/devTranscript";
import { api, type Message, type RoomMember } from "@/services/api";

const NO_PARTICIPANTS: RoomMember[] = [];


/**
 * Live call transcript. Renders speaker-labeled lines in near-real-time with
 * autoscroll, and a visual difference between interim (streaming, dimmed +
 * italic) and final (committed) lines.
 *
 * Source = `transcript` data-channel messages, ingested into the call-UI store
 * by the VoiceProvider's RoomEvent.DataReceived handler.
 *
 * Producers (LIVE):
 *   1. Agent in call — agents/agent_runtime/transcript_publisher.py (human STT
 *      via Parakeet/Amanuensis + agent replies) → LiveKit topic `stable`.
 *   2. No agent — web/src/lib/humanTranscript.ts (Web Speech API for the local
 *      human) → local ingest + publish on the same topic.
 *
 * "Send to Meeting-Ops" is a per-session toggle (seeded from the Settings
 * default). When on, hang-up posts the final lines to
 * POST /api/v1/rooms/{id}/transcripts/export; the manual Send button does the
 * same mid-call without ending it.
 *
 * The `?devtranscript` flag still surfaces a "Seed sample" button for
 * exercising the rendering (interim vs final, autoscroll) without a live call.
 */
function voiceMessages(items: Message[]): CaptionVoiceMessage[] {
  return items.map((message) => ({
    id: message.id,
    senderId: message.sender_id,
    senderName: message.sender_name || "Someone",
    text: message.content,
    createdAtMs: Date.parse(message.created_at),
    viaVoice: message.metadata?.via === "voice",
  }));
}

export function TranscriptPanel() {
  const liveLines = useCallUiStore((s) => s.transcript);
  const exportTranscript = useCallUiStore((s) => s.exportTranscript);
  const caption = useCallUiStore((s) => s.caption);
  const serverCaptionEnabled = useCallUiStore((s) => s.serverCaptionEnabled);
  const setServerCaptionEnabled = useCallUiStore((s) => s.setServerCaptionEnabled);
  const selectDefaultMic = useCallUiStore((s) => s.useDefaultMic);
  const toggleTranscript = useCallUiStore((s) => s.toggleTranscript);
  const clearTranscript = useCallUiStore((s) => s.clearTranscript);
  const sendToMeetingOps = useCallUiStore((s) => s.sendToMeetingOps);
  const setSendToMeetingOps = useCallUiStore((s) => s.setSendToMeetingOps);
  const callStartedAt = useCallUiStore((s) => s.callStartedAt);
  const activeCallRoomId = useCallUiStore((s) => s.activeCallRoomId);
  const presenterEnabled = usePresenterStore((s) => s.enabled);
  const transcriptDestination = presenterEnabled ? "external service" : "Meeting-Ops";
  const rooms = useAppStore((s) => s.rooms);
  const currentUser = useAppStore((s) => s.currentUser);
  const agents = useAppStore((s) => s.agents);
  const participantList = useAppStore((s) =>
    activeCallRoomId ? s.participants[activeCallRoomId] : undefined,
  );
  const participants = participantList ?? NO_PARTICIPANTS;
  const roomMessages = useAppStore((s) =>
    activeCallRoomId ? s.messages[activeCallRoomId]?.items : undefined,
  );
  const pushToast = useAppStore((s) => s.pushToast);
  const lines = useMemo(
    () =>
      linesWithVoiceHistory(
        liveLines,
        voiceMessages(roomMessages ?? []),
        callStartedAt,
      ),
    [liveLines, roomMessages, callStartedAt],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  // Only autoscroll when the user is already at the bottom, so reading back
  // through history isn't yanked away by a new line.
  const pinnedRef = useRef(true);
  const [seeding, setSeeding] = useState(false);
  const [sending, setSending] = useState(false);
  const [lastExportNote, setLastExportNote] = useState<string | null>(null);
  const [lastExportUrl, setLastExportUrl] = useState<string | null>(null);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  async function onSeed() {
    setSeeding(true);
    try {
      await seedSampleTranscript();
    } finally {
      setSeeding(false);
    }
  }

  async function onSendToMeetingOps() {
    if (!activeCallRoomId || sending) return;
    // Every final of the call plus the voice turns only chat history holds;
    // the on-screen list is capped and would drop a long call's beginning.
    const exportLines = buildCallTranscriptExportLines(
      withVoiceHistoryLines(exportTranscript, lines),
    );
    if (exportLines.length === 0) {
      pushToast({
        title: "Nothing to send yet",
        body: "Final caption lines will appear as people finish speaking.",
      });
      return;
    }
    setSending(true);
    setLastExportNote(null);
    setLastExportUrl(null);
    try {
      const roomMeta = rooms.find((rm) => rm.id === activeCallRoomId);
      const result = await api.exportCallTranscript(activeCallRoomId, {
        lines: exportLines,
        room_name: roomMeta?.display_name || roomMeta?.name || null,
        call_started_at: callStartedAt
          ? new Date(callStartedAt).toISOString()
          : null,
        call_ended_at: new Date().toISOString(),
        send_to_meeting_ops: true,
        label: roomMeta
          ? `Stable call · ${roomMeta.display_name || roomMeta.name}`
          : "Stable call",
      });
      let current = result;
      // The export is durable as soon as POST returns. Give the server-side
      // outbox a short window to complete so manual Send can surface the
      // canonical Meeting-Ops link without pretending a queued row is sent.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (!["pending", "delivering"].includes(current.meeting_ops.status)) break;
        await new Promise((resolve) => window.setTimeout(resolve, 750));
        current = await api.getCallTranscriptExport(
          activeCallRoomId,
          current.export_id,
        );
      }
      const mo = current.meeting_ops;
      const note =
        mo?.status === "delivered"
            ? `Sent ${current.line_count} line${current.line_count === 1 ? "" : "s"} to ${transcriptDestination}`
            : mo?.status === "blocked"
            ? `Saved ${current.line_count} line${current.line_count === 1 ? "" : "s"} in Stable; ${transcriptDestination} is not configured`
            : mo?.status === "failed"
              ? `Saved in Stable, but ${transcriptDestination} rejected delivery${mo.detail ? `: ${mo.detail}` : ""}`
              : `Saved in Stable and queued for ${transcriptDestination} delivery`;
      setLastExportNote(note);
      setLastExportUrl(mo.remote_session_url || null);
      pushToast({
          title:
            mo?.status === "delivered"
            ? `Sent to ${transcriptDestination}`
            : mo?.status === "failed"
              ? "Delivery needs attention"
              : "Transcript safely queued",
        body: note,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Export failed";
      pushToast({
        title: "Couldn't export transcript",
        body: msg,
      });
    } finally {
      setSending(false);
    }
  }

  const finalCount = lines.filter((l) => l.isFinal).length;
  const laneTone =
    caption.lane === "off"
      ? "bg-amber-400/10 text-amber-200"
      : caption.lane === "server"
        ? "bg-stable-purple/15 text-stable-purple-light"
        : caption.lane === "agent"
          ? "bg-stable-mint/10 text-stable-mint"
          : "bg-stable-cyan/10 text-stable-cyan";

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-surface-1/70 backdrop-blur-xl"
      role="region"
      aria-label="Live call transcript"
      data-testid="transcript-panel"
    >
      <div className="flex shrink-0 flex-col gap-1 border-b border-line px-3 py-1.5">
        <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-display text-xs font-semibold text-slate-200">
          <Captions className="h-3.5 w-3.5 shrink-0 text-stable-cyan" />
          <span className="truncate">Live transcript</span>
          <span
            data-testid="caption-state-chip"
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-sans text-[9px] font-semibold uppercase tracking-[0.08em] ${laneTone}`}
          >
            {caption.lane !== "off" && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            )}
            {caption.lane}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {isDevTranscriptEnabled() && (
            <button
              onClick={onSeed}
              disabled={seeding}
              className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-stable-cyan transition-colors hover:bg-stable-cyan/10 disabled:opacity-50"
              title="Dev: inject sample transcript lines"
            >
              <Sparkles className="h-3 w-3" />
              {seeding ? "Seeding…" : "Seed"}
            </button>
          )}
          {lines.length > 0 && (
            <button
              onClick={clearTranscript}
              className="focus-ring rounded-md px-1.5 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => toggleTranscript(false)}
            className="focus-ring rounded-md p-1 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
            aria-label="Hide transcript"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        </div>
        <div role="status" aria-live="polite" data-testid="caption-state" className="flex flex-col gap-1">
          <p data-testid="caption-state-summary" className="text-[11px] leading-snug text-slate-400">
            {caption.summary}
          </p>
          {caption.actions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {caption.actions.includes("use-default-mic") && (
                <button
                  type="button"
                  data-testid="caption-use-default-mic"
                  onClick={() => selectDefaultMic?.()}
                  className="focus-ring rounded-md border border-line bg-surface-2/80 px-1.5 py-0.5 text-[11px] text-slate-200 transition-colors hover:border-stable-cyan/40 hover:text-stable-cyan"
                >
                  Use the default mic
                </button>
              )}
              {caption.actions.includes("invite-agent") && (
                <button
                  type="button"
                  data-testid="caption-invite-agent"
                  onClick={() => {
                    if (activeCallRoomId) {
                      useConversationUi.getState().openInviteSheet(activeCallRoomId);
                    }
                  }}
                  className="focus-ring rounded-md border border-line bg-surface-2/80 px-1.5 py-0.5 text-[11px] text-slate-200 transition-colors hover:border-stable-cyan/40 hover:text-stable-cyan"
                >
                  Invite an agent
                </button>
              )}
            </div>
          )}
          <label
            className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-400"
            title="Sends short clips of your microphone to Stable's transcription service when this browser cannot caption the input you picked. This is a caption, not a recording."
          >
            <input
              type="checkbox"
              data-testid="caption-server-pref"
              className="h-3 w-3 rounded border-line bg-surface-2 text-stable-cyan focus:ring-stable-cyan/40"
              checked={serverCaptionEnabled}
              onChange={(event) =>
                setServerCaptionEnabled(event.target.checked, currentUser?.id)
              }
            />
            <span className="select-none">Caption my microphone (server)</span>
          </label>
        </div>
      </div>

      {/* External transcript destination session controls */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line/80 px-3 py-1.5">
        <label
          className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-300"
          title={`When on, hang-up saves this call's captions in Stable's durable queue and delivers them to ${transcriptDestination}.`}
        >
          <input
            type="checkbox"
            className="h-3 w-3 rounded border-line bg-surface-2 text-stable-cyan focus:ring-stable-cyan/40"
            checked={sendToMeetingOps}
            onChange={(e) => setSendToMeetingOps(e.target.checked)}
          />
          <span className="select-none">Send to {transcriptDestination}</span>
        </label>
        <button
          type="button"
          onClick={() => void onSendToMeetingOps()}
          disabled={sending || !activeCallRoomId || finalCount === 0}
          className="focus-ring ml-auto inline-flex items-center gap-1 rounded-md border border-line bg-surface-2/80 px-1.5 py-0.5 text-[11px] text-slate-200 transition-colors hover:border-stable-cyan/40 hover:bg-stable-cyan/10 hover:text-stable-cyan disabled:cursor-not-allowed disabled:opacity-40"
          title={
            finalCount === 0
              ? "No final caption lines yet"
              : "Export final lines now (does not end the call)"
          }
        >
          {sending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : lastExportNote ? (
            <Check className="h-3 w-3 text-stable-mint" />
          ) : (
            <Send className="h-3 w-3" />
          )}
          {sending ? "Sending…" : "Send now"}
        </button>
        {lastExportUrl && (
          <a
            href={lastExportUrl}
            target="_blank"
            rel="noreferrer"
            className="focus-ring inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-stable-cyan hover:bg-stable-cyan/10"
          >
            Open record
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2"
      >
        {lines.length === 0 ? (
          <div className="flex animate-fade-in flex-col items-center gap-1.5 px-3 py-4 text-center">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-stable-cyan/10 text-stable-cyan shadow-[0_0_20px_rgba(34,211,238,0.15)]">
              <Captions className="h-5 w-5" />
            </div>
            <p className="font-display text-xs font-semibold text-slate-300">
              No captions yet
            </p>
            <p className="text-[11px] text-slate-500">
              Lines appear here as people speak.
            </p>
          </div>
        ) : (
          lines.map((line, index) => {
            const agentId = line.participantId.replace(/^agent-/, "");
            const agent = agents.find((candidate) => candidate.id === agentId);
            const participant = participants.find(
              (candidate) =>
                candidate.participant_id === line.participantId ||
                candidate.user_id === line.participantId ||
                candidate.id === line.participantId,
            );
            const ident = identityFor(
              agentId,
              line.name,
            );
            const previous = lines[index - 1];
            const continuation =
              previous?.participantId === line.participantId &&
              line.ts - previous.ts < 60_000;
            const isMe = !!(
              currentUser &&
              (currentUser.id === line.participantId ||
                currentUser.username === line.participantId ||
                // LiveKit identity is often the Stable participant UUID or
                // a "user-<uuid>" form — also match member row.
                participant?.is_self === true ||
                (participant?.participant_id &&
                  participant.participant_id === currentUser.id))
            );
            const provenance: { label: string; verified: boolean } =
              line.source === "local_mic"
                ? { label: "Identity matched · client caption", verified: false }
                : line.source === "server"
                  ? { label: "Server transcription · not a recording", verified: false }
                : line.source === "agent_stt" || line.source === "captioner"
                  ? { label: "Identity matched · room STT", verified: false }
                  : line.source === "agent"
                    ? { label: "Verified · agent caption", verified: true }
                    : { label: "Unverified · legacy source", verified: false };
            return (
              <div
                key={line.id}
                className="group flex gap-2 rounded-xl px-2 py-1.5 text-sm leading-snug transition-colors hover:bg-white/[0.035]"
              >
                <div className="w-7 shrink-0 pt-0.5">
                  {!continuation && (
                    <Identity
                      {...resolveIdentity(
                        participant
                          ? {
                              ...participant,
                              avatar_url:
                                participant.avatar_url ?? agent?.avatar_url,
                              participant_type:
                                participant.participant_type ??
                                (agent || line.source === "agent"
                                  ? "agent"
                                  : "human"),
                            }
                          : {
                              id: agent?.id ?? agentId,
                              display_name: line.name,
                              username: line.participantId,
                              avatar_url: agent?.avatar_url,
                              participant_type:
                                agent ||
                                line.source === "agent" ||
                                line.participantId.startsWith("agent-")
                                  ? "agent"
                                  : "human",
                            },
                      )}
                      size={28}
                      shape="rounded"
                      emoji={agent?.emoji}
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  {!continuation && (
                    <div className="mb-0.5 flex min-w-0 items-baseline gap-1.5">
                      <span
                        className="truncate text-[11px] font-semibold"
                        style={{ color: ident.text }}
                      >
                        {line.name}
                      </span>
                      {isMe && (
                        <span className="rounded-full bg-white/[0.06] px-1 py-px text-[8px] font-semibold uppercase tracking-wide text-slate-400">
                          You
                        </span>
                      )}
                      <span
                        className={
                          provenance.verified
                            ? "rounded-full border border-stable-mint/25 bg-stable-mint/[0.06] px-1.5 py-px text-[8px] font-medium text-stable-mint/80"
                            : "rounded-full border border-amber-400/25 bg-amber-400/[0.06] px-1.5 py-px text-[8px] font-medium text-amber-300/80"
                        }
                      >
                        {provenance.label}
                      </span>
                      <time
                        className="ml-auto shrink-0 text-[9px] tabular-nums text-slate-600 opacity-0 transition-opacity group-hover:opacity-100"
                        dateTime={new Date(line.ts).toISOString()}
                      >
                        {new Date(line.ts).toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                  )}
                  {line.isFinal ? (
                    <p className="text-[13px] leading-relaxed text-slate-200">
                      {line.text}
                    </p>
                  ) : (
                    <p className="text-[13px] italic leading-relaxed">
                      <span className="animate-shimmer">{line.text}</span>
                      <span className="ml-1 inline-block h-3 w-1 animate-pulse-soft rounded-full bg-slate-500 align-middle" />
                    </p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {lastExportNote && (
        <div className="shrink-0 border-t border-line px-3 py-1 text-[10px] text-slate-500">
          {lastExportNote}
        </div>
      )}
    </div>
  );
}
