import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { RoomEvent } from "livekit-client";
import type { Participant, RemoteParticipant } from "livekit-client";
import { useVoice } from "@/contexts/VoiceProvider";
import { identityFor } from "@/lib/identity";

/**
 * VoiceAgentStatus — a compact "orb that moves with the voice" + a clear
 * working-state label for the agent during a voice call.
 *
 * The agent (a livekit-agents worker) publishes its lifecycle as the standard
 * `lk.agent.state` participant attribute — `initializing` → `listening` →
 * `thinking` → `speaking`. We surface that as a labelled, colour-coded orb so
 * the user can SEE the agent is listening / thinking / about to speak instead
 * of staring at silence. The orb also pulses with the agent's live audio level
 * while it speaks. Everything is read directly from livekit-client (no extra
 * provider wiring) and degrades gracefully: no agent + not connecting → nothing.
 */

const STATE_META: Record<string, { label: string; chip: string }> = {
  initializing: {
    label: "Connecting…",
    chip: "border-slate-500/30 bg-slate-500/10 text-slate-300 animate-pulse-soft",
  },
  listening: {
    label: "Listening",
    chip: "border-stable-mint/30 bg-stable-mint/10 text-stable-mint",
  },
  thinking: {
    label: "Thinking…",
    chip: "border-amber-300/30 bg-amber-300/10 text-amber-300 animate-pulse-soft",
  },
  // Speaking is tinted with the agent's identity hue inline at render time.
  speaking: {
    label: "Speaking",
    chip: "border-stable-cyan/30 bg-stable-cyan/10 text-stable-cyan",
  },
};

function findAgent(parts: RemoteParticipant[]): RemoteParticipant | null {
  return parts.find((p) => (p.identity || "").startsWith("agent-")) ?? null;
}

export function VoiceAgentStatus() {
  const { room, remoteParticipants, isConnecting, isConnected, version } =
    useVoice();
  const agent = findAgent(remoteParticipants);

  const [state, setState] = useState<string>("");
  const [level, setLevel] = useState(0);
  const levelRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Follow the agent's published lifecycle attribute.
  useEffect(() => {
    if (!room || !agent) {
      setState("");
      return;
    }
    const read = () =>
      setState((agent.attributes?.["lk.agent.state"] as string) || "");
    read();
    const onAttr = (_changed: Record<string, string>, p: Participant) => {
      if (p.identity === agent.identity) read();
    };
    room.on(RoomEvent.ParticipantAttributesChanged, onAttr);
    return () => {
      room.off(RoomEvent.ParticipantAttributesChanged, onAttr);
    };
  }, [room, agent, version]);

  // Smoothly track the agent's live audio level to size the orb.
  useEffect(() => {
    if (!agent) {
      setLevel(0);
      return;
    }
    const tick = () => {
      const target = agent.audioLevel || 0;
      levelRef.current += (target - levelRef.current) * 0.25;
      setLevel(levelRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [agent]);

  if (!agent && !isConnecting) return null;

  const meta = STATE_META[state] ?? {
    label: isConnected ? "Connected" : "Connecting…",
    chip: clsx(
      "border-slate-500/30 bg-slate-500/10 text-slate-300",
      !isConnected && "animate-pulse-soft",
    ),
  };
  const speaking = state === "speaking";

  // The orb wears the agent's identity hue; neutral slate until one arrives.
  const ident = agent
    ? identityFor(agent.identity.replace(/^agent-/, ""), agent.name)
    : null;
  const orbGradient =
    ident?.gradient ?? "linear-gradient(135deg, #626280, #434360)";
  const orbRing = ident?.ring ?? "rgba(98, 98, 128, 0.45)";
  const agentLabel = agent
    ? agent.name || agent.identity.replace(/^agent-/, "")
    : null;

  // Idle 1.0 → up to ~1.7 with voice; clamp so a loud burst doesn't overflow.
  const scale = 1 + Math.min(level * 3, 0.7);

  return (
    <div className="flex shrink-0 items-center justify-center gap-2.5 border-b border-line bg-surface-1/60 px-4 py-2 backdrop-blur-md">
      <div className="relative grid h-10 w-10 place-items-center">
        {/* Halo that swells with the voice */}
        <div
          className="absolute h-9 w-9 rounded-full opacity-35"
          style={{
            background: `radial-gradient(circle, ${orbRing} 0%, transparent 70%)`,
            transform: `scale(${scale})`,
            transition: "transform 80ms linear",
          }}
        />
        {/* Identity ring */}
        <div
          className="absolute h-7 w-7 rounded-full border-2"
          style={{ borderColor: orbRing }}
        />
        {/* Core sphere */}
        <div
          className={clsx("h-4 w-4 rounded-full", speaking && "animate-breathe")}
          style={{
            background: orbGradient,
            boxShadow: `0 0 10px ${orbRing}`,
          }}
        />
      </div>
      {agentLabel && (
        <span
          className="max-w-[14ch] truncate text-xs font-semibold"
          style={ident ? { color: ident.text } : undefined}
        >
          {agentLabel}
        </span>
      )}
      <span
        className={clsx(
          "rounded-full border px-2 py-0.5 text-[11px] font-medium",
          speaking && ident ? "animate-breathe" : meta.chip,
        )}
        style={
          speaking && ident
            ? {
                background: ident.soft,
                color: ident.text,
                borderColor: ident.border,
              }
            : undefined
        }
      >
        {meta.label}
      </span>
    </div>
  );
}
