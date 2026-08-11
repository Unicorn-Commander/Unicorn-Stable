import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type HomeSummary } from "@/services/api";
import { useFederationStore } from "@/stores/federationStore";
import {
  liveCallsByRoom,
  type LiveCallEntry,
} from "@/lib/callAwareness";

/**
 * ONE poll cadence for live-call awareness, shared with the Home dashboard.
 * react-query dedupes by key, so the sidebar badges, the in-room banner and
 * Home all ride a single request — there is never a per-surface (let alone
 * per-row) poll.
 */
export const LIVE_CALLS_POLL_MS = 30_000;

/** The query key the whole app shares for /home/summary (per instance). */
export function homeSummaryQueryKey(
  scope: string | null,
): [string, string | null] {
  return ["home-summary", scope];
}

/**
 * THE source of truth for "which rooms have a live call right now".
 *
 * Reads the member-scoped `live_calls` block of GET /home/summary — the
 * server's LiveKit occupancy probe — from the SAME react-query entry the Home
 * dashboard polls (key {@link homeSummaryQueryKey}), so mounting this hook
 * anywhere adds zero extra requests while Home is open and exactly one shared
 * 30s poll when it isn't. Between polls the cache is nudged in real time by
 * room-scoped `call_occupancy` WS events (see useGlobalNotifications), which
 * patch the same entry — every surface that consumes this hook updates
 * together, immediately.
 *
 * `select` narrows subscriptions to the live-calls slice, so consumers (the
 * sidebar renders on every room list change already, but still) don't
 * re-render for agent-activity/artifact churn in the rest of the summary.
 */
export function useLiveCalls(): {
  /** room id → live call info. Empty until the first poll/nudge lands. */
  byRoomId: Record<string, LiveCallEntry>;
  /** The raw list, for consumers that want to iterate. */
  list: LiveCallEntry[];
} {
  const scope = useFederationStore((s) => s.activeInstanceId);
  const { data } = useQuery({
    queryKey: homeSummaryQueryKey(scope),
    queryFn: () => api.getHomeSummary(),
    refetchInterval: LIVE_CALLS_POLL_MS,
    // WS nudges own freshness between polls; a small staleTime keeps route
    // changes (the banner mounts per room) from stampeding extra fetches.
    staleTime: 15_000,
    select: (summary: HomeSummary) =>
      (summary.live_calls ?? []) as LiveCallEntry[],
  });

  const list = useMemo(() => data ?? [], [data]);
  const byRoomId = useMemo(() => liveCallsByRoom(list), [list]);
  return { byRoomId, list };
}
