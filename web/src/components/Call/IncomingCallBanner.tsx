import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, PhoneOff, PhoneIncoming, VolumeX } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useIncomingCallStore } from "@/stores/incomingCallStore";
import { useVoice } from "@/contexts/VoiceProvider";
import { cueBlockedReason, playCue } from "@/lib/sounds";

/**
 * Fallback ring window used ONLY when the server didn't tell us its deadline
 * (an older backend). The live path derives the timeout from the call's
 * `expires_at`, because two independent 45s clocks on two machines is how you
 * get a banner still ringing for a call the server already declared dead.
 */
const RING_TIMEOUT_MS = 45_000;
/** Cadence of the gentle ring chirp while the banner is up. */
const RING_CUE_INTERVAL_MS = 2_000;

/**
 * Incoming-call ringing banner — mounted ONCE in AppShell (beside ToastStack)
 * so a dm/group_dm call rings no matter which view is open. Renders the
 * single-slot {@link useIncomingCallStore}; all suppression policy (self,
 * already-in-call, already-seen) lives in that store's `ingest`.
 *
 * Accept follows the exact same path as the room's own call button: navigate
 * to the room, then VoiceProvider.connect() — which reads the ACTIVE room at
 * call time. The URL is the single source of truth for activeRoomId (see
 * AppShell), so after navigating we wait for the route -> store effect to land
 * before connecting; connecting immediately would join the OLD room's call.
 *
 * Accept/decline are SERVER transitions, not local dismissals: the caller is
 * told which one happened, and this identity's other devices stop ringing. A
 * local-only dismiss would leave the caller ringing at nothing, which is the
 * whole failure this feature exists to remove.
 */
export function IncomingCallBanner() {
  const call = useIncomingCallStore((s) => s.call);
  const dismiss = useIncomingCallStore((s) => s.dismiss);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const pushToast = useAppStore((s) => s.pushToast);
  const { connect, isConnecting } = useVoice();
  const navigate = useNavigate();
  // Room we're navigating toward to join its call; connect() fires once the
  // route -> store sync makes it the active room.
  const pendingJoinRoomId = useRef<string | null>(null);
  const acting = useRef(false);
  // Non-null when the ring cue cannot be heard — rendered, never swallowed.
  const [silentReason, setSilentReason] = useState<string | null>(null);

  // One key per offered call — a NEW call (replacing the slot) restarts the
  // timeout + ring cadence; re-renders of the same call do not.
  const callKey = call ? (call.callId ?? `${call.roomId}:${call.startedAt}`) : null;
  const expiresAt = call?.expiresAt ?? null;

  // Unanswered ring times out on its own — on the SERVER's deadline where we
  // have one. This is a backstop for a lost `call_resolved` frame, not an
  // independent opinion about the ring window.
  useEffect(() => {
    if (!callKey) return;
    const ms = expiresAt
      ? Math.max(1_000, new Date(expiresAt).getTime() - Date.now())
      : RING_TIMEOUT_MS;
    const timer = window.setTimeout(
      () => useIncomingCallStore.getState().dismiss(),
      ms,
    );
    return () => window.clearTimeout(timer);
  }, [callKey, expiresAt]);

  // Gentle ring chirp every 2s while the banner shows — and, when the browser
  // will NOT let us make a sound, a visible line saying so. A ring that is
  // silently silent is a missed call the user never knew about; the autoplay
  // policy is a fact about the page, so it gets stated rather than swallowed.
  useEffect(() => {
    if (!callKey) {
      setSilentReason(null);
      return;
    }
    const reason = cueBlockedReason();
    setSilentReason(reason);
    if (reason) return; // no point scheduling chirps nobody can hear
    playCue("ring");
    const timer = window.setInterval(() => {
      // Re-probe: the user may interact mid-ring, which unblocks audio.
      const now = cueBlockedReason();
      setSilentReason(now);
      if (!now) playCue("ring");
    }, RING_CUE_INTERVAL_MS);
    return () => window.clearInterval(timer);
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

  function joinRoomCall(roomId: string) {
    if (activeRoomId === roomId) {
      void connect();
    } else {
      pendingJoinRoomId.current = roomId;
      navigate(`/c/${roomId}`);
    }
  }

  async function handleAccept() {
    if (!call || isConnecting || acting.current) return;
    acting.current = true;
    const { callId, roomId } = call;
    dismiss();
    if (callId) {
      try {
        await api.acceptCall(callId);
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 410) {
          // The caller hung up (or it rang out) while we reached for it. Say
          // that, and do NOT drop into an empty room.
          pushToast({ title: "That call already ended", body: call.callerName });
          acting.current = false;
          return;
        }
        // Any other failure: the signalling didn't land, but joining the room's
        // call is still the thing the user asked for, and the caller is already
        // sitting in it. Join, and don't pretend the accept succeeded silently.
        pushToast({
          title: "Joining anyway",
          body: "Couldn't confirm the answer with the server.",
        });
      }
    }
    joinRoomCall(roomId);
    acting.current = false;
  }

  async function handleDecline() {
    if (!call || acting.current) return;
    acting.current = true;
    const { callId } = call;
    dismiss();
    if (callId) {
      try {
        await api.declineCall(callId);
      } catch {
        // 410 = already over; anything else = the caller's own deadline will
        // end their ring. Either way our banner is down and no state is stuck.
      }
    }
    acting.current = false;
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
              {/* WHO is calling — their actual face, not a generic glyph. The
                  phone icon rides the corner so the call is still legible as a
                  call at a glance. */}
              <div className="relative shrink-0">
                <Avatar
                  name={call.callerName}
                  src={call.callerAvatarUrl}
                  id={call.callerId}
                  size="lg"
                />
                <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-slate-900 p-1">
                  <PhoneIncoming className="h-3.5 w-3.5 animate-pulse text-emerald-400" />
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-100">
                  {call.callerName}{" "}
                  <span className="font-normal text-slate-300">is calling</span>
                </p>
                <p className="truncate text-xs text-slate-400">
                  {call.roomName}
                </p>
                {silentReason && (
                  <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-amber-300/90">
                    <VolumeX className="h-3 w-3 shrink-0" />
                    {silentReason}
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2 px-3.5 pb-3.5">
              {/* min-h-11 == 44px. Both controls are always-visible buttons —
                  nothing here is revealed on hover, so a phone can answer. */}
              <button
                onClick={() => void handleAccept()}
                className="focus-ring flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-400"
              >
                <Phone className="h-4 w-4" />
                Accept
              </button>
              <button
                onClick={() => void handleDecline()}
                className="focus-ring flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-rose-500/20 hover:text-rose-200"
              >
                <PhoneOff className="h-4 w-4" />
                Decline
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
