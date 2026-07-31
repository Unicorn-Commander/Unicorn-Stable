import { useMemo } from "react";
import clsx from "clsx";
import { identityFor } from "@/lib/identity";

/**
 * Procedural animated unicorn bust — the tier-zero of the agent avatar
 * roadmap (P-00115): no downloaded assets, no runtime cost beyond a few CSS
 * keyframes, rendered identically everywhere. Mane and forelock take the
 * agent's identity hue so each resident stays visually distinct; the eye
 * blinks, an ear flicks, and the mouth animates while the agent is speaking
 * or streaming a reply. The full 3D VRM pipeline replaces this component
 * without changing any call site: same props, richer renderer.
 */
export type UnicornAvatarState = "idle" | "talking" | "working" | "offline";

interface UnicornAvatarProps {
  /** Stable participant/agent id — drives the identity hue. */
  id?: string | null;
  name: string;
  /** Square edge length in px. */
  size?: number;
  state?: UnicornAvatarState;
  className?: string;
}

export function UnicornAvatar({
  id,
  name,
  size = 32,
  state = "idle",
  className,
}: UnicornAvatarProps) {
  const ident = useMemo(() => identityFor(id, name), [id, name]);
  const talking = state === "talking";
  const offline = state === "offline";
  const gradientId = useMemo(
    () => `uc-mane-${(id || name).replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`,
    [id, name],
  );

  return (
    <span
      role="img"
      aria-label={`${name}${talking ? " is speaking" : ""}`}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center",
        offline && "opacity-50 saturate-50",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        aria-hidden="true"
        className={clsx(
          (talking || state === "working") && "animate-unicorn-bob",
        )}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={ident.color} />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
          <linearGradient id={`${gradientId}-horn`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fde68a" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
        </defs>

        {/* Mane sweep behind the head — the identity color carrier. */}
        <path
          d="M14 40 C10 22 22 8 38 10 C52 12 58 26 54 42 C50 54 40 58 32 57 C40 50 42 44 38 38 C30 44 20 48 14 40 Z"
          fill={`url(#${gradientId})`}
          opacity="0.9"
        />

        {/* Ears — the right one flicks now and then. */}
        <path d="M22 14 L27 24 L18 24 Z" fill="#ece9fe" />
        <path
          d="M40 12 L46 23 L35 22 Z"
          fill="#ece9fe"
          className="animate-unicorn-ear"
          style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
        />

        {/* Horn. */}
        <path
          d="M31 2 L36.5 20 L26.5 20 Z"
          fill={`url(#${gradientId}-horn)`}
        />

        {/* Head. */}
        <ellipse cx="31" cy="37" rx="17.5" ry="16" fill="#ece9fe" />
        {/* Muzzle. */}
        <ellipse cx="35" cy="45" rx="10.5" ry="8" fill="#f8f7ff" />
        <circle cx="39.5" cy="44.5" r="1.3" fill="#b9b3d8" />

        {/* Forelock strand in the identity color. */}
        <path
          d="M24 20 C30 16 38 17 42 22 C36 21 30 22 27 27 C26 24 25 22 24 20 Z"
          fill={ident.color}
          opacity="0.85"
        />

        {/* Eye — blinks. */}
        <ellipse
          cx="25"
          cy="36"
          rx="2.6"
          ry="3.6"
          fill="#221d3d"
          className={clsx(!offline && "animate-unicorn-blink")}
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
        />
        {/* Blush. */}
        <circle cx="23" cy="43" r="2.6" fill="#f9a8d4" opacity="0.45" />

        {/* Mouth — a resting line, or an animated open mouth while talking. */}
        {talking ? (
          <ellipse
            cx="34.5"
            cy="47.5"
            rx="3"
            ry="2.6"
            fill="#5b5380"
            className="animate-unicorn-talk"
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
          />
        ) : (
          <path
            d="M31.5 48.5 Q34.5 50.5 37.5 48.5"
            stroke="#8d85b5"
            strokeWidth="1.4"
            strokeLinecap="round"
            fill="none"
          />
        )}
      </svg>
    </span>
  );
}
