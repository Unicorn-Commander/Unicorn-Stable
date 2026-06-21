import { useMemo, useCallback } from "react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, Volume2, Bot, MonitorUp } from "lucide-react";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import { useStableRoom } from "@/hooks/useStableRoom";
import { api, type BrigadeAgent } from "@/services/api";

interface VoiceVideoBarProps {
  roomId: string;
}

interface ParticipantTileProps {
  name: string;
  isAgent: boolean;
  isSpeaking: boolean;
  isMuted: boolean;
  avatarUrl?: string | null;
  videoRef?: (el: HTMLVideoElement | null) => void;
  hasVideo: boolean;
}

function ParticipantTile({
  name,
  isAgent,
  isSpeaking,
  isMuted,
  avatarUrl,
  videoRef,
  hasVideo,
}: ParticipantTileProps) {
  const initial = name.charAt(0).toUpperCase();

  return (
    <div
      className={clsx(
        "relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-slate-800/60 transition-all",
        isSpeaking
          ? "ring-2 ring-green-500/60"
          : "ring-1 ring-slate-700/50",
      )}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full rounded-lg object-cover"
        />
      ) : avatarUrl ? (
        <img
          src={avatarUrl}
          alt={name}
          className={clsx(
            "h-14 w-14 rounded-full object-cover sm:h-16 sm:w-16",
            isAgent && "ring-1 ring-stable-cyan/30",
          )}
        />
      ) : (
        <div
          className={clsx(
            "flex h-14 w-14 items-center justify-center rounded-full text-lg font-semibold sm:h-16 sm:w-16",
            isAgent
              ? "bg-stable-cyan/20 text-stable-cyan"
              : "bg-stable-purple/20 text-stable-purple-light",
            isSpeaking && "animate-pulse-soft",
          )}
        >
          {isAgent ? <Bot className="h-7 w-7" /> : initial}
        </div>
      )}

      {/* Name plate, bottom-left, readable over the video. */}
      <span className="absolute bottom-1 left-1 max-w-[calc(100%-0.5rem)] truncate rounded bg-slate-950/70 px-1.5 py-0.5 text-xs font-medium text-slate-100">
        {name}
      </span>

      {isMuted && (
        <div className="absolute right-1 top-1 rounded-full bg-red-500/80 p-1">
          <MicOff className="h-3 w-3 text-white" />
        </div>
      )}

      {isSpeaking && !isMuted && (
        <div className="absolute right-1 top-1 rounded-full bg-green-500/80 p-1">
          <Volume2 className="h-3 w-3 text-white" />
        </div>
      )}
    </div>
  );
}

interface ScreenShareTileProps {
  label: string;
  videoRef: (el: HTMLVideoElement | null) => void;
}

function ScreenShareTile({ label, videoRef }: ScreenShareTileProps) {
  return (
    <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-slate-950/80 ring-1 ring-stable-cyan/40">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="h-full w-full rounded-lg bg-black object-contain"
      />
      <div className="absolute bottom-1 left-1 flex max-w-[calc(100%-0.5rem)] items-center gap-1 rounded bg-slate-950/70 px-1.5 py-0.5 text-xs font-medium text-stable-cyan">
        <MonitorUp className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
    </div>
  );
}

export function VoiceVideoBar({ roomId }: VoiceVideoBarProps) {
  const {
    room,
    localParticipant,
    remoteParticipants,
    isConnected,
    isConnecting,
    audioBlocked,
    version,
    startAudio,
    disconnect,
  } = useStableRoom(roomId);

  // Real Brigade roster (e.g. "Majik") — used to label agent participants and
  // to detect which participants are agents. Previously this read a Zustand
  // store seeded with 3 hardcoded MOCK agents, so the resident agent rendered
  // as its raw identity ("brigade"/"agent-majik") instead of its friendly name.
  const { data: brigadeAgents = [] } = useQuery({
    queryKey: ["brigade-agents"],
    queryFn: () => api.getBrigadeAgents(),
    staleTime: 5 * 60_000,
  });

  // Resolve a LiveKit participant identity ("agent-<brigade_id>") to a Brigade
  // agent, matching the same `agent-` prefix convention ParticipantStrip uses.
  const matchAgent = useCallback(
    (identity: string): BrigadeAgent | undefined => {
      const slug = identity.replace(/^agent-/, "");
      return brigadeAgents.find(
        (a) => a.id === slug || slug.includes(a.id) || identity.includes(a.id),
      );
    },
    [brigadeAgents],
  );

  const localVideoTrack = useMemo(() => {
    if (!localParticipant) return null;
    const pub = Array.from(localParticipant.trackPublications.values()).find(
      (t) => t.kind === "video" && t.track && t.source === "camera",
    );
    return pub?.track ?? null;
    // `version` bumps on LocalTrackPublished/Unpublished/Muted — without it this
    // never recomputes when the camera turns on (same participant ref), so the
    // self-view tile stayed blank. See VoiceProvider.version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localParticipant, version]);

  const attachLocal = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el && localVideoTrack) {
        localVideoTrack.attach(el);
        return () => {
          localVideoTrack.detach(el);
        };
      }
    },
    [localVideoTrack],
  );

  // Local screen-share (started from the call controls). Track.Source
  // is the string "screen_share" in livekit-client 2.x.
  const localScreenTrack = useMemo(() => {
    if (!localParticipant) return null;
    const pub = Array.from(localParticipant.trackPublications.values()).find(
      (t) => t.kind === "video" && t.track && t.source === "screen_share",
    );
    return pub?.track ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localParticipant, version]);

  const attachLocalScreen = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el && localScreenTrack) {
        localScreenTrack.attach(el);
        return () => {
          localScreenTrack.detach(el);
        };
      }
    },
    [localScreenTrack],
  );

  // Remote screen-shares: one tile per remote participant publishing one.
  const remoteScreenShares = useMemo(() => {
    const out: {
      sid: string;
      label: string;
      track: NonNullable<ReturnType<typeof getScreenTrack>>;
    }[] = [];
    function getScreenTrack(p: (typeof remoteParticipants)[number]) {
      const pub = Array.from(p.trackPublications.values()).find(
        (t) => t.kind === "video" && t.track && t.source === "screen_share",
      );
      return pub?.track ?? null;
    }
    for (const p of remoteParticipants) {
      const track = getScreenTrack(p);
      if (track) {
        const agent = matchAgent(p.identity);
        out.push({ sid: p.sid, label: agent?.name || p.name || p.identity, track });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteParticipants, version, matchAgent]);

  // Whether anyone in the call has a camera/screen track live. Drives the
  // "video stage" vs "compact audio bar" layout (see RoomView).
  const hasAnyVideo = useMemo(() => {
    if (localVideoTrack || localScreenTrack || remoteScreenShares.length > 0) {
      return true;
    }
    return remoteParticipants.some((p) =>
      Array.from(p.trackPublications.values()).some(
        (t) => t.kind === "video" && t.track,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    localVideoTrack,
    localScreenTrack,
    remoteScreenShares,
    remoteParticipants,
    version,
  ]);

  if (!isConnected && !isConnecting) {
    return null;
  }

  // Connecting — the Room isn't ready yet; show a minimal bar with a cancel.
  if (!room) {
    return (
      <div className="flex items-center justify-between border-b border-slate-700/50 bg-slate-900/80 px-4 py-2">
        <span className="animate-pulse-soft text-sm text-slate-400">
          Connecting to the call…
        </span>
        <button
          onClick={disconnect}
          className="rounded-lg bg-red-500/20 p-2.5 text-red-400 transition-colors hover:bg-red-500/30"
          aria-label="Cancel call"
        >
          <PhoneOff className="h-5 w-5" />
        </button>
      </div>
    );
  }

  const isMicOn = localParticipant?.isMicrophoneEnabled ?? false;
  const isCamOn = localParticipant?.isCameraEnabled ?? false;

  async function toggleMic() {
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(!isMicOn);
  }

  async function toggleCam() {
    if (!room) return;
    await room.localParticipant.setCameraEnabled(!isCamOn);
  }

  return (
    <div className="flex h-full flex-col">
      {audioBlocked && (
        <button
          onClick={() => void startAudio()}
          className="flex w-full shrink-0 items-center justify-center gap-2 bg-amber-500/25 px-4 py-2 text-sm font-semibold text-amber-100 transition-colors hover:bg-amber-500/35"
        >
          <Volume2 className="h-4 w-4" />
          Tap to hear the call
        </button>
      )}
      <div
        className={clsx(
          "flex min-h-0 flex-1 border-b border-slate-700/50 bg-slate-900/80",
          hasAnyVideo
            ? "flex-col gap-2 p-3"
            : "flex-row items-center gap-3 px-4 py-2",
        )}
        role="region"
        aria-label="Voice and video call"
      >
        {hasAnyVideo ? (
          // Video stage: responsive grid of aspect-video tiles. The local
          // self-view comes first so it's the prominent tile on mobile.
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 content-start gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
            <ParticipantTile
              name="You"
              isAgent={false}
              isSpeaking={localParticipant?.isSpeaking ?? false}
              isMuted={!isMicOn}
              hasVideo={!!localVideoTrack}
              videoRef={attachLocal}
            />

            {localScreenTrack && (
              <ScreenShareTile label="You — screen" videoRef={attachLocalScreen} />
            )}

            {remoteScreenShares.map((share) => (
              <ScreenShareTile
                key={`screen-${share.sid}`}
                label={`${share.label} — screen`}
                videoRef={(el) => {
                  if (el) share.track.attach(el);
                }}
              />
            ))}

            {remoteParticipants.map((participant) => {
              const identity = participant.identity;
              const agent = matchAgent(identity);
              const isAgent = !!agent;
              const name = agent?.name || participant.name || identity;

              const videoPublication = Array.from(
                participant.trackPublications.values(),
              ).find((t) => t.kind === "video" && t.track && t.source === "camera");

              const videoTrack = videoPublication?.track ?? null;

              return (
                <ParticipantTile
                  key={participant.sid}
                  name={name}
                  isAgent={isAgent}
                  isSpeaking={participant.isSpeaking}
                  isMuted={!participant.isMicrophoneEnabled}
                  hasVideo={!!videoTrack}
                  videoRef={
                    videoTrack
                      ? (el) => {
                          if (el) videoTrack.attach(el);
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
        ) : (
          // Audio-only call: keep it compact — avatar chips in a single row.
          <div className="flex flex-1 items-center gap-2 overflow-x-auto py-1">
            <AudioChip
              name="You"
              isAgent={false}
              isSpeaking={localParticipant?.isSpeaking ?? false}
              isMuted={!isMicOn}
            />
            {remoteParticipants.map((participant) => {
              const agent = matchAgent(participant.identity);
              return (
                <AudioChip
                  key={participant.sid}
                  name={agent?.name || participant.name || participant.identity}
                  isAgent={!!agent}
                  isSpeaking={participant.isSpeaking}
                  isMuted={!participant.isMicrophoneEnabled}
                />
              );
            })}
          </div>
        )}

        <div
          className={clsx(
            "flex shrink-0 items-center justify-center gap-2",
            hasAnyVideo && "pt-1",
          )}
        >
          <button
            onClick={toggleMic}
            className={clsx(
              "flex h-10 w-10 items-center justify-center rounded-full transition-colors",
              isMicOn
                ? "bg-slate-800 text-slate-200 hover:bg-slate-700"
                : "bg-red-500/20 text-red-400 hover:bg-red-500/30",
            )}
            aria-label={isMicOn ? "Mute" : "Unmute"}
          >
            {isMicOn ? (
              <Mic className="h-5 w-5" />
            ) : (
              <MicOff className="h-5 w-5" />
            )}
          </button>

          <button
            onClick={toggleCam}
            className={clsx(
              "flex h-10 w-10 items-center justify-center rounded-full transition-colors",
              isCamOn
                ? "bg-slate-800 text-slate-200 hover:bg-slate-700"
                : "bg-slate-800/60 text-slate-400 hover:bg-slate-700 hover:text-slate-200",
            )}
            aria-label={isCamOn ? "Turn off camera" : "Turn on camera"}
          >
            {isCamOn ? (
              <Video className="h-5 w-5" />
            ) : (
              <VideoOff className="h-5 w-5" />
            )}
          </button>

          <button
            onClick={disconnect}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/20 text-red-400 transition-colors hover:bg-red-500/30"
            aria-label="End call"
          >
            <PhoneOff className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

interface AudioChipProps {
  name: string;
  isAgent: boolean;
  isSpeaking: boolean;
  isMuted: boolean;
}

/** Compact avatar chip for an audio-only call (no video stage). */
function AudioChip({ name, isAgent, isSpeaking, isMuted }: AudioChipProps) {
  const initial = name.charAt(0).toUpperCase();
  return (
    <div
      className={clsx(
        "relative flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-3 transition-all",
        isSpeaking ? "bg-green-500/10 ring-1 ring-green-500/50" : "bg-slate-800/50",
      )}
    >
      <div
        className={clsx(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
          isAgent
            ? "bg-stable-cyan/20 text-stable-cyan"
            : "bg-stable-purple/20 text-stable-purple-light",
          isSpeaking && !isMuted && "animate-pulse-soft",
        )}
      >
        {isAgent ? <Bot className="h-4 w-4" /> : initial}
      </div>
      <span className="max-w-[10ch] truncate text-xs font-medium text-slate-200">
        {name}
      </span>
      {isMuted && <MicOff className="h-3.5 w-3.5 shrink-0 text-red-400" />}
    </div>
  );
}
