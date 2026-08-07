import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { Bell, BellOff, ChevronDown, Database, Hash, LayoutTemplate, LogOut, MoreVertical, PanelLeftOpen, Pencil, Pin, Search, UserPlus, UserRound, Users } from "lucide-react";
import { isMuted, onMutedChange, toggleMute } from "@/utils/mute";
import { identityFor } from "@/lib/identity";
import { api, type ApiError } from "@/services/api";
import { ws } from "@/services/websocket";
import { useAppStore } from "@/stores/appStore";
import { handleArtifactEvent, useCanvasStore } from "@/stores/canvasStore";
import { coerceArtifactEvent } from "@/lib/roomDataProtocol";
import { useKnowledgeStore } from "@/stores/knowledgeStore";
import { useMenuKeyboard } from "@/hooks/useMenuKeyboard";
import {
  PANEL_RESIZE_HANDLE_CLASS,
  useIsDesktop,
  usePanelResize,
} from "@/hooks/usePanelResize";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { CallRoomLayout } from "./CallRoomLayout";
import { ParticipantStrip } from "./ParticipantStrip";
import { ModelSwitcher } from "./ModelSwitcher";
import { BrigadeAgentPicker } from "./BrigadeAgentPicker";
import { InviteMembersModal } from "./InviteMembersModal";
import { ThreadPanel } from "./ThreadPanel";
import { SearchPanel } from "./SearchPanel";
import { PinsPanel } from "./PinsPanel";
import { CanvasPanel } from "./CanvasPanel";
import { LeaveRoomModal } from "./LeaveRoomModal";

// Lazy: the Knowledge panel (collection mgmt + file upload + doc lists) is a
// distinct surface most sessions never open, so split it out of the main chunk.
const KnowledgePanel = lazy(() => import("./KnowledgePanel"));

interface RoomViewProps {
  roomId: string;
}

export function RoomView({ roomId }: RoomViewProps) {
  const participantPanelOpen = useAppStore((s) => s.ui.participantPanelOpen);
  const toggleParticipantPanel = useAppStore((s) => s.toggleParticipantPanel);
  const setParticipantPanelOpen = useAppStore(
    (s) => s.setParticipantPanelOpen,
  );
  // Desktop drag-to-resize for the docked participants column. On phones the
  // panel is a fixed-width overlay drawer, so the stored width never applies.
  const isDesktop = useIsDesktop();
  const participantsResize = usePanelResize("participants", {
    defaultWidth: 240,
    min: 200,
    max: 420,
    edge: "left",
  });
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setPeopleDrawerOpen = useAppStore((s) => s.setPeopleDrawerOpen);
  const threadMessageId = useAppStore((s) => s.ui.threadMessageId);
  const setThreadMessageId = useAppStore((s) => s.setThreadMessageId);
  // Canvas (co-working artifacts) right-drawer. Open state is global (single
  // active canvas); the toggle + the data-channel both drive it.
  const canvasOpen = useCanvasStore((s) => s.panelOpen);
  const setCanvasOpen = useCanvasStore((s) => s.setPanelOpen);
  const setCanvasRoom = useCanvasStore((s) => s.setRoom);
  // Attention state for the Canvas toggle. `canvasCount` makes an existing
  // artifact discoverable at all (nothing else in the header hints the room has
  // one); `canvasUnseen` marks the ones that landed live while the drawer was
  // shut, so an arrival is visibly different from "there is stuff in here".
  const canvasCount = useCanvasStore((s) => s.artifacts.length);
  const canvasUnseen = useCanvasStore((s) => s.unseen);
  const canvasDot = !canvasOpen && (canvasCount > 0 || canvasUnseen > 0);
  // Keep the canvas store scoped to the active room even while the panel is
  // closed, so a live artifact event (or reopening the panel) always targets
  // the right room. RoomView remounts per room (keyed in AppShell), so this
  // fires exactly once per room. setRoom() no-ops if already scoped here.
  useEffect(() => {
    setCanvasRoom(roomId);
  }, [roomId, setCanvasRoom]);
  // Knowledge (KB collections) right-drawer. Like the canvas, open state is
  // global (single active panel) and the store is scoped to the active room so
  // the room's attached collections are always for the right room.
  const knowledgeOpen = useKnowledgeStore((s) => s.panelOpen);
  const setKnowledgeOpen = useKnowledgeStore((s) => s.setPanelOpen);
  const setKnowledgeRoom = useKnowledgeStore((s) => s.setRoom);
  useEffect(() => {
    setKnowledgeRoom(roomId);
  }, [roomId, setKnowledgeRoom]);
  // The call surface (video grid / audio bar) and its coexistence with chat is
  // owned entirely by <CallRoomLayout> below — it reads voiceActive + the
  // per-room view mode itself and resizes chat beside the video.
  const setParticipants = useAppStore((s) => s.setParticipants);
  const removeRoom = useAppStore((s) => s.removeRoom);
  const [inviteOpen, setInviteOpen] = useState(false);
  // Header agent-switcher (agent rooms only): shows the room's current agent
  // and opens the Brigade picker — inviting another agent re-routes replies to
  // it (last-invited wins; @mention any member agent to address it directly).
  const [agentSwitchOpen, setAgentSwitchOpen] = useState(false);
  const rosterAgents = useAppStore((s) => s.agents);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const overflowRef = useRef<HTMLDivElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const [muted, setMuted] = useState(() => isMuted(roomId));
  useEffect(() => {
    setMuted(isMuted(roomId));
    return onMutedChange(() => setMuted(isMuted(roomId)));
  }, [roomId]);

  /**
   * Room utilities share one workspace dock. Opening a thread, Canvas,
   * Knowledge, pins, or the roster replaces the current utility instead of
   * stacking another column onto chat.
   */
  function closeWorkspaceExcept(
    keep: "thread" | "pins" | "canvas" | "knowledge" | "participants",
  ) {
    if (keep !== "thread") setThreadMessageId(null);
    if (keep !== "pins") setPinsOpen(false);
    if (keep !== "canvas") setCanvasOpen(false);
    if (keep !== "knowledge") setKnowledgeOpen(false);
    if (keep !== "participants") setParticipantPanelOpen(false);
  }

  function togglePins() {
    if (pinsOpen) {
      setPinsOpen(false);
      return;
    }
    closeWorkspaceExcept("pins");
    setPinsOpen(true);
  }

  function toggleCanvas() {
    if (canvasOpen) {
      setCanvasOpen(false);
      return;
    }
    closeWorkspaceExcept("canvas");
    setCanvasOpen(true);
  }

  function toggleKnowledge() {
    if (knowledgeOpen) {
      setKnowledgeOpen(false);
      return;
    }
    closeWorkspaceExcept("knowledge");
    setKnowledgeOpen(true);
  }

  function toggleParticipants() {
    if (participantPanelOpen) {
      toggleParticipantPanel();
      return;
    }
    closeWorkspaceExcept("participants");
    setParticipantPanelOpen(true);
  }

  function openThread(messageId: string) {
    closeWorkspaceExcept("thread");
    setThreadMessageId(messageId);
  }

  // ChatPanel, pinned results, and global search open threads directly through
  // appStore. Reconcile those entry points with the one-dock contract too.
  useEffect(() => {
    if (!threadMessageId) return;
    setPinsOpen(false);
    setCanvasOpen(false);
    setKnowledgeOpen(false);
    setParticipantPanelOpen(false);
  }, [
    threadMessageId,
    setCanvasOpen,
    setKnowledgeOpen,
    setParticipantPanelOpen,
  ]);

  // Close the overflow menu on outside-click.
  useEffect(() => {
    if (!overflowOpen) return;
    function onDown(e: MouseEvent) {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [overflowOpen]);

  // Keyboard model for the ⋮ menu (focus-in, arrows, Esc-to-close + restore).
  useMenuKeyboard(overflowOpen, overflowMenuRef, overflowBtnRef, () =>
    setOverflowOpen(false),
  );

  const { data: roomDetail } = useQuery({
    queryKey: ["room", roomId],
    queryFn: () => api.getRoom(roomId),
    staleTime: 30_000,
  });

  // getRoom doesn't include members in our wire-format. Fetch separately so
  // the participant strip + read receipts have someone to render.
  // This is also the ONLY presence snapshot the client takes: each row carries
  // server-side, Redis-derived `is_online`, which covers peers who were already
  // online before we opened the room. (A second /rooms/{id}/presence poll used
  // to seed a separate global online set; it was add-only and could resurrect a
  // dot that a WS "offline" delta had just cleared, so the two snapshots could
  // disagree. One transport, one reader.)
  const {
    data: members,
    dataUpdatedAt: membersUpdatedAt,
    error: membersError,
  } = useQuery({
    queryKey: ["room-members", roomId],
    queryFn: () => api.getRoomMembers(roomId),
    refetchInterval: 30_000,
    retry: false,
  });

  // Keyed on dataUpdatedAt, NOT on the `members` reference. TanStack Query's
  // structural sharing returns the PREVIOUS object when a refetch deep-equals
  // the cached data, so a reference-keyed effect never re-runs on an unchanged
  // payload. Live WS deltas mutate presence in the store between polls, so the
  // store can legitimately disagree with an unchanged cached payload — without
  // this, that disagreement would never be re-settled. dataUpdatedAt advances
  // on every successful fetch, guaranteeing the poll always gets the last word.
  useEffect(() => {
    if (members) {
      setParticipants(roomId, members);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membersUpdatedAt, roomId, setParticipants]);

  // Live member changes (someone joined/left, was removed, role/mute changed)
  // fan out over the room socket so every open client refreshes immediately
  // instead of waiting for the 30s poll.
  useEffect(() => {
    if (!roomId) return;
    return ws.on("members_changed", (data) => {
      const evt = data as { room_id?: string };
      if (evt.room_id && evt.room_id !== roomId) return;
      qc.invalidateQueries({ queryKey: ["room-members", roomId] });
    });
  }, [roomId, qc]);

  // Live artifact (canvas) events over the ROOM SOCKET.
  //
  // This is the delivery path that actually covers the normal case. The backend
  // also fans these out on the LiveKit data channel (VoiceProvider), but that
  // only reaches clients joined to a CALL — so an artifact created while you
  // were just sitting in the room produced no client event whatsoever, and the
  // canvas only caught up on a reload or a room switch (setRoom →
  // refreshArtifacts). The two planes are additive and handleArtifactEvent is
  // idempotent, so a client in a call simply gets the event twice.
  useEffect(() => {
    if (!roomId) return;
    const onArtifact = (data: unknown) => {
      const msg = coerceArtifactEvent(data);
      // Foreign-room events are dropped again inside handleArtifactEvent, but
      // this socket is subscribed to every room the user belongs to, so filter
      // here too rather than churn the store for another room's traffic.
      if (!msg || msg.room_id !== roomId) return;
      handleArtifactEvent(msg);
    };
    const offCreated = ws.on("artifact_created", onArtifact);
    const offUpdated = ws.on("artifact_updated", onArtifact);
    return () => {
      offCreated();
      offUpdated();
    };
  }, [roomId]);

  // If the members fetch comes back 403, my membership is gone (I was removed
  // or the room was archived) — eject to home rather than sit on a dead room.
  useEffect(() => {
    if ((membersError as ApiError | null)?.status === 403) {
      removeRoom(roomId);
      navigate("/");
    }
  }, [membersError, roomId, removeRoom, navigate]);

  const displayName = roomDetail?.display_name || roomDetail?.name || "Room";
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  useEffect(() => {
    setTopicDraft(roomDetail?.description || "");
  }, [roomDetail?.description]);
  useEffect(() => {
    setNameDraft(roomDetail?.display_name || roomDetail?.name || "");
  }, [roomDetail?.display_name, roomDetail?.name]);

  async function saveTopic() {
    setEditingTopic(false);
    const next = topicDraft.trim();
    if ((roomDetail?.description || "") === next) return;
    try {
      await api.updateRoom(roomId, { description: next });
      await qc.invalidateQueries({ queryKey: ["room", roomId] });
    } catch (e) {
      console.error("topic save failed", e);
    }
  }

  async function saveName() {
    setEditingName(false);
    const next = nameDraft.trim();
    if (!next || next === (roomDetail?.display_name || roomDetail?.name || ""))
      return;
    try {
      await api.updateRoom(roomId, { display_name: next });
      await qc.invalidateQueries({ queryKey: ["room", roomId] });
      await qc.invalidateQueries({ queryKey: ["rooms"] });
    } catch (e) {
      console.error("name save failed", e);
      useAppStore.getState().pushToast({
        title: "Couldn't rename the room",
        body: (e as Error).message,
        kind: "error",
      });
    }
  }

  function openLeave() {
    setOverflowOpen(false);
    setLeaveOpen(true);
  }

  async function confirmLeave() {
    if (leaving) return;
    setLeaving(true);
    try {
      await api.leaveRoom(roomId);
      removeRoom(roomId);
      await qc.invalidateQueries({ queryKey: ["rooms"] });
      setLeaveOpen(false);
      // URL is the source of truth for the active room (see AppShell), so we
      // must navigate home; otherwise the route param would re-select the
      // room we just left on the next render.
      navigate("/");
    } catch (e) {
      console.error("leave room failed", e);
    } finally {
      setLeaving(false);
    }
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Room header */}
      {/* Glass paint lives on an inner layer: backdrop-filter on the header
          itself would make it the containing block for fixed descendants,
          clipping the agent-switcher's full-viewport click-away backdrop to
          the 48px strip (and trapping the z-50 menus in a header stacking
          context under root-level z-10 hover toolbars). */}
      <div className="relative flex h-12 min-w-0 shrink-0 items-center justify-between gap-1 border-b border-line px-2 sm:px-4">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-stable-glass backdrop-blur-xl"
        />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Phones: this sub-header is the single top bar, so it owns the
              drawer toggle. Hidden >= md (the AppShell Header's hamburger
              takes over there). */}
          <button
            onClick={toggleSidebar}
            className="-ml-1 shrink-0 rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring md:hidden"
            aria-label="Open sidebar"
          >
            <PanelLeftOpen className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => setPeopleDrawerOpen(true)}
            className="shrink-0 rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring md:hidden"
            aria-label="People"
            title="People"
          >
            <UserRound className="h-5 w-5" />
          </button>
          <Hash className="h-4 w-4 shrink-0 text-stable-cyan/70" />
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveName();
                } else if (e.key === "Escape") {
                  setNameDraft(roomDetail?.display_name || roomDetail?.name || "");
                  setEditingName(false);
                }
              }}
              className="rounded-lg border border-line bg-slate-950/60 px-2 py-0.5 font-display text-base md:text-sm font-semibold text-slate-100 outline-none transition focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            />
          ) : (
            <button
              onClick={() => {
                // Desktop-only: on phones a natural tap on the title would
                // summon an autofocused input + keyboard. Mobile renames via
                // the ⋮ overflow menu's "Rename channel" entry instead.
                if (window.matchMedia("(min-width: 768px)").matches) setEditingName(true);
              }}
              className="truncate font-display text-sm font-semibold text-slate-50 transition-colors hover:text-stable-purple-light focus-ring"
              title="Click to rename"
            >
              {displayName}
            </button>
          )}
          {/* Topic + its separator are secondary — hide on phones so a long
              topic can't squeeze the room name down to a couple letters. The
              name then takes the full width. md:contents keeps desktop identical. */}
          <span className="hidden md:contents">
          <span className="text-slate-700">·</span>
          {editingTopic ? (
            <input
              autoFocus
              value={topicDraft}
              onChange={(e) => setTopicDraft(e.target.value)}
              onBlur={saveTopic}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveTopic();
                } else if (e.key === "Escape") {
                  setTopicDraft(roomDetail?.description || "");
                  setEditingTopic(false);
                }
              }}
              placeholder="Add a topic…"
              className="flex-1 rounded-lg border border-line bg-slate-950/60 px-2 py-0.5 text-base md:text-xs text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            />
          ) : (
            <button
              onClick={() => setEditingTopic(true)}
              className={clsx(
                "truncate text-xs transition-colors hover:text-slate-300 focus-ring",
                roomDetail?.description ? "text-slate-400" : "italic text-slate-500",
              )}
              title="Click to edit topic"
            >
              {roomDetail?.description || "Add a topic…"}
            </button>
          )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {/* Mid-conversation model switcher. Desktop: inline. Phones: folds
              into the ⋮ menu below (rendered there) so the single mobile header
              bar doesn't get re-crowded. */}
          <span className="hidden md:contents">
            <ModelSwitcher roomId={roomId} />
          </span>
          {roomDetail?.brigade_agent_id &&
            (() => {
              const agentId = roomDetail.brigade_agent_id!;
              const roomAgent = rosterAgents.find((a) => a.id === agentId);
              const agentName = roomAgent?.display_name || roomAgent?.name || agentId;
              const ident = identityFor(agentId, agentName);
              return (
                <div className="relative hidden md:block">
                  <button
                    onClick={() => setAgentSwitchOpen((v) => !v)}
                    aria-haspopup="dialog"
                    aria-expanded={agentSwitchOpen}
                    title="Switch or add the agent this room talks to"
                    className="focus-ring flex items-center gap-1.5 rounded-lg border border-line bg-white/[0.03] px-2.5 py-1 text-xs font-medium transition-colors hover:border-line-strong hover:bg-white/[0.06]"
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: ident.color }}
                    />
                    <span
                      className="max-w-[14ch] truncate"
                      style={{ color: ident.text }}
                    >
                      {agentName}
                    </span>
                    <ChevronDown
                      className={clsx(
                        "h-3 w-3 text-slate-500 transition-transform",
                        agentSwitchOpen && "rotate-180",
                      )}
                    />
                  </button>
                  {agentSwitchOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        aria-hidden="true"
                        onClick={() => setAgentSwitchOpen(false)}
                      />
                      <div className="absolute right-0 top-full z-50 mt-2 w-80">
                        <BrigadeAgentPicker
                          roomName={roomDetail?.id ?? roomId}
                          defaultOpen
                          onInvited={() => setAgentSwitchOpen(false)}
                        />
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
          {/* Phones: search / pins / mute move into the ⋮ menu below so the
              room name has room to breathe. Desktop keeps them inline. */}
          <span className="hidden md:contents">
            <button
              onClick={() => setSearchOpen(true)}
              className="rounded-md p-2.5 md:p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring"
              aria-label="Search messages"
              title="Search this room"
            >
              <Search className="h-4 w-4" />
            </button>
            <button
              onClick={togglePins}
              className={clsx(
                "rounded-md p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring md:p-1.5",
                pinsOpen && "bg-white/[0.08] text-slate-100",
              )}
              aria-label="Show pinned messages"
              aria-pressed={pinsOpen}
              title="Pinned messages"
            >
              <Pin className="h-4 w-4" />
            </button>
            <button
              onClick={toggleCanvas}
              className={`relative rounded-md p-2.5 md:p-1.5 transition-colors focus-ring ${canvasOpen ? "bg-stable-purple/20 text-stable-purple-light" : "text-slate-400"} hover:bg-white/[0.06] hover:text-slate-100`}
              aria-label={
                canvasUnseen > 0
                  ? `Toggle canvas — ${canvasUnseen} new`
                  : canvasCount > 0
                    ? `Toggle canvas — ${canvasCount} artifact${canvasCount === 1 ? "" : "s"}`
                    : "Toggle canvas"
              }
              aria-pressed={canvasOpen}
              title={
                canvasCount > 0
                  ? `Canvas — ${canvasCount} artifact${canvasCount === 1 ? "" : "s"} in this room`
                  : "Canvas — co-working docs, code & diagrams"
              }
            >
              <LayoutTemplate className="h-4 w-4" />
              {canvasDot && (
                <span
                  aria-hidden="true"
                  className={clsx(
                    "pointer-events-none absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-slate-900 md:right-0.5 md:top-0.5",
                    canvasUnseen > 0
                      ? "animate-pulse bg-stable-purple-light"
                      : "bg-slate-500",
                  )}
                />
              )}
            </button>
            <button
              onClick={toggleKnowledge}
              className={`rounded-md p-2.5 md:p-1.5 transition-colors focus-ring ${knowledgeOpen ? "bg-stable-cyan/20 text-stable-cyan" : "text-slate-400"} hover:bg-white/[0.06] hover:text-slate-100`}
              aria-label="Toggle knowledge bases"
              aria-pressed={knowledgeOpen}
              title="Knowledge — attach docs for the agent to search"
            >
              <Database className="h-4 w-4" />
            </button>
            <button
              onClick={() => setMuted(toggleMute(roomId))}
              className={`rounded-md p-2.5 md:p-1.5 transition-colors focus-ring ${muted ? "text-amber-300" : "text-slate-400"} hover:bg-white/[0.06] hover:text-slate-100`}
              aria-label={muted ? "Unmute room" : "Mute room"}
              title={muted ? "Room muted — click to unmute" : "Mute notifications for this room"}
            >
              {muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
            </button>
          </span>
          <button
            onClick={() => setInviteOpen(true)}
            className="flex items-center gap-1 rounded-lg border border-stable-purple/30 bg-stable-purple/15 p-2.5 text-xs font-medium text-stable-purple-light transition-colors hover:border-stable-purple/50 hover:bg-stable-purple/25 focus-ring md:px-2.5 md:py-1"
            aria-label="Invite members"
          >
            <UserPlus className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Invite</span>
          </button>
          <button
            onClick={toggleParticipants}
            className={clsx(
              "rounded-md p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring md:p-1.5",
              participantPanelOpen && "bg-white/[0.08] text-slate-100",
            )}
            aria-label="Toggle participants panel"
            aria-pressed={participantPanelOpen}
            title="Show/hide members & agents"
          >
            <Users className="h-4 w-4" />
          </button>
          <div className="relative" ref={overflowRef}>
            <button
              ref={overflowBtnRef}
              onClick={() => setOverflowOpen((v) => !v)}
              className="rounded-md p-2.5 md:p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring"
              aria-label="More room actions"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              title="More"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            {overflowOpen && (
              <div
                ref={overflowMenuRef}
                role="menu"
                className="glass-heavy absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-xl py-1 shadow-pop animate-fade-in"
              >
                {/* Phones: model switcher lives here (its inline trigger is
                    hidden < md). Rendered as a labeled row; its own popover
                    opens below and stays inside this menu's bounds. */}
                <div className="px-3 py-1.5 md:hidden">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Model
                  </div>
                  <ModelSwitcher roomId={roomId} className="max-w-full" />
                </div>
                <div className="my-1 h-px bg-white/[0.06] md:hidden" />
                {/* Phones: search / pins / mute live here (their inline buttons
                    are hidden < md). Desktop only sees Leave. */}
                <button
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    setSearchOpen(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring md:hidden"
                >
                  <Search className="h-4 w-4" />
                  Search
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    if (!pinsOpen) togglePins();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring md:hidden"
                >
                  <Pin className="h-4 w-4" />
                  Pinned messages
                </button>
                {/* Canvas stays in this menu on EVERY viewport (not md:hidden):
                    the inline toolbar icon is easy to miss, so the labeled
                    entry doubles as its discoverable path on desktop too. */}
                <button
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    toggleCanvas();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
                >
                  <LayoutTemplate className="h-4 w-4" />
                  {canvasOpen ? "Hide canvas" : "Open canvas"}
                  {canvasDot && (
                    <span className="ml-auto rounded-full bg-stable-purple/20 px-1.5 py-0.5 text-[10px] text-stable-purple-light">
                      {canvasUnseen > 0 ? `${canvasUnseen} new` : canvasCount}
                    </span>
                  )}
                </button>
                {/* Knowledge is reachable on every viewport (its inline button is
                    hidden < md); the desktop toolbar button covers >= md. */}
                <button
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    toggleKnowledge();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring md:hidden"
                >
                  <Database className="h-4 w-4" />
                  {knowledgeOpen ? "Hide knowledge" : "Knowledge bases"}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    setMuted(toggleMute(roomId));
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring md:hidden"
                >
                  {muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                  {muted ? "Unmute room" : "Mute room"}
                </button>
                {/* Phones: rename lives here (the inline title tap is gated
                    to desktop pointers so it can't summon the keyboard). */}
                <button
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    setEditingName(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring md:hidden"
                >
                  <Pencil className="h-4 w-4" />
                  Rename channel
                </button>
                <div className="my-1 h-px bg-white/[0.06] md:hidden" />
                <button
                  role="menuitem"
                  onClick={openLeave}
                  disabled={leaving}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-rose-400 transition-colors hover:bg-rose-500/10 focus-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <LogOut className="h-4 w-4" />
                  {leaving ? "Leaving…" : "Leave room"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {searchOpen && (
          <SearchPanel
            roomId={roomId}
            onClose={() => setSearchOpen(false)}
            onSelect={(m) => {
              if (m.thread_id) {
                // A thread reply lives only in its thread panel.
                openThread(m.thread_id);
              } else {
                // Land on the message itself via the ?message deep-link
                // (scroll + highlight ring), not a one-message thread view.
                navigate(`/c/${roomId}?message=${m.id}`);
              }
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {inviteOpen && (
          <InviteMembersModal
            roomId={roomId}
            roomName={displayName}
            onClose={() => setInviteOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {leaveOpen && (
          <LeaveRoomModal
            roomName={displayName}
            leaving={leaving}
            onConfirm={confirmLeave}
            onClose={() => setLeaveOpen(false)}
          />
        )}
      </AnimatePresence>

      <div className="flex min-h-0 flex-1">
        {(participantPanelOpen || pinsOpen || threadMessageId) && (
          <div
            className="fixed inset-0 z-30 bg-slate-950/70 backdrop-blur-sm md:hidden"
            aria-hidden="true"
            onClick={() => {
              if (participantPanelOpen) toggleParticipantPanel();
              setPinsOpen(false);
              setThreadMessageId(null);
            }}
          />
        )}
        {/* The call surface (resizable video grid / audio bar) + chat, composed
            so chat always coexists BESIDE the video (never an overlay). Owns the
            agent stage + chat panel; reads the call/view-mode state itself. */}
        <CallRoomLayout
          roomId={roomId}
          onInviteAgent={() => setInviteOpen(true)}
        />

        <AnimatePresence>
          {threadMessageId && (
            <ThreadPanel
              key={threadMessageId}
              roomId={roomId}
              parentId={threadMessageId}
              onClose={() => setThreadMessageId(null)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {pinsOpen && (
            <PinsPanel roomId={roomId} onClose={() => setPinsOpen(false)} />
          )}
        </AnimatePresence>

        {/* Canvas (co-working artifacts). Mobile = full-screen takeover; desktop
            = a wide docked right column beside chat. Open state is in the canvas
            store so the data channel can surface agent-created artifacts later.
            The boundary wraps AnimatePresence (not the panel) so a canvas render
            crash is isolated to this drawer while exit animations still play. */}
        <ErrorBoundary label="the canvas">
          <AnimatePresence>
            {canvasOpen && (
              <CanvasPanel
                roomId={roomId}
                onClose={() => toggleCanvas()}
              />
            )}
          </AnimatePresence>
        </ErrorBoundary>

        {/* Knowledge bases (KB collection mgmt + room attach/detach). Same
            right-drawer footprint as the canvas; lazy-loaded (see import). */}
        <ErrorBoundary label="knowledge bases">
          <AnimatePresence>
            {knowledgeOpen && (
              <Suspense fallback={null}>
                <KnowledgePanel
                  roomId={roomId}
                  onClose={() => toggleKnowledge()}
                />
              </Suspense>
            )}
          </AnimatePresence>
        </ErrorBoundary>

        <AnimatePresence initial={false}>
          {participantPanelOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              // md:relative (not md:static): the resize handle is absolutely
              // positioned against this column. Desktop width comes from the
              // inline style (resizable, persisted); the mobile overlay keeps
              // its w-[min(85vw,260px)] class because the style is gated off.
              className="section-agents fixed inset-y-0 right-0 z-40 flex w-[min(85vw,260px)] flex-col overflow-hidden border-l border-line-strong bg-slate-900/95 shadow-2xl backdrop-blur-xl md:relative md:z-auto md:bg-transparent md:shadow-none md:backdrop-blur-none"
              style={isDesktop ? { width: participantsResize.width } : undefined}
            >
              <div
                {...participantsResize.dragHandleProps}
                aria-label="Resize participants panel"
                title="Drag to resize · double-click to reset"
                className={clsx(
                  PANEL_RESIZE_HANDLE_CLASS,
                  "left-0 hidden md:block",
                )}
              />
              <ErrorBoundary label="the participants panel">
                <ParticipantStrip roomId={roomId} />
                <div className="border-t border-line shrink-0">
                  <BrigadeAgentPicker roomName={roomDetail?.id ?? roomId} />
                </div>
              </ErrorBoundary>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
