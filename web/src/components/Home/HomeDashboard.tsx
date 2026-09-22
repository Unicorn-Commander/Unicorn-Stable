import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AtSign,
  Bot,
  Hash,
  Inbox,
  MessageSquare,
  Phone,
  Plus,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import { api, type PeopleDirectoryEntry } from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { ensureHumanDm } from "@/lib/ensureHumanDm";
import { resolveIdentity } from "@/lib/identity";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import { useFederationStore } from "@/stores/federationStore";
import { useKnowledgeStore } from "@/stores/knowledgeStore";
import { usePresenceStore } from "@/stores/presenceStore";
import { useVoice } from "@/contexts/VoiceProvider";
import {
  homeSummaryQueryKey,
  LIVE_CALLS_POLL_MS,
} from "@/hooks/useLiveCalls";
import {
  agentFeed,
  agentSubtitle,
  rankedFleet,
  type ConversationsTab,
  priorityModel,
  sortByRecency,
} from "./homeModel";
import { HomeRow, SenderLine, previewText, rowTime } from "./widgets/HomeRow";
import { SystemHealthStrip, useHomeHealth } from "./widgets/SystemHealthStrip";
import { ConversationsCard } from "./widgets/ConversationsCard";
import { KnowledgeRecents } from "./widgets/KnowledgeRecents";
import type { ActivityTab } from "@/components/Layout/ActivityCenter";

/** One tile in the command-center stat strip. */
type HomeStat = {
  key: string;
  label: string;
  value: string;
  icon: LucideIcon;
  /** Icon text-color class. */
  tone: string;
  /** Ring the tile when it demands attention (mentions/approvals > 0). */
  attention?: boolean;
  onClick?: () => void;
};

function StatTile({ stat }: { stat: HomeStat }) {
  const Icon = stat.icon;
  // A zero is a real answer, but it is not NEWS. Rendering six zeros in the
  // same white bold as the one number that matters makes the eye search for
  // the signal instead of landing on it — the strip reads as a wall of
  // digits. Zeros keep their tile (the set is stable, and the count is still
  // there when you look for it) and lose their emphasis.
  const isZero = stat.value === "0";
  const inner = (
    <>
      <span
        className={clsx(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]",
          isZero ? "text-slate-600" : stat.tone,
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span
          className={clsx(
            "block truncate font-display text-lg font-bold leading-none tabular-nums",
            isZero ? "text-slate-600" : "text-slate-50",
          )}
        >
          {stat.value}
        </span>
        <span
          className={clsx(
            "mt-1 block truncate text-[11px] font-medium",
            isZero ? "text-slate-600" : "text-slate-500",
          )}
        >
          {stat.label}
        </span>
      </span>
    </>
  );
  const cls = clsx(
    "card flex w-full items-center gap-3 px-3.5 py-3",
    stat.attention && "border-stable-purple/30",
    stat.onClick &&
      "card-hover focus-ring text-left transition active:scale-[0.98]",
  );
  if (stat.onClick) {
    return (
      <button type="button" onClick={stat.onClick} className={cls}>
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}

function greetingFor(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Section ids the stat tiles scroll to. A tile is a COUNT; clicking it must
 * show the SET being counted, not teleport into whichever member happens to
 * sort first (UX audit gap #15 — "you click a number and get one room"). */
const SECTION_PRIORITY = "home-priority";
const SECTION_LIVE_NOW = "home-live-now";
const SECTION_AGENT_FEED = "home-agent-feed";
const SECTION_HEALTH = "home-health-strip";
const SECTION_CONVERSATIONS = "home-conversations";

/**
 * Command-center landing surface for `/` when no room is selected.
 *
 * Answers four questions in one glance: what needs me (priority inbox), what
 * is happening live (Live now + occupancy), what did my agents do (activity
 * feed), and is the system healthy (health strip). Derivations live in
 * ./homeModel.ts; repeated row markup lives in ./widgets/HomeRow.tsx.
 */
export function HomeDashboard({ onOpenActivity }: { onOpenActivity?: (tab: ActivityTab) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rooms = useAppStore((s) => s.rooms);
  const roomsLoaded = useAppStore((s) => s.roomsLoaded);
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const mentionUnreads = useAppStore((s) => s.mentionUnreads);
  const currentUser = useAppStore((s) => s.currentUser);
  const currentParticipantId = useAppStore((s) => s.currentParticipantId);
  const participantsByRoom = useAppStore((s) => s.participants);
  const rosterAgents = useAppStore((s) => s.agents);
  const clearUnread = useAppStore((s) => s.clearUnread);
  const setCreateRoomModalOpen = useAppStore((s) => s.setCreateRoomModalOpen);
  const setPeopleDrawerOpen = useAppStore((s) => s.setPeopleDrawerOpen);
  const pushToast = useAppStore((s) => s.pushToast);
  const activeInstanceId = useFederationStore((s) => s.activeInstanceId);
  // Key comes from the shared helper so this query and useLiveCalls (sidebar
  // badges / in-room banner / call toast) are ONE cache entry + ONE poll by
  // construction — call_occupancy WS nudges patch it for all of them at once.
  const { data: homeSummary } = useQuery({
    queryKey: homeSummaryQueryKey(activeInstanceId),
    queryFn: () => api.getHomeSummary(),
    refetchInterval: LIVE_CALLS_POLL_MS,
  });

  const { isConnected } = useVoice();
  const activeCallRoomId = useCallUiStore((s) => s.activeCallRoomId);

  const [openingPersonId, setOpeningPersonId] = useState<string | null>(null);

  const openRoom = useCallback(
    (id: string) => {
      clearUnread(id);
      navigate(`/c/${id}`);
    },
    [clearUnread, navigate],
  );

  // ── Scroll-to + focus-flash for stat tiles ─────────────────────────────
  // Tiles used to openRoom(first item) — a "3" that opened one of the three.
  // Now they scroll to the section listing the whole set and flash it so the
  // eye lands somewhere specific. Smooth scrolling is motion, so it honors
  // prefers-reduced-motion; the flash itself is a static ring that appears
  // and fades via a box-shadow transition (highlight, not movement), which is
  // reduced-motion safe by construction.
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );
  const scrollToSection = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
    // Move keyboard/AT focus with the viewport (sections carry tabIndex=-1).
    el.focus({ preventScroll: true });
    setFlashId(id);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashId(null), 1600);
  }, []);
  const flashClass = useCallback(
    (id: string) =>
      clsx(
        "scroll-mt-4 rounded-2xl outline-none transition-shadow duration-500",
        flashId === id && "ring-2 ring-stable-purple/50",
      ),
    [flashId],
  );

  // ── Directory + favorites (shared react-query keys) ────────────────────
  const { data: directory = [] } = useQuery({
    queryKey: ["people-directory", activeInstanceId, ""],
    queryFn: () => api.getPeopleDirectory(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  useEffect(() => {
    if (directory.length === 0) return;
    usePresenceStore.getState().setFromDirectory(directory);
  }, [directory]);

  const presenceById = usePresenceStore((s) => s.byId);

  const { data: preferences } = useQuery({
    queryKey: ["my-preferences", activeInstanceId],
    queryFn: () => api.getMyPreferences(),
    staleTime: 60_000,
  });

  // Memoized (not `?? []` inline) so downstream useMemos don't recompute on
  // every render from a fresh empty-array identity.
  const favoriteIds = useMemo(
    () => preferences?.favorite_people_ids ?? [],
    [preferences?.favorite_people_ids],
  );

  // ── Pending approvals (same key as Header / ActivityCenter) ────────────
  const { data: pendingApprovals } = useQuery({
    queryKey: ["approvals", "pending", activeInstanceId],
    queryFn: () => api.getPendingApprovals(),
    refetchInterval: 15_000,
  });
  const approvalItems = useMemo(
    () => pendingApprovals?.items ?? [],
    [pendingApprovals?.items],
  );
  const approvalCount = approvalItems.length;
  const approvalLabel = pendingApprovals?.has_more
    ? `${approvalCount}+`
    : String(approvalCount);

  // ── Derived models (pure — see homeModel.ts) ───────────────────────────
  const activeCallRoom = useMemo(
    () =>
      activeCallRoomId
        ? (rooms.find((r) => r.id === activeCallRoomId) ?? null)
        : null,
    [rooms, activeCallRoomId],
  );
  const hasActiveCall = Boolean(isConnected && activeCallRoomId);

  const summaryLiveCalls = homeSummary?.live_calls ?? [];
  const showMeetingEmpty = !hasActiveCall && summaryLiveCalls.length === 0;

  const priority = useMemo(
    () =>
      priorityModel({
        rooms,
        unreadCounts,
        mentionUnreads,
        approvals: approvalItems,
        now: Date.now(),
      }),
    [rooms, unreadCounts, mentionUnreads, approvalItems],
  );

  const feed = useMemo(
    () => agentFeed(rooms, unreadCounts, { now: Date.now() }),
    [rooms, unreadCounts],
  );

  const favoritePeopleOnline = useMemo(() => {
    if (favoriteIds.length === 0 || directory.length === 0) return [];
    const byId = new Map(directory.map((p) => [p.id, p]));
    const online: PeopleDirectoryEntry[] = [];
    for (const id of favoriteIds) {
      const person = byId.get(id);
      if (!person) continue;
      const live = presenceById[id];
      const isOnline = live ? live.isOnline : person.is_online;
      if (isOnline) online.push(person);
    }
    return online.sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [favoriteIds, directory, presenceById]);

  // Agent fleet snapshot for the command grid — same roster the Agents page
  // uses (shared query key), so this costs nothing extra when both are warm.
  const { data: agentRoster = [] } = useQuery({
    queryKey: ["brigade-roster", activeInstanceId],
    queryFn: () => api.getAgents(),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const fleetAgents = useMemo(
    () => rankedFleet(agentRoster, rooms),
    [agentRoster, rooms],
  );
  const fleetActiveCount = useMemo(
    () =>
      agentRoster.filter((a) => a.status === "working" || a.status === "active")
        .length,
    [agentRoster],
  );

  // Everyone online (favorites first) — the People column should carry the
  // whole roster's presence, not go dark for users who never starred anyone.
  const peopleOnline = useMemo(() => {
    if (directory.length === 0) return [];
    const favs = new Set(favoriteIds);
    return directory
      .filter((p) => {
        if (p.id === currentUser?.id) return false;
        const live = presenceById[p.id];
        return live ? live.isOnline : p.is_online;
      })
      .sort(
        (a, b) =>
          Number(favs.has(b.id)) - Number(favs.has(a.id)) ||
          a.display_name.localeCompare(b.display_name),
      )
      .slice(0, 10);
  }, [directory, presenceById, favoriteIds, currentUser?.id]);

  // ── W7 health (one hook — the strip and the Workspace tile share it) ───
  const health = useHomeHealth(homeSummary?.counts.worker_last_seen_at);
  // Lifted out of ConversationsCard so the priority tail can drive it.
  const [conversationsTab, setConversationsTab] =
    useState<ConversationsTab | null>(null);
  // Stale-unread tail of "Needs you" — collapsed by default, per session.
  const [showStalePriority, setShowStalePriority] = useState(false);

  const openPersonDm = useCallback(
    async (person: PeopleDirectoryEntry) => {
      if (openingPersonId) return;
      setOpeningPersonId(person.id);
      try {
        const room = await ensureHumanDm(person);
        await queryClient.invalidateQueries({ queryKey: ["rooms"] });
        const state = useAppStore.getState();
        if (!state.rooms.some((r) => r.id === room.id)) {
          state.setRooms([room, ...state.rooms]);
        }
        openRoom(room.id);
      } catch (error) {
        pushToast({
          title: "Couldn't open chat",
          body: error instanceof Error ? error.message : "Request failed",
        });
      } finally {
        setOpeningPersonId(null);
      }
    },
    [openingPersonId, queryClient, openRoom, pushToast],
  );

  // The knowledge UI is RoomView's right drawer — its only mount point — so
  // opening it from home needs a host room. The most recently active room is
  // the least surprising anchor: the panel's collection list is global, the
  // room only decides where the drawer renders. Opening the collection BEFORE
  // navigating is safe: knowledgeStore.setRoom() clears attachment/search
  // state on the room switch but deliberately keeps the open collection.
  const openKnowledge = useCallback(
    (collectionId?: string) => {
      const host = [...rooms].sort(sortByRecency)[0];
      if (!host) {
        pushToast({
          title: "Couldn't open Knowledge",
          body: "Join or create a room first — knowledge bases open in a room's side panel.",
        });
        return;
      }
      const kb = useKnowledgeStore.getState();
      kb.setPanelOpen(true);
      if (collectionId) void kb.openCollectionById(collectionId);
      navigate(`/c/${host.id}`);
    },
    [rooms, navigate, pushToast],
  );

  const hour = new Date().getHours();
  const firstName = currentUser?.displayName?.trim().split(/\s+/)[0] ?? "there";

  const channelUnreadTotal =
    priority.channelUnreadRooms.length + priority.moreChannelCount;
  const statusBits: string[] = [];
  if (hasActiveCall) {
    statusBits.push("You're in a call");
  }
  if (priority.items.length > 0) {
    const n =
      priority.mentionRooms.length +
      priority.dmUnreadRooms.length +
      channelUnreadTotal +
      (approvalCount > 0 ? 1 : 0);
    statusBits.push(
      n === 1 ? "1 item needs attention" : `${n} items need attention`,
    );
  } else if (!hasActiveCall) {
    statusBits.push("You're all caught up");
  }
  if (favoritePeopleOnline.length > 0) {
    statusBits.push(
      favoritePeopleOnline.length === 1
        ? "1 favorite online"
        : `${favoritePeopleOnline.length} favorites online`,
    );
  }

  const liveMeetingCount = summaryLiveCalls.length;

  // Rooms the priority inbox is already rendering: Conversations must not
  // repeat them verbatim a few hundred pixels lower.
  const priorityRoomIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of priority.items) {
      if (item.kind !== "approval") ids.add(item.room.id);
    }
    return ids;
  }, [priority.items]);
  // Every tile is always clickable now: its target section always renders
  // (showing an honest empty state at zero), so there is no "count without a
  // set" dead end and no undefined-onClick dance per tile.
  const stats: HomeStat[] = [
    {
      key: "mentions",
      label: "Mentions",
      value: String(
        homeSummary?.counts.mention_rooms ?? priority.mentionRooms.length,
      ),
      icon: AtSign,
      tone: "text-stable-purple-light",
      attention: priority.mentionRooms.length > 0,
      // Open the message-level Mentions inbox; the ?? form double-fired
      // (void ?? scroll) and scrolled the page under the panel.
      onClick: () =>
        onOpenActivity
          ? onOpenActivity("mentions")
          : scrollToSection(SECTION_PRIORITY),
    },
    {
      key: "dms",
      label: "Unread DMs",
      value: String(priority.dmUnreadRooms.length),
      icon: MessageSquare,
      tone: "text-stable-cyan",
      attention: priority.dmUnreadRooms.length > 0,
      // No message-level DM feed exists (the inbox tabs are mention/thread/
      // reaction events) — the honest target is the Needs-you list, which is
      // exactly the set this number counts. "threads" was a wrong-tab map.
      onClick: () => scrollToSection(SECTION_PRIORITY),
    },
    {
      key: "approvals",
      label: "Approvals",
      value: homeSummary
        ? String(homeSummary.counts.approvals_pending)
        : approvalLabel,
      icon: ShieldCheck,
      tone: "text-rose-300",
      attention: approvalCount > 0,
      onClick: () =>
        onOpenActivity
          ? onOpenActivity("approvals")
          : scrollToSection(SECTION_PRIORITY),
    },
    {
      key: "meetings",
      label: "Live meetings",
      value: String(liveMeetingCount),
      icon: Video,
      tone: "text-stable-mint",
      onClick: () => scrollToSection(SECTION_LIVE_NOW),
    },
    {
      key: "agents",
      label: "Agents waiting",
      // The full waiting count, not the visible slice — the number must
      // describe the set even when the feed caps its rows.
      value: String(feed.waitingTotal),
      icon: Bot,
      tone: "text-stable-purple-light",
      attention: feed.waitingTotal > 0,
      onClick: () => scrollToSection(SECTION_AGENT_FEED),
    },
    {
      key: "people",
      label: "People online",
      value: String(homeSummary?.counts.people_online ?? peopleOnline.length),
      icon: UserRound,
      tone: "text-stable-mint",
      onClick: () => setPeopleDrawerOpen(true),
    },
    // NO "Workspace" tile. It sat directly on top of the health strip, which
    // names all four services and the deployed sha — two health surfaces
    // stacked, the upper one saying only "OK". The strip is strictly more
    // informative, so the tile was pure redundancy in the most valuable
    // pixels on the page.
  ];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="animate-fade-in mx-auto w-full max-w-[1720px] px-4 py-6 sm:px-6 lg:px-8">
        {/* ── Greeting + quick actions ─────────────────────────────────── */}
        <header className="card relative mb-4 overflow-hidden px-5 py-5 sm:px-6">
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_150%_at_100%_0%,rgba(139,92,246,0.14),transparent_55%)]"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_120%_at_82%_100%,rgba(34,211,238,0.10),transparent_60%)]"
            aria-hidden="true"
          />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2.5">
                <span className="gradient-bg glow-iris flex h-7 w-7 items-center justify-center rounded-lg">
                  <Sparkles className="h-4 w-4 text-white" />
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Unicorn Stable
                </span>
              </div>
              <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
                <span className="text-slate-50">{greetingFor(hour)}, </span>
                <span className="gradient-text-aurora">{firstName}</span>
              </h1>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-400">
                {statusBits.map((bit, i) => (
                  <span key={bit} className="flex items-center gap-2">
                    {i > 0 && (
                      <span className="text-slate-600" aria-hidden="true">
                        ·
                      </span>
                    )}
                    {bit === "You're in a call" ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="animate-live h-1.5 w-1.5 rounded-full bg-stable-mint" />
                        {bit}
                      </span>
                    ) : (
                      bit
                    )}
                  </span>
                ))}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setPeopleDrawerOpen(true)}
                className="focus-ring flex items-center gap-1.5 rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-xs font-semibold text-slate-200 transition-colors hover:border-line-strong hover:bg-white/[0.06]"
              >
                <UserRound className="h-3.5 w-3.5 text-stable-mint" />
                Message someone
              </button>
              <button
                type="button"
                onClick={() => setCreateRoomModalOpen(true)}
                className="gradient-bg glow-iris focus-ring flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white transition hover:opacity-95 active:scale-[0.98]"
              >
                <Plus className="h-3.5 w-3.5" />
                New room
              </button>
            </div>
          </div>
        </header>

        {roomsLoaded && rooms.length === 0 && (
          <section className="mb-6 rounded-2xl border border-stable-purple/30 bg-stable-purple/10 p-5" aria-label="Get started">
            <div className="flex items-center gap-4">
              <Identity
                {...resolveIdentity({
                  id: agentRoster[0]?.id,
                  name: agentRoster[0]?.name ?? "Majik",
                  display_name: agentRoster[0]?.name ?? "Majik",
                  participant_type: "agent",
                })}
                size={56}
              />
              <div><p className="font-display text-lg font-semibold text-slate-100">Meet {agentRoster[0]?.name ?? "Majik"}</p><p className="mt-1 text-sm text-slate-300">Your workspace starts with one useful conversation.</p></div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <button type="button" onClick={() => agentRoster[0] && void api.createAgentDm(agentRoster[0].id, agentRoster[0].name).then(async (room) => { await api.setOnboardingChecklist({ ...preferences?.onboarding_checklist, agent: true }); useAppStore.getState().setRooms([room]); navigate(`/c/${room.id}`); })} className="focus-ring rounded-xl border border-line bg-white/[0.05] px-3 py-3 text-left text-sm text-slate-100">{preferences?.onboarding_checklist?.agent ? "✓ " : "1. "}Say hi to an agent</button>
              <button type="button" onClick={() => void api.bootstrapDefaultRooms().then(async (newRooms) => { await api.setOnboardingChecklist({ ...preferences?.onboarding_checklist, channels: true }); useAppStore.getState().setRooms(newRooms); })} className="focus-ring rounded-xl border border-line bg-white/[0.05] px-3 py-3 text-left text-sm text-slate-100">{preferences?.onboarding_checklist?.channels ? "✓ " : "2. "}Seed your channels</button>
              <button type="button" onClick={() => { void api.setOnboardingChecklist({ ...preferences?.onboarding_checklist, invite: true }); setPeopleDrawerOpen(true); }} className="focus-ring rounded-xl border border-line bg-white/[0.05] px-3 py-3 text-left text-sm text-slate-100">{preferences?.onboarding_checklist?.invite ? "✓ " : "3. "}Invite a teammate</button>
            </div>
          </section>
        )}

        {/* ── Stat strip — the pulse of the whole workspace ────────────── */}
        <div
          className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
          role="group"
          aria-label="Workspace overview"
        >
          {roomsLoaded ? (
            stats.map((stat) => (
              <StatTile key={stat.key} stat={stat} />
            ))
          ) : (
            // Pre-load: the tiles would read as six zeros before the rooms
            // payload lands. Shimmer keeps the grid geometry stable.
            Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className="card flex animate-pulse-soft items-center gap-3 px-3.5 py-3"
                aria-hidden="true"
              >
                <div className="h-8 w-8 shrink-0 rounded-lg bg-white/[0.05]" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div
                    className="h-4 rounded bg-white/[0.06]"
                    style={{ width: `${[40, 55, 30, 45, 35, 50][i]}%` }}
                  />
                  <div className="h-2.5 w-2/3 rounded bg-white/[0.04]" />
                </div>
              </div>
            ))
          )}
        </div>

        {/* ── W7: ambient health strip (always renders — see the widget) ─ */}
        <div
          id={SECTION_HEALTH}
          tabIndex={-1}
          className={clsx("mb-6", flashClass(SECTION_HEALTH))}
        >
          <SystemHealthStrip health={health} />
        </div>

        {/* ── Command grid: attention | realtime | ambient ──────────────
            Column wrappers dissolve at <lg (`max-lg:contents`) so the
            sections become direct grid children and `max-lg:order-*` can
            impose the mobile triage order (needs-me → live-now → agent work
            → browsing), which no fixed column nesting can produce. At lg+
            the wrappers re-materialize as masonry-ish stacks — that is also
            why spacing is `lg:space-y-6` (at <lg the grid's own gap spaces
            the sections; a plain space-y would double up with it). */}
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2 2xl:grid-cols-4">
          <div className="min-w-0 max-lg:contents lg:space-y-6 2xl:col-span-2">
            {/* Column A: what needs the human, then the human's threads. */}

            {/* ── W2: Mentions & priority ──────────────────────────────── */}
            <section
              id={SECTION_PRIORITY}
              tabIndex={-1}
              aria-labelledby="home-priority-heading"
              className={clsx(
                "min-w-0 max-lg:order-1",
                flashClass(SECTION_PRIORITY),
              )}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Inbox className="h-4 w-4 text-stable-purple-light" />
                  <h2
                    id="home-priority-heading"
                    className="font-display text-sm font-semibold text-slate-200"
                  >
                    Needs you
                  </h2>
                </div>
                {approvalCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-rose-300">
                    <ShieldCheck className="h-3 w-3" />
                    {approvalLabel} approval{approvalCount === 1 ? "" : "s"}
                  </span>
                )}
              </div>

              {priority.items.length === 0 &&
              priority.staleItems.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
                  No mentions, DM unreads, approvals, or unread channels
                </p>
              ) : (
                <ul className="card overflow-hidden">
                  {priority.items.map((item, i) => {
                    if (item.kind === "approval") {
                      const { approval } = item;
                      return (
                        <li key={`approval-${approval.message.id}`}>
                          <HomeRow
                            leading={
                              <Identity
                                {...resolveIdentity(approval.message)}
                                size={36}
                                className="mt-0.5"
                              />
                            }
                            title="Approval needed"
                            at={approval.message.created_at}
                            tint="bg-rose-500/[0.05]"
                            divider={i > 0}
                            onClick={() => openRoom(approval.room_id)}
                            line={
                              <p className="mt-0.5 truncate text-xs text-slate-400">
                                <span className="font-medium text-slate-300">
                                  {approval.message.sender_name}
                                </span>
                                {" · "}
                                {approval.room_name}
                                {" — "}
                                {previewText(approval.message.content)}
                              </p>
                            }
                          />
                        </li>
                      );
                    }

                    const { room, unread, kind } = item;
                    const roomFace =
                      room.type === "channel"
                        ? null
                        : resolveIdentity(room, {
                            selfId: currentParticipantId ?? currentUser?.id,
                            members: participantsByRoom[room.id],
                            agents: rosterAgents,
                          });
                    return (
                      <li key={`${kind}-${room.id}`}>
                        <HomeRow
                          leading={
                            room.type === "channel" ? (
                              kind === "mention" ? (
                                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-purple/15 text-stable-purple-light">
                                  <AtSign className="h-4 w-4" />
                                </span>
                              ) : (
                                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-item-channel/15 text-item-channel">
                                  <Hash className="h-4 w-4" />
                                </span>
                              )
                            ) : roomFace?.origin === "name-only" &&
                              room.type === "group_dm" ? (
                              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-item-group">
                                <Users className="h-4 w-4" />
                              </span>
                            ) : roomFace ? (
                              <Identity
                                {...roomFace}
                                size={36}
                                className="mt-0.5"
                              />
                            ) : null
                          }
                          title={room.display_name || room.name}
                          at={room.last_message?.created_at ?? null}
                          unread={unread}
                          tint="bg-stable-purple/[0.06]"
                          divider={i > 0}
                          onClick={() => openRoom(room.id)}
                          line={
                            room.last_message ? (
                              <SenderLine message={room.last_message} />
                            ) : (
                              <p className="mt-0.5 text-xs italic text-slate-600">
                                {kind === "mention"
                                  ? "You were mentioned"
                                  : "Unread messages"}
                              </p>
                            )
                          }
                        />
                      </li>
                    );
                  })}
                  {priority.moreChannelCount > 0 && (
                    <li className="border-t border-line">
                      <button
                        type="button"
                        onClick={() => {
                          setConversationsTab("channels");
                          scrollToSection(SECTION_CONVERSATIONS);
                        }}
                        className="focus-ring w-full px-3.5 py-2 text-left text-[11px] tabular-nums text-slate-500 transition-colors hover:bg-white/[0.04] hover:text-slate-300"
                      >
                        +{priority.moreChannelCount} more unread channel
                        {priority.moreChannelCount === 1 ? "" : "s"} — show all
                      </button>
                    </li>
                  )}
                  {/* Stale tail: unread that has sat idle 2+ weeks is history
                      impersonating a to-do — collapsed behind a count so the
                      list above stays believable. */}
                  {priority.staleItems.length > 0 && (
                    <li
                      className={
                        priority.items.length > 0 ? "border-t border-line" : ""
                      }
                    >
                      <button
                        type="button"
                        onClick={() => setShowStalePriority((v) => !v)}
                        aria-expanded={showStalePriority}
                        className="focus-ring w-full px-3.5 py-2 text-left text-[11px] tabular-nums text-slate-500 transition-colors hover:bg-white/[0.04] hover:text-slate-300"
                      >
                        {priority.staleItems.length} older unread — quiet for
                        2+ weeks {showStalePriority ? "· hide" : "· show"}
                      </button>
                    </li>
                  )}
                  {showStalePriority &&
                    priority.staleItems.map((item) => {
                      if (item.kind === "approval") return null;
                      const { room, kind } = item;
                      return (
                        <li
                          key={`stale-${kind}-${room.id}`}
                          className="border-t border-line/50"
                        >
                          <button
                            type="button"
                            onClick={() => openRoom(room.id)}
                            className="focus-ring flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-xs text-slate-500 transition-colors hover:bg-white/[0.04] hover:text-slate-300"
                          >
                            <span className="truncate">
                              {room.display_name || room.name}
                            </span>
                            {room.last_message && (
                              <span className="ml-auto shrink-0 text-[10px] tabular-nums text-slate-600">
                                {rowTime(room.last_message.created_at)} ago
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                </ul>
              )}
            </section>

            {/* ── W3: Conversations (Chats | Channels) ─────────────────── */}
            <div
              id={SECTION_CONVERSATIONS}
              tabIndex={-1}
              className={clsx(
                "min-w-0 max-lg:order-4",
                flashClass(SECTION_CONVERSATIONS),
              )}
            >
              <ConversationsCard
                rooms={rooms}
                unreadCounts={unreadCounts}
                onOpenRoom={openRoom}
                onFindPeople={() => setPeopleDrawerOpen(true)}
                excludeRoomIds={priorityRoomIds}
                chosenTab={conversationsTab}
                onChooseTab={setConversationsTab}
              />
            </div>
          </div>

          <div className="min-w-0 max-lg:contents lg:space-y-6">
            {/* Column B: realtime surfaces — meetings, then agent work. */}

            {/* ── W4: Live now ─────────────────────────────────────────── */}
            <section
              id={SECTION_LIVE_NOW}
              tabIndex={-1}
              aria-labelledby="home-live-now-heading"
              className={clsx(
                "min-w-0 max-lg:order-2",
                flashClass(SECTION_LIVE_NOW),
              )}
            >
              <div className="mb-2 flex items-center gap-2">
                <Video className="h-4 w-4 text-stable-cyan" />
                <h2
                  id="home-live-now-heading"
                  className="font-display text-sm font-semibold text-slate-200"
                >
                  Live now
                </h2>
              </div>

              {hasActiveCall && activeCallRoomId && (
                <button
                  type="button"
                  onClick={() => openRoom(activeCallRoomId)}
                  className="card card-hover focus-ring group relative mb-3 flex w-full items-center gap-3 overflow-hidden border-stable-mint/40 px-4 py-4 text-left hover:glow-mint active:scale-[0.99]"
                >
                  <span
                    className="pointer-events-none absolute inset-0 bg-[radial-gradient(85%_120%_at_100%_0%,rgba(52,211,153,0.14),transparent_70%)]"
                    aria-hidden="true"
                  />
                  <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-stable-mint/15 text-stable-mint">
                    <Phone className="h-5 w-5" />
                  </span>
                  <span className="relative min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-slate-50">
                        Return to call
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-stable-mint/30 bg-stable-mint/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-stable-mint">
                        <span className="animate-live h-1 w-1 rounded-full bg-stable-mint" />
                        live
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-400">
                      {activeCallRoom?.display_name ||
                        activeCallRoom?.name ||
                        "Your active call"}
                    </span>
                  </span>
                  <span className="relative shrink-0 rounded-lg border border-stable-mint/30 bg-stable-mint/10 px-3 py-1.5 text-xs font-semibold text-stable-mint transition-colors group-hover:bg-stable-mint/20">
                    Rejoin
                  </span>
                </button>
              )}

              {summaryLiveCalls.length > 0 && (
                <ul className="grid grid-cols-1 gap-3">
                  {summaryLiveCalls.map((room) => (
                    <li key={room.room_id}>
                      <button
                        type="button"
                        onClick={() => openRoom(room.room_id)}
                        className="card card-hover focus-ring group relative flex w-full items-center gap-3 overflow-hidden px-4 py-3.5 text-left text-slate-200 hover:glow-aqua active:scale-[0.98]"
                      >
                        <span
                          className="pointer-events-none absolute inset-0 bg-[radial-gradient(85%_120%_at_100%_0%,rgba(34,211,238,0.08),transparent_70%)]"
                          aria-hidden="true"
                        />
                        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-cyan/15 text-stable-cyan">
                          <Video className="h-5 w-5" />
                        </span>
                        <span className="relative min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">
                            {room.display_name}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-slate-400">
                            {room.participant_count} participant
                            {room.participant_count === 1 ? "" : "s"}
                            {room.has_agent ? " · agent present" : ""}
                          </span>
                        </span>
                        <span className="relative shrink-0 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors group-hover:border-line-strong group-hover:bg-surface-3">
                          Open
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {showMeetingEmpty && (
                <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
                  No live meetings
                </p>
              )}
            </section>

            {/* ── W5: Agent activity (absorbs "Needs your attention") ──── */}
            <div
              id={SECTION_AGENT_FEED}
              tabIndex={-1}
              className={clsx(
                "min-w-0 max-lg:order-3",
                flashClass(SECTION_AGENT_FEED),
              )}
            >
              <section aria-labelledby="home-agent-feed-heading">
                <div className="mb-2 flex items-center gap-2">
                  <Bot className="h-4 w-4 text-item-agent" />
                  <h2
                    id="home-agent-feed-heading"
                    className="font-display text-sm font-semibold text-slate-200"
                  >
                    Agent activity
                  </h2>
                </div>
                {(homeSummary?.agent_activity.length ?? 0) === 0 ? (
                  <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
                    No agent activity yet
                  </p>
                ) : (
                  <ul className="card overflow-hidden">
                    {homeSummary!.agent_activity.map((item, i) => (
                      <li key={item.message_id}>
                        <HomeRow
                          leading={<Bot className="h-4 w-4 text-item-agent" />}
                          title={item.sender_name}
                          at={item.created_at}
                          divider={i > 0}
                          onClick={() => openRoom(item.room_id)}
                          line={
                            <span className="mt-0.5 block truncate text-xs text-slate-400">
                              {/* Server previews are raw message text — flatten
                                  markdown exactly like the client-derived rows. */}
                              {item.room_name} · {previewText(item.preview)}
                            </span>
                          }
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>

          <div className="min-w-0 max-lg:contents lg:col-start-2 lg:space-y-6 2xl:col-start-auto">
            {/* Column C: who's around right now, then ambient resources. */}

            {/* ── People online ────────────────────────────────────────── */}
            <section
              aria-labelledby="home-people-heading"
              className="min-w-0 max-lg:order-5"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <UserRound className="h-4 w-4 text-stable-mint" />
                  <h2
                    id="home-people-heading"
                    className="font-display text-sm font-semibold text-slate-200"
                  >
                    People online
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setPeopleDrawerOpen(true)}
                  className="focus-ring rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.04] hover:text-slate-200"
                >
                  Open People
                </button>
              </div>

              {peopleOnline.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
                  {favoriteIds.length === 0
                    ? "No one is online right now. Star people in the People drawer to keep them at the top here."
                    : "No one is online right now."}
                </p>
              ) : (
                <ul className="grid grid-cols-1 gap-2">
                  {peopleOnline.map((person) => {
                    const label =
                      person.display_name?.trim() ||
                      person.username?.trim() ||
                      "Person";
                    const busy = openingPersonId === person.id;
                    const starred = favoriteIds.includes(person.id);
                    return (
                      <li key={person.id}>
                        <button
                          type="button"
                          onClick={() => void openPersonDm(person)}
                          disabled={!!openingPersonId}
                          className="card card-hover focus-ring flex w-full items-center gap-3 px-3.5 py-3 text-left transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <span className="relative shrink-0">
                            <Identity
                              {...resolveIdentity({
                                ...person,
                                display_name: label,
                                participant_type: "human",
                                is_online: true,
                              })}
                              presence={null}
                              size={36}
                            />
                            <span
                              className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-900 bg-stable-mint animate-live"
                              aria-label="Online"
                            />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-medium text-slate-100">
                                {label}
                              </span>
                              {starred && (
                                <Sparkles
                                  className="h-3 w-3 shrink-0 text-stable-purple-light"
                                  aria-label="Favorite"
                                />
                              )}
                            </span>
                            <span className="block truncate text-xs text-slate-500">
                              {busy ? "Opening…" : "Message"}
                            </span>
                          </span>
                          <MessageSquare className="h-4 w-4 shrink-0 text-slate-500" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* ── Agent fleet ──────────────────────────────────────────── */}
            <section
              aria-labelledby="home-fleet-heading"
              className="min-w-0 max-lg:order-6"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-stable-purple-light" />
                  <h2
                    id="home-fleet-heading"
                    className="font-display text-sm font-semibold text-slate-200"
                  >
                    Agents
                  </h2>
                  {agentRoster.length > 0 && (
                    <span className="text-[11px] tabular-nums text-slate-500">
                      {/* "54/54 active" is a ratio that carries no information
                          and reads as a fabricated stat — Brigade reports
                          nearly everything `active` because that is
                          REGISTRATION, not liveness. State the count plainly
                          unless the split is real. */}
                      {fleetActiveCount === agentRoster.length
                        ? `${agentRoster.length} registered`
                        : `${fleetActiveCount}/${agentRoster.length} active`}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => navigate("/agents")}
                  className="focus-ring rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.04] hover:text-slate-200"
                >
                  Browse all
                </button>
              </div>

              {fleetAgents.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
                  No agents registered on this instance yet.
                </p>
              ) : (
                <ul className="card overflow-hidden">
                  {fleetAgents.map((agent, i) => {
                    const unreachable = agent.availability === "unavailable";
                    return (
                      <li key={agent.id}>
                        <button
                          type="button"
                          onClick={() => navigate("/agents")}
                          className={clsx(
                            "focus-ring flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.04]",
                            i > 0 && "border-t border-line",
                          )}
                        >
                          <span className="relative shrink-0">
                            <Identity
                              {...resolveIdentity({
                                ...agent,
                                participant_type: "agent",
                              })}
                              presence={null}
                              size={32}
                              dimmed={unreachable || agent.status === "offline"}
                            />
                            {agent.emoji && (
                              <span
                                className="absolute -bottom-1 -right-1 text-[10px]"
                                aria-hidden="true"
                              >
                                {agent.emoji}
                              </span>
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-slate-100">
                              {agent.display_name || agent.name}
                            </span>
                            <span className="block truncate text-xs text-slate-500">
                              {agentSubtitle([agent.rank, agent.title]) ||
                                agent.model}
                            </span>
                          </span>
                          <span
                            className={clsx(
                              "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                              unreachable
                                ? "border-rose-500/25 bg-rose-500/10 text-rose-300"
                                : agent.status === "working"
                                  ? "border-stable-mint/25 bg-stable-mint/10 text-stable-mint"
                                  : agent.status === "active"
                                    ? "border-stable-cyan/25 bg-stable-cyan/10 text-stable-cyan"
                                    : "border-line bg-white/[0.03] text-slate-400",
                            )}
                          >
                            <span
                              className={clsx(
                                "h-1.5 w-1.5 rounded-full",
                                unreachable
                                  ? "bg-rose-400"
                                  : agent.status === "working"
                                    ? "animate-live bg-stable-mint"
                                    : agent.status === "active"
                                      ? "bg-stable-cyan"
                                      : agent.status === "idle"
                                        ? "bg-slate-400"
                                        : "bg-slate-600",
                              )}
                            />
                            {unreachable ? "unreachable" : agent.status}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* ── W6: Knowledge rail ───────────────────────────────────── */}
            <div className="min-w-0 max-lg:order-7">
              <KnowledgeRecents
                onOpenKnowledge={openKnowledge}
                artifacts={homeSummary?.recent_artifacts}
                transcripts={homeSummary?.recent_transcripts}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
