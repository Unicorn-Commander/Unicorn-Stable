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
}

/**
 * GET /api/v1/crew, polled like the roster. A server that predates the
 * route (404) — or cannot be reached — falls back to the Brigade roster as
 * house rows, so "Talk to an agent" keeps working against a stale server.
 * The roster fallback never invents seats, partners, guests or integrations.
 */
export function useCrew(): CrewState {
  const scope = useFederationStore((s) => s.activeInstanceId);
  const agents = useAppStore((s) => s.agents);
  const query = useQuery({
    queryKey: crewQueryKey(scope),
    queryFn: () => api.getCrew(),
    staleTime: CREW_STALE_MS,
    refetchInterval: CREW_POLL_MS,
    retry: false,
  });
  const fromRoster = query.data === undefined && query.isError;
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
