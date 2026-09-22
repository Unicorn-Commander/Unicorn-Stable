import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Pencil,
  Phone,
  Sparkles,
} from "lucide-react";
import clsx from "clsx";
import { api, type Agent, type Room } from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { resolveDefaultAgent } from "@/components/Sidebar/newChat";
import { useAppStore } from "@/stores/appStore";
import { useFederationStore } from "@/stores/federationStore";
import { LIVE_CALLS_POLL_MS, useLiveCalls } from "@/hooks/useLiveCalls";
import { hasDraft, subscribeDrafts } from "@/utils/drafts";
import type { ActivityTab } from "@/components/Layout/ActivityCenter";
import { previewText, rowTime } from "./widgets/HomeRow";
import {
  isCrewWorking,
  mergeLiveCalls,
  modeLabel,
  moveSection,
  normalizeSectionOrder,
  partitionNeedsYou,
  recentConversations,
  reorderSections,
  todaySectionHidden,
  type HomeSectionId,
} from "./homeModel";
import {
  fetchHomeSummaryV3,
  fetchSectionPrefs,
  homeRequest,
  saveSectionPrefs,
  type CrewCard,
  type HomeActor,
  type HomeSectionPrefs,
  type HomeSummaryV3,
  type NeedsYouRow,
  type PoTaskRow,
  type TodayMeeting,
} from "./homeClient";

const SECTION_LABEL: Record<HomeSectionId, string> = {
  needs_you: "Needs you",
  live_now: "Live now",
  crew: "Your crew",
  recent: "Recent",
  today: "Today",
};

const AGENT_MODES = [
  ["answers_all", "Answers all"],
  ["when_named", "When named"],
  ["listening", "Listening"],
  ["muted", "Muted"],
] as const;

function greetingFor(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function ActorFace({ actor, size = 32 }: { actor: HomeActor; size?: number }) {
  return (
    <Identity
      {...resolveIdentity({
        participant_id: actor.participant_id,
        participant_type: actor.kind === "agent" || actor.kind === "guest" ? actor.kind : "human",
        display_name: actor.display_name,
        avatar_url: actor.avatar_url,
        id: actor.agent_id || actor.participant_id,
        username: actor.agent_id,
      })}
      size={size}
    />
  );
}

function RoomFace({
  room,
  selfId,
  agents,
  size = 32,
}: {
  room: Room;
  selfId: string | null;
  agents: Agent[];
  size?: number;
}) {
  return <Identity {...resolveIdentity(room, { selfId, agents })} size={size} />;
}

function AppFace({ id, name }: { id: string; name: string }) {
  return (
    <Identity
      {...resolveIdentity({ id, display_name: name, name })}
      size={32}
    />
  );
}

function Count({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-300">
      {n}
    </span>
  );
}

function Pill({ children, tone }: { children: string; tone: "live" | "rec" }) {
  return (
    <span
      className={clsx(
        "rounded-full px-1.5 py-0.5 text-[10px] font-bold tracking-wide",
        tone === "rec" ? "bg-rose-500/15 text-rose-300" : "bg-stable-mint/15 text-stable-mint",
      )}
    >
      {children}
    </span>
  );
}

function EmptyLine({ children }: { children: string }) {
  return (
    <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
      {children}
    </p>
  );
}

function Skeleton() {
  return (
    <div className="flex-1 overflow-y-auto" data-testid="home-skeleton" aria-busy="true">
      <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6 sm:px-6">
        <div className="card h-24 animate-pulse-soft" />
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="card space-y-3 p-4">
            <div className="h-3 w-28 rounded bg-white/[0.06]" />
            <div className="h-10 rounded-lg bg-white/[0.04]" />
            <div className="h-10 w-4/5 rounded-lg bg-white/[0.04]" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Dashboard v3 — an inbox. Counts live in the section headers. People and
 * the fleet directory are not on this page.
 */
export function HomeDashboard({
  onOpenActivity,
}: {
  onOpenActivity?: (tab: ActivityTab) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rooms = useAppStore((s) => s.rooms);
  const roomsLoaded = useAppStore((s) => s.roomsLoaded);
  const currentUser = useAppStore((s) => s.currentUser);
  const currentParticipantId = useAppStore((s) => s.currentParticipantId);
  const rosterAgents = useAppStore((s) => s.agents);
  const clearUnread = useAppStore((s) => s.clearUnread);
  const setPeopleDrawerOpen = useAppStore((s) => s.setPeopleDrawerOpen);
  const pushToast = useAppStore((s) => s.pushToast);
  const activeInstanceId = useFederationStore((s) => s.activeInstanceId);

  const summaryQuery = useQuery({
    queryKey: ["home-summary-v3", activeInstanceId],
    queryFn: fetchHomeSummaryV3,
    refetchInterval: LIVE_CALLS_POLL_MS,
  });
  const prefsQuery = useQuery({
    queryKey: ["home-section-prefs", activeInstanceId],
    queryFn: fetchSectionPrefs,
  });
  const preferencesQuery = useQuery({
    queryKey: ["my-preferences", activeInstanceId],
    queryFn: () => api.getMyPreferences(),
    staleTime: 60_000,
  });
  const rosterQuery = useQuery({
    queryKey: ["brigade-roster", activeInstanceId],
    queryFn: () => api.getAgents(),
    staleTime: 60_000,
  });
  const catalogQuery = useQuery({
    queryKey: ["conference-catalog", activeInstanceId],
    queryFn: () => api.getConferenceCatalog(),
    staleTime: 300_000,
  });

  // Shared with the sidebar badges. v3 (above) adds recording, floor, and the inbox.
  const live = useLiveCalls();

  const [draftTick, setDraftTick] = useState(0);
  useEffect(() => subscribeDrafts(() => setDraftTick((n) => n + 1)), []);
  const [staleOpen, setStaleOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragId, setDragId] = useState<HomeSectionId | null>(null);

  const summary: HomeSummaryV3 | undefined = summaryQuery.data;
  const order = useMemo(
    () => normalizeSectionOrder(prefsQuery.data?.order),
    [prefsQuery.data?.order],
  );
  const collapsed = prefsQuery.data?.collapsed ?? {};

  const savePrefs = useMutation({
    mutationFn: (prefs: HomeSectionPrefs) => saveSectionPrefs(prefs),
    onSuccess: (saved) => {
      queryClient.setQueryData(["home-section-prefs", activeInstanceId], saved);
    },
  });

  const persist = useCallback(
    (next: HomeSectionPrefs) => {
      queryClient.setQueryData(["home-section-prefs", activeInstanceId], next);
      savePrefs.mutate(next);
    },
    [activeInstanceId, queryClient, savePrefs],
  );

  const toggleCollapsed = useCallback(
    (id: HomeSectionId) => {
      persist({
        order,
        collapsed: { ...collapsed, [id]: !collapsed[id] },
      });
    },
    [collapsed, order, persist],
  );

  const shift = useCallback(
    (id: HomeSectionId, dir: -1 | 1) => {
      persist({ order: moveSection(order, id, dir), collapsed: { ...collapsed } });
    },
    [collapsed, order, persist],
  );

  const dropOn = useCallback(
    (target: HomeSectionId) => {
      if (!dragId) return;
      persist({
        order: reorderSections(order, dragId, target),
        collapsed: { ...collapsed },
      });
      setDragId(null);
    },
    [collapsed, dragId, order, persist],
  );

  const openRoom = useCallback(
    (id: string) => {
      clearUnread(id);
      navigate(`/c/${id}`);
    },
    [clearUnread, navigate],
  );

  const fail = useCallback(
    (title: string, error: unknown) => {
      pushToast({
        title,
        body: error instanceof Error ? error.message : "Request failed",
        kind: "error",
      });
    },
    [pushToast],
  );

  const decide = useCallback(
    async (row: NeedsYouRow, decision: "approved" | "rejected") => {
      if (!row.message_id || busy) return;
      setBusy(row.message_id + decision);
      try {
        await api.decideAction(row.message_id, decision);
        await queryClient.invalidateQueries({ queryKey: ["home-summary-v3"] });
        await queryClient.invalidateQueries({ queryKey: ["approvals", "pending"] });
      } catch (error) {
        fail(decision === "approved" ? "Couldn't approve" : "Couldn't decline", error);
      } finally {
        setBusy(null);
      }
    },
    [busy, fail, queryClient],
  );

  const hubFor = useCallback(async (card: CrewCard) => {
    if (card.hub_room_id) return card.hub_room_id;
    const hub = await homeRequest<{ id: string }>(
      "POST",
      `/api/v1/agents/${encodeURIComponent(card.agent_id)}/hub`,
    );
    return hub.id;
  }, []);

  const openHub = useCallback(
    async (card: CrewCard) => {
      if (busy) return;
      setBusy(card.agent_id);
      try {
        const id = await hubFor(card);
        openRoom(id);
      } catch (error) {
        fail("Couldn't open the hub", error);
      } finally {
        setBusy(null);
      }
    },
    [busy, fail, hubFor, openRoom],
  );

  const newThread = useCallback(
    async (card: CrewCard) => {
      if (busy) return;
      setBusy(`thread:${card.agent_id}`);
      try {
        const hub = await hubFor(card);
        const thread = await homeRequest<{ id: string }>(
          "POST",
          `/api/v1/rooms/${hub}/threads`,
          {},
        );
        setMenuFor(null);
        openRoom(thread.id);
      } catch (error) {
        fail("Couldn't start a thread", error);
      } finally {
        setBusy(null);
      }
    },
    [busy, fail, hubFor, openRoom],
  );

  const changeMode = useCallback(
    async (card: CrewCard, mode: string) => {
      if (busy) return;
      setBusy(`mode:${card.agent_id}`);
      try {
        const hub = await hubFor(card);
        await homeRequest(
          "PATCH",
          `/api/v1/rooms/${hub}/members/${card.participant_id}`,
          { agent_mode: mode },
        );
        setMenuFor(null);
        await queryClient.invalidateQueries({ queryKey: ["home-summary-v3"] });
      } catch (error) {
        fail("Couldn't change mode", error);
      } finally {
        setBusy(null);
      }
    },
    [busy, fail, hubFor, queryClient],
  );

  const joinStanding = useCallback(
    async (meeting: TodayMeeting) => {
      if (meeting.room_id) {
        openRoom(meeting.room_id);
        return;
      }
      if (!meeting.slug || busy) return;
      setBusy(meeting.slug);
      try {
        const room = await api.enterConferenceRoom(meeting.slug);
        const state = useAppStore.getState();
        if (!state.rooms.some((item) => item.id === room.id)) {
          state.setRooms([room, ...state.rooms]);
        }
        openRoom(room.id);
      } catch (error) {
        fail("Couldn't join", error);
      } finally {
        setBusy(null);
      }
    },
    [busy, fail, openRoom],
  );

  const defaultAgent = useMemo(
    () => resolveDefaultAgent(rosterQuery.data ?? rosterAgents, preferencesQuery.data?.default_agent_id ?? null),
    [preferencesQuery.data?.default_agent_id, rosterAgents, rosterQuery.data],
  );

  const meetAgent = useCallback(async () => {
    if (busy) return;
    setBusy("meet");
    try {
      const hub = await homeRequest<{ id: string }>(
        "POST",
        `/api/v1/agents/${encodeURIComponent(defaultAgent.id)}/hub`,
      );
      await api.setOnboardingChecklist({
        ...(preferencesQuery.data?.onboarding_checklist ?? {}),
        agent: true,
      });
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      openRoom(hub.id);
    } catch (error) {
      fail("Couldn't open that conversation", error);
    } finally {
      setBusy(null);
    }
  }, [busy, defaultAgent.id, fail, openRoom, preferencesQuery.data?.onboarding_checklist, queryClient]);

  const seedChannels = useCallback(async () => {
    if (busy) return;
    setBusy("seed");
    try {
      const created = await api.bootstrapDefaultRooms();
      await api.setOnboardingChecklist({
        ...(preferencesQuery.data?.onboarding_checklist ?? {}),
        channels: true,
      });
      const state = useAppStore.getState();
      if (created.length > 0) state.setRooms(created);
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
    } catch (error) {
      fail("Couldn't seed channels", error);
    } finally {
      setBusy(null);
    }
  }, [busy, fail, preferencesQuery.data?.onboarding_checklist, queryClient]);

  const cold = !roomsLoaded || summaryQuery.isPending;
  if (cold) return <Skeleton />;

  if (summaryQuery.isError || !summary) {
    return (
      <div className="flex-1 overflow-y-auto" data-testid="home-error">
        <div className="mx-auto max-w-lg px-4 py-16 text-center">
          <p className="font-display text-lg text-slate-100">Home didn't load</p>
          <p className="mt-2 text-sm text-slate-400">
            The summary request failed. Nothing below is filled in.
          </p>
          <button
            type="button"
            onClick={() => void summaryQuery.refetch()}
            className="focus-ring gradient-bg mt-4 rounded-lg px-3 py-2 text-xs font-semibold text-white"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (rooms.length === 0) {
    const agentIdentity = resolveIdentity({
      id: defaultAgent.id,
      display_name: defaultAgent.name,
      name: defaultAgent.name,
      participant_type: "agent",
    });
    return (
      <div className="flex-1 overflow-y-auto" data-testid="home-first-run">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
          <section className="card px-5 py-6 sm:px-8" aria-label="Get started">
            <div className="flex items-center gap-4">
              <Identity {...agentIdentity} size={56} />
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  First run
                </p>
                <h1 className="font-display text-2xl font-bold text-slate-50">
                  Meet {defaultAgent.name}
                </h1>
                <p className="mt-1 text-sm text-slate-400">
                  Your workspace starts with one useful conversation.
                </p>
              </div>
            </div>
            <div className="mt-5 grid gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => void meetAgent()}
                disabled={busy === "meet"}
                className="focus-ring rounded-xl border border-line bg-white/[0.05] px-3 py-3 text-left text-sm text-slate-100"
              >
                Meet {defaultAgent.name}
              </button>
              <button
                type="button"
                onClick={() => void seedChannels()}
                disabled={busy === "seed"}
                className="focus-ring rounded-xl border border-line bg-white/[0.05] px-3 py-3 text-left text-sm text-slate-100"
              >
                Seed channels
              </button>
              <button
                type="button"
                onClick={() => {
                  void api.setOnboardingChecklist({
                    ...(preferencesQuery.data?.onboarding_checklist ?? {}),
                    invite: true,
                  });
                  setPeopleDrawerOpen(true);
                }}
                className="focus-ring rounded-xl border border-line bg-white/[0.05] px-3 py-3 text-left text-sm text-slate-100"
              >
                Invite a teammate
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const home = summary;
  const needs = partitionNeedsYou(home.needs_you);
  const recent = recentConversations(rooms);
  const working = home.crew.filter((card) => isCrewWorking(card, Date.now()));
  const liveCalls = mergeLiveCalls(live.list, home.live_calls);
  const catalog = catalogQuery.data ?? [];
  const serverMeetings = home.today?.meetings ?? null;
  const standing: TodayMeeting[] =
    serverMeetings != null
      ? serverMeetings.filter((meeting) => meeting.kind === "standing")
      : catalog.map((room) => ({
          kind: "standing" as const,
          id: room.slug,
          title: room.display_name,
          at: null,
          room_id: null,
          slug: room.slug,
          summary: null,
        }));
  const recaps: TodayMeeting[] | null =
    serverMeetings == null ? null : serverMeetings.filter((meeting) => meeting.kind === "recap");
  const standingFallback =
    serverMeetings != null ? standing.length : catalogQuery.isPending ? 1 : catalog.length;
  const hideToday = todaySectionHidden(home.today, standingFallback);
  const selfId = currentParticipantId ?? currentUser?.id ?? null;
  const hour = new Date().getHours();
  const firstName = currentUser?.displayName?.trim().split(/\s+/)[0] ?? "there";
  const you = resolveIdentity({
    participant_id: currentParticipantId,
    id: currentUser?.id,
    display_name: currentUser?.displayName ?? firstName,
    avatar_url: currentUser?.avatarUrl,
    participant_type: "human",
    is_self: true,
  });

  const roomById = new Map(rooms.map((room) => [room.id, room]));

  function renderNeeds(rows: NeedsYouRow[]) {
    return (
      <ul className="card overflow-hidden">
        {rows.map((row) => (
          <li key={`${row.kind}:${row.room.id}:${row.message_id ?? row.created_at}`} className="border-t border-white/[0.04] first:border-t-0">
            <div className="flex items-start gap-3 px-3 py-2.5">
              <ActorFace actor={row.actor} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-medium text-slate-100">{row.actor.display_name}</p>
                  <span className="shrink-0 text-[11px] text-slate-500">{rowTime(row.created_at)}</span>
                </div>
                <p className="truncate text-xs text-slate-400">
                  {previewText(row.preview) || "—"}
                  <span className="text-slate-600"> · </span>
                  {row.room.display_name}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {row.kind === "approval" && row.message_id && (
                    <>
                      <button
                        type="button"
                        onClick={() => void decide(row, "approved")}
                        className="focus-ring rounded-md bg-stable-mint/15 px-2 py-1 text-[11px] font-semibold text-stable-mint"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => void decide(row, "rejected")}
                        className="focus-ring rounded-md bg-rose-500/10 px-2 py-1 text-[11px] font-semibold text-rose-300"
                      >
                        Decline
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => openRoom(row.room.id)}
                    className="focus-ring rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-slate-200"
                  >
                    {row.action === "join" ? "Join" : row.action === "reply" ? "Reply" : row.action === "approve" ? "Open" : "Open"}
                  </button>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  function renderLive() {
    if (liveCalls.length === 0 && working.length === 0) {
      return <EmptyLine>Nothing live right now.</EmptyLine>;
    }
    return (
      <ul className="card overflow-hidden">
        {liveCalls.map((call) => {
          const room = roomById.get(call.room_id);
          return (
            <li key={call.room_id} className="flex items-center gap-3 border-t border-white/[0.04] px-3 py-2.5 first:border-t-0">
              {room ? (
                <RoomFace room={room} selfId={selfId} agents={rosterAgents} />
              ) : (
                <Identity
                  {...resolveIdentity({
                    type: "channel",
                    id: call.room_id,
                    display_name: call.display_name,
                    name: call.display_name,
                    member_count: call.participant_count,
                  })}
                  size={32}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-sm font-medium text-slate-100">{call.display_name}</p>
                  <Pill tone="live">LIVE</Pill>
                  {call.recording && <Pill tone="rec">REC</Pill>}
                </div>
                <p className="truncate text-xs text-slate-400">
                  {call.participant_count} here
                  {call.floor_holder ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-slate-600"> · </span>
                      <ActorFace actor={call.floor_holder} size={16} />
                      <span>{call.floor_holder.display_name} has the floor</span>
                    </span>
                  ) : null}
                </p>
              </div>
              <button
                type="button"
                onClick={() => openRoom(call.room_id)}
                className="focus-ring shrink-0 rounded-md bg-white/[0.06] px-2.5 py-1 text-[11px] font-semibold text-slate-100"
              >
                Join
              </button>
            </li>
          );
        })}
        {working.map((card) => (
          <li key={`work:${card.agent_id}`} className="flex items-center gap-3 border-t border-white/[0.04] px-3 py-2.5">
            <ActorFace
              actor={{
                participant_id: card.participant_id,
                kind: "agent",
                display_name: card.display_name,
                avatar_url: card.avatar_url,
                agent_id: card.agent_id,
              }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-100">{card.display_name}</p>
              <p className="truncate text-xs text-slate-400">
                {card.current_task || "Working"}
                {card.since ? ` · ${rowTime(card.since)}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  function renderCrew() {
    if (home.crew.length === 0) {
      return <EmptyLine>No agents in your rooms yet.</EmptyLine>;
    }
    return (
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {home.crew.map((card) => (
          <li key={card.agent_id} className="card relative">
            <button
              type="button"
              onClick={() => void openHub(card)}
              className="focus-ring flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left"
            >
              <ActorFace
                actor={{
                  participant_id: card.participant_id,
                  kind: "agent",
                  display_name: card.display_name,
                  avatar_url: card.avatar_url,
                  agent_id: card.agent_id,
                }}
                size={40}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-100">{card.display_name}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1">
                  <span className="rounded-full bg-stable-purple/15 px-1.5 py-0.5 text-[10px] font-semibold text-stable-purple-light">
                    {modeLabel(card.agent_mode)}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">{card.status}</span>
                </span>
                <span className="mt-1 block truncate text-xs text-slate-400">
                  {card.last_line || "No recent line"}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label={`Actions for ${card.display_name}`}
              aria-expanded={menuFor === card.agent_id}
              onClick={() => setMenuFor((current) => (current === card.agent_id ? null : card.agent_id))}
              className="focus-ring absolute right-2 top-2 rounded-md p-1 text-slate-400 hover:bg-white/[0.06]"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menuFor === card.agent_id && (
              <div className="absolute right-2 top-9 z-10 w-44 rounded-xl border border-line bg-slate-950 p-1 shadow-xl">
                <button type="button" onClick={() => void newThread(card)} className="focus-ring block w-full rounded-lg px-2 py-1.5 text-left text-xs text-slate-100 hover:bg-white/[0.06]">
                  New thread
                </button>
                <button
                  type="button"
                  onClick={() => void openHub(card)}
                  className="focus-ring flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-xs text-slate-100 hover:bg-white/[0.06]"
                >
                  <Phone className="h-3 w-3" /> Call
                </button>
                <p className="px-2 pt-1 text-[10px] uppercase tracking-wide text-slate-500">Change mode</p>
                {AGENT_MODES.map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => void changeMode(card, mode)}
                    className="focus-ring block w-full rounded-lg px-2 py-1 text-left text-xs text-slate-300 hover:bg-white/[0.06]"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    );
  }

  function renderRecent() {
    if (recent.length === 0) return <EmptyLine>No conversations yet.</EmptyLine>;
    return (
      <ul className="card overflow-hidden">
        {recent.map((room) => (
          <li key={room.id}>
            <button
              type="button"
              onClick={() => openRoom(room.id)}
              className="focus-ring flex w-full items-center gap-3 border-t border-white/[0.04] px-3 py-2.5 text-left first:border-t-0"
            >
              <RoomFace room={room} selfId={selfId} agents={rosterAgents} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-slate-100">
                    {room.display_name || room.name}
                  </span>
                  {draftTick >= 0 && hasDraft(room.id) && (
                    <Pencil className="h-3 w-3 shrink-0 text-slate-400" aria-label="Draft" />
                  )}
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {room.last_message ? previewText(room.last_message.content) : "No messages yet"}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-slate-500">
                {rowTime(room.last_message?.created_at ?? room.updated_at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  function renderTask(task: PoTaskRow) {
    const body = (
      <>
        <AppFace id="project-ops" name="Project-Ops" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-100">{task.title}</span>
          <span className="block truncate text-xs text-slate-500">
            {task.project_number ? `${task.project_number} · ` : ""}
            {task.due_date ? `Due ${task.due_date}` : "Due"}
            {task.status ? ` · ${task.status}` : ""}
          </span>
        </span>
      </>
    );
    if (task.url) {
      return (
        <a
          key={task.id}
          href={task.url}
          className="focus-ring flex items-center gap-3 border-t border-white/[0.04] px-3 py-2.5 first:border-t-0"
        >
          {body}
        </a>
      );
    }
    return (
      <div key={task.id} className="flex items-center gap-3 border-t border-white/[0.04] px-3 py-2.5 first:border-t-0">
        {body}
      </div>
    );
  }

  function renderToday() {
    const tasks = home.today?.po_tasks ?? null;
    const taskCount = tasks?.length ?? 0;
    const meetingCount = standing.length + (recaps?.length ?? 0);
    return (
      <div className="space-y-3">
        {tasks == null ? null : tasks.length === 0 ? (
          <EmptyLine>No tasks due through tomorrow.</EmptyLine>
        ) : (
          <div className="card overflow-hidden">{tasks.map(renderTask)}</div>
        )}
        {standing.length > 0 && (
          <ul className="card overflow-hidden">
            {standing.map((meeting) => (
              <li key={meeting.id} className="flex items-center gap-3 border-t border-white/[0.04] px-3 py-2.5 first:border-t-0">
                <Identity
                  {...resolveIdentity({
                    type: "channel",
                    id: meeting.slug || meeting.id,
                    display_name: meeting.title,
                    name: meeting.title,
                    member_count: 1,
                  })}
                  size={32}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">{meeting.title}</p>
                  <p className="text-xs text-slate-500">Standing room</p>
                </div>
                <button
                  type="button"
                  onClick={() => void joinStanding(meeting)}
                  className="focus-ring shrink-0 rounded-md bg-white/[0.06] px-2.5 py-1 text-[11px] font-semibold text-slate-100"
                >
                  Join
                </button>
              </li>
            ))}
          </ul>
        )}
        {recaps == null ? null : recaps.length === 0 ? (
          <EmptyLine>No Meeting-Ops recaps in the last day.</EmptyLine>
        ) : (
          <ul className="card overflow-hidden">
            {recaps.map((meeting) => (
              <li key={meeting.id} className="flex items-start gap-3 border-t border-white/[0.04] px-3 py-2.5 first:border-t-0">
                <AppFace id="meeting-ops" name="Meeting-Ops" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-100">{meeting.title}</p>
                  <p className="truncate text-xs text-slate-400">
                    {meeting.summary || "Recap"}
                    {meeting.at ? ` · ${rowTime(meeting.at)}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <span className="sr-only">
          {taskCount + meetingCount} today
        </span>
      </div>
    );
  }

  const sections: Record<HomeSectionId, { count: number; body: ReactNode; hidden?: boolean }> = {
    needs_you: {
      count: needs.fresh.length,
      body: (
        <div className="space-y-2">
          {needs.fresh.length === 0 && needs.stale.length === 0 ? (
            <EmptyLine>You're clear.</EmptyLine>
          ) : (
            <>
              {needs.fresh.length > 0 && renderNeeds(needs.fresh)}
              {needs.stale.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setStaleOpen((open) => !open)}
                    className="focus-ring text-xs font-medium text-slate-500"
                    aria-expanded={staleOpen}
                  >
                    Stale ({needs.stale.length})
                  </button>
                  {staleOpen && <div className="mt-2">{renderNeeds(needs.stale)}</div>}
                </div>
              )}
            </>
          )}
          {onOpenActivity && (
            <button
              type="button"
              onClick={() => onOpenActivity("approvals")}
              className="focus-ring text-xs font-medium text-slate-400"
            >
              Open activity
            </button>
          )}
        </div>
      ),
    },
    live_now: { count: liveCalls.length + working.length, body: renderLive() },
    crew: { count: home.crew.length, body: renderCrew() },
    recent: { count: recent.length, body: renderRecent() },
    today: {
      count:
        (home.today?.po_tasks?.length ?? 0) +
        standing.length +
        (recaps?.length ?? 0),
      hidden: hideToday,
      body: renderToday(),
    },
  };

  return (
    <div className="flex-1 overflow-y-auto" data-testid="home-loaded">
      <div
        className="animate-fade-in mx-auto w-full max-w-5xl px-4 py-6 sm:px-6"
        data-testid="home-dashboard"
      >
        <header className="card mb-4 flex items-center gap-3 px-4 py-4 sm:px-5">
          <Identity {...you} size={40} />
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              <Sparkles className="mr-1 inline h-3 w-3" aria-hidden="true" />
              Unicorn Stable
            </p>
            <h1 className="font-display text-xl font-bold text-slate-50 sm:text-2xl">
              {greetingFor(hour)}, {firstName}
            </h1>
          </div>
        </header>
        <div className="space-y-4">
          {order.map((id) => {
            const section = sections[id];
            if (section.hidden) return null;
            const isCollapsed = collapsed[id] === true;
            return (
              <section
                key={id}
                aria-labelledby={`home-${id}-heading`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => dropOn(id)}
              >
                <div className="mb-2 flex items-center gap-1">
                  <button
                    type="button"
                    id={`home-${id}-heading`}
                    draggable
                    onDragStart={() => setDragId(id)}
                    onClick={() => toggleCollapsed(id)}
                    aria-expanded={!isCollapsed}
                    className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-left"
                  >
                    <ChevronDown
                      className={clsx("h-4 w-4 shrink-0 text-slate-500 transition", isCollapsed && "-rotate-90")}
                    />
                    <span className="font-display text-sm font-semibold text-slate-200">
                      {SECTION_LABEL[id]}
                    </span>
                    <Count n={section.count} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${SECTION_LABEL[id]} up`}
                    onClick={() => shift(id, -1)}
                    className="focus-ring rounded-md p-1 text-slate-500 hover:bg-white/[0.05]"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${SECTION_LABEL[id]} down`}
                    onClick={() => shift(id, 1)}
                    className="focus-ring rounded-md p-1 text-slate-500 hover:bg-white/[0.05]"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>
                {!isCollapsed && section.body}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
