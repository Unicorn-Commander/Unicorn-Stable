import { useState } from "react";
import clsx from "clsx";
import type { Room } from "@/services/api";
import { resolveAgentPortrait } from "@/lib/resolveAgentPortrait";
import { UnicornAvatar } from "@/components/Agents/UnicornAvatar";

/**
 * An agent's picture anywhere on Home, with a real failure path.
 *
 * Every surface here used to build its own bare `<img src={agent.avatar_url}>`
 * with no `onError`. Brigade's roster claims ~54 avatar files and serves ~16,
 * so the live dashboard rendered broken-image boxes for the difference — a
 * defect you cannot see in a diff, only by opening the page (2026-08-07: four
 * of them, confirmed via `naturalWidth === 0`).
 *
 * Two things make that impossible now: the ladder puts SAME-ORIGIN bundled art
 * ahead of the unverifiable remote URL, and a load failure still falls through
 * to the procedural head. Hiding the broken image is NOT good enough — it
 * leaves a hole where a face belongs, which is how `brief-drafter-v2.png`
 * survived the first fix.
 */
export function AgentPortrait({
  id,
  name,
  avatarUrl,
  size = 36,
  dimmed = false,
  className,
}: {
  /** Brigade agent id when known — the ladder matches art on it or the name. */
  id: string | null | undefined;
  name: string;
  avatarUrl?: string | null;
  size?: number;
  /** Offline / unreachable agents read back muted rather than absent. */
  dimmed?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = resolveAgentPortrait(id, name, avatarUrl);
  const box = { width: size, height: size };

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        style={box}
        onError={() => setFailed(true)}
        className={clsx(
          "shrink-0 rounded-lg object-cover ring-1 ring-white/10",
          dimmed && "opacity-50 saturate-50",
          className,
        )}
      />
    );
  }
  return (
    <span className={clsx("shrink-0", className)} style={box}>
      <UnicornAvatar
        id={id ?? name}
        name={name}
        size={size}
        state={dimmed ? "offline" : "idle"}
      />
    </span>
  );
}

/** Waiting-row variant: the row carries a room, not an agent record. */
export function RoomAgentPortrait({ room }: { room: Room }) {
  return (
    <AgentPortrait
      id={room.brigade_agent_id ?? null}
      name={room.display_name || room.name}
      className="mt-0.5"
    />
  );
}
