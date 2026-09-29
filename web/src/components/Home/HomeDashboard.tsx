import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import clsx from "clsx";
import { api, type Agent, type Room } from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { lastLinePreview } from "@/lib/systemLines";
import { useAppStore } from "@/stores/appStore";
import { useFederationStore } from "@/stores/federationStore";
import { useNavStore } from "@/stores/navStore";
import { LIVE_CALLS_POLL_MS, useLiveCalls } from "@/hooks/useLiveCalls";
import { hasDraft, subscribeDrafts } from "@/utils/drafts";
import type { ActivityTab } from "@/components/Layout/ActivityCenter";
import { previewText, rowTime } from "./widgets/HomeRow";
import {
  BOARD_CLEAR_LINE,
  HOME_RECENT_CAP,
  HOME_ZONE_LABEL,
  homeZones,
  isCrewWorking,
  mergeLiveCalls,
  orderNeedsYou,
  partitionNeedsYou,
  recentConversations,
  todaySectionHidden,
  type HomeZoneId,
} from "./homeModel";
import {
  fetchHomeSummaryV3,
  type HomeActor,
  type HomeSummaryV3,
  type NeedsYouRow,
  type PoTaskRow,
  type TodayMeeting,
} from "./homeClient";
import { HomeComposer } from "./HomeComposer";
import { SeatCards, useOwnSeatRows } from "./SeatCards";

/** Below `md` the shell is the phone's: tabs at the foot, and Home's composer pinned above them. */
const PHONE_QUERY = "(max-width: 767px)";

function usePhoneShell(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_QUERY)?.matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(PHONE_QUERY);
    if (!mq) return;
    const onChange = (event: MediaQueryListEvent) => setPhone(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return phone;
}

function ActorFace({ actor, size = 28 }: { actor: HomeActor; size?: number }) {
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
  size = 28,
}: {
  room: Room;
  selfId: string | null;
  agents: Agent[];
  size?: number;
}) {
  return <Identity {...resolveIdentity(room, { selfId, agents })} size={size} />;
}

function AppFace({ id, name }: { id: string; name: string }) {
  return <Identity {...resolveIdentity({ id, display_name: name, name })} size={28} />;
}

function Pill({ children, tone }: { children: string; tone: "live" | "rec" }) {
  return (
    <span
      className={clsx(
        "rounded-full px-1.5 py-0.5 text-[10px] font-bold tracking-wide",
        tone === "rec" ? "bg-stable-coral/10 text-stable-coral" : "bg-stable-mint/10 text-stable-mint",
      )}
    >
      {children}
    </span>
  );
}

const ROWS = "overflow-hidden rounded-xl border border-line bg-white/[0.02]";
const ROW = "border-t border-white/[0.04] first:border-t-0";
const SMALL_BUTTON =
  "focus-ring shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold max-md:min-h-9 max-md:px-2.5";

function Zone({
  id,
  count,
  action,
  children,
}: {
  id: HomeZoneId;
  count: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-testid={`home-zone-${id}`} aria-labelledby={`home-${id}-heading`}>
      <div className="flex items-center justify-between gap-2 px-1 pb-1.5">
        <h2
          id={`home-${id}-heading`}
          className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500"
        >
          {HOME_ZONE_LABEL[id]}
          {count > 0 && (
            <span className="ml-1.5 tabular-nums text-slate-400" data-testid="home-count">
              {count}
            </span>
          )}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ZoneSkeleton() {
  return (
    <div className="space-y-2" data-testid="home-skeleton" aria-busy="true">
      <div className="h-2.5 w-20 rounded bg-white/[0.06]" />
      <div className={clsx(ROWS, "animate-pulse-soft")}>
        {[0, 1, 2].map((index) => (
          <div key={index} className={clsx(ROW, "flex items-center gap-3 px-3 py-2.5")}>
            <div className="h-7 w-7 shrink-0 rounded-full bg-white/[0.05]" />
            <div className="h-2.5 flex-1 rounded bg-white/[0.05]" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Home v4 (Nav v3 §2.7) — a composer, not a report.
 *
 * The composer is the first thing on the page; your seats sit under it;
 * then what needs you, what is live, what is due today and where you were,
 * each only while it has rows. A quiet day is the composer, your seats and
 * one line. On a phone the order is the same in one column, with the
 * composer pinned above the tab bar.
 *
 * The composer and the seats come from /crew and do not wait for the
 * summary: a summary that is slow, or fails, costs the zones and nothing
 * else.
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
  const phone = usePhoneShell();
  const seatRows = useOwnSeatRows();

  const summaryQuery = useQuery({
    queryKey: ["home-summary-v3", activeInstanceId],
    queryFn: fetchHomeSummaryV3,
    refetchInterval: LIVE_CALLS_POLL_MS,
  });
  const preferencesQuery = useQuery({
    queryKey: ["my-preferences", activeInstanceId],
    queryFn: () => api.getMyPreferences(),
    staleTime: 60_000,
  });
  const catalogQuery = useQuery({
    queryKey: ["conference-catalog", activeInstanceId],
    queryFn: () => api.getConferenceCatalog(),
    staleTime: 300_000,
  });

  // Shared with the sidebar badges. The summary adds recording and the floor.
  const live = useLiveCalls();

  const [draftTick, setDraftTick] = useState(0);
  useEffect(() => subscribeDrafts(() => setDraftTick((n) => n + 1)), []);
  const [staleOpen, setStaleOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const summary: HomeSummaryV3 | undefined = summaryQuery.data;

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

  const showAllConversations = useCallback(() => {
    useNavStore.getState().setV2Destination("conversations");
    const state = useAppStore.getState();
    if (!state.ui.sidebarOpen) state.toggleSidebar();
  }, []);

  const selfId = currentParticipantId ?? currentUser?.id ?? null;
  const roomById = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms]);
  const seatIds = useMemo(() => new Set(seatRows.map((row) => row.member.agent_id)), [seatRows]);

  const firstRun = roomsLoaded && rooms.length === 0;
  const state: "loading" | "error" | "first-run" | "loaded" =
    !roomsLoaded || summaryQuery.isPending
      ? "loading"
      : summaryQuery.isError || !summary
        ? "error"
        : firstRun
          ? "first-run"
          : "loaded";

  let body: ReactNode = null;
  let quiet = true;

  if (state === "loading") {
    quiet = false;
    body = <ZoneSkeleton />;
  } else if (state === "error" || !summary) {
    body = (
      <div className="px-1 text-sm" data-testid="home-error">
        <p className="text-slate-300">Home didn't load.</p>
        <p className="mt-0.5 text-xs text-slate-500">
          The summary request failed, so nothing below the seats is filled in. The composer works.
        </p>
        <button
          type="button"
          onClick={() => void summaryQuery.refetch()}
          className="focus-ring mt-2 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/[0.05]"
        >
          Try again
        </button>
      </div>
    );
  } else {
    const home = summary;
    const needs = partitionNeedsYou(home.needs_you);
    const fresh = orderNeedsYou(needs.fresh);
    const stale = orderNeedsYou(needs.stale);
    const recent = recentConversations(rooms, HOME_RECENT_CAP);
    const liveCalls = mergeLiveCalls(live.list, home.live_calls);
    // A seat's card says what the seat is doing; this is the house at work.
    const working = home.crew.filter(
      (card) => !seatIds.has(card.agent_id) && isCrewWorking(card, Date.now()),
    );
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
    const recaps: TodayMeeting[] =
      serverMeetings == null ? [] : serverMeetings.filter((meeting) => meeting.kind === "recap");
    const standingFallback =
      serverMeetings != null ? standing.length : catalogQuery.isPending ? 1 : catalog.length;
    const hideToday = todaySectionHidden(home.today, standingFallback);
    const tasks: PoTaskRow[] = hideToday ? [] : (home.today?.po_tasks ?? []);
    // A standing room is always there; it is not something due. Today is
    // drawn for what has a date, and lists the standing rooms under it.
    const dated = hideToday ? 0 : tasks.length + recaps.length;

    const zones = homeZones({
      needsCount: fresh.length + stale.length,
      liveCount: liveCalls.length + working.length,
      todayCount: dated,
      recentCount: recent.length,
      seatCount: seatRows.length,
    });
    quiet = zones.zones.length === 0;

    const renderNeeds = (rows: NeedsYouRow[]) => (
      <ul className={ROWS}>
        {rows.map((row) => (
          <li
            key={`${row.kind}:${row.room.id}:${row.message_id ?? row.created_at}`}
            className={clsx(ROW, "flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2")}
            data-testid="home-needs-row"
            data-kind={row.kind}
          >
            <ActorFace actor={row.actor} />
            <div className="min-w-0 flex-1 basis-40">
              <p className="flex items-baseline gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-slate-100">
                  {row.actor.display_name}
                </span>
                <span className="shrink-0 text-[11px] text-slate-500">{rowTime(row.created_at)}</span>
              </p>
              <p className="truncate text-xs text-slate-400">
                {previewText(row.preview) || "—"}
                {/* The room, when it is not the person: a hub or a DM is named by its face. */}
                {row.room.display_name && row.room.display_name !== row.actor.display_name && (
                  <>
                    <span className="text-slate-600"> · </span>
                    {row.room.display_name}
                  </>
                )}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {row.kind === "approval" && row.message_id && (
                <>
                  <button
                    type="button"
                    onClick={() => void decide(row, "approved")}
                    className={clsx(SMALL_BUTTON, "bg-stable-mint/10 text-stable-mint")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => void decide(row, "rejected")}
                    className={clsx(SMALL_BUTTON, "bg-stable-coral/10 text-stable-coral")}
                  >
                    Decline
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => openRoom(row.room.id)}
                className={clsx(SMALL_BUTTON, "border border-line text-slate-200")}
              >
                {row.action === "join" ? "Join" : row.action === "reply" ? "Reply" : "Open"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    );

    const zoneBody: Record<HomeZoneId, () => ReactNode> = {
      needs_you: () => (
        <Zone
          id="needs_you"
          count={fresh.length}
          action={
            onOpenActivity && (
              <button
                type="button"
                onClick={() => onOpenActivity("approvals")}
                className="focus-ring rounded text-[11px] font-medium text-slate-400 hover:text-slate-200"
              >
                Activity
              </button>
            )
          }
        >
          <div className="space-y-1.5">
            {fresh.length > 0 && renderNeeds(fresh)}
            {stale.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setStaleOpen((open) => !open)}
                  className="focus-ring rounded px-1 text-[11px] font-medium text-slate-500 hover:text-slate-300"
                  aria-expanded={staleOpen}
                >
                  Older ({stale.length})
                </button>
                {staleOpen && <div className="mt-1.5">{renderNeeds(stale)}</div>}
              </div>
            )}
          </div>
        </Zone>
      ),
      live_now: () => (
        <Zone id="live_now" count={liveCalls.length + working.length}>
          <ul className={ROWS}>
            {liveCalls.map((call) => {
              const room = roomById.get(call.room_id);
              return (
                <li
                  key={call.room_id}
                  className={clsx(ROW, "flex items-center gap-3 px-3 py-2")}
                  data-testid="home-live-row"
                >
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
                      size={28}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate text-sm font-medium text-slate-100">
                        {call.display_name}
                      </span>
                      <Pill tone="live">LIVE</Pill>
                      {call.recording && <Pill tone="rec">REC</Pill>}
                    </p>
                    <p className="truncate text-xs text-slate-400">
                      {call.participant_count} here
                      {call.floor_holder ? (
                        <span>
                          <span className="text-slate-600"> · </span>
                          {call.floor_holder.display_name} has the floor
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openRoom(call.room_id)}
                    className={clsx(SMALL_BUTTON, "bg-white/[0.06] text-slate-100")}
                  >
                    Join
                  </button>
                </li>
              );
            })}
            {working.map((card) => (
              <li
                key={`work:${card.agent_id}`}
                className={clsx(ROW, "flex items-center gap-3 px-3 py-2")}
              >
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
        </Zone>
      ),
      today: () => (
        <Zone id="today" count={dated}>
          <ul className={ROWS}>
            {tasks.map((task) => {
              const inner = (
                <>
                  <AppFace id="project-ops" name="Project-Ops" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-100">
                      {task.title}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {task.project_number ? `${task.project_number} · ` : ""}
                      {task.due_date ? `Due ${task.due_date}` : "Due"}
                      {task.status ? ` · ${task.status}` : ""}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={task.id} className={ROW} data-testid="home-task-row">
                  {task.url ? (
                    <a href={task.url} className="focus-ring flex items-center gap-3 px-3 py-2">
                      {inner}
                    </a>
                  ) : (
                    <div className="flex items-center gap-3 px-3 py-2">{inner}</div>
                  )}
                </li>
              );
            })}
            {recaps.map((meeting) => (
              <li key={meeting.id} className={clsx(ROW, "flex items-center gap-3 px-3 py-2")}>
                <AppFace id="meeting-ops" name="Meeting-Ops" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">{meeting.title}</p>
                  <p className="truncate text-xs text-slate-400">
                    {meeting.summary || "Recap"}
                    {meeting.at ? ` · ${rowTime(meeting.at)}` : ""}
                  </p>
                </div>
              </li>
            ))}
            {standing.map((meeting) => (
              <li key={meeting.id} className={clsx(ROW, "flex items-center gap-3 px-3 py-2")}>
                <Identity
                  {...resolveIdentity({
                    type: "channel",
                    id: meeting.slug || meeting.id,
                    display_name: meeting.title,
                    name: meeting.title,
                    member_count: 1,
                  })}
                  size={28}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">{meeting.title}</p>
                  <p className="text-xs text-slate-500">Standing room</p>
                </div>
                <button
                  type="button"
                  onClick={() => void joinStanding(meeting)}
                  className={clsx(SMALL_BUTTON, "bg-white/[0.06] text-slate-100")}
                >
                  Join
                </button>
              </li>
            ))}
          </ul>
        </Zone>
      ),
      recent: () => (
        <Zone
          id="recent"
          count={0}
          action={
            <button
              type="button"
              onClick={showAllConversations}
              className="focus-ring rounded text-[11px] font-medium text-slate-400 hover:text-slate-200"
              data-testid="home-recent-all"
            >
              Show all
            </button>
          }
        >
          <ul className={ROWS}>
            {recent.map((room) => (
              <li key={room.id} className={ROW}>
                <button
                  type="button"
                  onClick={() => openRoom(room.id)}
                  className="focus-ring flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-white/[0.03] max-md:min-h-11"
                  data-testid="home-recent-row"
                >
                  <RoomFace room={room} selfId={selfId} agents={rosterAgents} size={20} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    <span className="font-medium text-slate-100">{room.display_name || room.name}</span>
                    {room.last_message && (
                      <span className="text-slate-500">
                        {" "}
                        · {previewText(lastLinePreview(room.last_message).text)}
                      </span>
                    )}
                  </span>
                  {draftTick >= 0 && hasDraft(room.id) && (
                    <Pencil className="h-3 w-3 shrink-0 text-slate-400" aria-label="Draft" />
                  )}
                  <span className="shrink-0 text-[11px] text-slate-500">
                    {rowTime(room.last_message?.created_at ?? room.updated_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Zone>
      ),
    };

    body = (
      <>
        {zones.boardClear && state === "loaded" && (
          <p className="px-1 text-sm text-slate-400" data-testid="home-board-clear">
            {BOARD_CLEAR_LINE}
          </p>
        )}
        {state === "first-run" && (
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-slate-500"
            data-testid="home-first-run"
          >
            <span>No conversations yet.</span>
            <button
              type="button"
              onClick={() => void seedChannels()}
              disabled={busy === "seed"}
              className="focus-ring rounded font-medium text-slate-300 underline-offset-2 hover:underline disabled:opacity-50 max-md:min-h-9"
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
              className="focus-ring rounded font-medium text-slate-300 underline-offset-2 hover:underline max-md:min-h-9"
            >
              Invite a teammate
            </button>
          </div>
        )}
        {zones.zones.map((id) => (
          <div key={id}>{zoneBody[id]()}</div>
        ))}
      </>
    );
  }

  const cards = summary?.crew ?? [];

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid={state === "loaded" || state === "first-run" ? "home-loaded" : `home-${state}-state`}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={clsx(
            "animate-fade-in mx-auto w-full max-w-[52rem] space-y-5 px-4 pb-8 sm:px-6",
            // A quiet day opens like a blank page: the box a third of the way
            // down. With rows under it, the box goes to the top.
            phone ? "pt-4" : quiet ? "pt-[14vh]" : "pt-8",
          )}
          data-testid="home-dashboard"
          data-state={state}
        >
          <h1 className="sr-only">Home</h1>
          {!phone && <HomeComposer />}
          <SeatCards rows={seatRows} cards={cards} />
          {body}
        </div>
      </div>
      {phone && (
        <div
          className="shrink-0 border-t border-line bg-surface-0/80 backdrop-blur-xl"
          data-testid="home-composer-pinned"
        >
          <HomeComposer pinned />
        </div>
      )}
    </div>
  );
}
