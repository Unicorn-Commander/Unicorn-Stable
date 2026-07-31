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
import { useAppStore } from "@/stores/appStore";
import { useCallUiStore } from "@/stores/callUiStore";
import { useFederationStore } from "@/stores/federationStore";
import { usePresenceStore } from "@/stores/presenceStore";
import { useVoice } from "@/contexts/VoiceProvider";
import { roomsForView } from "@/components/Sidebar/sidebarModel";

/** Recent enough last activity to treat a conference room as "live-ish". */
const LIVE_MEETING_MS = 2 * 60 * 60 * 1000;

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

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="animate-fade-in mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        {/* ── Greeting ─────────────────────────────────────────────────── */}
        <header className="card relative mb-6 overflow-hidden px-6 py-7 sm:px-8 sm:py-8">
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_150%_at_100%_0%,rgba(139,92,246,0.14),transparent_55%)]"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_120%_at_82%_100%,rgba(34,211,238,0.10),transparent_60%)]"
            aria-hidden="true"
          />
          <div className="relative">
            <div className="mb-3 flex items-center gap-2.5">
              <span className="gradient-bg glow-iris flex h-7 w-7 items-center justify-center rounded-lg">
                <Sparkles className="h-4 w-4 text-white" />
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Unicorn Stable
              </span>
            </div>
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              <span className="text-slate-50">{greetingFor(hour)}, </span>
              <span className="gradient-text-aurora">{firstName}</span>
            </h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-400">
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
        </header>

        {/* ── 1. Active meeting / rejoin ───────────────────────────────── */}
        <section className="mb-6" aria-labelledby="home-meetings-heading">
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
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

        {/* ── 2. Mentions & priority ───────────────────────────────────── */}
        <section className="mb-6" aria-labelledby="home-priority-heading">
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

        {/* ── 3. Favorite people online ────────────────────────────────── */}
        <section className="mb-6" aria-labelledby="home-favorites-heading">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <UserRound className="h-4 w-4 text-stable-mint" />
              <h2
                id="home-favorites-heading"
                className="font-display text-sm font-semibold text-slate-200"
              >
                Favorite people online
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

          {favoriteIds.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
              Star people from the People drawer to see them here when online.
            </p>
          ) : favoritePeopleOnline.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
              None of your favorites are online right now.
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {favoritePeopleOnline.map((person) => {
                const label =
                  person.display_name?.trim() ||
                  person.username?.trim() ||
                  "Person";
                const busy = openingPersonId === person.id;
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
                        <span className="block truncate text-sm font-medium text-slate-100">
                          {label}
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

        {/* ── 4. Recent human conversations ────────────────────────────── */}
        <section className="mb-6" aria-labelledby="home-chats-heading">
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

        {/* ── 5. Agent items only when actionable ──────────────────────── */}
        {actionableAgentItems.length > 0 && (
          <section className="mb-6" aria-labelledby="home-agents-heading">
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
          </section>
        )}

        {/* ── Subtle quick actions (not hero agent metrics) ────────────── */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setPeopleDrawerOpen(true)}
            className="card card-hover focus-ring group relative flex items-center gap-3 overflow-hidden border-stable-mint/25 px-4 py-3.5 text-left text-slate-200 hover:glow-mint active:scale-[0.98]"
          >
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-mint/15 text-stable-mint transition-colors group-hover:bg-stable-mint/25">
              <UserRound className="h-5 w-5" />
            </span>
            <span className="relative min-w-0">
              <span className="block text-sm font-semibold">Message someone</span>
              <span className="block truncate text-xs text-slate-400">
                Open People to start a DM or call
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setCreateRoomModalOpen(true)}
            className="card card-hover focus-ring group relative flex items-center gap-3 overflow-hidden border-stable-cyan/25 px-4 py-3.5 text-left text-slate-200 hover:glow-aqua active:scale-[0.98]"
          >
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-cyan/15 text-stable-cyan transition-colors group-hover:bg-stable-cyan/25">
              <Plus className="h-5 w-5" />
            </span>
            <span className="relative min-w-0">
              <span className="block text-sm font-semibold">New channel</span>
              <span className="block truncate text-xs text-slate-400">
                Spin up a room for the team
              </span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
