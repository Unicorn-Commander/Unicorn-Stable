import { useEffect, useRef, useState } from "react";
import { Captions, Check, Loader2, Send, X, Sparkles } from "lucide-react";
import { identityFor } from "@/lib/identity";
import { useCallUiStore } from "@/stores/callUiStore";
import { useAppStore } from "@/stores/appStore";
import {
  isDevTranscriptEnabled,
  seedSampleTranscript,
} from "@/lib/devTranscript";
import { isBrowserSttAvailable } from "@/lib/humanTranscript";
import { api } from "@/services/api";

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
export function TranscriptPanel() {
  const lines = useCallUiStore((s) => s.transcript);
  const toggleTranscript = useCallUiStore((s) => s.toggleTranscript);
  const clearTranscript = useCallUiStore((s) => s.clearTranscript);
  const sendToMeetingOps = useCallUiStore((s) => s.sendToMeetingOps);
  const setSendToMeetingOps = useCallUiStore((s) => s.setSendToMeetingOps);
  const callStartedAt = useCallUiStore((s) => s.callStartedAt);
  const activeCallRoomId = useCallUiStore((s) => s.activeCallRoomId);
  const rooms = useAppStore((s) => s.rooms);
  const pushToast = useAppStore((s) => s.pushToast);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Only autoscroll when the user is already at the bottom, so reading back
  // through history isn't yanked away by a new line.
  const pinnedRef = useRef(true);
  const [seeding, setSeeding] = useState(false);
  const [sending, setSending] = useState(false);
  const [lastExportNote, setLastExportNote] = useState<string | null>(null);

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
    const finals = lines.filter((l) => l.isFinal && l.text.trim());
    if (finals.length === 0) {
      pushToast({
        title: "Nothing to send yet",
        body: "Final caption lines will appear as people finish speaking.",
      });
      return;
    }
    setSending(true);
    setLastExportNote(null);
    try {
      const roomMeta = rooms.find((rm) => rm.id === activeCallRoomId);
      const result = await api.exportCallTranscript(activeCallRoomId, {
        lines: finals.map((l) => ({
          participant_id: l.participantId,
          name: l.name,
          text: l.text,
          ts: l.ts,
          is_final: true,
          segment_id: l.id,
        })),
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
      const mo = result.meeting_ops;
      const note =
        mo?.status === "ok"
          ? `Sent ${result.line_count} line${result.line_count === 1 ? "" : "s"} to Meeting-Ops`
          : mo?.status === "skipped"
            ? `Saved ${result.line_count} line${result.line_count === 1 ? "" : "s"} (Meeting-Ops not configured)`
            : `Export accepted (${mo?.detail || mo?.status || "unknown"})`;
      setLastExportNote(note);
      pushToast({
        title: mo?.status === "ok" ? "Sent to Meeting-Ops" : "Transcript exported",
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
  const browserStt = isBrowserSttAvailable();

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-surface-1/70 backdrop-blur-xl"
      role="region"
      aria-label="Live call transcript"
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <div className="flex items-center gap-1.5 font-display text-xs font-semibold text-slate-200">
          <Captions className="h-3.5 w-3.5 text-stable-cyan" />
          Transcript
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

      {/* Meeting-Ops session controls */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line/80 px-3 py-1.5">
        <label
          className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-300"
          title="When on, hang-up posts this call's captions to Meeting-Ops (or accepts them locally if Meeting-Ops is not configured)."
        >
          <input
            type="checkbox"
            className="h-3 w-3 rounded border-line bg-surface-2 text-stable-cyan focus:ring-stable-cyan/40"
            checked={sendToMeetingOps}
            onChange={(e) => setSendToMeetingOps(e.target.checked)}
          />
          <span className="select-none">Send to Meeting-Ops</span>
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
              {!browserStt
                ? " (Browser speech recognition unavailable — agent STT still works when an agent joins.)"
                : " Human speech is captioned live; agent replies stream as they speak."}
            </p>
          </div>
        ) : (
          lines.map((line) => {
            const ident = identityFor(
              line.participantId.replace(/^agent-/, ""),
              line.name,
            );
            return (
              <div
                key={line.id}
                className="rounded-md px-1.5 py-0.5 text-sm leading-snug transition-colors hover:bg-white/[0.03]"
              >
                <span
                  className="mr-1.5 font-semibold"
                  style={{ color: ident.text }}
                >
                  {line.name}
                </span>
                {line.isFinal ? (
                  <span className="text-slate-200">{line.text}</span>
                ) : (
                  <span className="italic">
                    <span className="animate-shimmer">{line.text}</span>
                    <span className="ml-0.5 inline-block h-3 w-1 animate-pulse-soft rounded-full bg-slate-500 align-middle" />
                  </span>
                )}
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
