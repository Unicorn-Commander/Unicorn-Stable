import clsx from "clsx";
import { Bot } from "lucide-react";
import { identityFor } from "@/lib/identity";

interface AvatarProps {
  name: string;
  src?: string | null;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  isAgent?: boolean;
  /**
   * Emoji identity (agents carry one from Brigade's roster). Rendered on the
   * identity gradient when there's no `src` — so every agent reads as itself
   * instead of an interchangeable Bot glyph. Falls back to Bot (agents) or
   * initials (people) when absent.
   */
  emoji?: string | null;
  className?: string;
  ringColor?: string;
  /**
   * Optional stable resident id (sender/participant id). Purely presentational:
   * it keys the identity hue so the fallback color matches the sender-name
   * color everywhere. Omitted → hashes the display name (previous behavior).
   */
  id?: string | null;
}

const SIZE: Record<NonNullable<AvatarProps["size"]>, string> = {
  xs: "h-5 w-5 text-[10px]",
  sm: "h-7 w-7 text-xs",
  md: "h-9 w-9 text-sm",
  lg: "h-12 w-12 text-base",
  xl: "h-20 w-20 text-2xl",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  return ((first[0] ?? "?") + (last[0] ?? "")).toUpperCase();
}

export function Avatar({
  name,
  src,
  size = "md",
  isAgent,
  emoji,
  className,
  ringColor,
  id,
}: AvatarProps) {
  const sz = SIZE[size];
  const ring = ringColor ? `ring-2 ${ringColor} ring-offset-2 ring-offset-slate-900` : "";
  // Identity hue — stable per resident of the Stable (id wins, name fallback).
  const ident = identityFor(id, name);
  const glyph = emoji?.trim() || null;

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={clsx(
          sz,
          "shrink-0 rounded-full object-cover",
          ring,
          className,
        )}
      />
    );
  }

  if (glyph) {
    return (
      <div
        className={clsx(
          sz,
          "flex shrink-0 select-none items-center justify-center rounded-full leading-none",
          ring,
          className,
        )}
        style={{ background: ident.gradient }}
        title={name}
      >
        <span className="text-[1.05em]" aria-hidden="true">
          {glyph}
        </span>
      </div>
    );
  }

  if (isAgent) {
    return (
      <div
        className={clsx(
          sz,
          "flex shrink-0 items-center justify-center rounded-full text-white",
          ring,
          className,
        )}
        style={{ background: ident.gradient }}
        title={name}
      >
        <Bot className="h-1/2 w-1/2" />
      </div>
    );
  }

  return (
    <div
      className={clsx(
        sz,
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        ring,
        className,
      )}
      style={{ background: ident.gradient }}
      title={name}
    >
      {initials(name || "?")}
    </div>
  );
}
