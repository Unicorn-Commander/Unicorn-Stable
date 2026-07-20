/**
 * Tooltip — the one hover/focus-hint primitive for the app.
 *
 * Replaces one-off `title=""` attributes, which cannot be styled, cannot carry
 * a shortcut chip, have an un-tunable ~1s delay, and never appear on touch.
 *
 * Accessibility contract (all four matter, and all four are easy to get wrong):
 *  - NOT hover-only. Keyboard focus shows it, Escape dismisses it, and touch
 *    devices get long-press. A control whose only affordance is a tooltip is
 *    still operable with a keyboard or a thumb.
 *  - Never traps focus. The bubble renders in a portal with pointer-events:none
 *    and is not focusable, so Tab order is exactly what it was without it.
 *  - Described, not labelled. The trigger keeps its own accessible name and
 *    gains `aria-describedby`. Using a tooltip as the *only* name is wrong, so
 *    icon-only triggers should still carry their own aria-label — pass
 *    `labelledBy` to have this component set it from the tooltip text.
 *  - Collision-aware. Placement flips to the opposite side when it would
 *    overflow the viewport and is then clamped, so a tooltip on a control at
 *    the screen edge is never clipped.
 *
 * Usage:
 *   <Tooltip content="Mute microphone" shortcut="M">
 *     <button aria-label="Mute microphone">…</button>
 *   </Tooltip>
 */
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  /** Tooltip body. Keep it short — this is a hint, not documentation. */
  content: ReactNode;
  /**
   * Optional keyboard shortcut rendered as a chip after the content, e.g. "⌘K"
   * or "Shift+/". Purely visual; it is included in the described text.
   */
  shortcut?: string;
  /** Preferred side. Flips automatically if it would overflow. */
  placement?: TooltipPlacement;
  /** Hover open delay in ms. 0 while another tooltip is already open. */
  delay?: number;
  /**
   * Also use the tooltip text as the trigger's accessible name. Only for
   * icon-only controls that have no other label — otherwise leave this off and
   * let the trigger keep its own aria-label.
   */
  labelledBy?: boolean;
  /** Escape hatch: render the trigger but never show the bubble. */
  disabled?: boolean;
  /** The trigger. Must be a single element that forwards ref + DOM props. */
  children: ReactElement;
}

/** Gap between trigger and bubble, and the minimum inset from the viewport. */
const OFFSET = 8;
const VIEWPORT_PAD = 8;
const TOUCH_HOLD_MS = 450;
const TOUCH_VISIBLE_MS = 2500;

/**
 * Shared "a tooltip is currently open" flag. Once one is open, moving along a
 * toolbar should show the next one immediately rather than re-waiting the full
 * delay — the same warm-up behaviour every good tooltip implementation has.
 */
let groupWarm = false;
let groupCooldown: ReturnType<typeof setTimeout> | null = null;

interface Coords {
  top: number;
  left: number;
  placement: TooltipPlacement;
}

export function Tooltip({
  content,
  shortcut,
  placement = "top",
  delay = 350,
  labelledBy = false,
  disabled = false,
  children,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (touchTimer.current) {
      clearTimeout(touchTimer.current);
      touchTimer.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    setOpen(false);
    setCoords(null);
    // Keep the group warm briefly so sweeping across a toolbar feels instant.
    if (groupCooldown) clearTimeout(groupCooldown);
    groupCooldown = setTimeout(() => {
      groupWarm = false;
    }, 300);
  }, [clearTimers]);

  const show = useCallback(
    (wait: number) => {
      if (disabled) return;
      clearTimers();
      const run = () => {
        groupWarm = true;
        if (groupCooldown) {
          clearTimeout(groupCooldown);
          groupCooldown = null;
        }
        setOpen(true);
      };
      if (wait <= 0) run();
      else openTimer.current = setTimeout(run, wait);
    },
    [disabled, clearTimers],
  );

  useEffect(() => clearTimers, [clearTimers]);

  /**
   * Position after the bubble has rendered (we need its measured size to flip
   * and clamp). useLayoutEffect so the first painted frame is already in the
   * right place — otherwise the tooltip visibly jumps from 0,0.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;

    const compute = () => {
      const t = trigger.getBoundingClientRect();
      const b = bubble.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const fits: Record<TooltipPlacement, boolean> = {
        top: t.top - b.height - OFFSET >= VIEWPORT_PAD,
        bottom: t.bottom + b.height + OFFSET <= vh - VIEWPORT_PAD,
        left: t.left - b.width - OFFSET >= VIEWPORT_PAD,
        right: t.right + b.width + OFFSET <= vw - VIEWPORT_PAD,
      };
      const opposite: Record<TooltipPlacement, TooltipPlacement> = {
        top: "bottom",
        bottom: "top",
        left: "right",
        right: "left",
      };
      // Preferred side, else its opposite, else the first side that fits, else
      // stay on the preferred side and let the clamp below rescue it.
      let side = placement;
      if (!fits[side]) {
        if (fits[opposite[side]]) side = opposite[side];
        else {
          const any = (Object.keys(fits) as TooltipPlacement[]).find((k) => fits[k]);
          if (any) side = any;
        }
      }

      let top: number;
      let left: number;
      switch (side) {
        case "bottom":
          top = t.bottom + OFFSET;
          left = t.left + t.width / 2 - b.width / 2;
          break;
        case "left":
          top = t.top + t.height / 2 - b.height / 2;
          left = t.left - b.width - OFFSET;
          break;
        case "right":
          top = t.top + t.height / 2 - b.height / 2;
          left = t.right + OFFSET;
          break;
        default:
          top = t.top - b.height - OFFSET;
          left = t.left + t.width / 2 - b.width / 2;
      }

      // Clamp into the viewport so an edge-of-screen trigger is never clipped.
      left = Math.min(Math.max(left, VIEWPORT_PAD), vw - b.width - VIEWPORT_PAD);
      top = Math.min(Math.max(top, VIEWPORT_PAD), vh - b.height - VIEWPORT_PAD);

      setCoords({ top, left, placement: side });
    };

    compute();
    // A tooltip anchored to something inside a scroller must follow it, and
    // must not linger mid-air after a resize.
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [open, placement, content, shortcut]);

  /** Escape closes — required for hover-triggered content (WCAG 1.4.13). */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      hide();
      // Dismiss only the topmost layer: without this the same Esc that closes
      // the tooltip also closes the surrounding modal, which feels broken. A
      // second Esc (no tooltip open, this listener detached) closes the modal.
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, hide]);

  if (!isValidElement(children)) return children ?? null;

  const describedText =
    typeof content === "string" && shortcut ? `${content} (${shortcut})` : undefined;

  type TriggerProps = Record<string, unknown> & {
    ref?: Ref<HTMLElement>;
    "aria-describedby"?: string;
    "aria-label"?: string;
  };
  const childProps = (children.props ?? {}) as TriggerProps;

  const chain =
    <E,>(theirs: ((e: E) => void) | undefined, ours: (e: E) => void) =>
    (e: E) => {
      theirs?.(e);
      ours(e);
    };

  const trigger = cloneElement(children as ReactElement<TriggerProps>, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      // Preserve whatever ref the caller already had on the trigger. React 19
      // passes ref through props; older elements carry it on the element. Check
      // both so wrapping a ref'd trigger never silently drops their ref.
      const theirs =
        childProps.ref ?? (children as unknown as { ref?: Ref<HTMLElement> }).ref;
      if (typeof theirs === "function") theirs(node);
      else if (theirs && typeof theirs === "object") {
        (theirs as { current: HTMLElement | null }).current = node;
      }
    },
    // Described, not named — unless the caller opts in for an icon-only button.
    "aria-describedby": open && !labelledBy ? id : childProps["aria-describedby"],
    "aria-label":
      labelledBy && typeof content === "string"
        ? (describedText ?? content)
        : childProps["aria-label"],
    onPointerEnter: chain(
      childProps.onPointerEnter as ((e: React.PointerEvent) => void) | undefined,
      (e: React.PointerEvent) => {
        // Touch "hover" fires spuriously right before a tap — long-press below
        // is that platform's affordance instead.
        if (e.pointerType === "touch") return;
        show(groupWarm ? 0 : delay);
      },
    ),
    onPointerLeave: chain(
      childProps.onPointerLeave as ((e: React.PointerEvent) => void) | undefined,
      (e: React.PointerEvent) => {
        if (e.pointerType === "touch") return;
        hide();
      },
    ),
    onPointerDown: chain(
      childProps.onPointerDown as ((e: React.PointerEvent) => void) | undefined,
      (e: React.PointerEvent) => {
        if (e.pointerType === "touch") {
          // Long-press reveals. The tap itself still fires normally, so this
          // adds an affordance without taking the primary action away.
          clearTimers();
          touchTimer.current = setTimeout(() => {
            show(0);
            touchTimer.current = setTimeout(hide, TOUCH_VISIBLE_MS);
          }, TOUCH_HOLD_MS);
          return;
        }
        // Mouse: acting on the control should dismiss the hint immediately.
        hide();
      },
    ),
    onPointerUp: chain(
      childProps.onPointerUp as ((e: React.PointerEvent) => void) | undefined,
      (e: React.PointerEvent) => {
        // Cancel a long-press that did not reach the threshold; leave an
        // already-visible one to time out on its own.
        if (e.pointerType === "touch" && !open) clearTimers();
      },
    ),
    onFocus: chain(
      childProps.onFocus as ((e: React.FocusEvent) => void) | undefined,
      (e: React.FocusEvent) => {
        // focus-visible only: clicking a button should not pop its tooltip,
        // but Tab-ing to it must.
        const el = e.currentTarget as HTMLElement;
        if (typeof el.matches === "function" && !el.matches(":focus-visible")) return;
        show(0);
      },
    ),
    onBlur: chain(
      childProps.onBlur as ((e: React.FocusEvent) => void) | undefined,
      hide,
    ),
  } as TriggerProps);

  return (
    <>
      {trigger}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            data-placement={coords?.placement ?? placement}
            className="tooltip-surface"
            style={{
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              // Hide the pre-measurement frame rather than flashing it at 0,0.
              visibility: coords ? "visible" : "hidden",
            }}
          >
            {content}
            {shortcut ? <span className="tooltip-kbd">{shortcut}</span> : null}
          </div>,
          document.body,
        )}
    </>
  );
}

export default Tooltip;
