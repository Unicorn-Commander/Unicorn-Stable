import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Captions, X, Sparkles } from "lucide-react";
import { useCallUiStore } from "@/stores/callUiStore";
import {
  isDevTranscriptEnabled,
  seedSampleTranscript,
} from "@/lib/devTranscript";

/**
 * Live call transcript. Renders speaker-labeled lines in near-real-time with
 * autoscroll, and a visual difference between interim (streaming, dimmed +
 * italic) and final (committed) lines.
 *
 * Source = `transcript` data-channel messages, ingested into the call-UI store
 * by the VoiceProvider's RoomEvent.DataReceived handler. There is no producer
 * yet — the `?devtranscript` flag surfaces a "Seed sample" button so the panel
 * is testable today.
 */
export function TranscriptPanel() {
  const lines = useCallUiStore((s) => s.transcript);
  const toggleTranscript = useCallUiStore((s) => s.toggleTranscript);
  const clearTranscript = useCallUiStore((s) => s.clearTranscript);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Only autoscroll when the user is already at the bottom, so reading back
  // through history isn't yanked away by a new line.
  const pinnedRef = useRef(true);
  const [seeding, setSeeding] = useState(false);

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

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-slate-900/60"
      role="region"
      aria-label="Live call transcript"
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-slate-700/50 px-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
          <Captions className="h-3.5 w-3.5 text-stable-cyan" />
          Transcript
        </div>
        <div className="flex items-center gap-1">
          {isDevTranscriptEnabled() && (
            <button
              onClick={onSeed}
              disabled={seeding}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-stable-cyan hover:bg-slate-800 disabled:opacity-50"
              title="Dev: inject sample transcript lines"
            >
              <Sparkles className="h-3 w-3" />
              {seeding ? "Seeding…" : "Seed"}
            </button>
          )}
          {lines.length > 0 && (
            <button
              onClick={clearTranscript}
              className="rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => toggleTranscript(false)}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Hide transcript"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2"
      >
        {lines.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-slate-600">
            No transcript yet. Captions appear here as people speak.
          </p>
        ) : (
          lines.map((line) => (
            <div key={line.id} className="text-sm leading-snug">
              <span
                className={clsx(
                  "mr-1.5 font-semibold",
                  line.participantId.startsWith("agent-")
                    ? "text-stable-cyan"
                    : "text-stable-purple-light",
                )}
              >
                {line.name}
              </span>
              <span
                className={clsx(
                  line.isFinal
                    ? "text-slate-200"
                    : "italic text-slate-400",
                )}
              >
                {line.text}
                {!line.isFinal && (
                  <span className="ml-0.5 inline-block h-3 w-1 animate-pulse-soft bg-slate-500 align-middle" />
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
