import { useEffect, type ReactNode } from "react";
import clsx from "clsx";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
} from "lucide-react";
import {
  useSplitPane,
  type SplitHandleAria,
  type SplitOrientation,
} from "@/hooks/useSplitPane";

/**
 * SplitPane — a resizable two-pane region built on {@link useSplitPane}.
 *
 * The `primary` pane is `flex-1` (takes the remaining space); the `secondary`
 * (end) pane is the one whose size is dragged + persisted. A draggable divider
 * sits between them, and — when `collapsible` — the secondary can be collapsed
 * to an edge tab (it stays MOUNTED behind `display:none`, so a chat panel keeps
 * its scroll position, subscriptions and unread state while hidden).
 *
 * Orientation is a prop, so one instance flips between side-by-side (desktop)
 * and stacked (mobile) across a breakpoint without remounting either pane.
 */

export interface SplitPaneProps {
  /** Stable localStorage key (sizes are stored per axis under this key). */
  storageKey: string;
  orientation: SplitOrientation;
  defaultSize: number;
  min: number;
  max: number;
  primary: ReactNode;
  secondary: ReactNode;
  collapsible?: boolean;
  /** Human label for the secondary pane, used on the handle + expand tab. */
  secondaryLabel?: string;
  /** Controlled collapse (optional). When omitted the split manages it itself. */
  collapsed?: boolean;
  onCollapsedChange?: (v: boolean) => void;
  /**
   * When collapsed, skip the in-flow expand tab so the primary pane is the
   * full width of the split. The call bar restores a hidden chat.
   */
  fullBleedWhenCollapsed?: boolean;
  onSizeCommit?: (size: number) => void;
  /**
   * When `preferredEpoch` changes to a non-zero value, snap the secondary
   * size to `preferredSize` (a layout preset). User drags do not bump the epoch.
   */
  preferredSize?: number;
  preferredEpoch?: number;
  /**
   * Older storage key whose saved width is copied once when this key is empty.
   * Used so `call-chat` (one width for every room) seeds `call-chat:${roomId}`.
   */
  legacyStorageKey?: string;
  className?: string;
}

export function SplitPane({
  storageKey,
  orientation,
  defaultSize,
  min,
  max,
  primary,
  secondary,
  collapsible = false,
  secondaryLabel = "panel",
  collapsed: collapsedProp,
  onCollapsedChange,
  fullBleedWhenCollapsed = false,
  onSizeCommit,
  preferredSize,
  preferredEpoch = 0,
  legacyStorageKey,
  className,
}: SplitPaneProps) {
  const split = useSplitPane(storageKey, {
    defaultSize,
    min,
    max,
    orientation,
    collapsible,
    onSizeCommit,
    legacyKey: legacyStorageKey,
  });

  // Support a controlled `collapsed` prop while keeping the persisted internal
  // state as the default. When controlled, mirror the prop into the hook so the
  // persisted value + aria stay consistent.
  const commitSize = split.commitSize;
  useEffect(() => {
    if (!preferredEpoch || preferredSize == null) return;
    commitSize(preferredSize);
  }, [preferredEpoch, preferredSize, commitSize]);

  const collapsed = collapsedProp ?? split.collapsed;
  useEffect(() => {
    if (collapsedProp !== undefined && collapsedProp !== split.collapsed) {
      split.setCollapsed(collapsedProp);
    }
  }, [collapsedProp, split]);

  const setCollapsed = (v: boolean) => {
    if (onCollapsedChange) onCollapsedChange(v);
    if (collapsedProp === undefined) split.setCollapsed(v);
  };

  const isH = orientation === "horizontal";
  const bleed = collapsed && fullBleedWhenCollapsed;

  return (
    <div
      className={clsx(
        "flex min-h-0 min-w-0 flex-1",
        isH ? "flex-row" : "flex-col",
        className,
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1">{primary}</div>

      {bleed ? null : collapsed ? (
        <ExpandTab
          orientation={orientation}
          label={secondaryLabel}
          onExpand={() => setCollapsed(false)}
        />
      ) : (
        <SplitHandle
          orientation={orientation}
          label={secondaryLabel}
          dragHandleProps={split.dragHandleProps}
          collapsible={collapsible}
          onCollapse={() => setCollapsed(true)}
        />
      )}

      {/* Secondary stays mounted even when collapsed (display:none) so its state
          survives a collapse/expand cycle. */}
      <div
        className={clsx(
          "flex min-h-0 min-w-0 shrink-0 overflow-hidden",
          collapsed && "hidden",
        )}
        style={
          collapsed
            ? undefined
            : isH
              ? { width: split.size }
              : { height: split.size }
        }
      >
        {secondary}
      </div>
    </div>
  );
}

interface SplitHandleProps {
  orientation: SplitOrientation;
  label: string;
  dragHandleProps: SplitHandleAria;
  collapsible: boolean;
  onCollapse: () => void;
}

/**
 * The divider: an in-flow flex item with a centered grip pill and (optionally) a
 * collapse chevron. The chevron is a sibling overlay whose pointerdown is
 * stopped so pressing it never starts a drag.
 */
function SplitHandle({
  orientation,
  label,
  dragHandleProps,
  collapsible,
  onCollapse,
}: SplitHandleProps) {
  const isH = orientation === "horizontal";
  const CollapseIcon = isH ? ChevronRight : ChevronDown;
  return (
    <div
      className={clsx(
        "relative shrink-0 self-stretch",
        isH ? "w-1.5" : "h-1.5",
      )}
    >
      <div
        {...dragHandleProps}
        aria-label={`Resize ${label}`}
        title="Drag to resize · double-click to reset"
        className={clsx(
          "group absolute inset-0 touch-none select-none",
          isH ? "cursor-col-resize" : "cursor-row-resize",
          "data-[dragging=true]:bg-stable-purple/5",
          "focus:outline-none",
          // grip pill (::before) — the at-rest affordance
          "before:pointer-events-none before:absolute before:left-1/2 before:top-1/2 before:-translate-x-1/2 before:-translate-y-1/2",
          "before:rounded-full before:bg-white/20 before:transition-all before:duration-150 before:content-['']",
          isH ? "before:h-8 before:w-[3px]" : "before:h-[3px] before:w-8",
          // seam glow (::after)
          "after:pointer-events-none after:absolute after:bg-transparent after:transition-colors after:duration-150 after:content-['']",
          isH
            ? "after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2"
            : "after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2",
          // hover / focus / active — grip grows + turns purple, seam lights up
          isH
            ? "hover:before:h-14 focus-visible:before:h-14 data-[dragging=true]:before:h-14"
            : "hover:before:w-14 focus-visible:before:w-14 data-[dragging=true]:before:w-14",
          "hover:before:bg-stable-purple/80 hover:after:bg-stable-purple/40",
          "focus-visible:before:bg-stable-purple focus-visible:after:bg-stable-purple/50",
          "data-[dragging=true]:before:bg-stable-purple data-[dragging=true]:after:bg-stable-purple/50",
        )}
      />
      {collapsible && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onCollapse}
          aria-label={`Collapse ${label}`}
          title={`Hide ${label}`}
          className={clsx(
            "glass focus-ring absolute z-10 flex items-center justify-center rounded-full p-0.5 text-slate-300 opacity-100 transition-opacity hover:text-white focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100",
            isH
              ? "left-1/2 top-3 -translate-x-1/2"
              : "left-3 top-1/2 -translate-y-1/2",
          )}
        >
          <CollapseIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

interface ExpandTabProps {
  orientation: SplitOrientation;
  label: string;
  onExpand: () => void;
}

/** Slim edge affordance shown in place of the secondary pane when collapsed. */
function ExpandTab({ orientation, label, onExpand }: ExpandTabProps) {
  const isH = orientation === "horizontal";
  const ExpandIcon = isH ? ChevronLeft : ChevronUp;
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Show ${label}`}
      title={`Show ${label}`}
      className={clsx(
        "focus-ring group flex shrink-0 items-center justify-center border-line bg-surface-1/70 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100",
        isH ? "w-6 self-stretch border-l" : "h-6 self-stretch border-t",
      )}
    >
      <ExpandIcon className="h-4 w-4 transition-transform group-hover:scale-110" />
    </button>
  );
}
