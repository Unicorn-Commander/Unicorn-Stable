import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import {
  FALLBACK_AGENT_NAME,
  voiceAgentDisplayName,
  voiceRelaySource,
} from "@/lib/voiceSettings";

/**
 * TalkGateIndicator — "the pedal is down and the agent is listening", live.
 *
 * The external talk gate (a foot pedal / stream deck / hotkey via the gateway)
 * has NO other feedback anywhere in the UI: without this strip a pedal-holder
 * is talking to a room with no idea whether the agent can hear them. While a
 * `talk_gate open:true` frame stands un-closed, this renders a mint chip in
 * the same visual language as the VoiceAgentStatus strip directly above it.
 *
 * Clearing is owned by callUiStore.setTalkGate / setActiveCallRoom: the close
 * frame, hang-up or call-switch, and the 120s safety timeout (a lost close
 * frame must not pin the chip forever) all end it — this component only reads.
 */
export function TalkGateIndicator({ roomId }: { roomId: string }) {
  const talkGate = useCallUiStore((s) => s.talkGate);
  const members = useAppStore((s) => s.participants[roomId]);
  const room = useAppStore((s) => s.rooms.find((r) => r.id === roomId));

  if (!talkGate.open) return null;

  const source = voiceRelaySource(room?.metadata_);
  const resolved = voiceAgentDisplayName(members, source);
  // Chip copy starts the sentence, so the generic fallback gets its capital.
  const agentName =
    resolved === FALLBACK_AGENT_NAME ? "The agent" : resolved;

  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center border-b border-line bg-surface-1/60 px-4 py-1.5 backdrop-blur-md"
    >
      <span className="flex items-center gap-1.5 rounded-full border border-stable-mint/30 bg-stable-mint/10 px-2.5 py-0.5 text-[11px] font-medium text-stable-mint">
        <span
          aria-hidden="true"
          className="h-2 w-2 animate-live rounded-full bg-stable-mint"
        />
        {agentName} can hear you
      </span>
    </div>
  );
}
