/**
 * The one face. Photo, puppet, app logo, or — for a human with nothing else —
 * initials. Agents never fall through to initials: a dead URL walks the
 * ladder and then the procedural unicorn.
 *
 * `ui/Avatar` stays the emoji/initials renderer for older call sites. This
 * component does not use it: that module imports the Keycloak client, and the
 * guest roster renders through here.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";
import { X } from "lucide-react";
import {
  UnicornAvatar,
  type UnicornAvatarState,
} from "@/components/Agents/UnicornAvatar";
import {
  AGENT_RING_AMBER,
  AGENT_RING_GREY,
  identityFor,
  initialsFor,
  resolveIdentity,
  type IdentityKind,
  type IdentityPresence,
  type IdentityRing,
  type ResolvedIdentity,
} from "@/lib/identity";
import { unicornStateFor, type PresenceExpression } from "@/lib/presenceFace";
import { useAppStore } from "@/stores/appStore";

export type IdentitySize = 20 | 24 | 32 | 40 | 56 | 96;

export interface IdentityProps extends ResolvedIdentity {
  /** Canonical sizes, or an explicit pixel box where a layout is already fixed. */
  size?: IdentitySize | number;
  className?: string;
  /** Mute an offline agent's portrait. */
  dimmed?: boolean;
  /** Facepile children: the group label lives on the parent. */
  decorative?: boolean;
  /** Circle is the default. "rounded" is the sticker crop (`Avatar` rounded="lg"). Apps stay square. */
  shape?: "circle" | "rounded";
  /** Agent image-ladder failure glyph. Shown before the procedural unicorn. */
  emoji?: string | null;
  /** Drives the procedural unicorn once an agent has no picture left. */
  expression?: PresenceExpression;
  /**
   * Draw the procedural bust in this state and skip the still picture.
   * The thinking row is a motion cue, not a portrait.
   */
  state?: UnicornAvatarState;
  /** Accessible name. "" marks the face decorative when the name sits beside it. */
  alt?: string;
}

const PRESENCE_LABEL: Record<Exclude<IdentityPresence, null>, string> = {
  online: "Online",
  available: "Available",
  unknown: "Presence unknown",
};

export function Identity({
  kind,
  id,
  name,
  src,
  fallbacks,
  ring,
  presence,
  faces,
  size = 32,
  className,
  dimmed = false,
  decorative = false,
  shape = "circle",
  emoji = null,
  expression,
  state,
  alt,
}: IdentityProps) {
  const px = typeof size === "number" ? size : 32;

  if (faces && faces.length >= 2) {
    return (
      <span
        className={clsx("relative inline-flex shrink-0", className)}
        style={{ width: px, height: px }}
        role={decorative ? undefined : "img"}
        aria-label={decorative ? undefined : name}
        aria-hidden={decorative || undefined}
      >
        {faces.slice(0, 3).map((face, index) => {
          const box = pileBox(index, Math.min(faces.length, 3), px);
          return (
            <span key={`${face.id}:${index}`} className="absolute" style={box}>
              <Identity
                {...face}
                size={box.width as number}
                decorative
                presence={null}
              />
            </span>
          );
        })}
      </span>
    );
  }

  return (
    <Face
      kind={kind}
      id={id}
      name={name}
      src={src}
      fallbacks={fallbacks}
      ring={ring}
      presence={presence}
      px={px}
      className={className}
      dimmed={dimmed}
      decorative={decorative}
      shape={shape}
      emoji={emoji}
      expression={expression}
      state={state}
      alt={alt}
    />
  );
}

function Face({
  kind,
  id,
  name,
  src,
  fallbacks,
  ring,
  presence,
  px,
  className,
  dimmed,
  decorative,
  shape,
  emoji,
  expression,
  state,
  alt,
}: {
  kind: IdentityKind;
  id: string;
  name: string;
  src: string | null;
  fallbacks: string[];
  ring: IdentityRing;
  presence: IdentityPresence;
  px: number;
  className?: string;
  dimmed: boolean;
  decorative: boolean;
  shape: "circle" | "rounded";
  emoji: string | null;
  expression?: PresenceExpression;
  state?: UnicornAvatarState;
  alt?: string;
}) {
  const ladder = useMemo(() => {
    const list: string[] = [];
    if (src) list.push(src);
    for (const url of fallbacks ?? []) {
      if (url && !list.includes(url)) list.push(url);
    }
    return list;
  }, [src, fallbacks]);
  const ladderKey = ladder.join("|");
  // Reset during render. An effect would commit the previous row's rung first,
  // and a virtualized list recycles the component (initials on a human, unicorn
  // on an agent) for that frame.
  const [step, setStep] = useState(0);
  const [seenKey, setSeenKey] = useState(ladderKey);
  if (seenKey !== ladderKey) {
    setSeenKey(ladderKey);
    setStep(0);
  }

  const current = seenKey === ladderKey ? (ladder[step] ?? null) : (ladder[0] ?? null);
  const hue = identityFor(id, name);
  const square = kind === "app" || kind === "channel";
  const glyph = (emoji ?? "").trim();
  const forceBust = kind === "agent" && !!state;
  const showImage = !!current && !forceBust;
  const decorativeFace = decorative || alt === "";
  const label = decorativeFace ? undefined : alt !== undefined ? alt : name;
  const bustState: UnicornAvatarState = state
    ? state
    : expression
      ? unicornStateFor(expression)
      : dimmed
        ? "offline"
        : "idle";

  const box: CSSProperties = {
    width: px,
    height: px,
    borderRadius: square ? 8 : shape === "rounded" ? Math.max(4, px * 0.22) : 9999,
    background:
      kind === "channel"
        ? // Neutral: a room takes no identity colour of its own.
          "color-mix(in srgb, currentColor 8%, transparent)"
        : showImage
          ? square
            ? "#131a28"
            : hue.soft
          : hue.gradient,
    boxShadow:
      ring === "amber"
        ? `0 0 0 2px ${AGENT_RING_AMBER}`
        : ring === "grey"
          ? `0 0 0 2px ${AGENT_RING_GREY}`
          : undefined,
    border: ring === "dashed" ? "1.5px dashed rgba(148, 163, 184, 0.95)" : undefined,
  };

  const dot = presence ? (
    <span
      className={clsx(
        "absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-slate-900",
        presence === "online" && "animate-live bg-stable-mint",
        presence === "available" && "border-stable-cyan bg-transparent",
        presence === "unknown" && "border-slate-600 bg-transparent",
      )}
      style={{ width: px >= 32 ? 10 : 8, height: px >= 32 ? 10 : 8 }}
      aria-label={PRESENCE_LABEL[presence]}
      title={PRESENCE_LABEL[presence]}
    />
  ) : null;

  let body: ReactNode;
  if (forceBust) {
    body = <UnicornAvatar id={id} name={name} size={px} state={bustState} />;
  } else if (showImage) {
    body = (
      <img
        src={current}
        alt=""
        width={px}
        height={px}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setStep((n) => n + 1)}
        className="h-full w-full object-cover"
      />
    );
  } else if (kind === "channel") {
    // A place, not a face: the room's own mark, muted, never a monogram.
    body = (
      <span
        className="font-semibold text-slate-400"
        style={{ fontSize: Math.round(px * 0.56), lineHeight: 1 }}
        aria-hidden="true"
      >
        {glyph === "lock" ? "\u{1F512}" : "#"}
      </span>
    );
  } else if (kind === "agent" && glyph) {
    body = (
      <span style={{ fontSize: Math.round(px * 0.58), lineHeight: 1 }}>{glyph}</span>
    );
  } else if (kind === "agent") {
    body = <UnicornAvatar id={id} name={name} size={px} state={bustState} />;
  } else {
    body = (
      <span
        className="font-semibold text-white"
        style={{
          fontSize: Math.round(px * 0.4),
          lineHeight: 1,
          letterSpacing: "0.02em",
        }}
      >
        {initialsFor(name)}
      </span>
    );
  }

  return (
    <span
      className={clsx(
        "relative inline-flex shrink-0 select-none",
        dimmed && kind !== "agent" && "opacity-50 saturate-50",
        className,
      )}
      style={{ width: px, height: px }}
      role={decorativeFace ? undefined : "img"}
      aria-label={label}
      aria-hidden={decorativeFace || undefined}
    >
      <span
        className="inline-flex h-full w-full items-center justify-center overflow-hidden"
        style={box}
      >
        {body}
      </span>
      {dot}
    </span>
  );
}

function pileBox(index: number, count: number, size: number): CSSProperties {
  const face = Math.round(size * (count === 2 ? 0.68 : 0.58));
  if (count === 2) {
    return {
      width: face,
      height: face,
      left: index === 0 ? 0 : size - face,
      top: Math.round((size - face) / 2),
      zIndex: index + 1,
    };
  }
  const slots = [
    { left: Math.round((size - face) / 2), top: 0 },
    { left: 0, top: size - face },
    { left: size - face, top: size - face },
  ];
  const slot = slots[index] ?? slots[0]!;
  return { width: face, height: face, zIndex: index + 1, ...slot };
}

/** The signed-in face. Uses the settled avatar once syncMyAvatar has landed. */
export function useSelfFace(): ResolvedIdentity {
  const currentUser = useAppStore((s) => s.currentUser);
  const avatarSync = useAppStore((s) => s.avatarSync);
  const resolvedAvatarUrl = useAppStore((s) => s.resolvedAvatarUrl);
  const avatarUrl =
    avatarSync === "settled" ? resolvedAvatarUrl : (currentUser?.avatarUrl ?? null);
  return resolveIdentity({
    id: currentUser?.id,
    display_name: currentUser?.displayName || "You",
    username: currentUser?.username,
    avatar_url: avatarUrl,
    participant_type: "human",
    is_self: !!currentUser,
  });
}

/** True only after the avatar sync has settled and the nudge has not been dismissed. */
export function useShowPhotoNudge(): boolean {
  const avatarSync = useAppStore((s) => s.avatarSync);
  const dismissed = useAppStore((s) => s.photoNudgeDismissed);
  const face = useSelfFace();
  return avatarSync === "settled" && !dismissed && !!face.needsPhoto;
}

/** One-time "Add your photo" chip. Dismissal is shared across every mount. */
export function PhotoNudge({ onAdd }: { onAdd: () => void }) {
  const dismissed = useAppStore((s) => s.photoNudgeDismissed);
  const dismiss = useAppStore((s) => s.dismissPhotoNudge);
  if (dismissed) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-lg border border-dashed border-stable-purple/40 bg-stable-purple/10 py-1 pl-2.5 pr-1 text-xs text-slate-200">
      <button
        type="button"
        onClick={onAdd}
        className="focus-ring rounded font-medium text-stable-purple-light hover:underline"
      >
        Add your photo
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss photo reminder"
        className="focus-ring rounded p-1 text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

export default Identity;
