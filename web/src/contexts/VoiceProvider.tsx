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
  RemoteAudioTrack,
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
 * It also does the three things a browser voice client must do and the old code
 * never did:
 *   1. attach remote *mic* audio tracks to the DOM so you actually HEAR the
 *      agent/peers (the SDK does NOT auto-play remote audio);
 *   2. attach remote *screen-share* audio so a shared tab/app is audible —
 *      routed through a claim-aware sink (see below) so it plays in every view
 *      mode by default but a visible ScreenShareTile can take ownership for
 *      per-share mute/volume without doubling the audio;
 *   3. call room.startAudio() to satisfy the autoplay policy — on mobile the
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
  /**
   * ScreenShareTile ownership seam (see SCREENAUDIO-NOTE.md).
   *
   * Remote screen-share AUDIO is audible in every view mode via a hidden global
   * sink by default — including compact / audio-only, where NO tile is rendered.
   * When a visible ScreenShareTile mounts its own un-muted <audio> for a share's
   * audio track it calls claimScreenAudio(track): the provider drops that track
   * from the global sink so the tile becomes the SOLE owner (one attach → no
   * doubled/echoed audio; enables per-share mute/volume; the <audio> follows the
   * tile into a pop-out portal). On unmount the tile calls releaseScreenAudio():
   * if the track is still live the provider re-attaches it to the global sink so
   * audio-only listeners keep hearing it. Idempotent per track.sid; render each
   * share's audio in EXACTLY ONE tile at a time.
   */
  claimScreenAudio: (track: RemoteAudioTrack) => void;
  releaseScreenAudio: (track: RemoteAudioTrack) => void;
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

  // Screen-share audio sink bookkeeping. `screenSinkEls` maps a screen-share
  // audio track's sid → the hidden <audio> element WE created for the global
  // sink (so we can detach exactly that element when a tile claims the track or
  // the track goes away). `claimedScreenAudio` is the set of track sids a
  // ScreenShareTile currently owns — while claimed we keep the track OUT of the
  // global sink to avoid double/echoed audio. `pendingScreenReattach` holds sids
  // whose sink re-attach is deferred one microtask (see releaseScreenAudio) so a
  // same-batch claim (view-mode switch remount) can cancel it → glitch-free.
  const screenSinkEls = useRef(new Map<string, HTMLMediaElement>());
  const claimedScreenAudio = useRef(new Set<string>());
  const pendingScreenReattach = useRef(new Set<string>());

  const sync = useCallback((r: Room) => {
    setLocalParticipant(r.localParticipant);
    setRemoteParticipants(Array.from(r.remoteParticipants.values()));
    setVersion((v) => v + 1);
  }, []);

  // Attach a remote screen-share audio track to the hidden global sink so it is
  // audible in EVERY view mode (incl. compact/audio-only, which render no tile).
  // No-op if a tile has claimed it or it's already sinked.
  const attachScreenAudioToSink = useCallback((track: RemoteTrack) => {
    const sid = track.sid;
    if (!sid) return;
    if (claimedScreenAudio.current.has(sid)) return; // a tile owns it
    if (screenSinkEls.current.has(sid)) return; // already sinked
    const el = track.attach();
    el.setAttribute("data-lk-audio-sink", "screen");
    el.style.display = "none";
    document.body.appendChild(el);
    screenSinkEls.current.set(sid, el);
  }, []);

  // Remove the global-sink element for a screen-share audio track (on claim, or
  // when the track goes away). Detaches the specific element so the LiveKit
  // track stops tracking it, then removes it from the DOM.
  const detachScreenAudioFromSink = useCallback((track: RemoteTrack) => {
    const sid = track.sid;
    if (!sid) return;
    const el = screenSinkEls.current.get(sid);
    if (el) {
      track.detach(el);
      el.remove();
      screenSinkEls.current.delete(sid);
    }
  }, []);

  // Is this screen-share audio track still subscribed in the room? Guards the
  // re-attach on releaseScreenAudio so we don't resurrect a dead track's sink.
  const isScreenAudioLive = useCallback((track: RemoteTrack): boolean => {
    const r = roomRef.current;
    if (!r) return false;
    for (const p of r.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.track === track && pub.isSubscribed) return true;
      }
    }
    return false;
  }, []);

  // --- ScreenShareTile ownership seam (consumed by VoiceVideoBar's tile) ---
  const claimScreenAudio = useCallback(
    (track: RemoteAudioTrack) => {
      const sid = track?.sid;
      if (!sid) return;
      // Cancel any deferred sink re-attach from a just-unmounted tile of the
      // SAME track (view-mode switch remounts the tile in one effect batch:
      // old.release → new.claim). Winning the race here means the sink is never
      // touched — the <audio> ownership passes tile→tile with no doubling.
      pendingScreenReattach.current.delete(sid);
      claimedScreenAudio.current.add(sid);
      // Hand ownership to the tile: drop our global-sink element so the track
      // isn't attached twice (tile <audio> + sink) → no doubled audio.
      detachScreenAudioFromSink(track);
    },
    [detachScreenAudioFromSink],
  );

  const releaseScreenAudio = useCallback(
    (track: RemoteAudioTrack) => {
      const sid = track?.sid;
      if (!sid) return;
      claimedScreenAudio.current.delete(sid);
      // Tile went away. It might be a genuine unmount (switched to
      // compact/audio-only → resume global playback so listeners still hear it)
      // OR a remount to a different stage (a new tile is about to claim in this
      // same effect batch). Defer the sink re-attach one microtask so a
      // followup claim() can cancel it — otherwise we'd briefly double-attach
      // (tile <audio> + sink) during the switch.
      pendingScreenReattach.current.add(sid);
      queueMicrotask(() => {
        if (!pendingScreenReattach.current.delete(sid)) return; // claimed → cancelled
        if (isScreenAudioLive(track)) attachScreenAudioToSink(track);
      });
    },
    [attachScreenAudioToSink, isScreenAudioLive],
  );

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
    // Belt-and-suspenders: drop any lingering screen-audio sink elements +
    // claims + pending re-attaches. TrackUnsubscribed normally removes these on
    // disconnect, but a hard teardown must not leak hidden <audio> nodes, stale
    // claim sids, or a queued microtask that would resurrect a dead sink.
    for (const el of screenSinkEls.current.values()) el.remove();
    screenSinkEls.current.clear();
    claimedScreenAudio.current.clear();
    pendingScreenReattach.current.clear();
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
        // the agent/peers are audible. Video is attached by the tiles in
        // VoiceVideoBar. Screen-share audio is a special case (see below).
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Audio) {
            if (track.source === Track.Source.ScreenShareAudio) {
              // Route through the claim-aware sink: audible in every view mode
              // now, but a visible ScreenShareTile can take ownership later
              // (claimScreenAudio) without doubling the audio.
              attachScreenAudioToSink(track);
            } else {
              // Mic (and any other) remote audio → hidden global sink, always.
              const el = track.attach();
              el.setAttribute("data-lk-audio-sink", "1");
              el.style.display = "none";
              document.body.appendChild(el);
            }
          }
          sync(r);
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Audio) {
            if (track.source === Track.Source.ScreenShareAudio) {
              // Clear any claim, pending re-attach, + our global-sink element for
              // this track. The owning tile (if any) is unmounting alongside the
              // vanished share and tears down its own <audio> via its attach-ref
              // cleanup.
              claimedScreenAudio.current.delete(track.sid ?? "");
              pendingScreenReattach.current.delete(track.sid ?? "");
              detachScreenAudioFromSink(track);
            } else {
              track.detach().forEach((el) => el.remove());
            }
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
  }, [
    setVoiceActive,
    sync,
    startAudio,
    attachScreenAudioToSink,
    detachScreenAudioFromSink,
  ]);

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
        claimScreenAudio,
        releaseScreenAudio,
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
