import { useLocation } from "react-router-dom";
import { isCompositeBroadcastPath } from "@/lib/composite";
import { BroadcastPage } from "./BroadcastPage";
import { CompositePage } from "./CompositePage";

/**
 * Both feeds live under /broadcast, which is mounted above AuthGate so an
 * OBS source or an egress Chrome never meets the Keycloak redirect. The
 * composite recorder is one path in that subtree; every other URL stays the
 * one-tile OBS page.
 */
export function BroadcastMount() {
  const { pathname } = useLocation();
  if (isCompositeBroadcastPath(pathname)) return <CompositePage />;
  return <BroadcastPage />;
}

export default BroadcastMount;
