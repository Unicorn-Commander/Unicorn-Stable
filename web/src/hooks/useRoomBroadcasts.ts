import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ActiveBroadcast } from "@/services/api";

/** How often the consent surface refreshes. */
const BROADCAST_POLL_MS = 20_000;

/**
 * Who in this room currently has a live broadcast feed.
 *
 * THIS IS A CONSENT FEATURE, not a status widget. A broadcast viewer joins
 * LiveKit with `hidden=True` so an OBS feed never pollutes the call roster —
 * which, combined with a no-login URL, would otherwise mean a participant can
 * be streamed to the internet with no indication to them anywhere. The feed
 * stays invisible; the FACT of it does not.
 *
 * Read by any room MEMBER (the server gates it that way on purpose — the owner
 * is exactly the person who does NOT need to be told), so the "● Broadcasting"
 * badge it drives is shown to everyone, on everyone.
 *
 * Polled rather than pushed: minting is rare and there is no WS event for it,
 * and 20s is well inside the time it takes a human to notice a camera light.
 */
export function useRoomBroadcasts(roomId: string | null | undefined) {
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["room-broadcasts", roomId],
    queryFn: () => api.getActiveBroadcasts(roomId as string),
    enabled: Boolean(roomId),
    refetchInterval: BROADCAST_POLL_MS,
    staleTime: BROADCAST_POLL_MS / 2,
    // A non-member gets a 403 here. Retrying it just hammers the endpoint.
    retry: false,
  });

  const broadcasting: ActiveBroadcast[] = useMemo(
    () => data?.broadcasting ?? [],
    [data],
  );

  const identities = useMemo(
    () => new Set(broadcasting.map((b) => b.participant_identity)),
    [broadcasting],
  );

  /** Is THIS LiveKit identity being broadcast right now? */
  const isBroadcasting = useCallback(
    (identity: string | null | undefined) =>
      Boolean(identity) && identities.has(identity as string),
    [identities],
  );

  const viewerCountFor = useCallback(
    (identity: string | null | undefined) =>
      identity
        ? broadcasting.find((b) => b.participant_identity === identity)
            ?.viewer_count
        : undefined,
    [broadcasting],
  );

  /** Pull the list forward — call after minting or revoking. */
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["room-broadcasts", roomId] });
  }, [qc, roomId]);

  return { broadcasting, identities, isBroadcasting, viewerCountFor, refresh };
}
