/**
 * AgentPresenceFace — the call-tile composer that decides what an agent's face
 * looks like on a stage surface.
 *
 * Why this exists instead of a `vrmUrl` prop on `Avatar`: `Avatar` is the cheap
 * universal primitive that renders in chat chips, member lists and settings, and
 * three.js must never become reachable from those. This component is the only
 * thing in the app allowed to reach the WebGL rung, and it is only ever rendered
 * from a stage-class call tile.
 *
 * It walks the ladder from `lib/presenceFace.ts`:
 *
 *   face (WebGL) → portrait → UnicornAvatar → Avatar initials
 *
 * and it steps DOWN a rung on its own when something fails — no WebGL, a model
 * that will not decode, a container that has collapsed to nothing. It never
 * renders an empty box.
 *
 * The heavy renderer is behind `lazy()`, so the three.js chunk is requested by
 * the browser only when the flag is on AND the tile is stage-class AND WebGL
 * works. A user who never turns the flag on never downloads a byte of it.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Avatar } from "@/components/ui/Avatar";
import { UnicornAvatar } from "@/components/Agents/UnicornAvatar";
import { resolveAgentPortrait } from "@/lib/resolveAgentPortrait";
import { resolveAgentVrmUrl } from "@/lib/agentVrmCatalog";
import {
  isTalkingFaceEnabled,
  isTalkingFaceDebugEnabled,
} from "@/lib/talkingFaceFlag";
import { isWebglAvailable } from "@/lib/webglSupport";
import {
  MIN_FACE_BOX_PX,
  agentSlugFromIdentity,
  selectFallbackRung,
  selectPresenceRung,
  unicornStateFor,
  type PresenceExpression,
  type PresenceSurface,
} from "@/lib/presenceFace";

// Lazy — this import is the ONLY edge from the app graph into three.js.
const VrmAvatar = lazy(() => import("@/components/Agents/VrmAvatar"));

export interface AgentPresenceFaceProps {
  /** Full LiveKit identity ("agent-majik"). The face renderer needs it to find
   *  the participant whose audio level drives the mouth. */
  participantId: string;
  /** Catalog / identity-colour slug, without the "agent-" prefix. */
  id: string;
  name: string;
  /** Raw roster avatar URL — resolved through the portrait ladder here. */
  avatarUrl?: string | null;
  /** Brigade `avatar_vrm_url` when that field exists (PR7). Null today. */
  vrmUrl?: string | null;
  emoji?: string | null;
  /** Pixel box for the 2D rungs. 96 on a stage large tile, 64 elsewhere. */
  size: number;
  /** Only "stage" may reach the WebGL rung. */
  surface: PresenceSurface;
  expression?: PresenceExpression;
  /** Boolean only. The per-frame level is sampled inside the renderer. */
  isSpeaking?: boolean;
  className?: string;
  alt?: string;
}

export function AgentPresenceFace({
  participantId,
  id,
  name,
  avatarUrl,
  vrmUrl,
  emoji,
  size,
  surface,
  expression = "idle",
  isSpeaking = false,
  className,
  alt = "",
}: AgentPresenceFaceProps) {
  const slug = agentSlugFromIdentity(id || participantId);
  const flagEnabled = isTalkingFaceEnabled();
  const debug = isTalkingFaceDebugEnabled();

  const portraitSrc = useMemo(
    () => resolveAgentPortrait(slug, name, avatarUrl),
    [slug, name, avatarUrl],
  );
  const vrmSrc = useMemo(
    () => resolveAgentVrmUrl(slug, name, vrmUrl),
    [slug, name, vrmUrl],
  );

  /**
   * A face that has failed once stays failed for the life of this tile. Retrying
   * a decode every render would spin a broken model forever, and a WebGL context
   * that could not be created will not be creatable a frame later either.
   */
  const [faceHealthy, setFaceHealthy] = useState(true);

  /**
   * Does the tile actually have room?
   *
   * ⚠️ Do NOT gate this on a layout "ready" signal — this codebase has been
   * burned twice by ready flags that silently never fire. Measure the geometry
   * we own, and keep measuring: the box is 0×0 on the first paint of a flex
   * stage, and a one-shot read would conclude "too small" and never look again.
   * ResizeObserver covers the resize case; the interval covers the case where no
   * resize event ever fires because the element was replaced under us.
   */
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [boxOk, setBoxOk] = useState(false);
  const wantsFace =
    flagEnabled && surface === "stage" && faceHealthy && isWebglAvailable();

  useEffect(() => {
    if (!wantsFace) return;
    const el = hostRef.current;
    if (!el) return;
    let done = false;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const ok = Math.min(r.width, r.height) >= MIN_FACE_BOX_PX;
      if (ok && !done) {
        done = true;
        setBoxOk(true);
      }
      return ok;
    };
    if (measure()) return;
    const ro = new ResizeObserver(() => {
      if (measure()) ro.disconnect();
    });
    ro.observe(el);
    // Poll as well. setInterval, not rAF: rAF does not fire in a hidden tab, and
    // every automated / background tab is hidden.
    const poll = window.setInterval(() => {
      if (measure()) window.clearInterval(poll);
    }, 250);
    return () => {
      ro.disconnect();
      window.clearInterval(poll);
    };
  }, [wantsFace, size, surface]);

  const rung = selectPresenceRung({
    flagEnabled,
    surface,
    webglOk: isWebglAvailable() && boxOk,
    faceHealthy,
    portraitSrc,
    vrmSrc,
  });

  // What the 2D half renders — also the Suspense fallback, so the tile shows the
  // agent's portrait while the three.js chunk is on the wire instead of a hole.
  const fallbackRung = selectFallbackRung(portraitSrc);
  const twoD =
    fallbackRung === "portrait" ? (
      <Avatar
        avatarUrl={portraitSrc}
        emoji={emoji}
        id={slug}
        name={name}
        size={size}
        ring={isSpeaking}
        className={clsx(isSpeaking && "animate-pulse-soft")}
        alt={alt}
      />
    ) : (
      <UnicornAvatar
        id={slug}
        name={name}
        size={size}
        state={unicornStateFor(expression)}
      />
    );

  if (rung !== "face") {
    return (
      <span
        ref={hostRef}
        className={clsx(
          "relative flex h-full w-full items-center justify-center",
          className,
        )}
        data-presence-rung={rung}
        data-presence-agent={slug}
      >
        {twoD}
        {debug && <RungBadge rung={rung} reason={debugReason(flagEnabled, surface)} />}
      </span>
    );
  }

  return (
    <span
      ref={hostRef}
      className={clsx(
        "relative flex h-full w-full items-center justify-center",
        className,
      )}
      data-presence-rung="face"
      data-presence-agent={slug}
    >
      <Suspense fallback={twoD}>
        <VrmAvatar
          participantId={participantId}
          slug={slug}
          name={name}
          vrmSrc={vrmSrc}
          size={size}
          expression={expression}
          isSpeaking={isSpeaking}
          debug={debug}
          onFail={(why) => {
            console.warn(`[talking-face] face rung failed for ${slug}: ${why}`);
            setFaceHealthy(false);
          }}
        />
      </Suspense>
    </span>
  );
}

function debugReason(flagEnabled: boolean, surface: PresenceSurface): string {
  if (!flagEnabled) return "flag off";
  if (surface !== "stage") return `surface=${surface}`;
  if (!isWebglAvailable()) return "no webgl";
  return "box too small / face failed";
}

function RungBadge({ rung, reason }: { rung: string; reason: string }) {
  return (
    <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] leading-tight text-amber-300">
      {rung} · {reason}
    </span>
  );
}

export default AgentPresenceFace;
