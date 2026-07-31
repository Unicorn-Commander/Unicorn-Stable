import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
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
import {
  api,
  type PeopleDirectoryEntry,
  type PendingApproval,
  type Room,
} from "@/services/api";
import { identityFor } from "@/lib/identity";
import { ensureHumanDm } from "@/lib/ensureHumanDm";
import { Avatar } from "@/components/Avatar";
import { UnicornAvatar } from "@/components/Agents/UnicornAvatar";
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import { useFederationStore } from "@/stores/federationStore";
import { usePresenceStore } from "@/stores/presenceStore";
import { useVoice } from "@/contexts/VoiceProvider";
import { roomsForView } from "@/components/Sidebar/sidebarModel";

/** Recent enough last activity to treat a conference room as "live-ish". */
const LIVE_MEETING_MS = 2 * 60 * 60 * 1000;

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
  const inner = (
    <>
      <span
        className={clsx(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]",
          stat.tone,
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block font-display text-lg font-bold leading-none tabular-nums text-slate-50">
          {stat.value}
        </span>
        <span className="mt-1 block truncate text-[11px] font-medium text-slate-500">
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

function preview(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 90 ? oneLine.slice(0, 90) + "…" : oneLine;
}

function timestamp(dateStr: string): string {
  try {
    return formatDistanceToNowStrict(new Date(dateStr), { addSuffix: false });
  } catch {
    return "";
  }
}

function roomActivityAt(room: Room): number {
  return new Date(room.last_message?.created_at ?? room.updated_at).getTime();
}

function isHumanConversation(room: Room): boolean {
  return (
    (room.type === "dm" || room.type === "group_dm") && !room.brigade_agent_id
  );
}

function isAgentConversation(room: Room): boolean {
  return (
    (room.type === "dm" || room.type === "group_dm") && !!room.brigade_agent_id
  );
}

function sortByRecency(a: Room, b: Room): number {
  return roomActivityAt(b) - roomActivityAt(a);
}

/**
 * Human-first landing surface for `/` when no room is selected.
 *
 * Prioritizes live meetings, mentions/DM unreads, favorite people online, and
 * recent human conversations. Agents appear only when they need attention
 * (pending approvals or agent rooms with unread waiting on the user).
 */
export function HomeDashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rooms = useAppStore((s) => s.rooms);
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const mentionUnreads = useAppStore((s) => s.mentionUnreads);
  const currentUser = useAppStore((s) => s.currentUser);
  const clearUnread = useAppStore((s) => s.clearUnread);
  const setCreateRoomModalOpen = useAppStore((s) => s.setCreateRoomModalOpen);
  const setPeopleDrawerOpen = useAppStore((s) => s.setPeopleDrawerOpen);
  const pushToast = useAppStore((s) => s.pushToast);
  const activeInstanceId = useFederationStore((s) => s.activeInstanceId);

  const { isConnected } = useVoice();
  const activeCallRoomId = useCallUiStore((s) => s.activeCallRoomId);

  const [openingPersonId, setOpeningPersonId] = useState<string | null>(null);

  const unreadFor = useCallback(
    (r: Room) => unreadCounts[r.id] ?? r.unread_count ?? 0,
    [unreadCounts],
  );

  const openRoom = useCallback(
    (id: string) => {
      clearUnread(id);
      navigate(`/c/${id}`);
    },
    [clearUnread, navigate],
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

  const favoriteIds = preferences?.favorite_people_ids ?? [];

  // ── Pending approvals (same key as Header / ActivityCenter) ────────────
  const { data: pendingApprovals } = useQuery({
    queryKey: ["approvals", "pending", activeInstanceId],
    queryFn: () => api.getPendingApprovals(),
    refetchInterval: 15_000,
  });
  const approvalItems = pendingApprovals?.items ?? [];
  const approvalCount = approvalItems.length;
  const approvalLabel = pendingApprovals?.has_more
    ? `${approvalCount}+`
    : String(approvalCount);

  // ── Derived lists ──────────────────────────────────────────────────────
  const activeCallRoom = useMemo(
    () =>
      activeCallRoomId
        ? rooms.find((r) => r.id === activeCallRoomId) ?? null
        : null,
    [rooms, activeCallRoomId],
  );
  const hasActiveCall = Boolean(isConnected && activeCallRoomId);

  const liveConferenceRooms = useMemo(() => {
    const now = Date.now();
    return rooms
      .filter((r) => r.is_conference)
      .filter((r) => {
        if (hasActiveCall && r.id === activeCallRoomId) return false;
        const age = now - roomActivityAt(r);
        // Joined conference with recent activity, or any conference the user
        // already belongs to (rejoin target) when updated recently.
        return age <= LIVE_MEETING_MS || unreadFor(r) > 0;
      })
      .sort(sortByRecency)
      .slice(0, 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, hasActiveCall, activeCallRoomId, unreadCounts]);

  const showMeetingEmpty =
    !hasActiveCall && liveConferenceRooms.length === 0;

  const mentionRooms = useMemo(() => {
    return rooms
      .filter((r) => mentionUnreads[r.id] === true)
      .sort(sortByRecency);
  }, [rooms, mentionUnreads]);

  const dmUnreadRooms = useMemo(() => {
    return rooms
      .filter(
        (r) =>
          isHumanConversation(r) &&
          unreadFor(r) > 0 &&
          mentionUnreads[r.id] !== true,
      )
      .sort(sortByRecency);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, unreadCounts, mentionUnreads]);

  const priorityItems = useMemo(() => {
    type Priority =
      | { kind: "mention"; room: Room; unread: number }
      | { kind: "dm"; room: Room; unread: number }
      | { kind: "approval"; approval: PendingApproval };
    const items: Priority[] = [];
    for (const room of mentionRooms) {
      items.push({ kind: "mention", room, unread: unreadFor(room) });
    }
    for (const room of dmUnreadRooms) {
      items.push({ kind: "dm", room, unread: unreadFor(room) });
    }
    for (const approval of approvalItems) {
      items.push({ kind: "approval", approval });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionRooms, dmUnreadRooms, approvalItems, unreadCounts]);

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
    return online.sort((a, b) =>
      a.display_name.localeCompare(b.display_name),
    );
  }, [favoriteIds, directory, presenceById]);

  const recentHumanChats = useMemo(() => {
    return roomsForView(rooms, "chats").sort(sortByRecency).slice(0, 12);
  }, [rooms]);

  const actionableAgentItems = useMemo(() => {
    // Agent rooms with unread (likely waiting on the human), excluding pure
    // mentions already listed above when they are agent DMs with mention flag.
    const waiting = rooms
      .filter((r) => isAgentConversation(r) && unreadFor(r) > 0)
      .sort(sortByRecency)
      .slice(0, 8);

    // Approvals already surface in priority; still list agent rooms distinctly
    // under this section for "needs you" agent work.
    return waiting;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, unreadCounts]);

  // Agent fleet snapshot for the command grid — same roster the Agents page
  // uses (shared query key), so this costs nothing extra when both are warm.
  const { data: agentRoster = [] } = useQuery({
    queryKey: ["brigade-roster", activeInstanceId],
    queryFn: () => api.getAgents(),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const fleetAgents = useMemo(() => {
    const order: Record<string, number> = {
      working: 0,
      active: 1,
      idle: 2,
      offline: 3,
    };
    return [...agentRoster]
      .sort(
        (a, b) =>
          (order[a.status] ?? 9) - (order[b.status] ?? 9) ||
          (a.display_name || a.name).localeCompare(b.display_name || b.name),
      )
      .slice(0, 8);
  }, [agentRoster]);
  const fleetActiveCount = useMemo(
    () =>
      agentRoster.filter(
        (a) => a.status === "working" || a.status === "active",
      ).length,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, presenceById, favoriteIds, currentUser?.id]);

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

  const hour = new Date().getHours();
  const firstName = currentUser?.displayName?.trim().split(/\s+/)[0] ?? "there";

  const statusBits: string[] = [];
  if (hasActiveCall) {
    statusBits.push("You're in a call");
  }
  if (priorityItems.length > 0) {
    const n =
      mentionRooms.length +
      dmUnreadRooms.length +
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

  const liveMeetingCount =
    liveConferenceRooms.length + (hasActiveCall ? 1 : 0);
  const firstMention = mentionRooms[0];
  const firstDmUnread = dmUnreadRooms[0];
  const firstApproval = approvalItems[0];
  const firstConference = liveConferenceRooms[0];
  const firstAgentItem = actionableAgentItems[0];
  const stats: HomeStat[] = [
    {
      key: "mentions",
      label: "Mentions",
      value: String(mentionRooms.length),
      icon: AtSign,
      tone: "text-stable-purple-light",
      attention: mentionRooms.length > 0,
      onClick: firstMention ? () => openRoom(firstMention.id) : undefined,
    },
    {
      key: "dms",
      label: "Unread DMs",
      value: String(dmUnreadRooms.length),
      icon: MessageSquare,
      tone: "text-stable-cyan",
      attention: dmUnreadRooms.length > 0,
      onClick: firstDmUnread ? () => openRoom(firstDmUnread.id) : undefined,
    },
    {
      key: "approvals",
      label: "Approvals",
      value: approvalLabel,
      icon: ShieldCheck,
      tone: "text-rose-300",
      attention: approvalCount > 0,
      onClick: firstApproval
        ? () => openRoom(firstApproval.room_id)
        : undefined,
    },
    {
      key: "meetings",
      label: "Live meetings",
      value: String(liveMeetingCount),
      icon: Video,
      tone: "text-stable-mint",
      onClick:
        hasActiveCall && activeCallRoomId
          ? () => openRoom(activeCallRoomId)
          : firstConference
            ? () => openRoom(firstConference.id)
            : undefined,
    },
    {
      key: "agents",
      label: "Agents waiting",
      value: String(actionableAgentItems.length),
      icon: Bot,
      tone: "text-stable-purple-light",
      onClick: firstAgentItem ? () => openRoom(firstAgentItem.id) : undefined,
    },
    {
      key: "people",
      label: "People online",
      value: String(peopleOnline.length),
      icon: UserRound,
      tone: "text-stable-mint",
      onClick: () => setPeopleDrawerOpen(true),
    },
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

        {/* ── Stat strip — the pulse of the whole workspace ────────────── */}
        <div
          className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
          role="group"
          aria-label="Workspace overview"
        >
          {stats.map((stat) => (
            <StatTile key={stat.key} stat={stat} />
          ))}
        </div>

        {/* ── Command grid: attention | meetings+agents | people ───────── */}
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2 2xl:grid-cols-4">
          <div className="min-w-0 space-y-6 2xl:col-span-2">
            {/* Column A: what needs the human, then the human's threads. */}

        {/* ── Mentions & priority ──────────────────────────────────────── */}
        <section aria-labelledby="home-priority-heading">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Inbox className="h-4 w-4 text-stable-purple-light" />
              <h2
                id="home-priority-heading"
                className="font-display text-sm font-semibold text-slate-200"
              >
                Mentions &amp; priority
              </h2>
            </div>
            {approvalCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-rose-300">
                <ShieldCheck className="h-3 w-3" />
                {approvalLabel} approval{approvalCount === 1 ? "" : "s"}
              </span>
            )}
          </div>

          {priorityItems.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
              No mentions, DM unreads, or pending approvals
            </p>
          ) : (
            <ul className="card overflow-hidden">
              {priorityItems.map((item, i) => {
                if (item.kind === "approval") {
                  const { approval } = item;
                  return (
                    <li key={`approval-${approval.message.id}`}>
                      <button
                        type="button"
                        onClick={() => openRoom(approval.room_id)}
                        className={clsx(
                          "focus-ring flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.04]",
                          i > 0 && "border-t border-line",
                          "bg-rose-500/[0.05]",
                        )}
                      >
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 text-rose-300">
                          <ShieldCheck className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm font-semibold text-slate-50">
                              Approval needed
                            </span>
                            <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
                              {timestamp(approval.message.created_at)}
                            </span>
                          </span>
                          <p className="mt-0.5 truncate text-xs text-slate-400">
                            <span className="font-medium text-slate-300">
                              {approval.message.sender_name}
                            </span>
                            {" · "}
                            {approval.room_name}
                            {" — "}
                            {preview(approval.message.content)}
                          </p>
                        </span>
                      </button>
                    </li>
                  );
                }

                const { room, unread, kind } = item;
                const isChannel = room.type === "channel";
                return (
                  <li key={`${kind}-${room.id}`}>
                    <button
                      type="button"
                      onClick={() => openRoom(room.id)}
                      className={clsx(
                        "focus-ring flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.04]",
                        i > 0 && "border-t border-line",
                        "bg-stable-purple/[0.06]",
                      )}
                    >
                      {kind === "mention" ? (
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-purple/15 text-stable-purple-light">
                          <AtSign className="h-4 w-4" />
                        </span>
                      ) : isChannel ? (
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-stable-cyan/70">
                          <Hash className="h-4 w-4" />
                        </span>
                      ) : (
                        <Avatar
                          name={room.display_name || room.name}
                          size="md"
                          className="mt-0.5"
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-slate-50">
                            {room.display_name || room.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {room.last_message && (
                              <span className="text-[11px] tabular-nums text-slate-500">
                                {timestamp(room.last_message.created_at)}
                              </span>
                            )}
                            {unread > 0 && (
                              <span className="gradient-bg grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
                                {unread > 99 ? "99+" : unread}
                              </span>
                            )}
                          </span>
                        </span>
                        {room.last_message ? (
                          <p className="mt-0.5 truncate text-xs text-slate-300">
                            <span
                              className="font-medium"
                              style={{
                                color: identityFor(
                                  room.last_message.sender_id,
                                  room.last_message.sender_name,
                                ).text,
                              }}
                            >
                              {room.last_message.sender_name}:
                            </span>{" "}
                            {preview(room.last_message.content)}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-xs italic text-slate-600">
                            {kind === "mention" ? "You were mentioned" : "Unread messages"}
                          </p>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ── Recent human conversations ───────────────────────────────── */}
        <section aria-labelledby="home-chats-heading">
          <div className="mb-2 flex items-center gap-2">
            <Users className="h-4 w-4 text-stable-cyan" />
            <h2
              id="home-chats-heading"
              className="font-display text-sm font-semibold text-slate-200"
            >
              Recent conversations
            </h2>
          </div>

          {recentHumanChats.length === 0 ? (
            <div className="card relative flex flex-col items-center gap-3 overflow-hidden px-6 py-10 text-center">
              <span
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,rgba(34,211,238,0.08),transparent_70%)]"
                aria-hidden="true"
              />
              <span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-stable-cyan/15 text-stable-cyan">
                <MessageSquare className="h-5 w-5" />
              </span>
              <div className="relative">
                <p className="text-sm font-medium text-slate-200">
                  No human chats yet
                </p>
                <p className="mt-1 max-w-sm text-xs text-slate-500">
                  Message a teammate from People, or start a group DM.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPeopleDrawerOpen(true)}
                className="gradient-bg glow-iris focus-ring relative flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white transition hover:opacity-95 active:scale-[0.98]"
              >
                <UserRound className="h-3.5 w-3.5" />
                Find people
              </button>
            </div>
          ) : (
            <ul className="card overflow-hidden">
              {recentHumanChats.map((room, i) => {
                const unread = unreadFor(room);
                const m = room.last_message;
                const isGroup = room.type === "group_dm";
                return (
                  <li key={room.id}>
                    <button
                      type="button"
                      onClick={() => openRoom(room.id)}
                      className={clsx(
                        "focus-ring flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.04]",
                        i > 0 && "border-t border-line",
                        unread > 0 && "bg-stable-purple/[0.06]",
                      )}
                    >
                      {isGroup ? (
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-stable-cyan/70">
                          <Users className="h-4 w-4" />
                        </span>
                      ) : (
                        <Avatar
                          name={room.display_name || room.name}
                          size="md"
                          className="mt-0.5"
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span
                            className={clsx(
                              "truncate text-sm",
                              unread > 0
                                ? "font-semibold text-slate-50"
                                : "font-medium text-slate-200",
                            )}
                          >
                            {room.display_name || room.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {m && (
                              <span className="text-[11px] tabular-nums text-slate-500">
                                {timestamp(m.created_at)}
                              </span>
                            )}
                            {unread > 0 && (
                              <span className="gradient-bg grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
                                {unread > 99 ? "99+" : unread}
                              </span>
                            )}
                          </span>
                        </span>
                        {m ? (
                          <p
                            className={clsx(
                              "mt-0.5 truncate text-xs",
                              unread > 0 ? "text-slate-300" : "text-slate-400",
                            )}
                          >
                            <span
                              className="font-medium"
                              style={{
                                color: identityFor(m.sender_id, m.sender_name)
                                  .text,
                              }}
                            >
                              {m.sender_name}:
                            </span>{" "}
                            {preview(m.content)}
                          </p>
                        ) : (
                          <p className="mt-0.5 truncate text-xs italic text-slate-600">
                            No messages yet
                          </p>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

          </div>

          <div className="min-w-0 space-y-6">
            {/* Column B: realtime surfaces — meetings, then agent work. */}

        {/* ── Meetings ─────────────────────────────────────────────────── */}
        <section aria-labelledby="home-meetings-heading">
          <div className="mb-2 flex items-center gap-2">
            <Video className="h-4 w-4 text-stable-cyan" />
            <h2
              id="home-meetings-heading"
              className="font-display text-sm font-semibold text-slate-200"
            >
              Meetings
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

          {liveConferenceRooms.length > 0 && (
            <ul className="grid grid-cols-1 gap-3">
              {liveConferenceRooms.map((room) => (
                <li key={room.id}>
                  <button
                    type="button"
                    onClick={() => openRoom(room.id)}
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
                        {room.display_name || room.name}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-slate-400">
                        {room.last_message
                          ? `Active ${timestamp(room.last_message.created_at)} ago`
                          : "Conference room"}
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

        {/* ── Agent work waiting on the human ──────────────────────────── */}
          <section aria-labelledby="home-agents-heading">
            <div className="mb-2 flex items-center gap-2">
              <Bot className="h-4 w-4 text-slate-400" />
              <h2
                id="home-agents-heading"
                className="font-display text-sm font-semibold text-slate-200"
              >
                Needs your attention
              </h2>
              <span className="text-[11px] text-slate-500">agents</span>
            </div>
            {actionableAgentItems.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
                No agents waiting on you
              </p>
            ) : (
            <ul className="card overflow-hidden">
              {actionableAgentItems.map((room, i) => {
                const unread = unreadFor(room);
                const m = room.last_message;
                return (
                  <li key={room.id}>
                    <button
                      type="button"
                      onClick={() => openRoom(room.id)}
                      className={clsx(
                        "focus-ring flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.04]",
                        i > 0 && "border-t border-line",
                        "bg-stable-purple/[0.04]",
                      )}
                    >
                      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-purple/15 text-stable-purple-light">
                        <Bot className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-slate-50">
                            {room.display_name || room.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {m && (
                              <span className="text-[11px] tabular-nums text-slate-500">
                                {timestamp(m.created_at)}
                              </span>
                            )}
                            {unread > 0 && (
                              <span className="gradient-bg grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white">
                                {unread > 99 ? "99+" : unread}
                              </span>
                            )}
                          </span>
                        </span>
                        {m ? (
                          <p className="mt-0.5 truncate text-xs text-slate-300">
                            <span
                              className="font-medium"
                              style={{
                                color: identityFor(m.sender_id, m.sender_name)
                                  .text,
                              }}
                            >
                              {m.sender_name}:
                            </span>{" "}
                            {preview(m.content)}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-xs text-slate-500">
                            Unread agent messages
                          </p>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            )}
          </section>
          </div>

          <div className="min-w-0 space-y-6">
            {/* Column C: who's around right now. */}

        {/* ── People online ────────────────────────────────────────────── */}
        <section aria-labelledby="home-people-heading">
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
                        <Avatar
                          id={person.id}
                          name={label}
                          src={person.avatar_url}
                          size="md"
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

        {/* ── Agent fleet ──────────────────────────────────────────────── */}
        <section aria-labelledby="home-fleet-heading">
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
                  {fleetActiveCount}/{agentRoster.length} active
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
                        <UnicornAvatar
                          id={agent.id}
                          name={agent.display_name || agent.name}
                          size={32}
                          state={
                            unreachable || agent.status === "offline"
                              ? "offline"
                              : agent.status === "working"
                                ? "working"
                                : "idle"
                          }
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
                          {[agent.rank, agent.title].filter(Boolean).join(" · ") ||
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
          </div>
        </div>
      </div>
    </div>
  );
}
