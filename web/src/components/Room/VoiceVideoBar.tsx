import { useMemo, useCallback } from "react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, Volume2, Bot, MonitorUp } from "lucide-react";
import clsx from "clsx";
import { useStableRoom } from "@/hooks/useStableRoom";
import { useAppStore } from "@/stores/appStore";

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
        "relative flex flex-col items-center gap-1 rounded-xl p-2 transition-all",
        isSpeaking
          ? "ring-2 ring-green-500/50 bg-green-500/5"
          : "bg-slate-800/40",
      )}
      style={{ width: 100, minHeight: 80 }}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-14 w-full rounded-lg object-cover"
        />
      ) : (
        <div className="flex h-14 w-14 items-center justify-center rounded-full">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={name}
              className={clsx(
                "h-10 w-10 rounded-full object-cover",
                isAgent && "ring-1 ring-stable-cyan/30",
              )}
            />
          ) : (
            <div
              className={clsx(
                "flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold",
                isAgent
                  ? "bg-stable-cyan/20 text-stable-cyan"
                  : "bg-stable-purple/20 text-stable-purple-light",
                isSpeaking && "animate-pulse-soft",
              )}
            >
              {isAgent ? <Bot className="h-5 w-5" /> : initial}
            </div>
          )}
        </div>
      )}

      <span className="max-w-full truncate text-[10px] font-medium text-slate-300">
        {name}
      </span>

      {isMuted && (
        <div className="absolute right-1 top-1 rounded-full bg-red-500/80 p-0.5">
          <MicOff className="h-2.5 w-2.5 text-white" />
        </div>
      )}

      {isSpeaking && !isMuted && (
        <div className="absolute right-1 top-1 rounded-full bg-green-500/80 p-0.5">
          <Volume2 className="h-2.5 w-2.5 text-white" />
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
    <div
      className="relative flex shrink-0 flex-col items-center gap-1 rounded-xl bg-slate-950/60 p-2 ring-1 ring-stable-cyan/30"
      style={{ width: 180, minHeight: 80 }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="aspect-video w-full rounded-lg bg-black object-contain"
      />
      <div className="flex max-w-full items-center gap-1 text-[10px] font-medium text-stable-cyan">
        <MonitorUp className="h-2.5 w-2.5 shrink-0" />
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
    startAudio,
    disconnect,
  } = useStableRoom(roomId);

  const agents = useAppStore((s) => s.agents);

  const localVideoTrack = useMemo(() => {
    if (!localParticipant) return null;
    const pub = Array.from(localParticipant.trackPublications.values()).find(
      (t) => t.kind === "video" && t.track && t.source === "camera",
    );
    return pub?.track ?? null;
  }, [localParticipant]);

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
  }, [localParticipant]);

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
        out.push({ sid: p.sid, label: p.name || p.identity, track });
      }
    }
    return out;
  }, [remoteParticipants]);

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
          className="rounded-lg bg-red-500/20 p-2 text-red-400 transition-colors hover:bg-red-500/30"
          aria-label="Cancel call"
        >
          <PhoneOff className="h-4 w-4" />
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

  function isAgentParticipant(identity: string): boolean {
    return agents.some(
      (a) => identity.includes(a.id) || identity.includes(a.name),
    );
  }

  return (
    <div className="flex flex-col">
      {audioBlocked && (
        <button
          onClick={() => void startAudio()}
          className="flex w-full items-center justify-center gap-2 bg-amber-500/25 px-4 py-2 text-sm font-semibold text-amber-100 transition-colors hover:bg-amber-500/35"
        >
          <Volume2 className="h-4 w-4" />
          Tap to hear the call
        </button>
      )}
      <div
        className="flex items-center gap-3 border-b border-slate-700/50 bg-slate-900/80 px-4 py-2"
        role="region"
        aria-label="Voice and video call"
      >
      <div className="flex flex-1 items-center gap-2 overflow-x-auto py-1">
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

        <ParticipantTile
          name="You"
          isAgent={false}
          isSpeaking={localParticipant?.isSpeaking ?? false}
          isMuted={!isMicOn}
          hasVideo={!!localVideoTrack}
          videoRef={attachLocal}
        />

        {remoteParticipants.map((participant) => {
          const identity = participant.identity;
          const isAgent = isAgentParticipant(identity);
          const name = participant.name || identity;

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

      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={toggleMic}
          className={clsx(
            "rounded-lg p-2 transition-colors",
            isMicOn
              ? "text-slate-300 hover:bg-slate-800"
              : "bg-red-500/20 text-red-400 hover:bg-red-500/30",
          )}
          aria-label={isMicOn ? "Mute" : "Unmute"}
        >
          {isMicOn ? (
            <Mic className="h-4 w-4" />
          ) : (
            <MicOff className="h-4 w-4" />
          )}
        </button>

        <button
          onClick={toggleCam}
          className={clsx(
            "rounded-lg p-2 transition-colors",
            isCamOn
              ? "text-slate-300 hover:bg-slate-800"
              : "text-slate-500 hover:bg-slate-800 hover:text-slate-300",
          )}
          aria-label={isCamOn ? "Turn off camera" : "Turn on camera"}
        >
          {isCamOn ? (
            <Video className="h-4 w-4" />
          ) : (
            <VideoOff className="h-4 w-4" />
          )}
        </button>

        <button
          onClick={disconnect}
          className="rounded-lg bg-red-500/20 p-2 text-red-400 transition-colors hover:bg-red-500/30"
          aria-label="End call"
        >
          <PhoneOff className="h-4 w-4" />
        </button>
      </div>
      </div>
    </div>
  );
}
