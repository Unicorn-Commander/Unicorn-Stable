import clsx from "clsx";
import { Bot } from "lucide-react";

interface AvatarProps {
  name: string;
  src?: string | null;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  isAgent?: boolean;
  className?: string;
  ringColor?: string;
}

const SIZE: Record<NonNullable<AvatarProps["size"]>, string> = {
  xs: "h-5 w-5 text-[10px]",
  sm: "h-7 w-7 text-xs",
  md: "h-9 w-9 text-sm",
  lg: "h-12 w-12 text-base",
  xl: "h-20 w-20 text-2xl",
};

// Tailwind-safe palette of background colors. Hash on name → stable color per user.
const PALETTE = [
  "bg-rose-500",
  "bg-pink-500",
  "bg-fuchsia-500",
  "bg-purple-500",
  "bg-violet-500",
  "bg-indigo-500",
  "bg-blue-500",
  "bg-sky-500",
  "bg-cyan-500",
  "bg-teal-500",
  "bg-emerald-500",
  "bg-green-500",
  "bg-lime-600",
  "bg-amber-500",
  "bg-orange-500",
  "bg-red-500",
];

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length] ?? PALETTE[0]!;
}

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
  className,
  ringColor,
}: AvatarProps) {
  const sz = SIZE[size];
  const ring = ringColor ? `ring-2 ${ringColor} ring-offset-2 ring-offset-slate-900` : "";

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

  if (isAgent) {
    return (
      <div
        className={clsx(
          sz,
          "flex shrink-0 items-center justify-center rounded-full bg-stable-cyan/20 text-stable-cyan",
          ring,
          className,
        )}
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
        colorFor(name || "?"),
        ring,
        className,
      )}
      title={name}
    >
      {initials(name || "?")}
    </div>
  );
}
