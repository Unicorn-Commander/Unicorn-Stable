import { useMemo, useCallback, useState, useEffect } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Bot, Star, ChevronDown, ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import clsx from "clsx";
import type { Agent } from "@/services/api";
import {
  AFFIL_META,
  affiliationOf,
  agentIdentity,
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
  hasChildren: boolean;
  isExpanded: boolean;
  childCount: number;
  onToggle: (id: string) => void;
}

/**
 * One agent node — the same classification a card shows (affiliation left-border,
 * model-tier chip, paid-tool $ badge) compacted to node size, plus a drill-down
 * chevron on any agent that has reports. Clicking the body opens the chat popup;
 * clicking the chevron expands/collapses that agent's team.
 */
function OrgGraphNode(props: NodeProps) {
  const { agent, isRoot, hasChildren, isExpanded, childCount, onToggle } =
    props.data as unknown as OrgNodeData;
  const affilMeta = AFFIL_META[affiliationOf(agent)];
  const tierMeta = TIER_META[tierOf(agent)];
  const ident = agentIdentity(agent);
  return (
    <div
      title={`${affilMeta.label} · ${tierMeta.label} model — click to chat`}
      className={clsx(
        "group flex w-[212px] cursor-pointer items-center gap-2.5 rounded-xl border border-l-4 bg-surface-2/95 px-2.5 py-2 backdrop-blur-sm transition-colors hover:bg-surface-3",
        isRoot
          ? "border-stable-purple/60 shadow-glow-iris"
          : "border-line-strong shadow-soft",
        affilMeta.border,
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !border-0 !bg-slate-600"
      />
      <span
        className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg text-base text-white/90"
        style={{ background: ident.gradient }}
      >
        {agent.avatar_url ? (
          <img src={agent.avatar_url} alt="" className="h-full w-full object-cover" />
        ) : agent.emoji ? (
          <span aria-hidden="true">{agent.emoji}</span>
        ) : (
          <Bot className="h-4 w-4" />
        )}
        <span
          className={clsx(
            "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface-2",
            statusDot(agent.status),
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className="truncate text-[13px] font-semibold text-slate-100">
            {label(agent)}
          </span>
          {isRoot && <Star className="h-3 w-3 shrink-0 text-stable-gold" />}
        </span>
        <span className="block truncate text-[10px] text-slate-400">
          {agent.title || agent.rank || prettyDomain(agent.domain)}
        </span>
        <span className="mt-0.5 flex items-center gap-1">
          <span
            className={clsx(
              "inline-flex items-center rounded-md px-1 text-[8px] font-semibold uppercase tracking-wide ring-1",
              tierMeta.chip,
            )}
          >
            {tierMeta.label}
          </span>
          <PaidToolsBadge agent={agent} size="xs" />
        </span>
      </span>
      {hasChildren && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(agent.id);
          }}
          title={
            isExpanded
              ? `Collapse ${childCount} report${childCount === 1 ? "" : "s"}`
              : `Show ${childCount} report${childCount === 1 ? "" : "s"} under ${label(agent)}`
          }
          aria-label={isExpanded ? "Collapse team" : "Expand team"}
          className="nodrag nopan focus-ring flex shrink-0 items-center gap-0.5 self-stretch rounded-md bg-white/[0.04] px-1 text-[10px] font-semibold tabular-nums text-slate-400 transition-colors hover:bg-white/[0.08] hover:text-slate-100"
        >
          {isExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          {childCount}
        </button>
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !border-0 !bg-slate-600"
      />
    </div>
  );
}

const nodeTypes = { orgAgent: OrgGraphNode };
const RESTING_EDGE = { stroke: "#43436080", strokeWidth: 1.5 };

// Re-fit the viewport when the visible node set changes (drill-down / search),
// so newly revealed reports come into view. Rendered inside <ReactFlow> so it
// has the flow context.
function FitOnChange({ token }: { token: string }) {
  const rf = useReactFlow();
  useEffect(() => {
    const t = setTimeout(() => {
      rf.fitView({ padding: 0.12, minZoom: 0.5, maxZoom: 0.85, duration: 300 });
    }, 60);
    return () => clearTimeout(t);
  }, [token, rf]);
  return null;
}

/**
 * The org chart as a top-down node graph (dagre layout) with reporting-line
 * edges — the classic org-chart idiom. Starts collapsed to the apex + domain
 * leads; expand a lead (chevron) to drill into their team. Click any node to
 * chat.
 */
export function AgentOrgChart({
  agents,
  onOpen,
  expandAll = false,
}: {
  agents: Agent[];
  onOpen: (agent: Agent) => void;
  expandAll?: boolean;
}) {
  const tree = useMemo(() => buildOrgTree(agents), [agents]);

  const parentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, kids] of tree.childrenById) if (kids.length) ids.add(id);
    return ids;
  }, [tree]);

  // Which agents have their reports shown. Default: just the apex (so the domain
  // leads show, their members collapsed). Search/expand-all opens everything.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(tree.root ? [tree.root.id] : []),
  );
  useEffect(() => {
    setExpanded(
      expandAll
        ? new Set(parentIds)
        : new Set(tree.root ? [tree.root.id] : []),
    );
  }, [tree, expandAll, parentIds]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Visible = the apex plus every descendant reachable through expanded nodes.
  const visibleIds = useMemo(() => {
    const vis = new Set<string>();
    if (!tree.root) return vis;
    const stack = [tree.root.id];
    vis.add(tree.root.id);
    while (stack.length) {
      const n = stack.pop()!;
      if (expanded.has(n)) {
        for (const c of tree.childrenById.get(n) || []) {
          if (!vis.has(c)) {
            vis.add(c);
            stack.push(c);
          }
        }
      }
    }
    return vis;
  }, [tree, expanded]);

  const rawNodes: Node[] = useMemo(
    () =>
      tree.agents
        .filter((a) => visibleIds.has(a.id))
        .map((a) => {
          const childCount = (tree.childrenById.get(a.id) || []).length;
          return {
            id: a.id,
            type: "orgAgent",
            position: { x: 0, y: 0 },
            data: {
              agent: a,
              isRoot: a.id === tree.root?.id,
              hasChildren: childCount > 0,
              isExpanded: expanded.has(a.id),
              childCount,
              onToggle: toggle,
            },
          };
        }),
    [tree, visibleIds, expanded, toggle],
  );

  const edges: Edge[] = useMemo(
    () =>
      tree.edges
        .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
        .map((e) => ({
          ...e,
          type: "smoothstep",
          style: RESTING_EDGE,
          markerEnd: { type: MarkerType.ArrowClosed, color: "#434360" },
        })),
    [tree, visibleIds],
  );

  const nodes = useOrgLayout(rawNodes, edges, { ranksep: 70, nodesep: 22 });

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const a = tree.byId.get(node.id);
      if (a) onOpen(a);
    },
    [tree, onOpen],
  );

  const expandEverything = useCallback(
    () => setExpanded(new Set(parentIds)),
    [parentIds],
  );
  const collapseToTop = useCallback(
    () => setExpanded(new Set(tree.root ? [tree.root.id] : [])),
    [tree],
  );

  if (agents.length === 0) {
    return (
      <div className="card animate-fade-in flex flex-col items-center gap-3 px-6 py-16 text-center">
        <span className="glass glow-iris flex h-12 w-12 items-center justify-center rounded-2xl text-stable-purple-light">
          <Bot className="h-6 w-6" />
        </span>
        <div>
          <p className="font-display text-sm font-semibold text-slate-200">
            No residents match
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Try a different name, role, domain, or tool.
          </p>
        </div>
      </div>
    );
  }

  const hiddenCount = tree.agents.length - visibleIds.size;

  return (
    <div className="h-[72vh] min-h-[520px] w-full overflow-hidden rounded-2xl border border-line bg-surface-1/60 shadow-soft">
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
        <FitOnChange token={`${visibleIds.size}:${expandAll}`} />
        <Panel position="top-right" className="!m-2">
          <div className="glass flex items-center gap-1 rounded-lg p-0.5 text-[11px] shadow-soft">
            <button
              onClick={expandEverything}
              className="focus-ring flex items-center gap-1 rounded-md px-2 py-1 font-medium text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
              title="Expand every team"
            >
              <Maximize2 className="h-3 w-3" />
              Expand all
            </button>
            <button
              onClick={collapseToTop}
              className="focus-ring flex items-center gap-1 rounded-md px-2 py-1 font-medium text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
              title="Collapse to the leadership tier"
            >
              <Minimize2 className="h-3 w-3" />
              Collapse
            </button>
          </div>
          {hiddenCount > 0 && (
            <p className="mt-1.5 text-right text-[10px] font-medium text-slate-500">
              {hiddenCount} more — expand a lead to drill in
            </p>
          )}
        </Panel>
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2b2b44" />
        <Controls
          showInteractive={false}
          className="!overflow-hidden !rounded-xl !border !border-stable-glass-border !shadow-soft [--xy-controls-box-shadow:none] [--xy-controls-button-background-color:rgba(18,18,32,0.85)] [--xy-controls-button-background-color-hover:rgba(31,31,51,0.92)] [--xy-controls-button-border-color:rgba(148,152,196,0.12)] [--xy-controls-button-color:#9193af] [--xy-controls-button-color-hover:#f8f8fd]"
        />
        <MiniMap
          pannable
          zoomable
          nodeColor="#8b5cf6"
          maskColor="rgba(8,8,15,0.72)"
          className="!overflow-hidden !rounded-xl !border !border-stable-glass-border !shadow-soft [--xy-minimap-background-color:rgba(11,11,21,0.9)]"
        />
      </ReactFlow>
    </div>
  );
}
