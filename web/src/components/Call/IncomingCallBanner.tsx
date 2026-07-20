import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, PhoneIncoming } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useIncomingCallStore } from "@/stores/incomingCallStore";
import { useVoice } from "@/contexts/VoiceProvider";
import { playCue } from "@/lib/sounds";

/** How long an unanswered call rings before the banner dismisses itself. */
const RING_TIMEOUT_MS = 45_000;
/** Cadence of the gentle ring chirp while the banner is up. */
const RING_CUE_INTERVAL_MS = 2_000;

/**
 * Incoming-call ringing banner — mounted ONCE in AppShell (beside ToastStack)
 * so a dm/group_dm call rings no matter which view is open. Renders the
 * single-slot {@link useIncomingCallStore}; all suppression policy (self,
 * already-in-call, already-seen) lives in that store's `ingest`.
 *
 * Join follows the exact same path as the room's own call button: navigate to
 * the room, then VoiceProvider.connect() — which reads the ACTIVE room at call
 * time. The URL is the single source of truth for activeRoomId (see AppShell),
 * so after navigating we wait for the route -> store effect to land before
 * connecting; connecting immediately would join the OLD room's call.
 */
export function IncomingCallBanner() {
  const call = useIncomingCallStore((s) => s.call);
  const dismiss = useIncomingCallStore((s) => s.dismiss);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const { connect, isConnecting } = useVoice();
  const navigate = useNavigate();
  // Room we're navigating toward to join its call; connect() fires once the
  // route -> store sync makes it the active room.
  const pendingJoinRoomId = useRef<string | null>(null);

  // One key per offered call — a NEW call (replacing the slot) restarts the
  // timeout + ring cadence; re-renders of the same call do not.
  const callKey = call ? `${call.roomId}:${call.startedAt}` : null;

  // Unanswered ring times out on its own.
  useEffect(() => {
    if (!callKey) return;
    const timer = window.setTimeout(
      () => useIncomingCallStore.getState().dismiss(),
      RING_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [callKey]);

  // Gentle ring chirp every 2s while the banner shows. Only when the user has
  // already interacted with the page (autoplay policy — a first-visit tab
  // can't render audio anyway), and fully fault-tolerant: sound is decoration,
  // it must never take down the ringing surface.
  useEffect(() => {
    if (!callKey) return;
    try {
      const activation = (
        navigator as Navigator & {
          userActivation?: { hasBeenActive?: boolean };
        }
      ).userActivation;
      if (!activation?.hasBeenActive) return;
      playCue("ring");
      const timer = window.setInterval(() => {
        try {
          playCue("ring");
        } catch {
          // playCue already swallows — belt and braces.
        }
      }, RING_CUE_INTERVAL_MS);
      return () => window.clearInterval(timer);
    } catch {
      return;
    }
  }, [callKey]);

  // Deferred join: once the navigated-to room is actually active, start the
  // call exactly like its own call button would.
  useEffect(() => {
    if (
      pendingJoinRoomId.current &&
      activeRoomId === pendingJoinRoomId.current
    ) {
      pendingJoinRoomId.current = null;
      void connect();
    }
  }, [activeRoomId, connect]);

  function handleJoin() {
    if (!call || isConnecting) return;
    dismiss();
    if (activeRoomId === call.roomId) {
      void connect();
    } else {
      pendingJoinRoomId.current = call.roomId;
      navigate(`/c/${call.roomId}`);
    }
  }

  return (
    <AnimatePresence>
      {call && (
        <motion.div
          key={callKey}
          // x:-50% in every state — framer owns transform, so the centering
          // must ride the motion values (a -translate-x-1/2 class would be
          // clobbered by the animation).
          initial={{ y: -24, x: "-50%", opacity: 0, scale: 0.98 }}
          animate={{ y: 0, x: "-50%", opacity: 1, scale: 1 }}
          exit={{ y: -24, x: "-50%", opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          role="alert"
          aria-live="assertive"
          className="fixed left-1/2 z-[90] w-96 max-w-[calc(100vw-2rem)]"
          style={{ top: "max(0.75rem, env(safe-area-inset-top))" }}
        >
          <div className="glass-heavy overflow-hidden rounded-2xl shadow-pop">
            <div className="flex items-center gap-3 p-3.5 pb-2.5">
              <div className="shrink-0 rounded-full bg-emerald-500/15 p-2.5">
                <PhoneIncoming className="h-5 w-5 animate-pulse text-emerald-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-100">
                  {call.callerName}{" "}
                  <span className="font-normal text-slate-300">is calling</span>
                </p>
                <p className="truncate text-xs text-slate-400">
                  {call.roomName}
                </p>
              </div>
            </div>
            <div className="flex gap-2 px-3.5 pb-3.5">
              <button
                onClick={handleJoin}
                className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-400"
              >
                <Phone className="h-4 w-4" />
                Join
              </button>
              <button
                onClick={dismiss}
                className="focus-ring flex-1 rounded-lg bg-white/[0.06] px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/[0.1] hover:text-slate-100"
              >
                Dismiss
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
