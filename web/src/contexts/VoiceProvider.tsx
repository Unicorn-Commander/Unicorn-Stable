import { enterDuplexSession, recoverCallAudio } from "@/lib/audioRecovery";
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
  DisconnectReason,
  RemoteParticipant,
  LocalParticipant,
  RemoteTrack,
  RemoteAudioTrack,
} from "livekit-client";
import {
  isMovedToAnotherDevice,
  MOVED_TO_ANOTHER_DEVICE_TOAST,
} from "@/lib/callHandoff";
import { api, residentAgentIds } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import {
  decodeRoomData,
  isAgentParticipant,
  type TranscriptMessage,
} from "@/lib/roomDataProtocol";
import {
  useCallUiStore,
  dispatchTalkGate,
  dispatchUiCommand,
  setActiveCallRoom,
} from "@/stores/callUiStore";
import { applyRelayConfigToRoomQueries } from "@/lib/voiceSettings";
import { useQueryClient } from "@tanstack/react-query";
import { handleArtifactEvent } from "@/stores/canvasStore";
import { playCue } from "@/lib/sounds";
import { HumanTranscriptSession } from "@/lib/humanTranscript";
import { apiErrorText, isEntitlementDenial } from "@/lib/agentEntitlement";
import { DeviceCheckDialog } from "@/components/Call/DeviceCheckDialog";
import { readCallJoinPrefs, saveCallJoinPrefs } from "@/lib/callJoinPrefs";
import {
  resolveCallEntry,
  type CallEntryPrefs,
  type CallKind,
} from "@/lib/callEntry";
import { matchDevice } from "@/lib/callDeepLink";
import { useOutgoingCallStore } from "@/stores/outgoingCallStore";
import {
  pickAudioInputDevice,
  readDevicePreferences,
  saveDevicePreference,
  setElementSink,
  type StableDeviceKind,
} from "@/lib/mediaDevices";

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
/**
 * How to enter a call. Every field optional — a bare `connect()` is a VOICE
 * call: straight in with the chosen mic, camera off, no dialog. A `kind` of
 * "video" turns the camera on and (only if the user opted in) shows the
 * pre-join device check first. The rule lives in `lib/callEntry`; deep links
 * (`hooks/useCallDeepLink`) fill the rest in.
 */
export interface ConnectOptions {
  /** Voice (default) or video call. */
  kind?: CallKind;
  /** Skip the pre-join dialog regardless of the preference. */
  skipDeviceCheck?: boolean;
  /** Microphone by deviceId or label (see lib/callDeepLink.matchDevice). */
  mic?: string | null;
  /** Camera by deviceId or label. */
  cam?: string | null;
  /** Publish the camera on join (Stable calls are audio-first: default off). */
  video?: boolean;
}

/** Resolved per-join choices handed to join(): ids, not labels. */
interface JoinOverrides {
  audioinput?: string;
  videoinput?: string;
  video?: boolean;
}

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
  /** Resolves true once connected, false when the user backed out of the device check. */
  connect: (opts?: ConnectOptions) => Promise<boolean>;
  /** Call-entry preferences (server-side, cached per browser). */
  callPrefs: CallEntryPrefs;
  /** Persist a call-entry preference: local cache now, server when signed in. */
  setCallPrefs: (patch: Partial<CallEntryPrefs>) => Promise<CallEntryPrefs>;
  disconnect: () => void;
  startAudio: () => Promise<void>;
  repairAudio: () => Promise<void>;
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
  devices: Record<StableDeviceKind, MediaDeviceInfo[]>;
  selectedDevices: Record<StableDeviceKind, string>;
  refreshDevices: () => Promise<void>;
  switchDevice: (kind: StableDeviceKind, deviceId: string) => Promise<void>;
  deviceSignal: { audioinput: boolean; videoinput: boolean };
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

/**
 * Lab/verification seam — NOT for app code.
 *
 * The face lab (src/faceLab.tsx, served as /face-lab.html in dev) mounts
 * AgentPresenceFace under a SYNTHETIC voice context so "does the mouth
 * actually move on agent audio" is answerable headlessly, without LiveKit.
 * App code must keep consuming through <VoiceProvider>/useVoice(); anything
 * else importing these is a review flag.
 */
export { VoiceContext as VoiceContextForLab };
export type { VoiceContextValue };

/**
 * Bind a transcript packet to the LiveKit participant that actually sent it.
 *
 * Human peers may caption only themselves. Agent workers may caption
 * themselves or a known human participant whose audio session they are linked
 * to. The packet's claimed name/source never outranks LiveKit identity.
 */
function bindTranscriptSender(
  room: Room,
  sender: RemoteParticipant | undefined,
  message: TranscriptMessage,
): TranscriptMessage | null {
  if (!sender) return null;

  const senderIsAgent = isAgentParticipant(sender);
  let speaker: RemoteParticipant | LocalParticipant = sender;
  let source: TranscriptMessage["source"];

  if (senderIsAgent) {
    const claimedSource =
      message.source ??
      (message.participantId === sender.identity ? "agent" : "agent_stt");
    if (claimedSource === "agent") {
      speaker = sender;
      source = "agent";
    } else if (claimedSource === "agent_stt") {
      const candidates: Array<RemoteParticipant | LocalParticipant> = [
        room.localParticipant,
        ...room.remoteParticipants.values(),
      ];
      const linkedHuman = candidates.find(
        (candidate) =>
          candidate.identity === message.participantId &&
          !isAgentParticipant(candidate),
      );
      if (!linkedHuman) return null;
      speaker = linkedHuman;
      source = "agent_stt";
    } else {
      return null;
    }
  } else {
    // A human data sender can only publish a caption for their own mic.
    speaker = sender;
    source = "local_mic";
  }

  const now = Date.now();
  const ts =
    Number.isFinite(message.ts) && Math.abs(message.ts - now) <= 5 * 60_000
      ? message.ts
      : now;
  return {
    ...message,
    participantId: speaker.identity,
    name: speaker.name || speaker.identity,
    source,
    ts,
    // A producer-controlled segment ID must not collide with another
    // participant's interim line.
    segmentId: message.segmentId
      ? `${speaker.identity}:${message.segmentId}`
      : undefined,
  };
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const setVoiceActive = useAppStore((s) => s.setVoiceActive);
  // For relay_config frames: the room-detail query is what the voice-settings
  // surface renders from, so a mode change that arrives over the data channel
  // reconciles it (patch + invalidate) instead of letting stale UI lie.
  const queryClient = useQueryClient();

  const [room, setRoom] = useState<Room | null>(null);
  const audioSessionRestore = useRef<(() => void) | null>(null);
  const [localParticipant, setLocalParticipant] =
    useState<LocalParticipant | null>(null);
  const [remoteParticipants, setRemoteParticipants] = useState<
    RemoteParticipant[]
  >([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [showDeviceCheck, setShowDeviceCheck] = useState(false);
  // Which kind of call the open device check belongs to (labels the dialog).
  const [deviceCheckKind, setDeviceCheckKind] = useState<CallKind>("video");
  const currentUserId = useAppStore((s) => s.currentUser?.id ?? null);
  const [callPrefs, setCallPrefsState] = useState<CallEntryPrefs>(() =>
    readCallJoinPrefs(useAppStore.getState().currentUser?.id),
  );
  // The server copy wins once we're signed in: a choice made at the desk
  // follows the phone. The local cache covers the moments before it arrives.
  // A save made while the fetch is in flight must not be clobbered by the
  // stale response — the sequence counter says which is newer.
  const callPrefsSaveSeq = useRef(0);
  useEffect(() => {
    setCallPrefsState(readCallJoinPrefs(currentUserId));
    if (!currentUserId) return;
    let cancelled = false;
    const seqAtFetch = callPrefsSaveSeq.current;
    void api
      .getMyPreferences()
      .then((prefs) => {
        if (cancelled || !prefs.call_prefs) return;
        if (callPrefsSaveSeq.current !== seqAtFetch) return;
        setCallPrefsState(
          saveCallJoinPrefs(currentUserId, {
            checkDevicesBeforeVideo:
              prefs.call_prefs.check_devices_before_video === true,
          }),
        );
      })
      .catch((e) => console.warn("call prefs: server copy unavailable", e));
    return () => {
      cancelled = true;
    };
  }, [currentUserId]);
  const setCallPrefs = useCallback(
    async (patch: Partial<CallEntryPrefs>): Promise<CallEntryPrefs> => {
      const userId = useAppStore.getState().currentUser?.id;
      callPrefsSaveSeq.current += 1;
      const next = saveCallJoinPrefs(userId, patch);
      setCallPrefsState(next);
      if (userId) {
        try {
          await api.setCallPrefs({
            check_devices_before_video: next.checkDevicesBeforeVideo,
          });
        } catch (e) {
          console.warn("call prefs: server save failed, kept locally", e);
          useAppStore.getState().pushToast({
            title: "Call setting not synced",
            body: "Couldn't save it to your account. It applies here until the next sign-in; try again in a moment.",
            kind: "error",
          });
        }
      }
      return next;
    },
    [],
  );
  const [devices, setDevices] = useState<
    Record<StableDeviceKind, MediaDeviceInfo[]>
  >({ audioinput: [], videoinput: [], audiooutput: [] });
  const [selectedDevices, setSelectedDevices] = useState<
    Record<StableDeviceKind, string>
  >({ audioinput: "", videoinput: "", audiooutput: "" });
  const [deviceSignal, setDeviceSignal] = useState({
    audioinput: true,
    videoinput: true,
  });
  // Bumped on every sync() so consumers can detect track/participant changes
  // even though LiveKit hands back the same participant object each time.
  const [version, setVersion] = useState(0);

  const roomRef = useRef<Room | null>(null);
  const connectingRef = useRef(false);
  // The connect() awaiting the device-check dialog's verdict (Join / Cancel).
  // One at a time: a second connect() while the dialog is up settles the
  // first as "backed out" rather than leaving a promise dangling forever.
  const pendingConnectRef = useRef<{
    resolve: (joined: boolean) => void;
    overrides: JoinOverrides;
  } | null>(null);
  // Join cue fires once per connect() — Reconnected/state churn must not
  // re-chime. Reset when a fresh Room is created in connect().
  const joinCuePlayedRef = useRef(false);
  // Speaker-owned browser STT for the local human. It runs with or without an
  // agent and mirrors the LiveKit mute state.
  const humanTranscriptRef = useRef<HumanTranscriptSession | null>(null);

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

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    const next = {
      audioinput: all.filter((d) => d.kind === "audioinput"),
      videoinput: all.filter((d) => d.kind === "videoinput"),
      audiooutput: all.filter((d) => d.kind === "audiooutput"),
    };
    setDevices(next);
    const saved = readDevicePreferences(useAppStore.getState().currentUser?.id);
    setSelectedDevices((current) => ({
      audioinput: next.audioinput.some((d) => d.deviceId === current.audioinput)
        ? current.audioinput
        : pickAudioInputDevice(next.audioinput, saved.audioinput),
      videoinput: next.videoinput.some((d) => d.deviceId === current.videoinput)
        ? current.videoinput
        : next.videoinput.find((d) => d.deviceId === saved.videoinput)
            ?.deviceId ||
          next.videoinput[0]?.deviceId ||
          "",
      audiooutput: next.audiooutput.some(
        (d) => d.deviceId === current.audiooutput,
      )
        ? current.audiooutput
        : next.audiooutput.find((d) => d.deviceId === saved.audiooutput)
            ?.deviceId ||
          next.audiooutput[0]?.deviceId ||
          "",
    }));
  }, []);

  const switchDevice = useCallback(
    async (kind: StableDeviceKind, deviceId: string) => {
      const previous = selectedDevices[kind];
      setSelectedDevices((current) => ({ ...current, [kind]: deviceId }));
      try {
        const activeRoom = roomRef.current;
        if (activeRoom?.state === ConnectionState.Connected)
          await activeRoom.switchActiveDevice(kind, deviceId, true);
        if (kind === "audiooutput") {
          await Promise.all(
            Array.from(
              document.querySelectorAll<HTMLMediaElement>(
                "audio,video[data-lk-audio-sink]",
              ),
            ).map((el) => setElementSink(el, deviceId)),
          );
        }
        saveDevicePreference(
          useAppStore.getState().currentUser?.id,
          kind,
          deviceId,
        );
      } catch (error) {
        setSelectedDevices((current) => ({ ...current, [kind]: previous }));
        throw error;
      }
    },
    [selectedDevices],
  );

  useEffect(() => {
    void refreshDevices();
    const onChange = () =>
      void navigator.mediaDevices.enumerateDevices().then(async (all) => {
        await refreshDevices();
        if (roomRef.current?.state !== ConnectionState.Connected) return;
        for (const kind of [
          "audioinput",
          "videoinput",
          "audiooutput",
        ] as StableDeviceKind[]) {
          if (
            !selectedDevices[kind] ||
            all.some(
              (d) => d.kind === kind && d.deviceId === selectedDevices[kind],
            )
          )
            continue;
          const fallback = all.find((d) => d.kind === kind);
          if (!fallback) continue;
          await switchDevice(kind, fallback.deviceId);
          useAppStore.getState().pushToast({
            title: `${kind === "videoinput" ? "Camera" : kind === "audioinput" ? "Microphone" : "Speaker"} disconnected`,
            body: `Switched to ${fallback.label || "the next available device"}.`,
          });
        }
      });
    navigator.mediaDevices?.addEventListener("devicechange", onChange);
    return () =>
      navigator.mediaDevices?.removeEventListener("devicechange", onChange);
  }, [refreshDevices, selectedDevices, switchDevice]);

  const sync = useCallback((r: Room) => {
    setLocalParticipant(r.localParticipant);
    setRemoteParticipants(Array.from(r.remoteParticipants.values()));
    humanTranscriptRef.current?.syncMicrophone(
      r.localParticipant.isMicrophoneEnabled,
    );
    setVersion((v) => v + 1);
  }, []);

  // Attach a remote screen-share audio track to the hidden global sink so it is
  // audible in EVERY view mode (incl. compact/audio-only, which render no tile).
  // No-op if a tile has claimed it or it's already sinked.
  const attachScreenAudioToSink = useCallback(
    (track: RemoteTrack) => {
      const sid = track.sid;
      if (!sid) return;
      if (claimedScreenAudio.current.has(sid)) return; // a tile owns it
      if (screenSinkEls.current.has(sid)) return; // already sinked
      const el = track.attach();
      el.setAttribute("data-lk-audio-sink", "screen");
      el.style.display = "none";
      document.body.appendChild(el);
      void setElementSink(el, selectedDevices.audiooutput).catch(console.error);
      screenSinkEls.current.set(sid, el);
    },
    [selectedDevices.audiooutput],
  );

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
    // Hanging up while your call is still ringing IS cancelling it. Before
    // this the card kept pulsing "Calling…" every 2.4 s — and the callee's
    // devices kept ringing — for the rest of the 45 s window after you left.
    void useOutgoingCallStore.getState().cancelActive();
    // Capture call room before we clear activeCallRoomId so export knows where
    // to POST. Hang-up is the natural finalize point for "Send to Meeting-Ops".
    const callRoomId = useCallUiStore.getState().activeCallRoomId;
    roomRef.current = null;
    connectingRef.current = false;

    // Stop browser STT before tearing the room down.
    try {
      humanTranscriptRef.current?.stop();
    } catch {
      /* ignore */
    }
    humanTranscriptRef.current = null;

    // Submit final caption lines without blocking LiveKit teardown. Once the
    // Stable API accepts this request its durable server outbox owns delivery,
    // retries, and recovery; the browser never calls Meeting-Ops directly.
    void (async () => {
      try {
        const ui = useCallUiStore.getState();
        if (!ui.sendToMeetingOps || !callRoomId) return;
        const finals = ui.transcript.filter((l) => l.isFinal && l.text.trim());
        if (finals.length === 0) return;
        const roomMeta = useAppStore
          .getState()
          .rooms.find((rm) => rm.id === callRoomId);
        await api.exportCallTranscript(callRoomId, {
          lines: finals.map((l) => ({
            participant_id: l.participantId,
            name: l.name,
            text: l.text,
            ts: l.ts,
            is_final: true,
            segment_id: l.id,
            source: l.source || "unknown",
          })),
          room_name: roomMeta?.display_name || roomMeta?.name || null,
          call_started_at: ui.callStartedAt
            ? new Date(ui.callStartedAt).toISOString()
            : null,
          call_ended_at: new Date().toISOString(),
          send_to_meeting_ops: true,
          label: roomMeta
            ? `Stable call · ${roomMeta.display_name || roomMeta.name}`
            : "Stable call",
        });
      } catch (e) {
        console.warn("call transcript export on hang-up failed", e);
      }
    })();

    if (r) {
      // Only a live (connected) room earns the hang-up cue — tearing down a
      // failed/stale room object must stay silent.
      if (r.state === ConnectionState.Connected) playCue("call-leave");
      // Silence this room's events BEFORE tearing it down. LiveKit emits
      // Disconnected/ConnectionStateChanged asynchronously (after its internal
      // close() awaits), so if we immediately start a NEW call (End→Start, or a
      // call-switch) those late events from the OLD room would run their still-
      // attached handlers and flip the LIVE call's UI state off — leaving an
      // invisible, uncontrollable call. We do the teardown manually below, so
      // the room's own events are redundant here anyway.
      r.removeAllListeners();
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
    audioSessionRestore.current?.();
    audioSessionRestore.current = null;
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

  const repairingAudio = useRef(false);
  const repairAudio = useCallback(async () => {
    const active = roomRef.current;
    if (
      !active ||
      active.state !== ConnectionState.Connected ||
      repairingAudio.current
    )
      return;
    repairingAudio.current = true;
    try {
      await recoverCallAudio(active, Track.Source.Microphone);
      if (active.localParticipant.isMicrophoneEnabled) {
        setSelectedDevices((current) => ({ ...current, audioinput: "default" }));
      }
      setVersion((v) => v + 1);
      setAudioBlocked(!active.canPlaybackAudio);
    } catch {
      useAppStore
        .getState()
        .pushToast({
          title: "Audio needs attention",
          body: "Check the phone's audio route, then tap Repair audio.",
          kind: "error",
        });
    } finally {
      repairingAudio.current = false;
    }
  }, []);

  useEffect(() => {
    if (!room) return;
    const restore = audioSessionRestore.current ?? enterDuplexSession();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recover = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void repairAudio(), 350);
    };
    const visible = () => {
      if (document.visibilityState === "visible") recover();
    };
    navigator.mediaDevices?.addEventListener("devicechange", recover);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pageshow", recover);
    return () => {
      clearTimeout(timer);
      restore();
      navigator.mediaDevices?.removeEventListener("devicechange", recover);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pageshow", recover);
    };
  }, [room, repairAudio]);

  const join = useCallback(async (overrides?: JoinOverrides): Promise<boolean> => {
    const roomId = useAppStore.getState().activeRoomId;
    if (!roomId || connectingRef.current) return false;
    // Deep-link / immediate-join choices arrive as ids; they win over the
    // (possibly stale-in-closure) selected state for THIS join.
    const chosen = {
      audioinput: overrides?.audioinput ?? selectedDevices.audioinput,
      videoinput: overrides?.videoinput ?? selectedDevices.videoinput,
    };
    const leftover = roomRef.current;
    if (leftover) {
      if (leftover.state !== ConnectionState.Disconnected) {
        // Already in a LIVE call. The call now PERSISTS across navigation, so
        // being connected no longer means "connect() for the current view" —
        // it might be a call still running in another room. If it's THIS room's
        // call, nothing to do. If it's a different room, this connect() is an
        // explicit call-switch (you can only be in one LiveKit room): tear the
        // old call down, then fall through to join the new one.
        if (useCallUiStore.getState().activeCallRoomId === roomId) return true;
        disconnect();
      } else {
        // A room object left behind by a just-ended call must not brick the
        // Start-call button (the "hang up, immediately call again → click
        // silently ignored" trap) — clear it and connect fresh.
        console.warn("voice connect: clearing stale disconnected room");
        roomRef.current = null;
      }
    }
    connectingRef.current = true;
    setIsConnecting(true);
    setError(null);

    try {
      const { token, ws_url } = await api.getLiveKitToken(roomId);

      const r = new Room({
        // Adaptive stream YES, background pause NO. livekit keys "background"
        // off the MAIN document's visibility only and exempts nothing but
        // element-PiP / Document-PiP — a feed popped out via window.open
        // froze the instant the opener tab was hidden (the normal way a
        // second-monitor pop-out is used), while PiP of the same track kept
        // playing. Per-element resolution adaptation and viewport-visibility
        // pausing still apply (cross-window IO/RO verified working); we only
        // drop the opener-tab-hidden pause, which can't see our windows.
        adaptiveStream: { pauseVideoInBackground: false },
        dynacast: true,
        audioCaptureDefaults: {
          deviceId: chosen.audioinput || undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        videoCaptureDefaults: {
          deviceId: chosen.videoinput || undefined,
        },
      });
      roomRef.current = r;
      joinCuePlayedRef.current = false;

      // Ownership guard for every handler below. LiveKit events are delivered
      // asynchronously, so a Room that has been SUPERSEDED — a call-switch, a
      // terminal teardown, or an abandoned failed connect (whose listeners
      // survive `roomRef.current = null`) — can still fire long after. Letting
      // a stale room's Disconnected/ConnectionStateChanged run these handlers
      // clobbered the LIVE call's state (isConnected → false with nothing to
      // flip it back until the next state change), which wrongly hid the
      // CallDock and CallRoomLayout while audio kept playing: an invisible,
      // uncontrollable call. Events from anything but the CURRENT room are
      // dropped wholesale.
      const own =
        <A extends unknown[]>(fn: (...args: A) => void) =>
        (...args: A): void => {
          if (roomRef.current !== r) return;
          fn(...args);
        };

      const onState = () => {
        setIsConnected(r.state === ConnectionState.Connected);
        setIsConnecting(
          r.state === ConnectionState.Connecting ||
            r.state === ConnectionState.Reconnecting,
        );
        sync(r);
      };

      r.on(RoomEvent.Connected, own(onState))
        // Join chime: once per connect (ref-guarded), never on reconnects.
        .on(
          RoomEvent.Connected,
          own(() => {
            if (joinCuePlayedRef.current) return;
            joinCuePlayedRef.current = true;
            playCue("call-join");
          }),
        )
        .on(RoomEvent.Reconnected, own(onState))
        .on(
          RoomEvent.Reconnecting,
          own(() => setIsConnecting(true)),
        )
        .on(RoomEvent.ConnectionStateChanged, own(onState))
        .on(
          RoomEvent.Disconnected,
          own((reason?: DisconnectReason) => {
            // DUPLICATE_IDENTITY = this same person joined the call from
            // ANOTHER device, and LiveKit handed the identity over — a device
            // handoff, not a failure. Tear this leg down fully (disconnect()
            // also flushes the transcript export this leg accumulated) and say
            // what happened; the call button is the move-it-back affordance
            // (the server answers a re-ring of a live call with `in_call` →
            // plain join).
            if (isMovedToAnotherDevice(reason)) {
              disconnect();
              useAppStore.getState().pushToast(MOVED_TO_ANOTHER_DEVICE_TOAST);
              return;
            }
            // Any other Disconnected is TERMINAL for this leg (LiveKit emits
            // Reconnecting for transient drops). The old code only flipped
            // isConnected/voiceActive here, which wedged the rest of the call
            // state: `activeCallRoomId` stayed pointed at a dead call forever
            // (so the NEXT call in the same room skipped setActiveCallRoom's
            // per-call reset), the browser-STT session kept the mic hot, and
            // the accumulated transcript was never flushed. Run the one true
            // teardown instead — it is what an explicit hang-up runs.
            disconnect();
          }),
        )
        .on(
          RoomEvent.ParticipantConnected,
          own(() => sync(r)),
        )
        .on(
          RoomEvent.ParticipantDisconnected,
          own(() => sync(r)),
        )
        .on(
          RoomEvent.LocalTrackPublished,
          own((publication) => {
            const mediaTrack = publication.track?.mediaStreamTrack;
            if (mediaTrack) {
              const label =
                publication.kind === Track.Kind.Video ? "Camera" : "Microphone";
              const kind =
                publication.kind === Track.Kind.Video
                  ? "videoinput"
                  : "audioinput";
              const dead = () => {
                setDeviceSignal((current) => ({ ...current, [kind]: false }));
                useAppStore
                  .getState()
                  .pushToast({
                    title: `${label} has no signal`,
                    body: "Stable is trying to reacquire an available device.",
                  });
              };
              mediaTrack.addEventListener("mute", dead);
              mediaTrack.addEventListener("ended", dead);
              mediaTrack.addEventListener("unmute", () =>
                setDeviceSignal((current) => ({ ...current, [kind]: true })),
              );
            }
            sync(r);
          }),
        )
        .on(
          RoomEvent.LocalTrackUnpublished,
          own(() => sync(r)),
        )
        .on(
          RoomEvent.TrackMuted,
          own(() => sync(r)),
        )
        .on(
          RoomEvent.TrackUnmuted,
          own(() => sync(r)),
        )
        // The core SDK does NOT auto-play remote audio — attach it ourselves so
        // the agent/peers are audible. Video is attached by the tiles in
        // VoiceVideoBar. Screen-share audio is a special case (see below).
        .on(
          RoomEvent.TrackSubscribed,
          own((track: RemoteTrack) => {
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
                void setElementSink(el, selectedDevices.audiooutput).catch(
                  console.error,
                );
              }
            }
            sync(r);
          }),
        )
        .on(
          RoomEvent.TrackUnsubscribed,
          own((track: RemoteTrack) => {
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
          }),
        )
        .on(
          RoomEvent.AudioPlaybackStatusChanged,
          own(() => {
            setAudioBlocked(!r.canPlaybackAudio);
          }),
        )
        // Room data channel: transcript lines + agent UI commands. Transcript
        // packets feed the live-transcript panel; ui_command packets drive the
        // call UI but ONLY when the sender is an agent (the AG-UI seam).
        .on(
          RoomEvent.DataReceived,
          own((payload: Uint8Array, participant?: RemoteParticipant) => {
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
              const bound = bindTranscriptSender(r, participant, msg);
              if (!bound) return;
              useCallUiStore.getState().ingestTranscript(bound);
              return;
            }
            if (msg.type === "ui_command") {
              // Gate: only AI agents may drive the interface. A human peer's
              // ui_command is dropped.
              if (!isAgentParticipant(participant)) return;
              dispatchUiCommand(msg, roomId);
              return;
            }
            // Voice-relay frames. Legitimate ones are published by the SERVER
            // (gateway /talk-gate, rooms /voice-settings), which arrives with
            // NO participant; an agent worker re-broadcasting is also fine. A
            // human browser fabricating them is not — same trust stance as
            // ui_command, so gate on "not a human sender".
            if (msg.type === "talk_gate") {
              if (participant && !isAgentParticipant(participant)) return;
              dispatchTalkGate(msg);
              return;
            }
            if (msg.type === "relay_config") {
              if (participant && !isAgentParticipant(participant)) return;
              applyRelayConfigToRoomQueries(queryClient, roomId, msg.activation);
              return;
            }
          }),
        );

      // Tell the imperative uiCommandBus which room agent commands apply to
      // (it runs outside React, so it can't read the active room itself).
      setActiveCallRoom(roomId);
      // Seed Meeting-Ops session toggle from the "always by default" pref and
      // clear any leftover captions from a prior call.
      useCallUiStore.getState().beginCallTranscriptSession();

      audioSessionRestore.current?.();
      audioSessionRestore.current = enterDuplexSession();
      await r.connect(ws_url, token);
      setRoom(r);
      setVoiceActive(true);

      // Speaker-owned human captions. Every browser labels its own local mic;
      // the linked-agent STT remains a deduplicated quality/fallback source.
      // Re-evaluate on participant churn in case the recognition engine ended
      // while the browser changed audio devices.
      try {
        humanTranscriptRef.current?.stop();
      } catch {
        /* ignore */
      }
      const humanSession = new HumanTranscriptSession(r);
      humanTranscriptRef.current = humanSession;
      // Web Speech opens a second, browser-owned microphone and exposes no
      // deviceId constraint. Do not secretly capture the OS default when the
      // caller deliberately selected another input; agent STT remains active.
      const browserSttCanFollowInput =
        !chosen.audioinput || chosen.audioinput === "default";
      if (browserSttCanFollowInput) {
        humanSession.start();
        r.on(
          RoomEvent.ParticipantConnected,
          own(() => humanSession.reevaluate()),
        );
        r.on(
          RoomEvent.ParticipantDisconnected,
          own(() => humanSession.reevaluate()),
        );
      } else {
        useAppStore.getState().pushToast({
          title: "Browser captions paused",
          body: "Web Speech cannot follow a selected microphone. Call audio still uses your chosen input.",
        });
      }
      // Pause local Web Speech when a remote human is the active speaker so
      // their audio through speakers is not captioned as the local user.
      r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        try {
          const localId = r.localParticipant?.identity;
          const localSpeaking = speakers.some((s) => s.identity === localId);
          const remoteHumanSpeaking = speakers.some(
            (s) => s.identity !== localId && !isAgentParticipant(s),
          );
          humanSession.setRemoteDominant(remoteHumanSpeaking && !localSpeaking);
        } catch {
          /* ignore */
        }
      });

      // Publish the human's mic so the agent can hear them. Do NOT await — the
      // mic-permission prompt would otherwise block the agent dispatch below
      // (and the dispatch must fire whether or not the human grants the mic).
      void r.localParticipant
        .setMicrophoneEnabled(true)
        .catch((e) =>
          console.error("failed to enable microphone on call start", e),
        );

      // Deep link `video=1`: camera on from the first frame. Same
      // fire-and-forget shape as the mic — a denied camera must not stall the
      // agent dispatch below.
      if (overrides?.video) {
        void r.localParticipant.setCameraEnabled(true).catch((e) => {
          // Still a call — say why it's voice-only instead of failing silently.
          console.error("failed to enable camera on call start", e);
          const name = e instanceof Error ? e.name : "";
          useAppStore.getState().pushToast({
            title: "Camera didn't start",
            body:
              name === "NotAllowedError"
                ? "Camera access is blocked for this site. You're in the call with audio only."
                : name === "NotFoundError"
                  ? "No camera was found. You're in the call with audio only."
                  : "You're in the call with audio only. Try the camera button in the call bar.",
          });
        });
      }

      // Best-effort unblock of remote-audio playback; if the browser still
      // blocks it (mobile), audioBlocked drives the tap-to-hear prompt.
      void startAudio();

      // Dispatch EVERY Brigade agent resident in the room into the call, not
      // just the canonical one. Workers join under per-agent LiveKit
      // identities now (`agent-majik`, `agent-the-general`), so several can
      // hold one room instead of the second evicting the first; a room with a
      // single resident dispatches exactly one agent, exactly as before.
      // A failed dispatch must never break the human's call.
      const inviteAgents = async (): Promise<number> => {
        const detail = await api.getRoom(roomId);
        const agentIds = residentAgentIds(detail);
        if (!agentIds.length) return 0;
        // Honor the per-room model override (mid-conversation switcher) for
        // the voice agents too, so they use the same chosen LLM.
        const model = useAppStore.getState().modelOverrides[roomId];
        let joined = 0;
        let lastError: unknown = null;
        for (const agentId of agentIds) {
          try {
            await api.inviteBrigadeAgent(roomId, agentId, model);
            joined += 1;
          } catch (e) {
            lastError = e;
            console.error("agent dispatch failed", agentId, e);
          }
        }
        // Only a TOTAL failure is the call's failure. One agent the caller
        // isn't entitled to must not silence the ones they are, nor stop the
        // self-heal poll below.
        if (joined === 0 && lastError !== null) throw lastError;
        return agentIds.length;
      };
      // Optimistic default: if the invite itself failed we still want the
      // self-heal loop below (it no-ops for rooms without a resident agent).
      let roomHasAgent = true;
      let expectedAgents = 1;
      try {
        expectedAgents = await inviteAgents();
        roomHasAgent = expectedAgents > 0;
      } catch (e) {
        console.error("failed to dispatch agent into voice call", e);
        if (isEntitlementDenial(e)) {
          // The server's per-user agent gate said no. The human's call is
          // fine (someone else in the room may be entitled to summon the
          // agent) — but toast why THEIR agent won't join, and don't let the
          // self-heal loop re-hit the same 403 every few seconds.
          roomHasAgent = false;
          useAppStore.getState().pushToast({
            title: "Agent can't join this call",
            body: apiErrorText(e, "You don't have access to this agent."),
            kind: "error",
          });
        }
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
            // Count, don't just test for one: in a multi-agent room the first
            // agent being present says nothing about the second, and "some
            // agent is here" would have declared the call healed with three of
            // four missing. The server's per-agent presence check makes the
            // re-invite a no-op for the ones that DID make it.
            const agentCount = Array.from(
              cur.remoteParticipants.values(),
            ).filter((p) => isAgentParticipant(p)).length;
            if (agentCount >= expectedAgents) return;
            console.warn(
              `voice call has ${agentCount}/${expectedAgents} agents after ${attempt * 4}s — re-inviting`,
            );
            try {
              await inviteAgents();
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
      // Full teardown through the ONE hang-up path, not ad-hoc flag clearing.
      // The old cleanup nulled roomRef but left the failed Room's listeners
      // attached (a late async Disconnected from it could then clobber a LATER
      // call's state) and left `activeCallRoomId` pointing at a room that
      // never got its call — setActiveCallRoom(roomId) runs BEFORE the await
      // above — so every activeCallRoomId consumer believed a call was live
      // here, and the next call in this room skipped its per-call reset.
      // disconnect() detaches the listeners, resets all of it, and is a no-op
      // for the parts a pre-connect failure never set up.
      disconnect();
      setError(message);
      // Nothing renders `error` inline yet — without a toast a failed connect
      // is a silently dead Start-call button. Keep the state for future inline
      // surfaces; the toast is the user-visible signal today.
      useAppStore.getState().pushToast({
        title: "Couldn't start the call",
        body: message,
      });
      return false;
    }
    connectingRef.current = false;
    return true;
  }, [
    setVoiceActive,
    sync,
    startAudio,
    disconnect,
    attachScreenAudioToSink,
    detachScreenAudioFromSink,
    selectedDevices.audioinput,
    selectedDevices.videoinput,
    selectedDevices.audiooutput,
    queryClient,
  ]);

  /**
   * Turn deep-link `mic` / `cam` (id OR label) into device ids, unlocking
   * labels with a one-shot permission probe when the browser has not shown
   * them yet. A miss falls back to what the app would have used anyway and
   * says so in a toast — a call on the wrong mic is fixable in one click
   * from the call bar; no call is not.
   */
  const resolveOverrides = useCallback(
    async (opts?: ConnectOptions): Promise<JoinOverrides> => {
      const overrides: JoinOverrides = { video: opts?.video };
      if (!opts?.mic && !opts?.cam) return overrides;
      if (!navigator.mediaDevices?.enumerateDevices) return overrides;

      let all = await navigator.mediaDevices.enumerateDevices();
      const wantedKinds = (
        [
          ["audioinput", opts.mic],
          ["videoinput", opts.cam],
        ] as const
      ).filter(([, want]) => !!want);
      // Labels are blank until a media permission has been granted. If any
      // wanted device fails to match on ids alone, ask once, then re-read.
      const idsOnlyMiss = wantedKinds.some(
        ([kind, want]) =>
          !matchDevice(all.filter((d) => d.kind === kind), want),
      );
      if (idsOnlyMiss && all.some((d) => !d.label)) {
        try {
          const probe = await navigator.mediaDevices.getUserMedia({
            audio: !!opts.mic,
            video: !!opts.cam,
          });
          probe.getTracks().forEach((t) => t.stop());
        } catch {
          // Denied — match against whatever labels we have.
        }
        all = await navigator.mediaDevices.enumerateDevices();
      }
      await refreshDevices();

      const userId = useAppStore.getState().currentUser?.id;
      for (const [kind, want] of wantedKinds) {
        const pool = all.filter((d) => d.kind === kind);
        const hit = matchDevice(pool, want);
        const noun = kind === "audioinput" ? "Mic" : "Camera";
        if (hit) {
          overrides[kind] = hit.deviceId;
          setSelectedDevices((current) => ({ ...current, [kind]: hit.deviceId }));
          saveDevicePreference(userId, kind, hit.deviceId);
        } else {
          const fallbackId =
            kind === "audioinput"
              ? pickAudioInputDevice(pool, readDevicePreferences(userId).audioinput)
              : readDevicePreferences(userId).videoinput || pool[0]?.deviceId || "";
          const fallback = pool.find((d) => d.deviceId === fallbackId);
          useAppStore.getState().pushToast({
            title: `${noun} "${want}" not found`,
            body: fallback
              ? `Using ${fallback.label || "the default " + noun.toLowerCase()} instead.`
              : `No ${noun.toLowerCase()} is available; joining without one.`,
          });
        }
      }
      return overrides;
    },
    [refreshDevices],
  );

  const connect = useCallback(
    async (opts?: ConnectOptions): Promise<boolean> => {
      const active = roomRef.current;
      if (
        active &&
        active.state !== ConnectionState.Disconnected &&
        useCallUiStore.getState().activeCallRoomId ===
          useAppStore.getState().activeRoomId
      )
        return true;
      await refreshDevices();
      const entry = resolveCallEntry(opts, callPrefs);
      const overrides = await resolveOverrides({ ...opts, video: entry.video });
      // Voice calls NEVER stop here; video calls only when the user asked.
      if (entry.skipDeviceCheck) return join(overrides);

      // Pre-join check. The promise settles on Join (→ the join's own
      // outcome) or Cancel (false) — so a caller can ring only once we are
      // genuinely on the line, and ring nobody when the user backs out.
      pendingConnectRef.current?.resolve(false);
      return new Promise<boolean>((resolve) => {
        pendingConnectRef.current = { resolve, overrides };
        setDeviceCheckKind(entry.kind);
        setShowDeviceCheck(true);
      });
    },
    [refreshDevices, resolveOverrides, join, callPrefs],
  );

  // NOTE: the call intentionally PERSISTS across navigation now. We used to
  // disconnect whenever `activeRoomId` changed (leaving/switching rooms ended
  // the call) — that's exactly the "navigating off a room kicks you out of the
  // call" behavior. The call surface is now keyed off `activeCallRoomId`
  // (callUiStore), so the full call UI shows only in the call's own room and a
  // floating CallDock covers every other view; the LiveKit Room stays live
  // until the user explicitly hangs up (or an explicit call-switch — see
  // connect() above — or this provider unmounts).

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
        callPrefs,
        setCallPrefs,
        disconnect,
        startAudio,
        repairAudio,
        claimScreenAudio,
        releaseScreenAudio,
        devices,
        selectedDevices,
        refreshDevices,
        switchDevice,
        deviceSignal,
      }}
    >
      {children}
      {showDeviceCheck && (
        <DeviceCheckDialog
          kind={deviceCheckKind}
          devices={devices}
          selected={selectedDevices}
          onSelect={switchDevice}
          onRefresh={refreshDevices}
          onJoinAudioOnly={() => {
            // The camera failed or the user waved it off: still a call.
            setShowDeviceCheck(false);
            const pending = pendingConnectRef.current;
            pendingConnectRef.current = null;
            void join({ video: false }).then(
              (joined) => pending?.resolve(joined),
              () => pending?.resolve(false),
            );
          }}
          onCancel={() => {
            setShowDeviceCheck(false);
            const pending = pendingConnectRef.current;
            pendingConnectRef.current = null;
            pending?.resolve(false);
          }}
          onJoin={() => {
            setShowDeviceCheck(false);
            const pending = pendingConnectRef.current;
            pendingConnectRef.current = null;
            // The dialog's own picks were applied through switchDevice, so
            // only the deep-link `video` flag still rides on the overrides.
            void join({ video: pending?.overrides.video }).then(
              (joined) => pending?.resolve(joined),
              () => pending?.resolve(false),
            );
          }}
        />
      )}
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
