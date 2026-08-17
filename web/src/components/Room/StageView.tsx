import { useCallback, useMemo } from "react";
import { Minimize2, Maximize2, Maximize, Minimize, Bot, X } from "lucide-react";
import { useState } from "react";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import { identityFor } from "@/lib/identity";
import { useStableRoom } from "@/hooks/useStableRoom";
import { useTileFullscreen } from "@/hooks/useTileFullscreen";
import { useAppStore } from "@/stores/appStore";
import { api } from "@/services/api";
import { Avatar } from "@/components/ui/Avatar";
import { resolveAgentPortrait } from "@/lib/resolveAgentPortrait";

interface StageViewProps {
  agentId: string;
  roomId: string;
}

export function StageView({ agentId, roomId }: StageViewProps) {
  const agents = useAppStore((s) => s.agents);
  const setStageAgentId = useAppStore((s) => s.setStageAgentId);
  const voiceActive = useAppStore((s) => s.voiceActive);
  const { remoteParticipants, version } = useStableRoom(voiceActive ? roomId : null);
  const [maximized, setMaximized] = useState(false);

  const agent = agents.find((a) => a.id === agentId);

  // Real Brigade roster — resolve the on-stage agent's friendly name (e.g.
  // "Majik") and match its LiveKit identity ("agent-<brigade_id>"). The local
  // `agents` store is mock-seeded, so prefer the roster's display name.
  const { data: brigadeAgents = [] } = useQuery({
    queryKey: ["brigade-agents"],
    queryFn: () => api.getBrigadeAgents(),
    staleTime: 5 * 60_000,
  });

  const brigadeAgent = useMemo(() => {
    const slug = agentId.replace(/^agent-/, "");
    return brigadeAgents.find(
      (a) => a.id === slug || slug.includes(a.id) || agentId.includes(a.id),
    );
  }, [brigadeAgents, agentId]);

  const displayName =
    brigadeAgent?.name || agent?.display_name || "Agent";

  // The on-stage resident's identity hue — colors the avatar orb + name plate.
  const ident = identityFor(agentId.replace(/^agent-/, ""), displayName);

  // Emoji identity from the rich roster — the store id is the un-prefixed slug,
  // so fall back to that when the raw `agent-<id>` lookup misses. Renders in the
  // stage orb / name plate instead of an interchangeable Bot glyph.
  const stageAgent =
    agent ?? agents.find((a) => a.id === agentId.replace(/^agent-/, ""));
  const stageEmoji = stageAgent?.emoji?.trim() || null;

  const agentParticipant = useMemo(() => {
    return remoteParticipants.find((p) => {
      const identity = p.identity;
      const slug = identity.replace(/^agent-/, "");
      if (brigadeAgent && (slug === brigadeAgent.id || identity.includes(brigadeAgent.id))) {
        return true;
      }
      return (
        identity.includes(agentId) ||
        (agent?.name ? identity.includes(agent.name) : false)
      );
    });
    // `version` bumps when participants/tracks change so this re-resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteParticipants, version, agentId, agent?.name, brigadeAgent]);

  const videoTrack = useMemo(() => {
    if (!agentParticipant) return null;
    const pub = Array.from(agentParticipant.trackPublications.values()).find(
      (t) => t.kind === "video" && t.track && t.source === "screen_share",
    );
    return pub?.track ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentParticipant, version]);

  // Browser fullscreen for the stage tile — the same per-tile affordance the
  // call tiles carry. Registers the <video> so iPhone (no element fullscreen)
  // can present the native player instead of hiding the button. Destructured
  // because the STABLE function is the dependency — depending on the `fs`
  // object (fresh each render) would rebuild attachRef every render and
  // detach/reattach the LiveKit track (flicker + black frame).
  const fs = useTileFullscreen();
  const { videoRef: fsVideoRef } = fs;

  const attachRef = useCallback(
    (el: HTMLVideoElement | null) => {
      fsVideoRef(el);
      if (el && videoTrack) {
        videoTrack.attach(el);
        return () => {
          videoTrack.detach(el);
          fsVideoRef(null);
        };
      }
    },
    [videoTrack, fsVideoRef],
  );

  function handleClose() {
    setStageAgentId(null);
  }

  return (
    <div
      ref={fs.ref}
      className={clsx(
        "relative flex h-full w-full items-center justify-center bg-slate-950",
        maximized && "fixed inset-0 z-40",
      )}
      role="region"
      aria-label={`Stage view for ${displayName}`}
    >
      {videoTrack ? (
        <video
          ref={attachRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex animate-fade-in flex-col items-center gap-3">
          <Avatar
            avatarUrl={resolveAgentPortrait(
              agentId.replace(/^agent-/, ""),
              displayName,
              stageAgent?.avatar_url,
            )}
            emoji={stageEmoji}
            id={agentId.replace(/^agent-/, "")}
            name={displayName}
            size={64}
            ring
            alt=""
          />
          <p className="font-display text-sm font-semibold text-slate-100">
            {displayName}
          </p>
          <p className="text-xs text-slate-500">
            {voiceActive
              ? "No stage track active"
              : "Join a call to see the stage"}
          </p>

          {voiceActive && agentParticipant && (
            <div className="mt-2 flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-stable-mint animate-live" />
              <span className="text-xs text-slate-400">Agent connected</span>
            </div>
          )}
        </div>
      )}

      <div className="glass absolute right-3 top-3 flex items-center gap-1 rounded-xl p-1">
        {/* Browser fullscreen — distinct from "Maximize stage", which only
            expands the stage over the app. p-3.5 keeps a ≥44px touch target
            on mobile, compacting beside its siblings on md+. */}
        {fs.supported && (
          <button
            onClick={fs.toggle}
            className="focus-ring rounded-lg p-3.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:p-1.5"
            aria-label={fs.isFullscreen ? "Exit full screen" : "Full screen"}
            aria-pressed={fs.isFullscreen}
            title={
              fs.isFullscreen
                ? "Exit full screen"
                : "Full screen — fills the whole screen (Esc exits); “Maximize stage” only expands it over the app"
            }
          >
            {fs.isFullscreen ? (
              <Minimize className="h-4 w-4" />
            ) : (
              <Maximize className="h-4 w-4" />
            )}
          </button>
        )}
        <button
          onClick={() => setMaximized(!maximized)}
          className="focus-ring rounded-lg p-3.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:p-1.5"
          aria-label={maximized ? "Minimize stage" : "Maximize stage"}
          title={
            maximized
              ? "Minimize stage"
              : "Maximize stage — expand over the app (use “Full screen” for the whole screen)"
          }
        >
          {maximized ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </button>
        <button
          onClick={handleClose}
          className="focus-ring rounded-lg p-3.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 md:p-1.5"
          aria-label="Close stage"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {(brigadeAgent || agent) && (
        <div className="glass absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md px-2 py-0.5">
          {stageEmoji ? (
            <span className="text-xs leading-none" aria-hidden="true">
              {stageEmoji}
            </span>
          ) : (
            <Bot className="h-3.5 w-3.5" style={{ color: ident.text }} />
          )}
          <span className="text-xs font-medium text-slate-100">
            {displayName}
          </span>
          {agent && (
            <span
              className={clsx(
                "h-1.5 w-1.5 rounded-full",
                agent.status === "active" && "bg-stable-mint animate-live",
                agent.status === "working" && "bg-amber-300 animate-pulse-soft",
                agent.status === "idle" && "bg-slate-500",
                agent.status === "offline" && "bg-slate-700",
              )}
            />
          )}
        </div>
      )}
    </div>
  );
}
