/**
 * The guest's video stage: the one room's call, and nothing around it.
 *
 * A guest is a guest ON the show, so this is the surface the whole feature
 * exists for. It is a deliberately small sibling of VoiceVideoBar rather than a
 * reuse of it: that component reads the app store (rooms, agents, brigade
 * personas, call-UI preferences, pop-outs, PiP, transcripts) and a guest has
 * none of those. Only `VideoGrid` is shared, because it is pure layout that
 * takes already-built tile nodes.
 *
 * TWO THINGS THE SERVER DECIDES AND THIS FILE ONLY REFLECTS:
 *
 *  1. PUBLISH. `can_publish` comes off the INVITE, and the LiveKit grant is
 *     built from it server-side. A watch-only guest gets no camera controls
 *     here, and would be refused by LiveKit even if they did.
 *  2. LIFETIME. The guest's LiveKit token is clamped to their session's expiry
 *     (api/tokens.py), so a revoked guest cannot keep publishing on a token
 *     that outlived their credential.
 *
 * On an unexpected disconnect we MINT A FRESH TOKEN before reconnecting rather
 * than resuming with the one in hand: by the time a drop is over, the old token
 * may be past the clamp, and a resume with a stale token fails in a way that
 * looks exactly like "the guest's camera just stopped working".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LocalVideoTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteAudioTrack,
} from "livekit-client";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import clsx from "clsx";
import { VideoGrid, type VideoTileItem } from "@/components/Room/VideoGrid";
import { guestReconnectDelayMs, isGuestCallIdentity, type GuestSession } from "@/lib/guest";
import {
  GuestSessionEnded,
  getGuestLiveKitToken,
  type GuestRoomMember,
} from "@/services/guestApi";
import { GuestBadge, NameDisc } from "./GuestChrome";

interface GuestVideoStageProps {
  session: GuestSession;
  members: GuestRoomMember[];
  /** The credential stopped authenticating — the shell goes terminal. */
  onSessionEnded: () => void;
}

interface Tile {
  key: string;
  /** LiveKit identity — the join key back to the roster for the Guest badge. */
  identity: string;
  name: string;
  video: RemoteVideoTrack | LocalVideoTrack | null;
  audio: RemoteAudioTrack | null;
  muted: boolean;
  speaking: boolean;
  isLocal: boolean;
}

function TileView({
  tile,
  members,
}: {
  tile: Tile;
  members: GuestRoomMember[];
}) {
  const attach = useCallback(
    (el: HTMLVideoElement | null) => {
      const track = tile.video;
      if (el && track) {
        track.attach(el);
        return () => {
          track.detach(el);
        };
      }
    },
    [tile.video],
  );
  const attachAudio = useCallback(
    (el: HTMLAudioElement | null) => {
      const track = tile.audio;
      if (el && track) {
        track.attach(el);
        return () => {
          track.detach(el);
        };
      }
    },
    [tile.audio],
  );

  // Badge from the ROSTER's participant_type, joined on the LiveKit identity —
  // a LiveKit token carries no guest marker, and a `guest-` username prefix is
  // an identity detail, not a claim about access.
  const isGuest = isGuestCallIdentity(tile.identity, members);

  return (
    <div
      className={clsx(
        "relative h-full w-full overflow-hidden rounded-xl bg-slate-950 ring-1",
        tile.speaking ? "ring-stable-mint" : "ring-white/[0.06]",
      )}
    >
      {tile.video ? (
        <video
          ref={attach}
          autoPlay
          playsInline
          // The local preview must be muted or the guest hears themselves.
          muted={tile.isLocal}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="grid h-full w-full place-items-center">
          <NameDisc name={tile.name} id={tile.identity} size={64} />
        </div>
      )}
      {!tile.isLocal && tile.audio && <audio ref={attachAudio} autoPlay />}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-white">
          {tile.name}
          {tile.isLocal && <span className="ml-1 text-white/50">(you)</span>}
        </span>
        {isGuest && <GuestBadge />}
        {tile.muted && <MicOff className="h-3.5 w-3.5 shrink-0 text-rose-300" />}
      </div>
    </div>
  );
}

export function GuestVideoStage({
  session,
  members,
  onSessionEnded,
}: GuestVideoStageProps) {
  const roomRef = useRef<Room | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [connected, setConnected] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    /** Bumped before each connect attempt so a superseded session's events —
     *  including the disconnect our own replacement causes — are no-ops. */
    let generation = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let room: Room | null = null;

    function collect(current: Room, gen: number) {
      if (disposed || gen !== generation) return;
      const speakers = new Set(current.activeSpeakers.map((p) => p.identity));
      const next: Tile[] = [];

      const local = current.localParticipant;
      const localCam = local.getTrackPublication(Track.Source.Camera);
      const localMic = local.getTrackPublication(Track.Source.Microphone);
      // The local tile only appears once there is something to show; a
      // watch-only guest never publishes and never gets one.
      if (localCam?.track || localMic?.track) {
        next.push({
          key: `local:${local.identity}`,
          identity: local.identity,
          name: session.displayName,
          video:
            localCam?.track instanceof LocalVideoTrack && !localCam.isMuted
              ? localCam.track
              : null,
          audio: null,
          muted: !localMic?.track || localMic.isMuted,
          speaking: speakers.has(local.identity),
          isLocal: true,
        });
      }

      for (const participant of current.remoteParticipants.values()) {
        const cam = participant.getTrackPublication(Track.Source.Camera);
        const screen = participant.getTrackPublication(Track.Source.ScreenShare);
        const mic = participant.getTrackPublication(Track.Source.Microphone);
        const videoPub = screen?.track ? screen : cam;
        next.push({
          key: participant.identity,
          identity: participant.identity,
          name: participant.name || participant.identity,
          video:
            videoPub?.track instanceof RemoteVideoTrack && !videoPub.isMuted
              ? videoPub.track
              : null,
          audio: (mic?.track as RemoteAudioTrack | undefined) ?? null,
          muted: !mic?.track || mic.isMuted,
          speaking: speakers.has(participant.identity),
          isLocal: false,
        });
      }
      setTiles(next);
    }

    async function cycle() {
      if (disposed) return;
      const gen = ++generation;
      let grant;
      try {
        grant = await getGuestLiveKitToken(
          session.token,
          session.roomId,
          session.displayName,
        );
      } catch (error) {
        if (disposed || gen !== generation) return;
        if (error instanceof GuestSessionEnded) {
          // The credential is gone. Nothing to retry — the shell is about to
          // go terminal anyway.
          onSessionEnded();
          return;
        }
        attempt += 1;
        retry = setTimeout(() => void cycle(), guestReconnectDelayMs(attempt));
        return;
      }
      if (disposed || gen !== generation) return;

      const next = new Room({ adaptiveStream: true, dynacast: true });
      const sync = () => collect(next, gen);
      next
        .on(RoomEvent.ParticipantConnected, sync)
        .on(RoomEvent.ParticipantDisconnected, sync)
        .on(RoomEvent.TrackSubscribed, sync)
        .on(RoomEvent.TrackUnsubscribed, sync)
        .on(RoomEvent.TrackPublished, sync)
        .on(RoomEvent.TrackUnpublished, sync)
        .on(RoomEvent.TrackMuted, sync)
        .on(RoomEvent.TrackUnmuted, sync)
        .on(RoomEvent.LocalTrackPublished, sync)
        .on(RoomEvent.LocalTrackUnpublished, sync)
        .on(RoomEvent.ActiveSpeakersChanged, sync)
        .on(RoomEvent.Reconnected, sync)
        .on(RoomEvent.Disconnected, () => {
          if (disposed || gen !== generation) return;
          setConnected(false);
          setTiles([]);
          attempt += 1;
          // Re-mint rather than resume: the guest's token is clamped to their
          // session expiry, so the one in hand may already be past it.
          retry = setTimeout(() => void cycle(), guestReconnectDelayMs(attempt));
        });

      try {
        await next.connect(grant.ws_url, grant.token);
      } catch {
        if (disposed || gen !== generation) return;
        attempt += 1;
        retry = setTimeout(() => void cycle(), guestReconnectDelayMs(attempt));
        return;
      }
      if (disposed || gen !== generation) {
        void next.disconnect();
        return;
      }
      attempt = 0;
      room = next;
      roomRef.current = next;
      setConnected(true);
      collect(next, gen);
    }

    void cycle();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      roomRef.current = null;
      if (room) void room.disconnect();
    };
  }, [session.token, session.roomId, session.displayName, onSessionEnded]);

  const toggle = useCallback(
    async (kind: "camera" | "mic") => {
      const room = roomRef.current;
      if (!room || !session.canPublish) return;
      setDeviceError(null);
      try {
        if (kind === "camera") {
          const next = !cameraOn;
          await room.localParticipant.setCameraEnabled(next);
          setCameraOn(next);
        } else {
          const next = !micOn;
          await room.localParticipant.setMicrophoneEnabled(next);
          setMicOn(next);
        }
      } catch {
        // Permission denied, no device, or a device already in use by another
        // app. Say so — a control that silently does nothing is worse than one
        // that explains itself, and this is the single most common thing to go
        // wrong for a guest on someone else's laptop.
        setDeviceError(
          kind === "camera"
            ? "Couldn't start your camera. Check the browser's camera permission."
            : "Couldn't start your microphone. Check the browser's mic permission.",
        );
      }
    },
    [cameraOn, micOn, session.canPublish],
  );

  const items: VideoTileItem[] = tiles.map((tile) => ({
    key: tile.key,
    node: <TileView tile={tile} members={members} />,
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="min-h-0 flex-1">
        {items.length > 0 ? (
          <VideoGrid items={items} className="h-full" />
        ) : (
          <div className="grid h-full min-h-40 place-items-center rounded-xl border border-white/[0.06] bg-slate-950/40 text-xs text-slate-500">
            {connected
              ? "Nobody is on camera yet."
              : "Connecting to the room…"}
          </div>
        )}
      </div>

      {deviceError && (
        <p role="alert" className="text-[11px] text-rose-300">
          {deviceError}
        </p>
      )}

      {session.canPublish ? (
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => void toggle("mic")}
            disabled={!connected}
            aria-pressed={micOn}
            className={clsx(
              "focus-ring inline-flex min-h-10 items-center gap-2 rounded-full px-4 py-2 text-xs font-medium transition-colors disabled:opacity-40",
              micOn
                ? "bg-stable-purple text-white"
                : "bg-white/[0.06] text-slate-300 hover:bg-white/[0.1]",
            )}
          >
            {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
            {micOn ? "Mic on" : "Mic off"}
          </button>
          <button
            type="button"
            onClick={() => void toggle("camera")}
            disabled={!connected}
            aria-pressed={cameraOn}
            className={clsx(
              "focus-ring inline-flex min-h-10 items-center gap-2 rounded-full px-4 py-2 text-xs font-medium transition-colors disabled:opacity-40",
              cameraOn
                ? "bg-stable-purple text-white"
                : "bg-white/[0.06] text-slate-300 hover:bg-white/[0.1]",
            )}
          >
            {cameraOn ? (
              <Video className="h-4 w-4" />
            ) : (
              <VideoOff className="h-4 w-4" />
            )}
            {cameraOn ? "Camera on" : "Camera off"}
          </button>
        </div>
      ) : (
        // Watch-only. Say so rather than showing dead controls: the invite was
        // minted without publish and no client-side toggle can change that.
        <p className="text-center text-[11px] text-slate-500">
          You&rsquo;re watching only — this invite doesn&rsquo;t include camera
          or microphone.
        </p>
      )}
    </div>
  );
}

export default GuestVideoStage;
