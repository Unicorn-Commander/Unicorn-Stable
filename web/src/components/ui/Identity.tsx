/**
 * The one face. Photo, puppet, app logo, or — for a human with nothing else —
 * initials. Agents never fall through to initials: a dead URL walks the
 * ladder and then the procedural unicorn.
 *
 * `ui/Avatar` stays the emoji/initials renderer for older call sites. This
 * component does not use it: that module imports the Keycloak client, and the
 * guest roster renders through here.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";
import { X } from "lucide-react";
import { UnicornAvatar } from "@/components/Agents/UnicornAvatar";
import {
  AGENT_RING_AMBER,
  AGENT_RING_GREY,
  dismissPhotoNudge,
  identityFor,
  initialsFor,
  isPhotoNudgeDismissed,
  type IdentityKind,
  type IdentityPresence,
  type IdentityRing,
  type ResolvedIdentity,
} from "@/lib/identity";

export type IdentitySize = 20 | 24 | 32 | 40 | 56 | 96;

export interface IdentityProps extends ResolvedIdentity {
  /** Canonical sizes, or an explicit pixel box where a layout is already fixed. */
  size?: IdentitySize | number;
  className?: string;
  /** Mute an offline agent's portrait. */
  dimmed?: boolean;
  /** Facepile children: the group label lives on the parent. */
  decorative?: boolean;
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
  const [step, setStep] = useState(0);
  useEffect(() => {
    setStep(0);
  }, [ladderKey]);

  const current = ladder[step] ?? null;
  const hue = identityFor(id, name);
  const square = kind === "app";
  const showImage = !!current;
  const label = decorative ? undefined : name;

  const box: CSSProperties = {
    width: px,
    height: px,
    borderRadius: square ? 8 : 9999,
    background: showImage ? (square ? "#131a28" : hue.soft) : hue.gradient,
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
  if (showImage) {
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
  } else if (kind === "agent") {
    body = (
      <UnicornAvatar
        id={id}
        name={name}
        size={px}
        state={dimmed ? "offline" : "idle"}
      />
    );
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
      role={decorative ? undefined : "img"}
      aria-label={label}
      aria-hidden={decorative || undefined}
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

/** One-time "Add your photo" chip. Dismissal sticks for this browser. */
export function PhotoNudge({ onAdd }: { onAdd: () => void }) {
  const [gone, setGone] = useState(() => isPhotoNudgeDismissed());
  if (gone) return null;
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
        onClick={() => {
          dismissPhotoNudge();
          setGone(true);
        }}
        aria-label="Dismiss photo reminder"
        className="focus-ring rounded p-1 text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

export default Identity;
