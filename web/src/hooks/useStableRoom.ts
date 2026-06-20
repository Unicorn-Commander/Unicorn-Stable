import { useVoice } from "@/contexts/VoiceProvider";

/**
 * Compatibility wrapper over the shared {@link VoiceProvider}. The optional
 * roomId argument is ignored — the provider already tracks the active room, and
 * every voice surface (Header, MessageInput, VoiceVideoBar, StageView) now
 * shares the SAME Room through this hook (previously each got its own, so the
 * call UI rendered a Room that never connected). Returns `connect`/`disconnect`
 * plus `audioBlocked`/`startAudio` for the mobile autoplay prompt.
 */
export function useStableRoom(_roomId?: string | null) {
  return useVoice();
}
