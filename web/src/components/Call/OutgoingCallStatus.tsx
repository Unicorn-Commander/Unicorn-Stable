import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PhoneOutgoing, PhoneOff, PhoneMissed, Check } from "lucide-react";
import { api } from "@/services/api";
import {
  isTerminalPhase,
  useOutgoingCallStore,
  type OutgoingPhase,
} from "@/stores/outgoingCallStore";

/**
 * The CALLER's status card — mounted once in AppShell beside
 * IncomingCallBanner. It is the answer to "a caller staring at nothing".
 *
 * Three clocks could end an outgoing call and they are deliberately NOT peers:
 *   1. the server's ring deadline (authoritative) — arrives as a
 *      `call_ring_state` frame with state "timeout";
 *   2. this component's backstop, derived from the server's own `expires_at`
 *      plus slack — it exists ONLY for the case where the websocket died and
 *      frame (1) can never arrive. It is not a second opinion about when a
 *      call times out; it is the same opinion, read off the same value;
 *   3. the callee's banner timer, likewise derived from `expires_at`.
 * Deriving 2 and 3 from 1 is what stops the two ends disagreeing.
 */

const TERMINAL_LINGER_MS = 6_000;
/** Slack past the server deadline before the local backstop gives up. */
const BACKSTOP_SLACK_MS = 6_000;

const PHASE_TONE: Record<OutgoingPhase, string> = {
  ringing: "text-sky-300",
  accepted: "text-emerald-300",
  declined: "text-rose-300",
  no_answer: "text-amber-300",
  busy: "text-amber-300",
  offline: "text-slate-300",
  unknown: "text-amber-300",
  canceled: "text-slate-300",
  failed: "text-rose-300",
};

const PHASE_HEADLINE: Record<OutgoingPhase, string> = {
  ringing: "Calling",
  accepted: "Answered",
  declined: "Call declined",
  no_answer: "No answer",
  busy: "Busy",
  offline: "Not available",
  unknown: "Not available",
  canceled: "Call cancelled",
  failed: "Call failed",
};

function PhaseIcon({ phase }: { phase: OutgoingPhase }) {
  if (phase === "ringing")
    return <PhoneOutgoing className="h-5 w-5 animate-pulse text-sky-400" />;
  if (phase === "accepted") return <Check className="h-5 w-5 text-emerald-400" />;
  if (phase === "no_answer")
    return <PhoneMissed className="h-5 w-5 text-amber-400" />;
  return <PhoneOff className="h-5 w-5 text-slate-400" />;
}

export function OutgoingCallStatus() {
  const call = useOutgoingCallStore((s) => s.call);
  const settle = useOutgoingCallStore((s) => s.settle);
  const clear = useOutgoingCallStore((s) => s.clear);
  const cancelling = useRef(false);

  const key = call ? `${call.callId ?? call.roomId}:${call.phase}` : null;
  const phase = call?.phase;
  const expiresAt = call?.expiresAt ?? null;
  const callId = call?.callId ?? null;

  // Terminal outcomes are read, then they go away on their own.
  useEffect(() => {
    if (!phase || !isTerminalPhase(phase)) return;
    const t = window.setTimeout(() => useOutgoingCallStore.getState().clear(), TERMINAL_LINGER_MS);
    return () => window.clearTimeout(t);
  }, [key, phase]);

  // Backstop for a dead socket ONLY — see the header comment. Derived from the
  // server's expires_at so it can never disagree with the server about when
  // the ring ended, only about whether we heard.
  useEffect(() => {
    if (phase !== "ringing" || !expiresAt) return;
    const due = new Date(expiresAt).getTime() + BACKSTOP_SLACK_MS;
    const ms = Math.max(1_000, due - Date.now());
    const t = window.setTimeout(() => {
      useOutgoingCallStore
        .getState()
        .settle("no_answer", "They didn't pick up.", { callId });
    }, ms);
    return () => window.clearTimeout(t);
  }, [key, phase, expiresAt, callId]);

  async function handleCancel() {
    if (!call?.callId || cancelling.current) return;
    cancelling.current = true;
    // Settle locally FIRST: the button must feel like it did something even if
    // the request is slow or fails. The server broadcast that follows is
    // idempotent with this.
    settle("canceled", "You cancelled the call.", { callId: call.callId });
    try {
      await api.cancelCall(call.callId);
    } catch {
      // Already resolved server-side (410) or unreachable — either way the
      // ring is over for us and the callee's own deadline ends theirs.
    } finally {
      cancelling.current = false;
    }
  }

  return (
    <AnimatePresence>
      {call && (
        <motion.div
          key={key}
          initial={{ y: 16, x: "-50%", opacity: 0 }}
          animate={{ y: 0, x: "-50%", opacity: 1 }}
          exit={{ y: 16, x: "-50%", opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-1/2 z-[85] w-80 max-w-[calc(100vw-2rem)]"
          style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <div className="glass-heavy overflow-hidden rounded-2xl shadow-pop">
            <div className="flex items-center gap-3 p-3.5">
              <div className="shrink-0 rounded-full bg-white/[0.06] p-2.5">
                <PhaseIcon phase={call.phase} />
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={`truncate text-sm font-semibold ${PHASE_TONE[call.phase]}`}
                >
                  {PHASE_HEADLINE[call.phase]}
                  {call.phase === "ringing" ? ` ${call.label}` : ""}
                </p>
                <p className="truncate text-xs text-slate-400">{call.detail}</p>
              </div>
            </div>
            <div className="px-3.5 pb-3.5">
              {call.phase === "ringing" ? (
                <button
                  onClick={handleCancel}
                  // min-h-11 == 44px: a real touch target, and a plain button
                  // rather than anything hover-revealed.
                  className="focus-ring flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-rose-500/90 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
                >
                  <PhoneOff className="h-4 w-4" />
                  Cancel
                </button>
              ) : (
                <button
                  onClick={clear}
                  className="focus-ring min-h-11 w-full rounded-lg bg-white/[0.06] px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/[0.1] hover:text-slate-100"
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
