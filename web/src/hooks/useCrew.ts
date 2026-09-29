import { useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api, type CrewMember } from "@/services/api";
import { crewFromRoster } from "@/lib/crew";
import { useAppStore } from "@/stores/appStore";
import { useFederationStore } from "@/stores/federationStore";

export const CREW_STALE_MS = 30_000;
export const CREW_POLL_MS = 60_000;

export function crewQueryKey(scope: string | null): readonly ["crew", string | null] {
  return ["crew", scope] as const;
}

export interface CrewState {
  crew: CrewMember[];
  /** True once the server answered (or refused) — before that, no rows means "loading". */
  loaded: boolean;
  /**
   * The list came from the Brigade roster because /crew has never answered on
   * this server. A failed background refetch over a list that did load keeps
   * the real list and says nothing.
   */
  fromRoster: boolean;
  /** /crew answered at least once: `hub_room_id` is the truth, not a room-list search. */
  crewAnswered: boolean;
  isPending: boolean;
  /**
   * /crew failed and has never answered, on a server that has the route (not
   * a 404): the list is not known. The roster fallback still fills the rail,
   * but who a message is FOR must not quietly change on a 5xx — Home's
   * composer holds and says so (review 2, P2-7).
   */
  unavailable: boolean;
}

/** Retries before a failure counts: two, and none for a route the server does not have. */
export const CREW_RETRIES = 2;

export function crewRetry(failureCount: number, error: unknown): boolean {
  if ((error as { status?: number } | null)?.status === 404) return false;
  return failureCount < CREW_RETRIES;
}

/**
 * GET /api/v1/crew, polled like the roster. A server that predates the
 * route (404) — or cannot be reached — falls back to the Brigade roster as
 * house rows, so "Talk to an agent" keeps working against a stale server.
 * The roster fallback never invents seats, partners, guests or integrations.
 * Anything but a 404 is retried twice first (P2-7): one 5xx on arrival no
 * longer re-addresses Home.
 */
export function useCrew(): CrewState {
  const scope = useFederationStore((s) => s.activeInstanceId);
  const agents = useAppStore((s) => s.agents);
  const query = useQuery({
    queryKey: crewQueryKey(scope),
    queryFn: () => api.getCrew(),
    staleTime: CREW_STALE_MS,
    refetchInterval: CREW_POLL_MS,
    retry: crewRetry,
  });
  const fromRoster = query.data === undefined && query.isError;
  const notThere = (query.error as { status?: number } | null)?.status === 404;
  const unavailable = query.data === undefined && !notThere && (query.isError || query.failureCount > 0);
  const crew = useMemo(
    () => (query.data ? query.data : fromRoster ? crewFromRoster(agents) : []),
    [query.data, fromRoster, agents],
  );
  return {
    crew,
    loaded: query.data !== undefined || query.isError,
    fromRoster,
    crewAnswered: query.data !== undefined,
    isPending: query.isPending,
    unavailable,
  };
}

/**
 * Synchronous read for code that runs outside React (the Alt+↑/↓ handler):
 * the cached list, else the roster fallback when the query already failed.
 */
export function readCrewCache(
  qc: QueryClient,
  scope: string | null,
): { crew: CrewMember[]; crewAnswered: boolean } {
  const state = qc.getQueryState<CrewMember[]>(crewQueryKey(scope));
  if (state?.data) return { crew: state.data, crewAnswered: true };
  if (state?.status === "error") {
    return { crew: crewFromRoster(useAppStore.getState().agents), crewAnswered: false };
  }
  return { crew: [], crewAnswered: false };
}
