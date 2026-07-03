import { DollarSign } from "lucide-react";
import clsx from "clsx";
import type { Agent } from "@/services/api";
import { toolCostInfo } from "./agentClass";

/**
 * A compact amber "$N" badge shown when an agent has tools that cost money
 * (paid or subscription). Money = amber, consistent across Stable + Brigade.
 * Renders nothing when the agent has no paid tools.
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
  const names = paidTools.length
    ? paidTools.map((t) => t.displayName || t.name).join(", ")
    : `${paidCount} tool${paidCount === 1 ? "" : "s"}`;
  return (
    <span
      title={`Costs money: ${names}`}
      className={clsx(
        "inline-flex shrink-0 items-center gap-0.5 rounded-md bg-amber-500/15 font-semibold tabular-nums text-amber-200 ring-1 ring-amber-500/30",
        size === "xs" ? "px-1 py-0.5 text-[9px]" : "px-1.5 py-0.5 text-[10px]",
      )}
    >
      <DollarSign className={size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3"} />
      {paidCount}
    </span>
  );
}
