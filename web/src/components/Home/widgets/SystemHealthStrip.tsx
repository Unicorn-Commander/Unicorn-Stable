import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { api, type ApiError } from "@/services/api";
import { ws } from "@/services/websocket";
import { useFederationStore } from "@/stores/federationStore";
import {
  agentsSegment,
  buildRevision,
  overallTone,
  serviceEntries,
  type SegmentTone,
} from "@/components/Home/homeModel";

/**
 * W7 — the ambient system-health strip.
 *
 * This exists because the app once served a green-looking SPA through a 45 h
 * backend outage: nothing on the page said anything was wrong. The strip is
 * the standing answer to "is the system healthy?" — the AppShell banner still
 * owns outage TAKEOVER UX (reconnect countdowns, sign-in escapes); this bar
 * only states facts, quietly, all the time. It therefore has no empty state:
 * the worst it can render is all-gray "unknown", because an absent health
 * surface is what hid the last outage.
 */

export interface HealthSegment {
  key: string;
  label: string;
  tone: SegmentTone;
  /** Hover text (native title) — per-service states, doctrine notes. */
  detail?: string;
}

export interface HomeHealthModel {
  segments: HealthSegment[];
  overall: SegmentTone;
  /** Short deploy sha when the server reports one — deploy-drift visibility. */
  revision: string | null;
}

/**
 * One hook, two consumers: the strip renders every segment, and the stat
 * strip's 7th "Workspace" tile renders {@link HomeHealthModel.overall}. Both
 * call this — react-query dedupes the fetches by key and the ws subscription
 * is a cheap listener, so sharing state through props vs. calling twice costs
 * the same, and the tile can never disagree with the strip it scrolls to.
 */
export function useHomeHealth(): HomeHealthModel {
  const activeInstanceId = useFederationStore((s) => s.activeInstanceId);

  // Realtime — event-driven, seeded from the live getter so a dashboard
  // mounted after the socket settled starts truthful instead of defaulting
  // one way and waiting for the next transition.
  const [realtimeUp, setRealtimeUp] = useState(() => ws.connected);
  useEffect(() => {
    setRealtimeUp(ws.connected);
    const offUp = ws.on("connected", () => setRealtimeUp(true));
    const offDown = ws.on("disconnected", () => setRealtimeUp(false));
    return () => {
      offUp();
      offDown();
    };
  }, []);

  // Server — same query key as Settings → Instance, so the two surfaces can
  // never disagree and the dashboard rides free when Settings is warm.
  // retry:false — the strip's job is to show trouble NOW, not after three
  // silent retries; getInstanceHealth already treats a readiness 503 as data.
  const healthQuery = useQuery({
    queryKey: ["instance-health", activeInstanceId],
    queryFn: () => api.getInstanceHealth(),
    refetchInterval: 60_000,
    retry: false,
  });

  // Agents — the same roster the fleet card and Agents page poll (shared key).
  const { data: roster = [] } = useQuery({
    queryKey: ["brigade-roster", activeInstanceId],
    queryFn: () => api.getAgents(),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  // Meetings — a config probe; it changes on redeploy, not minute to minute.
  const { data: meetingOps, isError: meetingOpsFailed } = useQuery({
    queryKey: ["meeting-ops-status", activeInstanceId],
    queryFn: () => api.getMeetingOpsStatus(),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const health = healthQuery.data;
  const healthFailed = healthQuery.isError;
  const healthError = healthQuery.error as ApiError | null;

  return useMemo(() => {
    const segments: HealthSegment[] = [];

    segments.push(
      realtimeUp
        ? { key: "realtime", label: "Realtime", tone: "ok" }
        : {
            key: "realtime",
            label: "Reconnecting…",
            tone: "warn",
            detail:
              "Live updates are down; the app is retrying in the background.",
          },
    );

    let revision: string | null = null;
    let server: HealthSegment;
    if (health) {
      revision = buildRevision(health.services);
      const detail = serviceEntries(health.services ?? {})
        .map((e) => `${e.name}: ${e.state}`)
        .join("\n");
      server =
        health.status === "ready"
          ? { key: "server", label: "Server ready", tone: "ok", detail }
          : { key: "server", label: "Server degraded", tone: "warn", detail };
    } else if (healthFailed) {
      // No parseable readiness body at all — the app itself is out of reach
      // (network down, proxy 5xx). A reachable-but-degraded server lands in
      // the branch above with its failing services named.
      server = {
        key: "server",
        label: "Server unreachable",
        tone: "warn",
        detail: healthError?.status
          ? `Health check failed (HTTP ${healthError.status})`
          : "Health check failed",
      };
    } else {
      server = { key: "server", label: "Server checking…", tone: "unknown" };
    }
    segments.push(server);

    const agents = agentsSegment(roster);
    segments.push({
      key: "agents",
      label: `Agents · ${agents.label}`,
      tone: agents.tone,
      detail:
        agents.tone === "unknown"
          ? "No availability signal from the agent runtime — unknown is the honest answer, not green."
          : undefined,
    });

    let meetings: HealthSegment;
    if (meetingOps) {
      meetings = meetingOps.configured
        ? { key: "meetings", label: "Transcripts wired", tone: "ok" }
        : {
            key: "meetings",
            label: "Transcripts off",
            // Explicitly not configured — a known state, so it must not park
            // the Workspace chip on "unknown" forever (see overallTone).
            tone: "off",
            detail: "Meeting-Ops is not configured on this instance.",
          };
    } else {
      meetings = {
        key: "meetings",
        label: "Transcripts · unknown",
        tone: "unknown",
        detail: meetingOpsFailed
          ? "Could not read the Meeting-Ops status."
          : undefined,
      };
    }
    segments.push(meetings);

    return {
      segments,
      overall: overallTone(segments.map((s) => s.tone)),
      revision,
    };
  }, [realtimeUp, health, healthFailed, healthError, roster, meetingOps, meetingOpsFailed]);
}

/** Static dots by design: no animate-live here, so the strip is calm and
 * reduced-motion safe without any media-query work. `off` shares unknown's
 * gray — visually "nothing to watch", semantically distinguished only where
 * it matters (the overall rollup). */
const DOT: Record<SegmentTone, string> = {
  ok: "bg-status-active",
  warn: "bg-status-working",
  unknown: "bg-status-offline",
  off: "bg-status-offline",
};

const LABEL: Record<SegmentTone, string> = {
  ok: "text-slate-300",
  warn: "text-status-working",
  unknown: "text-slate-500",
  off: "text-slate-500",
};

export function SystemHealthStrip({ health }: { health: HomeHealthModel }) {
  return (
    <div
      role="status"
      aria-label="System health"
      className="card flex flex-wrap items-center gap-x-5 gap-y-1.5 px-4 py-2.5"
    >
      {health.segments.map((segment) => (
        <span
          key={segment.key}
          title={segment.detail}
          className="flex items-center gap-1.5 text-xs font-medium"
        >
          <span
            aria-hidden="true"
            className={clsx(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              DOT[segment.tone],
            )}
          />
          <span className={clsx(LABEL[segment.tone])}>{segment.label}</span>
          {segment.key === "server" && health.revision && (
            <span
              className="font-mono text-[10px] text-slate-600"
              title="Deployed build revision"
            >
              {health.revision}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
