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
import {
  decodeRoomData,
  isAgentParticipant,
} from "@/lib/roomDataProtocol";
import {
  useCallUiStore,
  dispatchUiCommand,
  setActiveCallRoom,
} from "@/stores/callUiStore";
import { handleArtifactEvent } from "@/stores/canvasStore";
import { playCue } from "@/lib/sounds";

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
  /**
   * Monotonic counter bumped on every sync() — i.e. whenever a track is
   * published/unpublished/muted or a participant joins/leaves. The LiveKit SDK
   * reuses the SAME LocalParticipant/RemoteParticipant object across these
   * events, so setState with that object reference is a React no-op and tile
   * useMemos keyed only on the participant never recompute (the camera self-view
   * stayed blank). Consumers include `version` in those dep arrays to force a
   * recompute when the underlying track set changes.
   */
  version: number;
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
  // Bumped on every sync() so consumers can detect track/participant changes
  // even though LiveKit hands back the same participant object each time.
  const [version, setVersion] = useState(0);

  const roomRef = useRef<Room | null>(null);
  const connectingRef = useRef(false);
  // Join cue fires once per connect() — Reconnected/state churn must not
  // re-chime. Reset when a fresh Room is created in connect().
  const joinCuePlayedRef = useRef(false);

  const sync = useCallback((r: Room) => {
    setLocalParticipant(r.localParticipant);
    setRemoteParticipants(Array.from(r.remoteParticipants.values()));
    setVersion((v) => v + 1);
  }, []);

  const disconnect = useCallback(() => {
    const r = roomRef.current;
    roomRef.current = null;
    connectingRef.current = false;
    if (r) {
      // Only a live (connected) room earns the hang-up cue — tearing down a
      // failed/stale room object must stay silent.
      if (r.state === ConnectionState.Connected) playCue("call-leave");
      r.disconnect();
    }
    setRoom(null);
    setLocalParticipant(null);
    setRemoteParticipants([]);
    setIsConnected(false);
    setIsConnecting(false);
    setAudioBlocked(false);
    setVersion(0);
    setVoiceActive(false);
    // No active call → agent ui_commands have no room to target.
    setActiveCallRoom(null);
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
    if (!roomId || connectingRef.current) return;
    const leftover = roomRef.current;
    if (leftover) {
      // A live room means we're already in a call. But a room object left
      // behind by a just-ended call must not brick the Start-call button
      // (the "hang up, immediately call again → click silently ignored"
      // trap) — clear it and connect fresh.
      if (leftover.state !== ConnectionState.Disconnected) return;
      console.warn("voice connect: clearing stale disconnected room");
      roomRef.current = null;
    }
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
      joinCuePlayedRef.current = false;

      const onState = () => {
        setIsConnected(r.state === ConnectionState.Connected);
        setIsConnecting(
          r.state === ConnectionState.Connecting ||
            r.state === ConnectionState.Reconnecting,
        );
        sync(r);
      };

      r.on(RoomEvent.Connected, onState)
        // Join chime: once per connect (ref-guarded), never on reconnects.
        .on(RoomEvent.Connected, () => {
          if (joinCuePlayedRef.current) return;
          joinCuePlayedRef.current = true;
          playCue("call-join");
        })
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
        })
        // Room data channel: transcript lines + agent UI commands. Transcript
        // packets feed the live-transcript panel; ui_command packets drive the
        // call UI but ONLY when the sender is an agent (the AG-UI seam).
        .on(
          RoomEvent.DataReceived,
          (payload: Uint8Array, participant?: RemoteParticipant) => {
            const msg = decodeRoomData(payload);
            if (!msg) return;
            // Artifact events are tagged with `event` (not `type`); handle them
            // first. The canvas store re-fetches the affected artifact so the
            // panel live-updates (cheap no-op when nothing relevant is open).
            if ("event" in msg) {
              handleArtifactEvent(msg);
              return;
            }
            if (msg.type === "transcript") {
              useCallUiStore.getState().ingestTranscript(msg);
              return;
            }
            if (msg.type === "ui_command") {
              // Gate: only AI agents may drive the interface. A human peer's
              // ui_command is dropped.
              if (!isAgentParticipant(participant)) return;
              dispatchUiCommand(msg, roomId);
            }
          },
        );

      // Tell the imperative uiCommandBus which room agent commands apply to
      // (it runs outside React, so it can't read the active room itself).
      setActiveCallRoom(roomId);

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
      const inviteAgent = async () => {
        const detail = await api.getRoom(roomId);
        const agentId = detail?.brigade_agent_id;
        if (!agentId) return false;
        // Honor the per-room model override (mid-conversation switcher) for
        // the voice agent too, so the spoken agent uses the same chosen LLM.
        const model = useAppStore.getState().modelOverrides[roomId];
        await api.inviteBrigadeAgent(roomId, agentId, model);
        return true;
      };
      // Optimistic default: if the invite itself failed we still want the
      // self-heal loop below (it no-ops for rooms without a resident agent).
      let roomHasAgent = true;
      try {
        roomHasAgent = await inviteAgent();
      } catch (e) {
        console.error("failed to dispatch agent into voice call", e);
      }

      // Self-heal: the server skips the dispatch when a previous call's agent
      // is still in the room — but that agent may be a zombie mid-teardown
      // (rapid hang-up → call-again), and a dispatch can also just get lost.
      // Poll for a live agent participant and re-invite until one shows up.
      if (roomHasAgent) {
        const ensureAgent = (attempt: number) => {
          window.setTimeout(async () => {
            const cur = roomRef.current;
            if (!cur || cur.state !== ConnectionState.Connected) return;
            const agentPresent = Array.from(
              cur.remoteParticipants.values(),
            ).some((p) => isAgentParticipant(p));
            if (agentPresent) return;
            console.warn(
              `voice call has no agent after ${attempt * 4}s — re-inviting`,
            );
            try {
              await inviteAgent();
            } catch (e) {
              console.error("agent re-invite failed", e);
            }
            if (attempt < 3) ensureAgent(attempt + 1);
          }, 4000);
        };
        ensureAgent(1);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to connect to room";
      setError(message);
      // Nothing renders `error` inline yet — without a toast a failed connect
      // is a silently dead Start-call button. Keep the state for future inline
      // surfaces; the toast is the user-visible signal today.
      useAppStore.getState().pushToast({
        title: "Couldn't start the call",
        body: message,
      });
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
        version,
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
