/**
 * The one agent status dot.
 *
 * Previously this was a bare `<span>` plus a `statusDot()` class string, open-
 * coded at five call sites — and `statusDot()` itself existed twice, in
 * agentClass.ts and again inside HomeDashboard.tsx, where the two copies had
 * already drifted (one pulsed "active", the other did not). Two copies of the
 * rule for what a colour MEANS is how a state encoding rots, so there is now
 * one component and one table.
 *
 * The dot is 6-14px with no adjacent text at most call sites, which makes
 * colour its only channel for sighted users and NO channel at all for a screen
 * reader. So:
 *
 *  - The colours come from the `--color-status-*` tokens, which carry an
 *    enforced separation contract (check-contrast.mjs, STATE_GROUPS) rather
 *    than merely clearing a contrast floor against the background. They are
 *    also theme-aware, which the old raw `bg-emerald-400` / `bg-slate-400`
 *    utilities were not — in light mode those rendered at ~1.9:1 on white.
 *  - Every dot carries an accessible name and a tooltip, so the state is
 *    readable by assistive tech and confirmable on hover. Pass `labelled={false}`
 *    where the row already prints the status as text, so it is not announced
 *    twice.
 *
 * Rejected on purpose: a hollow-ring form for "offline" (Slack's trick). At the
 * 6px size used in AgentList's inline row the ring has no interior left to
 * read, so it would be a decoration that only works at some sizes — worse than
 * no second channel, because it looks like one. Motion is out for the same
 * class of reason: `animate-live` is correctly disabled under
 * prefers-reduced-motion, so it can never be load-bearing.
 */
import clsx from "clsx";
import type { Agent } from "@/services/api";
import { Tooltip } from "@/components/ui/Tooltip";
import { STATUS_LABEL, statusDot } from "./agentClass";

export interface StatusDotProps {
  status: Agent["status"];
  /** Size + positioning classes from the call site, e.g. "h-3 w-3 absolute". */
  className?: string;
  /**
   * Announce + tooltip the status. Default true. Set false when the adjacent
   * text already says it, to avoid a duplicate announcement.
   */
  labelled?: boolean;
}

export function StatusDot({ status, className, labelled = true }: StatusDotProps) {
  const label = STATUS_LABEL[status];
  const dot = (
    <span
      className={clsx("rounded-full", statusDot(status), className)}
      {...(labelled
        ? { role: "img" as const, "aria-label": label }
        : { "aria-hidden": true as const })}
    />
  );
  // No tooltip when unlabelled — the text next to it already says the same
  // thing, and a hint that repeats its own neighbour is noise.
  return labelled ? <Tooltip content={label}>{dot}</Tooltip> : dot;
}

export default StatusDot;
