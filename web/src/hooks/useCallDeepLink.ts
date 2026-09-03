import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/appStore";
import { useDirectCall } from "@/hooks/useDirectCall";
import {
  parseCallDeepLink,
  stripCallDeepLinkParams,
} from "@/lib/callDeepLink";

/**
 * `/c/<roomId>?join=1&mic=…&cam=…&video=0|1&ring=0|1` — open a room ALREADY
 * in its call, devices chosen, no pre-join dialog. The contract is in
 * `~/Projects/rook-bin/specs/CALL-DEEPLINK.md`; a native control app is the
 * first consumer.
 *
 * Fires ONCE per URL: the params are consumed and replaced out of the
 * address bar the moment the room is the active one, so a reload (or the
 * back button) never joins — and never RINGS — a second time. That second
 * ring is the exact loop this branch exists to end.
 */
export function useCallDeepLink(routeRoomId: string | undefined): void {
  const location = useLocation();
  const navigate = useNavigate();
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const roomsLoaded = useAppStore((s) => s.rooms.length > 0);
  const { startCall } = useDirectCall();
  const consumedRef = useRef<string | null>(null);

  useEffect(() => {
    const link = parseCallDeepLink(location.search);
    if (!link || !routeRoomId) return;
    // Wait until the route's room is the active one and the room list (which
    // startCall reads for the ring policy) has arrived.
    if (activeRoomId !== routeRoomId || !roomsLoaded) return;
    const key = `${routeRoomId}${location.search}`;
    if (consumedRef.current === key) return;
    consumedRef.current = key;

    // Consume the params FIRST so nothing re-fires whatever happens next.
    navigate(
      { pathname: location.pathname, search: stripCallDeepLinkParams(location.search) },
      { replace: true },
    );
    void startCall(routeRoomId, {
      skipDeviceCheck: true,
      mic: link.mic,
      cam: link.cam,
      video: link.video,
      ring: link.ring,
    });
  }, [
    location.search,
    location.pathname,
    routeRoomId,
    activeRoomId,
    roomsLoaded,
    navigate,
    startCall,
  ]);
}
