import { useMemo } from "react";
import clsx from "clsx";
import { lineDiff } from "./lineDiff";

/**
 * Read-only unified line diff between two version contents (prev → current).
 * Uses the dependency-free {@link lineDiff}. Surfaced from the version toolbar
 * as a "show changes" view when paging through history.
 */
export default function DiffView({
  before,
  after,
}: {
  before: string;
  after: string;
}) {
  const rows = useMemo(() => lineDiff(before, after), [before, after]);
  return (
    <div className="h-full min-h-0 overflow-auto bg-slate-950/40 p-3 font-mono text-xs leading-relaxed">
      {rows.map((r, i) => (
        <div
          key={i}
          className={clsx(
            "flex whitespace-pre-wrap break-words",
            r.type === "add" && "bg-green-500/10 text-green-300",
            r.type === "del" && "bg-red-500/10 text-red-300",
            r.type === "same" && "text-slate-400",
          )}
        >
          <span
            className={clsx(
              "mr-2 shrink-0 select-none",
              r.type === "add"
                ? "text-green-500"
                : r.type === "del"
                  ? "text-red-500"
                  : "text-slate-700",
            )}
          >
            {r.type === "add" ? "+" : r.type === "del" ? "-" : " "}
          </span>
          <span className="min-w-0 flex-1">{r.text || " "}</span>
        </div>
      ))}
    </div>
  );
}
