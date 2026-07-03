import { useEffect, useRef, useState } from "react";
import { Captions, X, Sparkles } from "lucide-react";
import { identityFor } from "@/lib/identity";
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
    </div>
  );
}
