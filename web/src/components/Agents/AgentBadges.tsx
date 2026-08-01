import { Coins } from "lucide-react";
import clsx from "clsx";
import type { Agent } from "@/services/api";
import { toolCostInfo } from "./agentClass";

/**
 * Badge that says how many of an agent's tools COST MONEY.
 *
 * It used to render a dollar glyph next to an integer — "$ 4" — which reads as
 * four dollars, and got asked about as if it were a bill. It never was an
 * amount: it is a count of tools whose costTier is anything but free, and the
 * agent may run them a thousand times or never. So the number now carries the
 * word "paid" beside it, the glyph is coins rather than a currency sign, and
 * the accessible name spells the whole thing out.
 *
 * Money is still amber, consistent across Stable + Brigade. Renders nothing
 * when nothing costs money.
 */
export function PaidToolsBadge({
  agent,
  size = "sm",
}: {
  agent: Agent;
  size?: "sm" | "xs";
}) {
  const { paidCount, paidTools } = toolCostInfo(agent);
  if (paidCount <= 0) return null;
  const head = `${paidCount} paid tool${paidCount === 1 ? "" : "s"} (cost money to run)`;
  const summary = paidTools.length
    ? `${head}: ${paidTools.map((t) => t.displayName || t.name).join(", ")}`
    : head;
  const xs = size === "xs";
  return (
    <span
      title={summary}
      aria-label={summary}
      className={clsx(
        "inline-flex shrink-0 items-center gap-0.5 rounded-md bg-amber-500/15 font-semibold tabular-nums text-amber-200 ring-1 ring-amber-500/30",
        xs ? "px-1 py-0.5 text-[9px]" : "px-1.5 py-0.5 text-[10px]",
      )}
    >
      <Coins aria-hidden="true" className={xs ? "h-2.5 w-2.5" : "h-3 w-3"} />
      {paidCount} paid{xs ? "" : ` tool${paidCount === 1 ? "" : "s"}`}
    </span>
  );
}
