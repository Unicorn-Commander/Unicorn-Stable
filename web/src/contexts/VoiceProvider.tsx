import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { Room, RoomEvent, ConnectionState, Track } from "livekit-client";
import type {
  RemoteParticipant,
  LocalParticipant,
  RemoteTrack,
} from "livekit-client";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";

/**
 * THE single LiveKit Room for the whole app.
 *
 * Previously every voice surface (Header, MessageInput, VoiceVideoBar,
 * StageView) called useStableRoom() and got its OWN Room — so the surface that
 * rendered the call UI (VoiceVideoBar) held a Room that never connected and
 * always rendered null, while Header connected a *different* Room. Result: you
 * could start a call (mic prompt + agent dispatch fired) but never see the call
 * or hear the agent. This provider owns ONE Room everyone shares.
 *
 * It also does the two things a browser voice client must do and the old code
 * never did:
 *   1. attach remote audio tracks to the DOM so you actually HEAR the agent;
 *   2. call room.startAudio() to satisfy the autoplay policy — on mobile the
 *      agent's audio is blocked until a user gesture unblocks it (audioBlocked).
 */
interface VoiceContextValue {
  room: Room | null;
  localParticipant: LocalParticipant | null;
  remoteParticipants: RemoteParticipant[];
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  /** Browser is blocking autoplay of remote audio → show a "tap to hear" prompt. */
  audioBlocked: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  startAudio: () => Promise<void>;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const setVoiceActive = useAppStore((s) => s.setVoiceActive);
  const activeRoomId = useAppStore((s) => s.activeRoomId);

  const [room, setRoom] = useState<Room | null>(null);
  const [localParticipant, setLocalParticipant] =
    useState<LocalParticipant | null>(null);
  const [remoteParticipants, setRemoteParticipants] = useState<
    RemoteParticipant[]
  >([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const connectingRef = useRef(false);

  const sync = useCallback((r: Room) => {
    setLocalParticipant(r.localParticipant);
    setRemoteParticipants(Array.from(r.remoteParticipants.values()));
  }, []);

  const disconnect = useCallback(() => {
    const r = roomRef.current;
    roomRef.current = null;
    connectingRef.current = false;
    if (r) r.disconnect();
    setRoom(null);
    setLocalParticipant(null);
    setRemoteParticipants([]);
    setIsConnected(false);
    setIsConnecting(false);
    setAudioBlocked(false);
    setVoiceActive(false);
  }, [setVoiceActive]);

  const startAudio = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    try {
      await r.startAudio();
    } catch (e) {
      console.error("startAudio failed", e);
    }
    setAudioBlocked(!r.canPlaybackAudio);
  }, []);

  const connect = useCallback(async () => {
    const roomId = useAppStore.getState().activeRoomId;
    if (!roomId || connectingRef.current || roomRef.current) return;
    connectingRef.current = true;
    setIsConnecting(true);
    setError(null);

    try {
      const { token, ws_url } = await api.getLiveKitToken(roomId);

      const r = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      roomRef.current = r;

      const onState = () => {
        setIsConnected(r.state === ConnectionState.Connected);
        setIsConnecting(
          r.state === ConnectionState.Connecting ||
            r.state === ConnectionState.Reconnecting,
        );
        sync(r);
      };

      r.on(RoomEvent.Connected, onState)
        .on(RoomEvent.Reconnected, onState)
        .on(RoomEvent.Reconnecting, () => setIsConnecting(true))
        .on(RoomEvent.ConnectionStateChanged, onState)
        .on(RoomEvent.Disconnected, () => {
          setIsConnected(false);
          setVoiceActive(false);
          sync(r);
        })
        .on(RoomEvent.ParticipantConnected, () => sync(r))
        .on(RoomEvent.ParticipantDisconnected, () => sync(r))
        .on(RoomEvent.LocalTrackPublished, () => sync(r))
        .on(RoomEvent.LocalTrackUnpublished, () => sync(r))
        .on(RoomEvent.TrackMuted, () => sync(r))
        .on(RoomEvent.TrackUnmuted, () => sync(r))
        // The core SDK does NOT auto-play remote audio — attach it ourselves so
        // the agent is audible. Video is attached by the tiles in VoiceVideoBar.
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach();
            el.setAttribute("data-lk-audio-sink", "1");
            el.style.display = "none";
            document.body.appendChild(el);
          }
          sync(r);
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Audio) {
            track.detach().forEach((el) => el.remove());
          }
          sync(r);
        })
        .on(RoomEvent.AudioPlaybackStatusChanged, () => {
          setAudioBlocked(!r.canPlaybackAudio);
        });

      await r.connect(ws_url, token);
      setRoom(r);
      setVoiceActive(true);

      // Publish the human's mic so the agent can hear them. Do NOT await — the
      // mic-permission prompt would otherwise block the agent dispatch below
      // (and the dispatch must fire whether or not the human grants the mic).
      void r.localParticipant
        .setMicrophoneEnabled(true)
        .catch((e) =>
          console.error("failed to enable microphone on call start", e),
        );

      // Best-effort unblock of remote-audio playback; if the browser still
      // blocks it (mobile), audioBlocked drives the tap-to-hear prompt.
      void startAudio();

      // Dispatch the room's resident Brigade agent (e.g. Majik) into the call.
      // A failed dispatch must never break the human's call.
      try {
        const detail = await api.getRoom(roomId);
        const agentId = detail?.brigade_agent_id;
        if (agentId) {
          await api.inviteBrigadeAgent(roomId, agentId);
        }
      } catch (e) {
        console.error("failed to dispatch agent into voice call", e);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect to room");
      roomRef.current = null;
      connectingRef.current = false;
      setIsConnecting(false);
      return;
    }
    connectingRef.current = false;
  }, [setVoiceActive, sync, startAudio]);

  // Leaving the room (or switching rooms) ends any live call.
  const prevRoomIdRef = useRef(activeRoomId);
  useEffect(() => {
    if (prevRoomIdRef.current !== activeRoomId) {
      prevRoomIdRef.current = activeRoomId;
      if (roomRef.current) disconnect();
    }
  }, [activeRoomId, disconnect]);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, []);

  return (
    <VoiceContext.Provider
      value={{
        room,
        localParticipant,
        remoteParticipants,
        isConnected,
        isConnecting,
        error,
        audioBlocked,
        connect,
        disconnect,
        startAudio,
      }}
    >
      {children}
    </VoiceContext.Provider>
  );
}

export function useVoice(): VoiceContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) {
    throw new Error("useVoice must be used within <VoiceProvider>");
  }
  return ctx;
}
