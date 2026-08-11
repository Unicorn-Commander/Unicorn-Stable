import { useState } from "react";
import { Phone } from "lucide-react";
import { useVoice } from "@/contexts/VoiceProvider";
import { useCallUiStore } from "@/stores/callUiStore";
import { useIncomingCallStore } from "@/stores/incomingCallStore";
import { useLiveCalls } from "@/hooks/useLiveCalls";
import { shouldShowLiveCallBanner } from "@/lib/callAwareness";

/**
 * Slim "Call in progress" strip at the top of a room's chat, shown when THIS
 * room has a live call this device is not connected to — the call moved to
 * your phone, or others are already talking. One click joins.
 *
 * Join is a plain LiveKit join via VoiceProvider.connect() — the exact path
 * the ring endpoint's `in_call` answer takes (see useDirectCall): joining an
 * ongoing call must never re-ring anybody, and if the call is your own on
 * another device, LiveKit's duplicate-identity handoff moves it here, which is
 * precisely the "get back to the call" gesture. connect() reads the active
 * room from the app store, and this banner only renders inside the room it
 * announces, so the two always agree.
 *
 * Data comes from the shared useLiveCalls source of truth (home-summary poll +
 * call_occupancy WS nudges), so this banner, the sidebar badges and the toast
 * can never disagree about whether a call is live.
 */
export function LiveCallBanner({ roomId }: { roomId: string }) {
  const { byRoomId } = useLiveCalls();
  const { isConnected, isConnecting, connect } = useVoice();
  const activeCallRoomId = useCallUiStore((s) => s.activeCallRoomId);
  const ringingRoomId = useIncomingCallStore((s) => s.call?.roomId ?? null);
  const [joining, setJoining] = useState(false);

  const liveCall = byRoomId[roomId];
  const show = shouldShowLiveCallBanner({
    liveCall,
    roomId,
    isConnected,
    isConnecting,
    activeCallRoomId,
    ringingRoomId,
  });
  if (!show || !liveCall) return null;

  const count = liveCall.participant_count;

  async function join() {
    if (joining) return;
    setJoining(true);
    try {
      await connect();
    } finally {
      setJoining(false);
    }
  }

  return (
    <div
      className="flex items-center gap-2.5 border-b border-stable-mint/25 bg-stable-mint/10 px-3 py-1.5"
      role="status"
      aria-label={`Call in progress in this room, ${count} in call`}
    >
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-stable-mint opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-stable-mint" />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-slate-200">
        <span className="font-semibold text-stable-mint">Call in progress</span>
        <span className="text-slate-400">
          {" "}
          · {count} in call
        </span>
      </span>
      <button
        type="button"
        onClick={() => void join()}
        disabled={joining}
        className="focus-ring flex shrink-0 items-center gap-1.5 rounded-lg border border-stable-mint/40 bg-stable-mint/15 px-2.5 py-1 text-xs font-semibold text-stable-mint transition-colors hover:bg-stable-mint/25 disabled:opacity-60"
      >
        <Phone className="h-3 w-3" aria-hidden="true" />
        {joining ? "Joining…" : "Join"}
      </button>
    </div>
  );
}
