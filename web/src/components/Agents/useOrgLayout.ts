import { useMemo } from "react";
import dagre from "@dagrejs/dagre";
import { Position, type Node, type Edge } from "@xyflow/react";

export const ORG_NODE_W = 212;
export const ORG_NODE_H = 78;

export interface OrgLayoutOpts {
  rankdir?: string;
  ranksep?: number;
  nodesep?: number;
}

/**
 * Run dagre top-to-bottom over the xyflow nodes/edges and return the nodes
 * with absolute positions. Dagre owns x/y. Pure — the hook below memoizes it.
 *
 * Every node is also stamped with `initialWidth`/`initialHeight` — the same
 * constants dagre just laid out with — and that stamp is LOAD-BEARING for the
 * `<MiniMap>`: this chart is a controlled flow with no `onNodesChange`, so
 * xyflow's measured dimensions live only on its internal nodes and are never
 * written back to these user-node objects. The MiniMap's per-node renderer
 * checks `nodeHasDimensions(userNode)` (measured ?? width ?? initialWidth) and
 * silently renders NOTHING for a node with none of the three — which is how
 * the minimap shipped as an empty dark box. `initialWidth/Height` satisfy that
 * check and size the minimap rects to the exact dagre footprint, while (unlike
 * `width`/`height`) only influencing the DOM for the first pre-measurement
 * paint, so the visible chart is untouched.
 */
export function layoutOrgNodes(
  nodes: Node[],
  edges: Edge[],
  opts: OrgLayoutOpts = {},
): Node[] {
  const { rankdir = "TB", ranksep = 90, nodesep = 38 } = opts;
  if (!nodes.length) return nodes;
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir, ranksep, nodesep, marginx: 24, marginy: 24 });
  nodes.forEach((n) => g.setNode(n.id, { width: ORG_NODE_W, height: ORG_NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return {
      ...n,
      position: { x: p.x - ORG_NODE_W / 2, y: p.y - ORG_NODE_H / 2 },
      initialWidth: ORG_NODE_W,
      initialHeight: ORG_NODE_H,
      targetPosition: Position.Top,
      sourcePosition: Position.Bottom,
    };
  });
}

/** Memoized {@link layoutOrgNodes}. (Port of Brigade's useOrgLayout.) */
export function useOrgLayout(
  nodes: Node[],
  edges: Edge[],
  opts: OrgLayoutOpts = {},
): Node[] {
  const { rankdir = "TB", ranksep = 90, nodesep = 38 } = opts;
  return useMemo(
    () => layoutOrgNodes(nodes, edges, { rankdir, ranksep, nodesep }),
    [nodes, edges, rankdir, ranksep, nodesep],
  );
}

export default useOrgLayout;
