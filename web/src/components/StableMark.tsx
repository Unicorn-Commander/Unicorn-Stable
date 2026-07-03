/**
 * The Stable brand mark — a unicorn horn rising through an aurora tile.
 * Inline SVG so it inherits crispness at any size; keep in sync with
 * public/favicon.svg (same artwork).
 */
export function StableMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient
          id="stable-mark-g"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="64"
          y2="64"
        >
          <stop offset="0%" stopColor="#8b5cf6" />
          <stop offset="55%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#stable-mark-g)" />
      {/* Horn — tapered spire */}
      <path
        d="M45 11 Q33 28 19 49 Q24 54 30 55 Q40 34 45 11 Z"
        fill="#ffffff"
        opacity="0.96"
      />
      {/* Spiral bands — sample the tile gradient so they read as cuts */}
      <path
        d="M25.8 34.8 L37.6 40.6"
        stroke="url(#stable-mark-g)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        d="M31.9 24.9 L41.7 29.9"
        stroke="url(#stable-mark-g)"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
      {/* Spark */}
      <path
        d="M17 9 L19.3 15 L25 17.2 L19.3 19.4 L17 25.4 L14.7 19.4 L9 17.2 L14.7 15 Z"
        fill="#ffffff"
        opacity="0.92"
      />
    </svg>
  );
}
