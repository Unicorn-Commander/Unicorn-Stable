/**
 * Avatar — the one primitive that renders a resident of the Stable, human or
 * agent, anywhere.
 *
 *   import { Avatar } from "@/components/ui/Avatar";
 *
 *   <Avatar avatarUrl={m.sender_avatar} id={m.sender_id} name={m.sender_name} />
 *   <Avatar avatarUrl={a.avatar_url} emoji={a.emoji} id={a.id} name={a.display_name} />
 *
 * It resolves through `lib/avatar.ts` (image -> emoji -> initials), so a
 * missing, hostile or dead URL degrades to something legible instead of a
 * broken-image glyph. Pass whatever you have; every field is optional.
 *
 * Two things it deliberately does NOT do:
 *
 *   * It never renders hover-only information. On a touch screen there is no
 *     hover, so anything that only appears on :hover is functionally missing.
 *     If you want a name on hover, wrap it in the Tooltip primitive, which
 *     handles tap.
 *   * It never applies identity colour through a Tailwind class. Identity hues
 *     are per-resident and computed at runtime; they go through `style`, which
 *     is also why they are hex rather than CSS vars.
 */
import { useEffect, useState } from "react";
import { resolveAvatar, type AvatarInput } from "@/lib/avatar";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

/** px. Kept as numbers, not classes, so the emoji/initials scale can be
 *  derived from the box rather than maintained as a parallel class map. */
const SIZE_PX: Record<AvatarSize, number> = {
  xs: 20,
  sm: 24,
  md: 32,
  lg: 40,
  xl: 96,
};

export interface AvatarProps extends AvatarInput {
  /** Named size, or an explicit pixel box. Default "md". */
  size?: AvatarSize | number;
  /** Tinted ring in the resident's identity colour. Off by default. */
  ring?: boolean;
  /** Square-ish instead of a circle (agents in the org chart read better). */
  rounded?: "full" | "lg";
  className?: string;
  /** Accessible label. Defaults to the resident's name. Set "" for decorative
   *  avatars that sit next to the name in text — a screen reader should not
   *  read the same name twice. */
  alt?: string;
}

export function Avatar({
  size = "md",
  ring = false,
  rounded = "full",
  className = "",
  alt,
  ...input
}: AvatarProps) {
  const px = typeof size === "number" ? size : SIZE_PX[size];
  const resolved = resolveAvatar(input);

  // A stored avatar URL can outlive the file it points at (host moved, file
  // pruned). Track load failure so we fall through to emoji/initials instead
  // of leaving a broken image in the message list forever.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [resolved.src]);

  const showImage = resolved.kind === "image" && resolved.src && !failed;
  const label = alt ?? input.name ?? input.id ?? "";
  const { identity } = resolved;

  const box: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: rounded === "full" ? "9999px" : Math.max(4, px * 0.22),
    // The identity wash sits under the image too, so a transparent PNG and a
    // slow-loading image both land on the resident's colour rather than on a
    // grey hole.
    background: showImage ? identity.soft : identity.gradient,
    boxShadow: ring ? `0 0 0 2px ${identity.ring}` : undefined,
  };

  return (
    <span
      className={`relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden ${className}`}
      style={box}
    >
      {showImage ? (
        <img
          src={resolved.src!}
          alt={label}
          width={px}
          height={px}
          loading="lazy"
          decoding="async"
          // Do NOT set crossOrigin here: it would turn every load into a CORS
          // request, and an avatar on another configured host may not send
          // Access-Control-Allow-Origin —
          // the image would simply fail. no-referrer is the useful half: it
          // stops the current room URL leaking to the image host.
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : resolved.kind === "emoji" || (failed && resolved.emoji) ? (
        <span
          aria-label={label || undefined}
          role={label ? "img" : undefined}
          // Emoji are square-ish; 58% of the box centres them without clipping
          // the taller glyphs.
          style={{ fontSize: Math.round(px * 0.58), lineHeight: 1 }}
        >
          {resolved.emoji}
        </span>
      ) : (
        <span
          aria-label={label || undefined}
          role={label ? "img" : undefined}
          className="font-semibold text-white"
          style={{
            fontSize: Math.round(px * 0.4),
            lineHeight: 1,
            letterSpacing: "0.02em",
          }}
        >
          {resolved.initials}
        </span>
      )}
    </span>
  );
}

export default Avatar;
