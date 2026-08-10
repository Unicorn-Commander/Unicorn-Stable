/**
 * layoutOrgNodes — dagre geometry plus the MiniMap dimension contract.
 *
 * The dimension stamp is the regression under guard here: the org chart is a
 * controlled flow with no `onNodesChange`, so xyflow never writes measured
 * sizes back onto these user-node objects, and `<MiniMap>` refuses to draw a
 * user node that carries none of measured/width/initialWidth — that exact
 * combination shipped as the "empty dark box" minimap. If someone removes the
 * initialWidth/initialHeight stamp, the minimap goes blank again with zero
 * console output; this test is the tripwire.
 */
import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import {
  layoutOrgNodes,
  ORG_NODE_H,
  ORG_NODE_W,
} from "./useOrgLayout";

function node(id: string): Node {
  return { id, type: "orgAgent", position: { x: 0, y: 0 }, data: {} };
}

const nodes: Node[] = [node("apex"), node("lead-a"), node("lead-b")];
const edges: Edge[] = [
  { id: "e1", source: "apex", target: "lead-a" },
  { id: "e2", source: "apex", target: "lead-b" },
];

describe("layoutOrgNodes", () => {
  it("returns the empty array untouched", () => {
    expect(layoutOrgNodes([], [], {})).toEqual([]);
  });

  it("stamps every node with the dimensions dagre laid out with (the MiniMap contract)", () => {
    const out = layoutOrgNodes(nodes, edges, {});
    expect(out).toHaveLength(3);
    for (const n of out) {
      expect(n.initialWidth).toBe(ORG_NODE_W);
      expect(n.initialHeight).toBe(ORG_NODE_H);
    }
  });

  it("positions the apex above its two reports, reports on one rank", () => {
    const out = layoutOrgNodes(nodes, edges, { ranksep: 70, nodesep: 22 });
    const byId = new Map(out.map((n) => [n.id, n]));
    const apex = byId.get("apex")!;
    const a = byId.get("lead-a")!;
    const b = byId.get("lead-b")!;
    expect(apex.position.y).toBeLessThan(a.position.y);
    expect(a.position.y).toBe(b.position.y);
    expect(a.position.x).not.toBe(b.position.x);
    // Dagre owns x/y; the anchors are the org-chart's top-down convention.
    expect(apex.sourcePosition).toBe("bottom");
    expect(apex.targetPosition).toBe("top");
  });
});
