import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { Bell, BellOff, ChevronDown, Database, Hash, LayoutTemplate, Link2, ListTree, Lock, LogOut, Mic, MoreVertical, PanelLeftOpen, Pencil, Phone, Pin, Plus, Search, UserPlus, UserRound, Users, Video } from "lucide-react";
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
import { LiveCallBanner } from "./LiveCallBanner";
import { ParticipantStrip } from "./ParticipantStrip";
import { ModelSwitcher } from "./ModelSwitcher";
import { BrigadeAgentPicker } from "./BrigadeAgentPicker";
import { InviteMembersModal } from "./InviteMembersModal";
import { GuestAccessModal } from "./GuestAccessModal";
import { VoiceSettingsModal } from "./VoiceSettingsModal";
import { StartGroupModal } from "./StartGroupModal";
import type { StartGroupPick } from "./startGroupModel";
import { ThreadPanel } from "./ThreadPanel";
import { SearchPanel } from "./SearchPanel";
import { PinsPanel } from "./PinsPanel";
import { CanvasPanel } from "./CanvasPanel";
import { TasksPanel, ThreadsPanel } from "./TasksPanel";
import { PanelHost } from "@/components/Layout/PanelHost";
import { useRoomPanels } from "@/hooks/useRoomPanels";
import { usePanelChromeStore } from "@/stores/panelChromeStore";
import { LeaveRoomModal } from "./LeaveRoomModal";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { agentPresence } from "@/lib/agentStatus";
import { canEditVoiceSettings, voiceRelaySource } from "@/lib/voiceSettings";
import { beginThread } from "@/lib/beginThread";
import { roomLabel } from "@/lib/conversation";
import { useConversationUi } from "@/stores/conversationUiStore";
import { InviteSheet } from "./InviteSheet";
import { useDirectCall } from "@/hooks/useDirectCall";
import { ProjectNumber } from "@/components/Sidebar/NewSheet";

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
  const roomPanels = useRoomPanels(roomId);
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
  // Guest access — the OTHER kind of invite: a no-account outsider on a link.
  // Owner-only (see `isRoomOwner` below), because minting one puts a stranger
  // in the room with camera, mic and read access.
  const [guestAccessOpen, setGuestAccessOpen] = useState(false);
  // Voice settings — when the room's voice agent treats speech as addressed
  // to it. Only offered when the room HAS a voice agent (voice_relay_source)
  // and the caller is owner/admin, the exact gate the PATCH enforces.
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
  // "Start a group with <peer>…" — the EXPLICIT DM→group conversion. 1:1 DMs
  // deliberately have no Invite (inviting silently converted the private
  // room); this replacement creates a NEW group room instead. `startGroupSeed`
  // pre-picks a selection when the flow was entered by choosing a specific
  // agent (the Brigade picker in a human DM routes here instead of binding).
  const [startGroupOpen, setStartGroupOpen] = useState(false);
  const [startGroupSeed, setStartGroupSeed] = useState<StartGroupPick[]>([]);
  function openStartGroup(seed: StartGroupPick[] = []) {
    setStartGroupSeed(seed);
    setStartGroupOpen(true);
  }
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
  useEffect(() => {
    if (useConversationUi.getState().takeTitleFocus(roomId)) setEditingName(true);
  }, [roomId, roomDetail?.id]);

  // ── Type-aware identity block (Fable gap 12) ────────────────────────────
  // A 1:1 DM is a private conversation, not a channel: its header names a
  // PERSON, so it gets the person's avatar + presence instead of a #, and it
  // drops the channel furniture (topic edit, rename, Invite) that implies
  // the room is a public space.
  const isDm = roomDetail?.type === "dm" || roomDetail?.type === "agent_hub";
  const parentRoom = useAppStore((s) =>
    roomDetail?.parent_room_id
      ? s.rooms.find((r) => r.id === roomDetail.parent_room_id) ?? null
      : null,
  );
  const { startCall } = useDirectCall();
  const [callMenuOpen, setCallMenuOpen] = useState(false);
  const dmAgentId = roomDetail?.brigade_agent_id ?? null;
  const dmAgent = dmAgentId
    ? rosterAgents.find((a) => a.id === dmAgentId)
    : undefined;
  const dmAgentName =
    dmAgent?.display_name || dmAgent?.name || dmAgentId || "";
  // Minting a guest link is OWNER-only on the server (membership is
  // deliberately not enough). Read the caller's own membership row — server-set
  // `is_self` is the only reliable "this is me" marker, since the Keycloak id
  // never equals the participant UUID — so a member never sees a control that
  // could only 403. Mirrors VoiceVideoBar's broadcast-mint gate.
  const isRoomOwner = members?.find((m) => m.is_self)?.role === "owner";
  // Voice-settings gate: the room has a voice relay AND the caller could
  // actually change it (owner/admin — canEditVoiceSettings mirrors the
  // server's ladder). Members don't see an entry that could only 403.
  const voiceAgentSource = voiceRelaySource(roomDetail?.metadata_);
  const showVoiceSettings =
    voiceAgentSource !== null && canEditVoiceSettings(members);
  // The person on the other side of a human 1:1 — members arrive from the
  // room-members query above (is_self is server-set, the only reliable marker).
  const dmPeer = members?.find(
    (m) => !m.is_self && (m.participant_type ?? "human") !== "agent",
  );
  const dmPeerName = dmPeer?.display_name || displayName;
  // Live presence comes from the agent's MEMBER row (Redis-derived, WS-
  // patched); the roster's `availability` is the reachability fallback.
  const dmAgentMember = members?.find(
    (m) => (m.participant_type ?? "human") === "agent",
  );
  const dmAgentBadge = dmAgentId
    ? agentPresence({
        isOnline: dmAgentMember?.is_online,
        availability:
          dmAgentMember?.availability ?? dmAgent?.availability,
        availabilityReason:
          dmAgentMember?.availability_reason ?? dmAgent?.availability_reason,
        name: dmAgentName,
      })
    : null;
  // Who "Start a group with …" names: the agent for agent DMs, the person for
  // human DMs. The display_name fallback strips the "DM with " prefix so a
  // pre-members render never yields "Start a group with DM with Alice".
  const dmPeerLabel = dmAgentId
    ? dmAgentName
    : dmPeer?.display_name ||
      (roomDetail?.display_name || "").replace(/^DM with /, "") ||
      "them";

  async function saveTopic() {
    const next = topicDraft.trim();
    if ((roomDetail?.description || "") === next) {
      setEditingTopic(false);
      return;
    }
    try {
      await api.updateRoom(roomId, { description: next });
      await qc.invalidateQueries({ queryKey: ["room", roomId] });
      setEditingTopic(false);
    } catch (e) {
      console.error("topic save failed", e);
      // Keep the input open with the attempted text — closing it would
      // silently discard what the user typed.
      useAppStore.getState().pushToast({
        title: "Couldn't update the topic",
        body:
          (e as { detail?: string; message?: string }).detail ||
          (e as Error).message,
        kind: "error",
      });
    }
  }

  async function saveName() {
    const next = nameDraft.trim();
    if (!next || next === (roomDetail?.display_name || roomDetail?.name || "")) {
      setEditingName(false);
      return;
    }
    try {
      await api.updateRoom(roomId, { display_name: next });
      await qc.invalidateQueries({ queryKey: ["room", roomId] });
      await qc.invalidateQueries({ queryKey: ["rooms"] });
      setEditingName(false);
    } catch (e) {
      console.error("name save failed", e);
      // Keep the input open with the attempted text (same contract as the
      // message-edit failure path).
      useAppStore.getState().pushToast({
        title: "Couldn't rename the room",
        body:
          (e as { detail?: string; message?: string }).detail ||
          (e as Error).message,
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
      useAppStore.getState().pushToast({
        title: "Couldn't leave the room",
        body:
          (e as { detail?: string; message?: string }).detail ||
          (e as Error).message,
        kind: "error",
      });
    } finally {
      setLeaving(false);
    }
  }

  const repliesFloated =
    roomPanels.replies.mode === "popped" || roomPanels.replies.mode === "floating";
  const canvasFloated =
    roomPanels.canvas.mode === "popped" || roomPanels.canvas.mode === "floating";
  const membersFloated =
    roomPanels.members.mode === "popped" || roomPanels.members.mode === "floating";
  const tasksFloated =
    roomPanels.tasks.mode === "popped" || roomPanels.tasks.mode === "floating";
  const threadsFloated =
    roomPanels.threads.mode === "popped" || roomPanels.threads.mode === "floating";

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
            className="-ml-1 max-md:min-h-11 max-md:min-w-11 shrink-0 rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring md:hidden"
            aria-label="Open sidebar"
          >
            <PanelLeftOpen className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => setPeopleDrawerOpen(true)}
            className="max-md:min-h-11 max-md:min-w-11 shrink-0 rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring md:hidden"
            aria-label="People"
            title="People"
          >
            <UserRound className="h-5 w-5" />
          </button>
          {isDm ? (
            /* 1:1 DM: the person IS the header. Avatar + presence + name,
               read-only — no #, no topic, no rename (channel furniture). */
            <div className="flex min-w-0 items-center gap-2">
              <span className="relative shrink-0">
                {dmAgentId ? (
                  <Identity
                    {...resolveIdentity({
                      id: dmAgentId,
                      display_name: dmAgentName,
                      avatar_url: dmAgent?.avatar_url ?? dmAgentMember?.avatar_url,
                      participant_type: "agent",
                      is_online: dmAgentMember?.is_online,
                      availability:
                        dmAgentMember?.availability ?? dmAgent?.availability,
                    })}
                    presence={null}
                    size={24}
                  />
                ) : (
                  <Identity
                    {...resolveIdentity(
                      dmPeer ?? {
                        display_name: dmPeerName,
                        participant_type: "human",
                      },
                    )}
                    presence={null}
                    size={28}
                  />
                )}
                {dmAgentId ? (
                  <span
                    className={clsx(
                      "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-900",
                      dmAgentBadge?.dotClass,
                    )}
                    aria-label={dmAgentBadge?.label}
                    title={dmAgentBadge?.label}
                  />
                ) : (
                  dmPeer?.is_online && (
                    <span
                      className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 animate-live rounded-full border-2 border-slate-900 bg-stable-mint"
                      aria-label="Online"
                      title="Online"
                    />
                  )
                )}
              </span>
              <span className="truncate font-display text-sm font-semibold text-slate-50">
                {parentRoom
                  ? `${roomLabel(parentRoom)} › ${displayName}`
                  : dmAgentId
                    ? dmAgentName
                    : dmPeerName}
              </span>
            </div>
          ) : (
            <>
          {roomDetail?.visibility === "private" || roomDetail?.project_number ? (
            <Lock className="h-4 w-4 shrink-0 text-amber-300/80" aria-label="Private channel" />
          ) : (
            <Hash className="h-4 w-4 shrink-0 text-stable-cyan/70" aria-label="Public channel" />
          )}
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
              {parentRoom ? `${roomLabel(parentRoom)} › ` : ""}
              {displayName}
            </button>
          )}
          {roomDetail?.project_number && (
            <ProjectNumber number={roomDetail.project_number} />
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
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {/* Mid-conversation model switcher. Desktop: inline. Phones: folds
              into the ⋮ menu below (rendered there) so the single mobile header
              bar doesn't get re-crowded. */}
          <span className="hidden md:contents">
            <ModelSwitcher roomId={roomId} />
          </span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setCallMenuOpen((v) => !v)}
              className="focus-ring inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-slate-200 hover:bg-white/[0.06]"
              aria-haspopup="menu"
              aria-expanded={callMenuOpen}
            >
              <Phone className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Call</span>
              <ChevronDown className="h-3 w-3 text-slate-500" />
            </button>
            {callMenuOpen && (
              <div role="menu" className="glass-heavy absolute right-0 top-full z-50 mt-1 w-36 rounded-xl p-1 shadow-pop">
                <button
                  type="button"
                  role="menuitem"
                  className="focus-ring flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/[0.06]"
                  onClick={() => {
                    setCallMenuOpen(false);
                    void startCall(roomId, { video: false });
                  }}
                >
                  <Phone className="h-3.5 w-3.5" /> Voice
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="focus-ring flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/[0.06]"
                  onClick={() => {
                    setCallMenuOpen(false);
                    void startCall(roomId, { video: true });
                  }}
                >
                  <Video className="h-3.5 w-3.5" /> Video
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() =>
              usePanelChromeStore.getState().setPanelMode(
                roomId,
                "threads",
                roomPanels.threads.mode === "hidden" ? "docked" : "hidden",
              )
            }
            className={clsx(
              "focus-ring rounded-md p-2 text-slate-400 hover:bg-white/[0.06] hover:text-slate-100",
              roomPanels.threads.mode !== "hidden" && "bg-white/[0.08] text-slate-100",
            )}
            aria-label="Threads"
            title="Threads"
          >
            <ListTree className="h-4 w-4" />
          </button>
          {roomDetail?.project_number && (
            <button
              type="button"
              onClick={() =>
                usePanelChromeStore.getState().setPanelMode(
                  roomId,
                  "tasks",
                  roomPanels.tasks.mode === "hidden" ? "docked" : "hidden",
                )
              }
              className="focus-ring rounded-md px-2 py-1 text-xs text-slate-300 hover:bg-white/[0.06]"
              aria-label="Tasks"
            >
              Tasks
            </button>
          )}
          <button
            type="button"
            onClick={() => void beginThread({ roomId: roomDetail?.parent_room_id || roomId, navigate })}
            className="focus-ring inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-stable-cyan hover:bg-white/[0.06]"
            aria-label="New thread"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">New thread</span>
          </button>
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
                          onStartGroup={(a) => {
                            setAgentSwitchOpen(false);
                            openStartGroup([
                              { kind: "agent", id: a.id, name: a.name },
                            ]);
                          }}
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
          {!isDm && (
          <button
            onClick={() => useConversationUi.getState().openInviteSheet(roomId)}
            className="max-md:min-h-11 max-md:min-w-11 flex items-center gap-1 rounded-lg border border-stable-purple/30 bg-stable-purple/15 p-2.5 text-xs font-medium text-stable-purple-light transition-colors hover:border-stable-purple/50 hover:bg-stable-purple/25 focus-ring md:px-2.5 md:py-1"
            aria-label="Invite members"
          >
            <UserPlus className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Invite</span>
          </button>
          )}
          <button
            onClick={toggleParticipants}
            className={clsx(
              "max-md:min-h-11 max-md:min-w-11 rounded-md p-2.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring md:p-1.5",
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
              className="max-md:min-h-11 max-md:min-w-11 rounded-md p-2.5 md:p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-ring"
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
                className={clsx(
                  "glass-heavy absolute right-0 top-full z-50 mt-1 overflow-hidden rounded-xl py-1 shadow-pop animate-fade-in",
                  // DMs carry the longer "Start a group with <name>…" entry.
                  isDm ? "w-60" : "w-44",
                )}
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
                    to desktop pointers so it can't summon the keyboard). 1:1
                    DMs are named by their person, not by the room. */}
                {!isDm && (
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
                )}
                {/* Guest access. In this menu on EVERY viewport (not md:hidden)
                    and labeled rather than an icon: it is the room's other
                    front door, and a host looking for "how do I get someone
                    without an account into this call" looks here and in the
                    Invite modal — which links across to it. Owner-only, because
                    the server is: a member who saw this could only ever 403. */}
                {!isDm && isRoomOwner && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    setGuestAccessOpen(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
                >
                  <Link2 className="h-4 w-4" />
                  Guest access…
                </button>
                )}
                {/* Voice settings — when the room's voice agent listens.
                    In this menu on EVERY viewport, labeled (the Guest-access
                    precedent): a per-room configuration surface belongs where
                    a person looks for room configuration. Gated to rooms
                    that HAVE a voice agent and to owner/admin — the server's
                    exact gate, so nobody sees a control that could only 403. */}
                {showVoiceSettings && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    setVoiceSettingsOpen(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
                >
                  <Mic className="h-4 w-4" />
                  Voice settings…
                </button>
                )}
                {/* 1:1 DMs: the explicit group conversion. EVERY viewport —
                    DM headers have no Invite button (removed on purpose:
                    inviting silently converted the private DM), so this
                    labeled entry is the one place the affordance lives. It
                    creates a NEW group room; this DM stays private. */}
                {isDm && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    openStartGroup();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.06] focus-ring"
                >
                  <UserPlus className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate">
                    Start a group with {dmPeerLabel}…
                  </span>
                </button>
                )}
                {isDm && <div className="my-1 h-px bg-white/[0.06]" />}
                {!isDm && <div className="my-1 h-px bg-white/[0.06] md:hidden" />}
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

      <InviteSheet
        roomId={roomId}
        onOpenGuestAccess={
          isRoomOwner
            ? () => {
                useConversationUi.getState().closeInviteSheet();
                setGuestAccessOpen(true);
              }
            : undefined
        }
      />
      {(roomDetail?.type === "agent_hub" ||
        roomDetail?.type === "channel" ||
        !!roomDetail?.parent_room_id) && (
        <button
          type="button"
          onClick={() =>
            void beginThread({
              roomId: roomDetail?.parent_room_id || roomId,
              navigate,
            })
          }
          className="focus-ring fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-stable-purple text-white shadow-pop md:hidden"
          aria-label="New thread"
        >
          <Plus className="h-6 w-6" />
        </button>
      )}
      <AnimatePresence>
        {inviteOpen && (
          <InviteMembersModal
            roomId={roomId}
            roomName={displayName}
            // The second front door, reachable from the first: "invite someone"
            // and "let in someone with no account" are the same intent until
            // the moment they aren't, and a host should not have to know which
            // menu the second one lives in.
            onOpenGuestAccess={
              isRoomOwner
                ? () => {
                    setInviteOpen(false);
                    setGuestAccessOpen(true);
                  }
                : undefined
            }
            onClose={() => setInviteOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {guestAccessOpen && (
          <GuestAccessModal
            roomId={roomId}
            roomName={displayName}
            onClose={() => setGuestAccessOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {voiceSettingsOpen && (
          <VoiceSettingsModal
            roomId={roomId}
            roomName={displayName}
            onClose={() => setVoiceSettingsOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {startGroupOpen && (
          <StartGroupModal
            roomId={roomId}
            peerLabel={dmPeerLabel}
            residentAgentId={dmAgentId}
            initialPicks={startGroupSeed}
            onClose={() => setStartGroupOpen(false)}
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

      {/* "Call in progress — Join" strip: this room has a live call this
          device is not on (it moved to the phone, or others are talking).
          Self-gating via the shared live-calls source of truth, so it can
          mount unconditionally between the header and the chat. */}
      <LiveCallBanner roomId={roomId} />

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
            agent stage + chat panel; reads the call/view-mode state itself.
            In a 1:1 DM (including during a DM call) the invite affordance is
            the EXPLICIT start-a-group flow — a plain invite would silently
            convert the private DM, which is exactly what the UX wave removed.
            The live call keeps running in THIS room either way: the modal
            overlays it, and navigating to the new group leaves the call owned
            here (VoiceProvider persists it; CallDock stands in). */}
        <CallRoomLayout
          roomId={roomId}
          onInviteAgent={() =>
            isDm ? openStartGroup() : setInviteOpen(true)
          }
        />

        <AnimatePresence>
          {threadMessageId && !repliesFloated && (
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
            {canvasOpen && !canvasFloated && (
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
          {participantPanelOpen && !membersFloated && (
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
                  {/* In a human 1:1 DM (in-room OR mid-call) the picker never
                      direct-binds — it hands the chosen agent to the explicit
                      start-a-group flow, pre-picked. This mount was the field
                      path that converted a human DM into an agent thread. */}
                  <BrigadeAgentPicker
                    roomName={roomDetail?.id ?? roomId}
                    onStartGroup={(a) =>
                      openStartGroup([
                        { kind: "agent", id: a.id, name: a.name },
                      ])
                    }
                  />
                </div>
              </ErrorBoundary>
            </motion.div>
          )}
        </AnimatePresence>

        {roomPanels.tasks.mode === "docked" && (
          <div className="hidden h-full w-80 shrink-0 flex-col border-l border-line md:flex">
            <TasksPanel roomId={roomId} />
          </div>
        )}
        {roomPanels.threads.mode === "docked" && (
          <div className="hidden h-full w-80 shrink-0 flex-col border-l border-line md:flex">
            <ThreadsPanel roomId={roomId} />
          </div>
        )}

        <PanelHost
          roomId={roomId}
          panelId="replies"
          title="Replies"
          present={repliesFloated ? roomPanels.replies.mode : "hidden"}
        >
          {repliesFloated && threadMessageId ? (
            <ThreadPanel
              roomId={roomId}
              parentId={threadMessageId}
              onClose={() => {
                setThreadMessageId(null);
                usePanelChromeStore.getState().setPanelMode(roomId, "replies", "hidden");
              }}
            />
          ) : repliesFloated ? (
            <p className="px-3 py-3 text-xs text-slate-400">
              Open a reply to see it here.
            </p>
          ) : null}
        </PanelHost>
        <PanelHost
          roomId={roomId}
          panelId="canvas"
          title="Canvas"
          present={canvasFloated ? roomPanels.canvas.mode : "hidden"}
        >
          {canvasFloated ? (
            <CanvasPanel
              roomId={roomId}
              onClose={() => {
                setCanvasOpen(false);
                usePanelChromeStore.getState().setPanelMode(roomId, "canvas", "hidden");
              }}
            />
          ) : null}
        </PanelHost>
        <PanelHost
          roomId={roomId}
          panelId="members"
          title="Members"
          present={membersFloated ? roomPanels.members.mode : "hidden"}
        >
          {membersFloated ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <ParticipantStrip roomId={roomId} />
              <div className="shrink-0 border-t border-line">
                <BrigadeAgentPicker
                  roomName={roomDetail?.id ?? roomId}
                  onStartGroup={(a) =>
                    openStartGroup([{ kind: "agent", id: a.id, name: a.name }])
                  }
                />
              </div>
            </div>
          ) : null}
        </PanelHost>
        <PanelHost
          roomId={roomId}
          panelId="tasks"
          title="Tasks"
          present={tasksFloated ? roomPanels.tasks.mode : "hidden"}
        >
          {tasksFloated ? <TasksPanel roomId={roomId} /> : null}
        </PanelHost>
        <PanelHost
          roomId={roomId}
          panelId="threads"
          title="Threads"
          present={threadsFloated ? roomPanels.threads.mode : "hidden"}
        >
          {threadsFloated ? <ThreadsPanel roomId={roomId} /> : null}
        </PanelHost>
      </div>
    </div>
  );
}
