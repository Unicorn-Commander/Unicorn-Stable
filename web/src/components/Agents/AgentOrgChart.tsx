import { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Bot, Star } from "lucide-react";
import clsx from "clsx";
import type { Agent } from "@/services/api";
import {
  AFFIL_META,
  affiliationOf,
  TIER_META,
  tierOf,
  statusDot,
  prettyDomain,
} from "./agentClass";
import { PaidToolsBadge } from "./AgentBadges";
import { buildOrgTree } from "./orgTree";
import { useOrgLayout } from "./useOrgLayout";

function label(a: Agent): string {
  return a.display_name || a.name;
}

interface OrgNodeData {
  agent: Agent;
  isRoot: boolean;
  subordinates: number;
}

/**
 * One agent node in the graph — the same classification a card shows (affiliation
 * left-border, model-tier chip, paid-tool $ badge) compacted to node size, with
 * the top/bottom handles the reporting edges attach to.
 */
function OrgGraphNode(props: NodeProps) {
  const { agent, isRoot, subordinates } = props.data as unknown as OrgNodeData;
  const affilMeta = AFFIL_META[affiliationOf(agent)];
  const tierMeta = TIER_META[tierOf(agent)];
  return (
    <div
      title={`${affilMeta.label} · ${tierMeta.label} model`}
      className={clsx(
        "group flex w-[212px] cursor-pointer items-center gap-2.5 rounded-xl border border-l-4 bg-slate-800/90 px-2.5 py-2 shadow-lg backdrop-blur-sm transition-colors hover:bg-slate-800",
        isRoot
          ? "border-stable-purple/60 shadow-stable-purple/20"
          : "border-slate-700/60",
        affilMeta.border,
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !border-0 !bg-slate-500"
      />
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-stable-purple/30 to-stable-cyan/20 text-base text-stable-purple-light">
        {agent.avatar_url ? (
          <img src={agent.avatar_url} alt="" className="h-full w-full object-cover" />
        ) : agent.emoji ? (
          <span aria-hidden="true">{agent.emoji}</span>
        ) : (
          <Bot className="h-4 w-4" />
        )}
        <span
          className={clsx(
            "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-800",
            statusDot(agent.status),
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className="truncate text-[13px] font-semibold text-slate-100">
            {label(agent)}
          </span>
          {isRoot && <Star className="h-3 w-3 shrink-0 text-stable-purple-light" />}
        </span>
        <span className="block truncate text-[10px] text-slate-400">
          {agent.title || agent.rank || prettyDomain(agent.domain)}
        </span>
        <span className="mt-0.5 flex items-center gap-1">
          <span
            className={clsx(
              "inline-flex items-center rounded-full px-1 text-[8px] font-semibold uppercase tracking-wide ring-1",
              tierMeta.chip,
            )}
          >
            {tierMeta.label}
          </span>
          <PaidToolsBadge agent={agent} size="xs" />
          {subordinates > 0 && (
            <span className="text-[9px] text-slate-500">
              {subordinates} report{subordinates === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </span>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !border-0 !bg-slate-500"
      />
    </div>
  );
}

const nodeTypes = { orgAgent: OrgGraphNode };
const RESTING_EDGE = { stroke: "#475569", strokeWidth: 1.5 };

/**
 * The org chart as a top-down node graph (dagre-laid-out) with reporting-line
 * edges — the Command-Center idiom. Click any node to open the chat popup.
 */
export function AgentOrgChart({
  agents,
  onOpen,
}: {
  agents: Agent[];
  onOpen: (agent: Agent) => void;
}) {
  const tree = useMemo(() => buildOrgTree(agents), [agents]);

  const rawNodes: Node[] = useMemo(
    () =>
      tree.agents.map((a) => ({
        id: a.id,
        type: "orgAgent",
        position: { x: 0, y: 0 },
        data: {
          agent: a,
          isRoot: a.id === tree.root?.id,
          subordinates: (tree.childrenById.get(a.id) || []).length,
        },
      })),
    [tree],
  );

  const edges: Edge[] = useMemo(
    () =>
      tree.edges.map((e) => ({
        ...e,
        type: "smoothstep",
        style: RESTING_EDGE,
        markerEnd: { type: MarkerType.ArrowClosed, color: "#475569" },
      })),
    [tree],
  );

  const nodes = useOrgLayout(rawNodes, edges, { ranksep: 70, nodesep: 22 });

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const a = tree.byId.get(node.id);
      if (a) onOpen(a);
    },
    [tree, onOpen],
  );

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-700/50 bg-slate-800/20 px-6 py-16 text-center">
        <Bot className="h-6 w-6 text-slate-600" />
        <p className="text-sm text-slate-500">No agents match your search.</p>
      </div>
    );
  }

  return (
    <div className="h-[72vh] min-h-[520px] w-full overflow-hidden rounded-2xl border border-slate-700/50 bg-slate-900/40">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.12, minZoom: 0.5, maxZoom: 0.85 }}
        minZoom={0.3}
        maxZoom={1.6}
        nodesDraggable={false}
        proOptions={{ hideAttribution: true }}
        className="bg-transparent"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1e293b" />
        <Controls showInteractive={false} className="!border-slate-700 !bg-slate-800/80" />
        <MiniMap
          pannable
          zoomable
          nodeColor="#8b5cf6"
          maskColor="rgba(2,6,23,0.7)"
          className="!border-slate-700 !bg-slate-900"
        />
      </ReactFlow>
    </div>
  );
}
