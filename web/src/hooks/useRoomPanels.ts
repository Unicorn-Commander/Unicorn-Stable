import { useEffect } from "react";
import {
  readLiveRoom,
  usePanelChromeStore,
  type PanelMap,
} from "@/stores/panelChromeStore";

export function useRoomPanels(roomId: string): PanelMap {
  const panels = usePanelChromeStore((s) => s.rooms[roomId]);
  const ensureRoom = usePanelChromeStore((s) => s.ensureRoom);
  useEffect(() => {
    ensureRoom(roomId);
  }, [roomId, ensureRoom]);
  return panels ?? readLiveRoom(roomId);
}
