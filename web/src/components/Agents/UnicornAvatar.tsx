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
 *
 * ── Why it is drawn as a STICKER ───────────────────────────────────────────
 * This is the guaranteed-renders rung: some agents will always land here, so
 * it sits directly beside the real portraits in the roster and the org chart.
 * The first version was a pastel lavender head with pink blush on a
 * transparent ground, and next to the shipped art it read as a placeholder
 * rather than as a resident — Aaron, 2026-08-12: "that basic unicorn that's
 * not the same style as our brand".
 *
 * So it now draws the same costume the authored portraits wear: a flat dark
 * navy disc (#131a28, sampled from the masters), a white sticker border, thick
 * black outlines, a purple→cyan mane and a gold horn. What it deliberately
 * does NOT do is imitate a specific character — no jacket, no prop, no
 * insignia. It should read as "a resident of this Stable whose portrait has
 * not been drawn yet", never as a particular agent.
 *
 * The identity hue survives all of that: it seeds the mane's midpoint, so the
 * fallback is still deterministic per agent and two agents side by side stay
 * distinguishable. That property is load-bearing — keep it.
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
          {/* Brand purple → identity hue → brand cyan. The endpoints are the
              Magic Unicorn gradient every authored portrait's mane uses; the
              identity colour rides in the middle so the fallback still tells
              two agents apart without leaving the palette. */}
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#b66eff" />
            <stop offset="50%" stopColor={ident.color} />
            <stop offset="100%" stopColor="#00d4ff" />
          </linearGradient>
          <linearGradient id={`${gradientId}-horn`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fde68a" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
        </defs>

        {/* Flat navy ground — the colour sampled from the portrait masters, so
            a fallback tile and a real one sit on the same field. */}
        <rect x="0" y="0" width="64" height="64" rx="14" fill="#131a28" />

        {/* The figure is scaled about its own centre to leave room for the
            sticker border; at 64² the horn tip would otherwise clip the edge. */}
        <g transform="translate(32 31) scale(0.86) translate(-34 -30)">
          {/* STICKER BORDER. The silhouette drawn once as a fat white stroke,
              underneath everything. The internal strokes are covered by the
              fills that follow, so only the outer edge survives — the same
              trick the authored art's die-cut border is drawn with. */}
          <g
            fill="#ffffff"
            stroke="#ffffff"
            strokeWidth="6"
            strokeLinejoin="round"
          >
            <path d="M14 40 C10 22 22 8 38 10 C52 12 58 26 54 42 C50 54 40 58 32 57 C40 50 42 44 38 38 C30 44 20 48 14 40 Z" />
            <path d="M22 14 L27 24 L18 24 Z" />
            <path d="M40 12 L46 23 L35 22 Z" />
            <path d="M31 2 L36.5 20 L26.5 20 Z" />
            <ellipse cx="31" cy="37" rx="17.5" ry="16" />
          </g>

          {/* Ink line for every shape below — thick black outlines are the
              single strongest style cue in the portrait set. */}
          <g stroke="#0b0d16" strokeWidth="1.7" strokeLinejoin="round">
            {/* Mane sweep behind the head — the identity colour carrier. */}
            <path
              d="M14 40 C10 22 22 8 38 10 C52 12 58 26 54 42 C50 54 40 58 32 57 C40 50 42 44 38 38 C30 44 20 48 14 40 Z"
              fill={`url(#${gradientId})`}
            />

            {/* Ears — the right one flicks now and then. */}
            <path d="M22 14 L27 24 L18 24 Z" fill="#f4f2ff" />
            <path
              d="M40 12 L46 23 L35 22 Z"
              fill="#f4f2ff"
              className="animate-unicorn-ear"
              style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
            />

            {/* Horn. */}
            <path d="M31 2 L36.5 20 L26.5 20 Z" fill={`url(#${gradientId}-horn)`} />

            {/* Head and muzzle. The muzzle is CENTRED under the head rather
                than offset: the authored portraits are all straight-on busts,
                and a three-quarter turn here was the other half of why the
                fallback read as a different character set. */}
            <ellipse cx="31" cy="37" rx="17.5" ry="16" fill="#f4f2ff" />
            <ellipse cx="31" cy="45.5" rx="11" ry="8" fill="#fbfaff" />
          </g>

          {/* Nostrils. */}
          <circle cx="27.6" cy="44.6" r="1.15" fill="#0b0d16" opacity="0.55" />
          <circle cx="34.4" cy="44.6" r="1.15" fill="#0b0d16" opacity="0.55" />

          {/* Forelock strand, unstroked so it reads as hair over the brow. */}
          <path
            d="M24 20 C30 16 38 17 42 22 C36 21 30 22 27 27 C26 24 25 22 24 20 Z"
            fill={ident.color}
          />

          {/* Eyes — solid black ink and a straight-on pair, matching the set.
              Both blink together; one lid closing on its own reads as a wink. */}
          <g
            fill="#0b0d16"
            className={clsx(!offline && "animate-unicorn-blink")}
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
          >
            <ellipse cx="24.6" cy="35.4" rx="2.7" ry="3.7" />
            <ellipse cx="37.4" cy="35.4" rx="2.7" ry="3.7" />
          </g>

          {/* Mouth — a resting line, or an animated open mouth while talking. */}
          {talking ? (
            <ellipse
              cx="31"
              cy="48"
              rx="3"
              ry="2.6"
              fill="#0b0d16"
              className="animate-unicorn-talk"
              style={{ transformBox: "fill-box", transformOrigin: "center" }}
            />
          ) : (
            <path
              d="M28 48.6 Q31 50.6 34 48.6"
              stroke="#0b0d16"
              strokeWidth="1.4"
              strokeLinecap="round"
              fill="none"
            />
          )}
        </g>
      </svg>
    </span>
  );
}
