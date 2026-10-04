import { useMemo } from "react";
import { useAppStore } from "@/stores/appStore";
import { usePresenterStore } from "@/stores/presenterStore";
import { useCrew } from "@/hooks/useCrew";
import {
  filterRooms,
  presenterRule,
  type PresenterRule,
} from "@/lib/presenterMode";

/**
 * Shared presenter seam for list-like surfaces. Presenter mode is local UI
 * state, so this hook never changes a query key or a server request; it only
 * decides which already-loaded records may be painted on this device.
 */
export function usePresentedRooms(): {
  enabled: boolean;
  rooms: ReturnType<typeof useAppStore.getState>["rooms"];
  hiddenCount: number;
  rule: PresenterRule;
} {
  const enabled = usePresenterStore((state) => state.enabled);
  const safeRoomIds = usePresenterStore((state) => state.safeRoomIds);
  const rooms = useAppStore((state) => state.rooms);
  const participantsByRoom = useAppStore((state) => state.participants);
  const openRoomId = useAppStore((state) => state.activeRoomId);
  const currentUser = useAppStore((state) => state.currentUser);
  const agents = useAppStore((state) => state.agents);
  const { crew } = useCrew();

  const rule = useMemo(
    () =>
      presenterRule({
        enabled,
        openRoomId,
        safeRoomIds,
        rooms,
        participantsByRoom,
        currentUser: currentUser
          ? {
              id: currentUser.id,
              displayName: currentUser.displayName,
              username: currentUser.username,
              email: currentUser.email,
            }
          : null,
        crew,
        agents,
      }),
    [
      enabled,
      openRoomId,
      safeRoomIds,
      rooms,
      participantsByRoom,
      currentUser,
      crew,
      agents,
    ],
  );

  const visibleRooms = useMemo(() => filterRooms(rooms, rule), [rooms, rule]);

  return {
    enabled,
    rooms: visibleRooms,
    hiddenCount: enabled ? rooms.length - visibleRooms.length : 0,
    rule,
  };
}

