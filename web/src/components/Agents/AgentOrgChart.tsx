import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  getNodesBounds,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot,
  Star,
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minimize2,
  ZoomIn,
  ZoomOut,
  Scan,
  Expand,
  X,
} from "lucide-react";
import clsx from "clsx";
import type { Agent } from "@/services/api";
import {
  AFFIL_META,
  affiliationOf,
  TIER_META,
  tierOf,
  prettyDomain,
} from "./agentClass";
import { PaidToolsBadge } from "./AgentBadges";
import { StatusDot } from "./StatusDot";
import { Tooltip } from "@/components/ui";
import { useModalA11y } from "@/hooks/useModalA11y";
import { buildOrgTree } from "./orgTree";
import { useOrgLayout, ORG_NODE_W, ORG_NODE_H } from "./useOrgLayout";
import {
  FIT_MIN_ZOOM,
  FIT_PADDING,
  FIT_MAX_ZOOM,
  LEGIBLE_ZOOM,
  CHART_MAX_ZOOM,
  FOCUS_PADDING,
  FOCUS_MAX_ZOOM,
  zoomStep,
  fitZoom,
  fitTarget,
  nodesRect,
  collectSubtreeIds,
} from "./orgViewport";
import { Avatar } from "@/components/ui/Avatar";
import { resolveAgentPortrait } from "@/lib/resolveAgentPortrait";

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
  onFocus: (id: string) => void;
}

/**
 * One agent node — the same classification a card shows (affiliation left-border,
 * model-tier chip, paid-tool $ badge) compacted to node size, plus a drill-down
 * chevron on any agent that has reports and a magnifier that zooms the chart
 * onto this agent's subtree. Clicking the body opens the chat popup; the
 * magnifier and chevron stop the click so they never open a chat.
 */
function OrgGraphNode(props: NodeProps) {
  const { agent, isRoot, hasChildren, isExpanded, childCount, onToggle, onFocus } =
    props.data as unknown as OrgNodeData;
  const affilMeta = AFFIL_META[affiliationOf(agent)];
  const tierMeta = TIER_META[tierOf(agent)];
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
      {/* Handles are edge anchors, not controls (the chart is read-only), so
          they must not hit-test: they sit at the node's top/bottom centre —
          exactly where a thumb lands — they are permanently `nopan`, and
          mobile Chrome's touch adjustment SNAPS a nearby finger onto them,
          which silently ate pan gestures that visually began on empty canvas. */}
      <Handle
        type="target"
        position={Position.Top}
        style={{ pointerEvents: "none" }}
        className="!h-1.5 !w-1.5 !border-0 !bg-slate-600"
      />
      <span className="relative flex h-9 w-9 shrink-0">
        <Avatar
          avatarUrl={resolveAgentPortrait(agent.id, label(agent), agent.avatar_url)}
          emoji={agent.emoji}
          id={agent.id}
          name={label(agent)}
          size={36}
          rounded="lg"
          alt=""
        />
        <StatusDot
          status={agent.status}
          className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 border-2 border-surface-2"
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
      {/* Zoom-to affordance. Faded until hover on pointer devices, but never
          hidden outright — touch has no hover, and an invisible control on
          the platform that needs it most is no control at all. */}
      <Tooltip
        content={
          hasChildren
            ? `Zoom to ${label(agent)}'s team`
            : `Zoom to ${label(agent)}`
        }
        placement="top"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onFocus(agent.id);
          }}
          aria-label={`Zoom to ${label(agent)}`}
          className="nodrag nopan focus-ring flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-md text-slate-500 opacity-60 transition-all hover:bg-white/[0.08] hover:text-slate-100 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <ZoomIn className="h-3 w-3" />
        </button>
      </Tooltip>
      {hasChildren && (
        <Tooltip
          content={
            isExpanded
              ? `Collapse ${childCount} report${childCount === 1 ? "" : "s"}`
              : `Show ${childCount} report${childCount === 1 ? "" : "s"} under ${label(agent)}`
          }
          placement="right"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(agent.id);
            }}
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
        </Tooltip>
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ pointerEvents: "none" }}
        className="!h-1.5 !w-1.5 !border-0 !bg-slate-600"
      />
    </div>
  );
}

const nodeTypes = { orgAgent: OrgGraphNode };
// pointerEvents none — with the hit strip gone (interactionWidth: 0, see the
// edge map) the visible hairline itself still hit-tests via visibleStroke,
// and a pan that starts exactly on it is swallowed. Decorative lines should
// be transparent to every pointer.
const RESTING_EDGE = {
  stroke: "#43436080",
  strokeWidth: 1.5,
  pointerEvents: "none",
} as const;

// Numeric viewport policy (limits, padding, legibility floor) lives in
// orgViewport.ts with the pure math it parameterises.
const FIT_OPTIONS = {
  padding: FIT_PADDING,
  minZoom: FIT_MIN_ZOOM,
  maxZoom: FIT_MAX_ZOOM,
};

/**
 * Read at call time, not module load — the OS setting can change mid-session.
 * Imperative xyflow moves (setCenter/zoomTo/fitView) take a raw duration and
 * sit outside both <MotionConfig reducedMotion="user"> and the globals.css
 * animation kill-switch, so they must check for themselves.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * One owner for the viewport (xyflow's built-in fitView already lost a fight
 * with a second driver here once — see the ReactFlow props). Everything that
 * wants to move the camera issues a command; the controller executes the
 * latest one:
 *
 *  - overview — the whole-chart view: fit when that lands at a legible zoom,
 *    otherwise anchor on the apex at LEGIBLE_ZOOM (a wide org fits only as an
 *    unreadable ribbon). Issued on mount, drill-down, search, reset,
 *    double-clicking empty canvas.
 *  - focus — centre + zoom onto one agent's subtree (bounds from dagre
 *    geometry, so it works before the freshly expanded nodes are measured).
 */
type ViewportCommand =
  | { kind: "overview"; seq: number }
  | { kind: "focus"; ids: string[]; seq: number };

function ViewportController({
  command,
  rootId,
  paneRef,
  expectedCount,
}: {
  command: ViewportCommand;
  rootId?: string;
  paneRef: React.RefObject<HTMLDivElement | null>;
  expectedCount: number;
}) {
  const rf = useReactFlow();
  useEffect(() => {
    // Poll for real geometry rather than gating on a single readiness signal.
    // Gating on useNodesInitialized left the viewport untouched at identity
    // scale — the signal never satisfied us, so the body never ran and nothing
    // positioned the chart at all. Polling is indifferent to which of pane
    // measurement / node measurement / layout settles last, and setInterval is
    // used deliberately over requestAnimationFrame, which never fires in a
    // hidden tab (every background or automated one).
    const apply = (): boolean => {
      const pane = paneRef.current;
      const ns = rf.getNodes();
      if (!pane || !ns.length) return false;
      const w = pane.clientWidth;
      const h = pane.clientHeight;
      if (!w || !h) return false;
      // Wait for the WHOLE board. A partial node set reports a narrower board,
      // which reads as "this would fit legibly", takes the fit branch, and —
      // because apply() then returns true and stops the poll — that wrong
      // viewport is the one that sticks. Count is the right signal because it
      // is ours: gating on xyflow's per-node `measured` instead left the
      // viewport at identity scale forever, since nothing ever satisfied it.
      // A readiness signal you cannot verify is not a readiness signal.
      if (expectedCount && ns.length < expectedCount) return false;
      const dur = prefersReducedMotion() ? 0 : 300;

      if (command.kind === "focus") {
        const subtree = command.ids
          .map((id) => rf.getNode(id))
          .filter((n): n is Node => !!n);
        if (subtree.length < command.ids.length) return false;
        const rect = nodesRect(
          subtree.map((n) => n.position),
          ORG_NODE_W,
          ORG_NODE_H,
        );
        if (!rect) return false;
        const t = fitTarget({ width: w, height: h }, rect, {
          padding: FOCUS_PADDING,
          minZoom: FIT_MIN_ZOOM,
          maxZoom: FOCUS_MAX_ZOOM,
        });
        rf.setCenter(t.cx, t.cy, { zoom: t.zoom, duration: dur });
        return true;
      }

      const bounds = getNodesBounds(ns);
      if (!bounds.width || !bounds.height) return false;

      // What zoom would fitView land on? Mirror its padding so the choice is
      // made BEFORE the viewport moves — fitting and then correcting would let
      // the fit be what the user sees first.
      const wouldFit = fitZoom({ width: w, height: h }, bounds, FIT_PADDING);

      if (wouldFit >= LEGIBLE_ZOOM) {
        rf.fitView({ ...FIT_OPTIONS, duration: dur });
        return true;
      }
      // Too WIDE to show legibly. Anchor horizontally on the apex, which sits
      // centred over its own tier, so the top of the chain of command and the
      // middle of the tier under it are what you land on, with the minimap and
      // panning to reach the rest.
      const root = rootId ? rf.getNode(rootId) : undefined;
      const cx = root
        ? root.position.x + ORG_NODE_W / 2
        : bounds.x + bounds.width / 2;
      // Vertically it is only the width that forces our hand — an org chart is
      // far wider than it is deep, and collapsed to the leadership tier this
      // one is 2 tiers in a pane with room for 8. Pinning the apex to the top
      // of the pane the way a depth-constrained chart needs left 81% of the
      // canvas empty under the chart. So centre the whole depth when it fits,
      // and only pin the apex to the top when the depth overflows too.
      const cy =
        bounds.height * LEGIBLE_ZOOM <= h || !root
          ? bounds.y + bounds.height / 2
          : root.position.y + h / (2 * LEGIBLE_ZOOM) - ORG_NODE_H;
      rf.setCenter(cx, cy, { zoom: LEGIBLE_ZOOM, duration: dur });
      return true;
    };

    if (apply()) return;
    let tries = 0;
    const iv = setInterval(() => {
      if (apply() || ++tries > 40) clearInterval(iv);
    }, 50);
    return () => clearInterval(iv);
  }, [command, rf, rootId, paneRef, expectedCount]);
  return null;
}

type Variant = "inline" | "overlay";

/**
 * Corner zoom cluster: +/− step the zoom about the viewport centre, reset
 * reissues the overview. Wheel-at-cursor / pinch / drag-pan come from xyflow
 * itself — these buttons are the keyboard-and-touch-friendly path (44px
 * targets in the full-screen overlay).
 */
function ZoomControls({
  variant,
  onReset,
}: {
  variant: Variant;
  onReset: () => void;
}) {
  const rf = useReactFlow();
  const step = (dir: 1 | -1) =>
    rf.zoomTo(zoomStep(rf.getZoom(), dir, FIT_MIN_ZOOM, CHART_MAX_ZOOM), {
      duration: prefersReducedMotion() ? 0 : 150,
    });
  const btn = clsx(
    "focus-ring flex items-center justify-center text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100",
    variant === "overlay" ? "h-11 w-11" : "h-8 w-8",
  );
  const icon = variant === "overlay" ? "h-4 w-4" : "h-3.5 w-3.5";
  return (
    <Panel position="bottom-left" className="!m-2">
      <div className="glass flex flex-col divide-y divide-white/[0.06] overflow-hidden rounded-lg shadow-soft">
        <button
          type="button"
          onClick={() => step(1)}
          aria-label="Zoom in"
          title="Zoom in"
          className={btn}
        >
          <ZoomIn className={icon} />
        </button>
        <button
          type="button"
          onClick={() => step(-1)}
          aria-label="Zoom out"
          title="Zoom out"
          className={btn}
        >
          <ZoomOut className={icon} />
        </button>
        <button
          type="button"
          onClick={onReset}
          aria-label="Reset view"
          title="Reset view — fit the chart"
          className={btn}
        >
          <Scan className={icon} />
        </button>
      </div>
    </Panel>
  );
}

/**
 * The org chart as a top-down node graph (dagre layout) with reporting-line
 * edges — the classic org-chart idiom. Starts collapsed to the apex + domain
 * leads; expand a lead (chevron) to drill into their team. Click any node to
 * chat; the node magnifier (or the corner controls) drives the camera.
 *
 * Rendered in two variants: "inline" on the Agents page (with a full-screen
 * button) and "overlay" inside the pop-out (with a close button and larger
 * touch targets). Each mount owns its viewport and drill-down state — the
 * pop-out opens fresh at the overview.
 */
function OrgChartCanvas({
  agents,
  onOpen,
  expandAll = false,
  variant,
  onPopOut,
  onCloseOverlay,
}: {
  agents: Agent[];
  onOpen: (agent: Agent) => void;
  expandAll?: boolean;
  variant: Variant;
  onPopOut?: () => void;
  onCloseOverlay?: () => void;
}) {
  const tree = useMemo(() => buildOrgTree(agents), [agents]);
  // Measured so the fit can tell whether the graph would land at a readable
  // zoom before it moves the viewport.
  const paneRef = useRef<HTMLDivElement>(null);

  const parentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, kids] of tree.childrenById) if (kids.length) ids.add(id);
    return ids;
  }, [tree]);

  // Which agents have their reports shown. Default: just the apex (so the domain
  // leads show, their members collapsed). Search/expand-all opens everything.
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    expandAll
      ? new Set(parentIds)
      : new Set(tree.root ? [tree.root.id] : []),
  );

  const [command, setCommand] = useState<ViewportCommand>({
    kind: "overview",
    seq: 0,
  });
  const requestOverview = useCallback(
    () => setCommand((c) => ({ kind: "overview", seq: c.seq + 1 })),
    [],
  );

  // Roster / search changes reset the drill-down and re-frame the chart. Skip
  // the mount run: the initializers above already produced this exact state,
  // and command seq 0 is the mount's overview.
  const didInit = useRef(false);
  useEffect(() => {
    if (!didInit.current) {
      didInit.current = true;
      return;
    }
    setExpanded(
      expandAll
        ? new Set(parentIds)
        : new Set(tree.root ? [tree.root.id] : []),
    );
    requestOverview();
  }, [tree, expandAll, parentIds, requestOverview]);

  const toggle = useCallback(
    (id: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      // Newly revealed reports come into view / a collapsed board re-frames.
      requestOverview();
    },
    [requestOverview],
  );

  // Zoom to an agent: make their whole subtree visible, then aim the camera
  // at it. The expansion and the focus ride one command so the controller
  // waits for the freshly mounted nodes instead of framing a half-built tree.
  const focusAgent = useCallback(
    (id: string) => {
      const ids = collectSubtreeIds(tree.childrenById, id);
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const sid of ids) {
          if ((tree.childrenById.get(sid) || []).length) next.add(sid);
        }
        return next;
      });
      setCommand((c) => ({ kind: "focus", ids, seq: c.seq + 1 }));
    },
    [tree],
  );

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

  // Emit nodes in chain-of-command order (apex, then each parent's rank-sorted
  // children, depth-first) rather than raw roster order. Dagre seeds its
  // within-rank ordering from insertion order, so roster order scattered the
  // tiers — the two Field Marshal orchestrators landed 11th and 12th in their
  // own row, reading as if they sat below the domain leads instead of beside
  // them. Walking the tree puts the highest rank first in every tier.
  const orderedVisible: Agent[] = useMemo(() => {
    if (!tree.root) return [];
    const out: Agent[] = [];
    const walk = (id: string) => {
      const a = tree.byId.get(id);
      if (!a || !visibleIds.has(id)) return;
      out.push(a);
      for (const c of tree.childrenById.get(id) || []) walk(c);
    };
    walk(tree.root.id);
    return out;
  }, [tree, visibleIds]);

  const rawNodes: Node[] = useMemo(
    () =>
      orderedVisible
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
              onFocus: focusAgent,
            },
          };
        }),
    [orderedVisible, tree, expanded, toggle, focusAgent],
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
          // Reporting lines are decoration, not controls — but xyflow gives
          // every edge an invisible ~20px hit strip for easier clicking, and
          // a pan that STARTS on one of those strips is swallowed instead of
          // panning. That was a dead-zone lattice across the whole chart
          // (worst on touch, where the finger covers the line you can't see).
          // Zero interaction width removes the strip; the visible path stays.
          interactionWidth: 0,
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

  // Double-click on EMPTY canvas re-frames the whole chart. The default
  // double-click behavior (zoom in a notch) is disabled in favour of this;
  // anything interactive — nodes, panels, the minimap, any button — keeps its
  // own double-click meaning and is excluded here.
  const onCanvasDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const t = e.target as Element | null;
      if (
        t &&
        t.closest(
          ".react-flow__node, .react-flow__panel, .react-flow__minimap, .react-flow__edge, button",
        )
      ) {
        return;
      }
      requestOverview();
    },
    [requestOverview],
  );

  const expandEverything = useCallback(() => {
    setExpanded(new Set(parentIds));
    requestOverview();
  }, [parentIds, requestOverview]);
  const collapseToTop = useCallback(() => {
    setExpanded(new Set(tree.root ? [tree.root.id] : []));
    requestOverview();
  }, [tree, requestOverview]);

  const hiddenCount = tree.agents.length - visibleIds.size;

  const overlay = variant === "overlay";
  const clusterBtn = clsx(
    "focus-ring flex items-center gap-1 rounded-md font-medium text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-slate-100",
    overlay ? "min-h-11 px-3 py-2" : "px-2 py-1",
  );
  const clusterIcon = overlay ? "h-3.5 w-3.5" : "h-3 w-3";

  return (
    <div
      ref={paneRef}
      className={clsx(
        "w-full overflow-hidden",
        overlay
          ? "h-full bg-surface-1/60"
          : "h-[72vh] min-h-[520px] rounded-2xl border border-line bg-surface-1/60 shadow-soft",
      )}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        // No `fitView` prop: ReactFlow's built-in fit and the controller were
        // both driving the viewport, and the built-in one won — so the
        // legibility anchoring below was computed, applied, and then silently
        // overwritten by a fit back down to ~0.24. One owner for the viewport.
        minZoom={FIT_MIN_ZOOM}
        maxZoom={CHART_MAX_ZOOM}
        zoomOnDoubleClick={false}
        onDoubleClick={onCanvasDoubleClick}
        nodesDraggable={false}
        // Read-only chart: without this, a touch-drag that lands on a node's
        // 6px connection handle starts a phantom connection gesture instead
        // of doing nothing — noticeable on mobile, where fingers are wide.
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        className="bg-transparent"
      >
        <ViewportController
          command={command}
          rootId={tree.root?.id}
          paneRef={paneRef}
          expectedCount={nodes.length}
        />
        <Panel position="top-right" className="!m-2">
          <div className="glass flex items-center gap-1 rounded-lg p-0.5 text-[11px] shadow-soft">
            <button
              type="button"
              onClick={expandEverything}
              className={clusterBtn}
              title="Expand every team"
            >
              <Maximize2 className={clusterIcon} />
              Expand all
            </button>
            <button
              type="button"
              onClick={collapseToTop}
              className={clusterBtn}
              title="Collapse to the leadership tier"
            >
              <Minimize2 className={clusterIcon} />
              Collapse
            </button>
            {(onPopOut || onCloseOverlay) && (
              <span aria-hidden="true" className="h-4 w-px bg-white/10" />
            )}
            {onPopOut && (
              <button
                type="button"
                onClick={onPopOut}
                className={clusterBtn}
                title="Open the chart full screen"
              >
                <Expand className={clusterIcon} />
                Full screen
              </button>
            )}
            {onCloseOverlay && (
              <button
                type="button"
                onClick={onCloseOverlay}
                aria-label="Close full screen"
                className={clusterBtn}
                title="Close full screen (Esc)"
              >
                <X className={clusterIcon} />
                Close
              </button>
            )}
          </div>
          {hiddenCount > 0 && (
            <p className="mt-1.5 text-right text-[10px] font-medium text-slate-500">
              {hiddenCount} more — expand a lead to drill in
            </p>
          )}
        </Panel>
        <ZoomControls variant={variant} onReset={requestOverview} />
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2b2b44" />
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

/**
 * Full-screen pop-out: the same chart, fresh mount, in a modal overlay — the
 * GlobalSearchModal / AgentChatModal idiom (backdrop click or Esc closes,
 * useModalA11y traps focus). Sits at z-40, one layer UNDER the chat modal's
 * z-50, so clicking an agent in the popped-out chart opens the chat on top of
 * it; that modal's own Esc handling closes one layer at a time.
 */
function OrgChartOverlay({
  agents,
  onOpen,
  expandAll,
  onClose,
}: {
  agents: Agent[];
  onOpen: (agent: Agent) => void;
  expandAll?: boolean;
  onClose: () => void;
}) {
  const panelRef = useModalA11y(true, onClose);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-40 bg-slate-950/80 backdrop-blur-sm sm:p-4"
      onClick={onClose}
    >
      <motion.div
        ref={panelRef}
        initial={{ scale: 0.98, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.98, opacity: 0 }}
        transition={{ duration: 0.15 }}
        role="dialog"
        aria-modal="true"
        aria-label="Org chart — full screen"
        className="glass-heavy relative h-full w-full overflow-hidden shadow-pop sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <OrgChartCanvas
          variant="overlay"
          agents={agents}
          onOpen={onOpen}
          expandAll={expandAll}
          onCloseOverlay={onClose}
        />
      </motion.div>
    </motion.div>
  );
}

/**
 * The Agents-page org chart: inline pane plus an optional full-screen pop-out
 * of the same chart. Camera and drill-down state deliberately do NOT carry
 * across — the pop-out exists to re-take in the whole org, so it opens at the
 * overview.
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
  const [poppedOut, setPoppedOut] = useState(false);

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

  return (
    <>
      <OrgChartCanvas
        variant="inline"
        agents={agents}
        onOpen={onOpen}
        expandAll={expandAll}
        onPopOut={() => setPoppedOut(true)}
      />
      <AnimatePresence>
        {poppedOut && (
          <OrgChartOverlay
            agents={agents}
            onOpen={onOpen}
            expandAll={expandAll}
            onClose={() => setPoppedOut(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
