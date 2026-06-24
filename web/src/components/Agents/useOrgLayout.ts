import { useMemo } from "react";
import dagre from "@dagrejs/dagre";
import { Position, type Node, type Edge } from "@xyflow/react";

export const ORG_NODE_W = 212;
export const ORG_NODE_H = 78;

/**
 * Run dagre top-to-bottom over the xyflow nodes/edges and return the nodes with
 * absolute positions. Dagre owns x/y so the layout only recomputes when the
 * visible node/edge set changes. (Port of Brigade's useOrgLayout.)
 */
export function useOrgLayout(
  nodes: Node[],
  edges: Edge[],
  opts: { rankdir?: string; ranksep?: number; nodesep?: number } = {},
): Node[] {
  const { rankdir = "TB", ranksep = 90, nodesep = 38 } = opts;
  return useMemo(() => {
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
        targetPosition: Position.Top,
        sourcePosition: Position.Bottom,
      };
    });
  }, [nodes, edges, rankdir, ranksep, nodesep]);
}

export default useOrgLayout;
