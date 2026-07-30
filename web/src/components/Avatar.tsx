/**
 * Compatibility adapter for the original Stable Avatar API.
 *
 * New code should import `components/ui/Avatar` directly. Keeping this thin
 * adapter lets every existing chat, participant, call, search, and settings
 * surface share the same safe image -> emoji -> initials resolution today,
 * without a risky flag-day rewrite of prop names.
 */
import { Avatar as ResidentAvatar } from "@/components/ui/Avatar";

interface AvatarProps {
  name: string;
  src?: string | null;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  isAgent?: boolean;
  emoji?: string | null;
  className?: string;
  ringColor?: string;
  id?: string | null;
}

const SIZE: Record<
  NonNullable<AvatarProps["size"]>,
  number
> = {
  xs: 20,
  sm: 28,
  md: 36,
  lg: 48,
  xl: 80,
};

export function Avatar({
  name,
  src,
  size = "md",
  emoji,
  className,
  ringColor,
  id,
}: AvatarProps) {
  return (
    <ResidentAvatar
      name={name}
      id={id}
      avatarUrl={src}
      emoji={emoji}
      size={SIZE[size]}
      ring={Boolean(ringColor)}
      className={className}
    />
  );
}
