import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { api } from "@/services/api";
import { useFederationStore } from "@/stores/federationStore";
import { rowTime } from "./HomeRow";

/**
 * W6 — the knowledge rail. 39 collections existed on dogfood and home never
 * mentioned one; this is the smallest honest fix (top 5 by update recency).
 * Artifacts + transcript exports join this card in v2 via /home/summary —
 * there is no cross-room list endpoint for either today.
 */
export function KnowledgeRecents({
  onOpenKnowledge,
}: {
  /** Open the existing knowledge UI, optionally landing on one collection.
   * The KB panel only mounts inside a room (RoomView's right drawer), so the
   * caller owns the "which room hosts it" decision. */
  onOpenKnowledge: (collectionId?: string) => void;
}) {
  const activeInstanceId = useFederationStore((s) => s.activeInstanceId);

  // Own key (no react-query consumer existed for collections — the KB panel
  // reads them through knowledgeStore, which fetches on open, so there is no
  // cache to share yet). staleTime 60 s per spec §4.5.
  const { data: collections = [] } = useQuery({
    queryKey: ["knowledge-collections", activeInstanceId],
    queryFn: () => api.listCollections(),
    staleTime: 60_000,
  });

  const recent = useMemo(
    () =>
      [...collections]
        .sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        )
        .slice(0, 5),
    [collections],
  );

  return (
    <section aria-labelledby="home-knowledge-heading">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-item-agent" />
          <h2
            id="home-knowledge-heading"
            className="font-display text-sm font-semibold text-slate-200"
          >
            Knowledge
          </h2>
        </div>
        {recent.length > 0 && (
          <button
            type="button"
            onClick={() => onOpenKnowledge()}
            className="focus-ring rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.04] hover:text-slate-200"
          >
            Open Knowledge
          </button>
        )}
      </div>

      {recent.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
          No knowledge bases yet — create one to ground your agents.
        </p>
      ) : (
        <ul className="card overflow-hidden">
          {recent.map((collection, i) => (
            <li key={collection.id}>
              <button
                type="button"
                onClick={() => onOpenKnowledge(collection.id)}
                className={
                  "focus-ring flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.04]" +
                  (i > 0 ? " border-t border-line" : "")
                }
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-item-agent/15 text-item-agent">
                  <BookOpen className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-100">
                    {collection.name}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    updated {rowTime(collection.updated_at)} ago
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
