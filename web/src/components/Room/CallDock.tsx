import { useNavigate } from "react-router-dom";
import { Mic, MicOff, Video, VideoOff, PhoneOff, ChevronUp } from "lucide-react";
import clsx from "clsx";
import { useVoice } from "@/contexts/VoiceProvider";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import { identityFor } from "@/lib/identity";
import { shouldShowCallDock } from "@/lib/callAwareness";

/**
 * CallDock — the persistent, app-level representation of a LIVE call while you
 * are looking at some OTHER room or page.
 *
 * The call no longer ends when you navigate away (see VoiceProvider — the
 * disconnect-on-room-switch effect was removed). The full call surface renders
 * only in the call's own room ({@link CallRoomLayout} keys off
 * `activeCallRoomId`); everywhere else THIS floating pill stands in for it:
 * a live indicator + a one-tap "return to the call", plus mic/camera/leave so
 * you never lose call control just because you wandered off to read another
 * channel. It self-gates — renders nothing unless a call is live AND you are
 * not currently viewing its room — so it can be mounted unconditionally at the
 * app root (inside VoiceProvider).
 *
 * Audio keeps playing the whole time because the remote-audio sink lives in the
 * VoiceProvider (app-level), not in the call surface that unmounts on nav.
 */
export function CallDock() {
  const navigate = useNavigate();
  const {
    room,
    localParticipant,
    remoteParticipants,
    isConnected,
    disconnect,
    // version is read purely to re-render on mic/track/participant changes
    // (LiveKit reuses the same participant objects, so a bump is the signal).
    version,
  } = useVoice();
  const activeCallRoomId = useCallUiStore((s) => s.activeCallRoomId);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const rooms = useAppStore((s) => s.rooms);
  void version;

  // Only stand in for the call when it's live AND we're not already looking at
  // its room (there the real call surface is on screen). The gate is a pure
  // function (lib/callAwareness) so its truth table is unit-tested.
  if (!shouldShowCallDock({ isConnected, activeCallRoomId, activeRoomId })) {
    return null;
  }
  if (!activeCallRoomId) return null; // narrow for TS — gate already required it

  const callRoom = rooms.find((r) => r.id === activeCallRoomId);
  const roomName = callRoom?.name ?? "your call";
  const ident = identityFor(activeCallRoomId, roomName);

  const count = remoteParticipants.length + (localParticipant ? 1 : 0);
  const micOn = localParticipant?.isMicrophoneEnabled ?? false;
  const camOn = localParticipant?.isCameraEnabled ?? false;

  function returnToCall() {
    if (activeCallRoomId) navigate(`/c/${activeCallRoomId}`);
  }
  async function toggleMic() {
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!micOn);
    } catch (e) {
      console.error("CallDock: toggle mic failed", e);
    }
  }
  async function toggleCam() {
    if (!room) return;
    try {
      await room.localParticipant.setCameraEnabled(!camOn);
    } catch (e) {
      console.error("CallDock: toggle camera failed", e);
    }
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-3 max-md:bottom-20"
      role="region"
      aria-label="Active call"
    >
      <div className="glass pointer-events-auto flex items-center gap-1.5 rounded-2xl border border-line bg-surface-1/80 p-1.5 shadow-xl backdrop-blur-md">
        {/* Return-to-call: the whole label region is the affordance. */}
        <button
          type="button"
          onClick={returnToCall}
          className="focus-ring group flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
          aria-label={`Return to the call in ${roomName}`}
          title={`Return to the call in ${roomName}`}
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
              style={{ background: ident.ring }}
            />
            <span
              className="relative inline-flex h-2.5 w-2.5 rounded-full"
              style={{ background: ident.ring }}
            />
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="flex items-center gap-1 text-xs font-semibold text-slate-100">
              <span className="max-w-[9rem] truncate">{roomName}</span>
              <ChevronUp className="h-3 w-3 shrink-0 text-slate-400 transition-transform group-hover:-translate-y-0.5" />
            </span>
            <span className="text-[11px] text-slate-400">
              In call · {count} {count === 1 ? "person" : "people"} · tap to return
            </span>
          </span>
        </button>

        <div className="mx-0.5 h-7 w-px shrink-0 bg-line" aria-hidden="true" />

        <button
          type="button"
          onClick={toggleMic}
          className={clsx(
            "focus-ring flex h-9 w-9 items-center justify-center rounded-xl border transition-colors active:scale-[0.98]",
            micOn
              ? "border-transparent text-slate-200 hover:bg-white/[0.06] hover:text-slate-100"
              : "border-rose-500/30 bg-rose-500/15 text-rose-400 hover:bg-rose-500/25",
          )}
          aria-label={micOn ? "Mute" : "Unmute"}
          aria-pressed={!micOn}
        >
          {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
        </button>

        <button
          type="button"
          onClick={toggleCam}
          className={clsx(
            "focus-ring flex h-9 w-9 items-center justify-center rounded-xl border transition-colors active:scale-[0.98]",
            camOn
              ? "border-transparent text-slate-200 hover:bg-white/[0.06] hover:text-slate-100"
              : "border-rose-500/30 bg-rose-500/15 text-rose-400 hover:bg-rose-500/25",
          )}
          aria-label={camOn ? "Turn off camera" : "Turn on camera"}
          aria-pressed={!camOn}
        >
          {camOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
        </button>

        <button
          type="button"
          onClick={disconnect}
          className="focus-ring flex h-9 w-9 items-center justify-center rounded-xl bg-rose-500/90 text-white transition hover:bg-rose-500 active:scale-[0.98]"
          aria-label="End call"
          title="End call"
        >
          <PhoneOff className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
