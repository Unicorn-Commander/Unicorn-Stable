import type { CSSProperties, ReactNode } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import clsx from "clsx";
import type { Message } from "@/services/api";
import { identityFor } from "@/lib/identity";

/**
 * The home dashboard's one room/message row: leading chip-or-avatar, title,
 * optional preview line, right-aligned timestamp + gradient unread pill.
 *
 * Extracted from HomeDashboard's inlined lists so the priority inbox, the
 * conversations tabs and the agent feed render IDENTICALLY — the page must
 * look like it was always one thing, and three hand-copied row markups is how
 * that stops being true.
 */

export function previewText(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 90 ? oneLine.slice(0, 90) + "…" : oneLine;
}

export function rowTime(dateStr: string): string {
  try {
    return formatDistanceToNowStrict(new Date(dateStr), { addSuffix: false });
  } catch {
    return "";
  }
}

/** The "Sender: preview" second line, sender name in their identity color. */
export function SenderLine({
  message,
  read,
  before,
}: {
  message: Message;
  /** Read rooms mute the preview a step (chats list behavior). */
  read?: boolean;
  /** Optional node rendered before the sender (e.g. the feed's room chip). */
  before?: ReactNode;
}) {
  return (
    <p
      className={clsx(
        "mt-0.5 truncate text-xs",
        read ? "text-slate-400" : "text-slate-300",
      )}
    >
      {before}
      <span
        className="font-medium"
        style={{
          color: identityFor(message.sender_id, message.sender_name).text,
        }}
      >
        {message.sender_name}:
      </span>{" "}
      {previewText(message.content)}
    </p>
  );
}

export interface HomeRowProps {
  /** 9×9 icon chip or avatar. Callers own the chip so item-type color stays
   * with the list that knows what the row is. */
  leading: ReactNode;
  title: string;
  /** Inline color override — the agent feed titles carry the sender's
   * identity color, same as sender names in previews. */
  titleStyle?: CSSProperties;
  /** Unread rows title in font-semibold/slate-50; read rows step down. */
  emphasis?: boolean;
  /** ISO timestamp for the right-aligned relative time. */
  at?: string | null;
  unread?: number;
  /** Extra right-cluster node rendered before the time (e.g. "3/12 here"). */
  aside?: ReactNode;
  /** Second line — usually a {@link SenderLine} or an italic fallback. */
  line?: ReactNode;
  /** Row tint classes (purple for priority, rose for approvals, none…). */
  tint?: string;
  /** border-t separator — true for every row but the first. */
  divider?: boolean;
  onClick: () => void;
}

export function HomeRow({
  leading,
  title,
  titleStyle,
  emphasis = true,
  at,
  unread = 0,
  aside,
  line,
  tint,
  divider,
  onClick,
}: HomeRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "focus-ring flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.04]",
        divider && "border-t border-line",
        tint,
      )}
    >
      {leading}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={clsx(
              "truncate text-sm",
              emphasis
                ? "font-semibold text-slate-50"
                : "font-medium text-slate-200",
            )}
            style={titleStyle}
          >
            {title}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {aside}
            {at && (
              <span className="text-[11px] tabular-nums text-slate-500">
                {rowTime(at)}
              </span>
            )}
            {unread > 0 && (
              <span className="gradient-bg grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </span>
        </span>
        {line}
      </span>
    </button>
  );
}
