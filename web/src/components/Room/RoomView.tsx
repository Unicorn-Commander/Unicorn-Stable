import { lazy, Suspense, useEffect, useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { Hash, Lock, Plus } from "lucide-react";
import { identityFor } from "@/lib/identity";
import { api, type ApiError } from "@/services/api";
import { ws } from "@/services/websocket";
import { useAppStore } from "@/stores/appStore";
import { handleArtifactEvent, useCanvasStore } from "@/stores/canvasStore";
import { coerceArtifactEvent } from "@/lib/roomDataProtocol";
import { useKnowledgeStore } from "@/stores/knowledgeStore";
import {
  PANEL_RESIZE_HANDLE_CLASS,
  useIsDesktop,
  usePanelResize,
} from "@/hooks/usePanelResize";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { CallRoomLayout } from "./CallRoomLayout";
import { LiveCallBanner } from "./LiveCallBanner";
import { ParticipantStrip } from "./ParticipantStrip";
import { BrigadeAgentPicker } from "./BrigadeAgentPicker";
import { RoomHeader } from "./RoomHeader";
import { SeatSettings } from "./SeatSettings";
import { useCrew } from "@/hooks/useCrew";
import { findSeatMembers, seatChipLabel, shouldShowModelSwitcher } from "@/lib/seatSettings";
import { isHubRoom, readRoomSeat } from "@/lib/crew";
import { InviteMembersModal } from "./InviteMembersModal";
import { GuestAccessModal } from "./GuestAccessModal";
import { VoiceSettingsModal } from "./VoiceSettingsModal";
import { RecordingSettingsModal } from "./RecordingSettingsModal";
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
  const [recordingSettingsOpen, setRecordingSettingsOpen] = useState(false);
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
  const rosterAgents = useAppStore((s) => s.agents);
  const [searchOpen, setSearchOpen] = useState(false);
  // The runner seat in this room (Nav v3 C2), matched against the crew list:
  // RoomResponse.agents[] carries no backend. A 409 on the seat write means
  // the server disagrees — the chip goes and the Brigade switcher returns.
  const { crew } = useCrew();
  const currentParticipantId = useAppStore((s) => s.currentParticipantId);
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  const [seatRefused, setSeatRefused] = useState(false);
  const [seatOpenFor, setSeatOpenFor] = useState<string | null>(null);
  const [seatRequested, setSeatRequested] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  // RoomView is not keyed by room: every per-room seat flag resets here, or a
  // `?seat=1` that found no seat would open the popover in the next room.
  useEffect(() => {
    setSeatRefused(false);
    setSeatOpenFor(null);
    setSeatRequested(false);
  }, [roomId]);
  // `/c/<id>?seat=1` (the crew row's Settings) opens the popover once.
  useEffect(() => {
    if (searchParams.get("seat") !== "1") return;
    setSeatRequested(true);
    const next = new URLSearchParams(searchParams);
    next.delete("seat");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

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

  // Every runner seat in the room, yours first: one chip each (metadata.seats).
  const seatMatches = useMemo(
    () => (seatRefused ? [] : findSeatMembers(roomDetail, members, crew)),
    [seatRefused, roomDetail, members, crew],
  );
  // Mode writes need room owner/admin (the server's ladder); read the caller's
  // own row, the only reliable "this is me".
  const myRole = members?.find((m) => m.is_self)?.role ?? null;
  const canEditMode = myRole === "owner" || myRole === "admin";
  // The Brigade switcher stays while any agent member is not a seat.
  const showModelSwitcher = seatRefused || shouldShowModelSwitcher(roomDetail, members, crew);
  useEffect(() => {
    if (!seatRequested) return;
    const first = seatMatches.find((match) => match.editable);
    if (!first) return;
    setSeatRequested(false);
    setSeatOpenFor(first.member.agent_id);
  }, [seatRequested, seatMatches]);
  // Phones: one More entry per seat of yours, named when there are several.
  const seatMenus = seatMatches
    .filter((match) => match.editable)
    .map((match) => {
      const label =
        seatChipLabel(
          readRoomSeat(roomDetail, match.member.agent_id),
          match.member.seat_capabilities,
        ) ?? "seat default";
      return {
        key: match.member.agent_id,
        label: seatMatches.length > 1 ? `${match.member.display_name} · ${label}` : label,
        onOpen: () => setSeatOpenFor(match.member.agent_id),
      };
    });
  const renderSeatChips = () =>
    seatMatches.map((match) => (
      <SeatSettings
        key={match.member.agent_id}
        roomId={roomId}
        room={roomDetail}
        match={match}
        open={seatOpenFor === match.member.agent_id}
        onOpenChange={(next) => setSeatOpenFor(next ? match.member.agent_id : null)}
        onNoSeat={() => setSeatRefused(true)}
        canEditMode={canEditMode}
        labelled={seatMatches.length > 1}
      />
    ));

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
  // "New conversation" only on YOUR hub (or a thread under it): the server's
  // hub test, not the room type alone. "You" is the participant id the socket
  // acknowledged, or — the one marker that needs no socket — the members
  // payload's own `is_self` row.
  const selfMember = members?.find((m) => m.is_self);
  const selfIds = [
    currentParticipantId,
    currentUserId,
    selfMember?.participant_id,
    selfMember?.id,
    selfMember?.user_id,
  ];
  const hubForNewConversation =
    roomDetail && isHubRoom(roomDetail, selfIds)
      ? roomDetail
      : parentRoom && isHubRoom(parentRoom, selfIds)
        ? parentRoom
        : null;
  const dmAgentId = roomDetail?.brigade_agent_id ?? null;
  const dmAgent = dmAgentId
    ? rosterAgents.find((a) => a.id === dmAgentId)
    : undefined;
  // A runner seat is not in the Brigade roster; the room's counterpart
  // carries its name, so the header never falls back to the raw agent id.
  const dmAgentName =
    dmAgent?.display_name ||
    dmAgent?.name ||
    roomDetail?.counterpart?.display_name ||
    dmAgentId ||
    "";
  const roomAgentIdent = dmAgentId ? identityFor(dmAgentId, dmAgentName) : null;
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
  const showRecordingSettings = canEditVoiceSettings(members);
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
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="room-view">
      <RoomHeader
        roomId={roomId}
        membersOpen={participantPanelOpen}
        onToggleMembers={toggleParticipants}
        showTasks={!!roomDetail?.project_number}
        showInvite={!isDm}
        onInvite={() => useConversationUi.getState().openInviteSheet(roomId)}
        onNewThread={() =>
          void beginThread({
            roomId: roomDetail?.parent_room_id || roomId,
            navigate,
          })
        }
        pinsOpen={pinsOpen}
        onTogglePins={togglePins}
        canvasOpen={canvasOpen}
        canvasCount={canvasCount}
        canvasUnseen={canvasUnseen}
        onToggleCanvas={toggleCanvas}
        knowledgeOpen={knowledgeOpen}
        onToggleKnowledge={toggleKnowledge}
        onOpenSearch={() => setSearchOpen(true)}
        showRename={!isDm}
        onStartRename={() => setEditingName(true)}
        showGuestAccess={!isDm && isRoomOwner}
        onOpenGuestAccess={() => setGuestAccessOpen(true)}
        showRecordingSettings={showRecordingSettings}
        onOpenRecordingSettings={() => setRecordingSettingsOpen(true)}
        showVoiceSettings={showVoiceSettings}
        onOpenVoiceSettings={() => setVoiceSettingsOpen(true)}
        showStartGroup={isDm}
        startGroupLabel={dmPeerLabel}
        onStartGroup={() => openStartGroup()}
        onLeave={openLeave}
        leaving={leaving}
        roomAgent={
          dmAgentId && roomAgentIdent
            ? {
                id: dmAgentId,
                name: dmAgentName,
                color: roomAgentIdent.color,
                text: roomAgentIdent.text,
              }
            : null
        }
        onStartGroupWithAgent={(agent) =>
          openStartGroup([{ kind: "agent", id: agent.id, name: agent.name }])
        }
        // Your hub, or a thread under it: a fresh conversation with this agent
        // is a thread under the hub, nested in the sidebar (Nav v3 §2.2).
        onNewConversation={
          hubForNewConversation
            ? () => void beginThread({ roomId: hubForNewConversation.id, navigate })
            : undefined
        }
        // A seat room's brain is the chip's popover; the Brigade switcher
        // stays while a house agent is in the room too.
        showModelSwitcher={showModelSwitcher}
        seatMenus={seatMenus}
      >
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
              {renderSeatChips()}
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
          {/* Seats in a channel or group: the same chips beside the name. */}
          {renderSeatChips()}
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
      </RoomHeader>

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
      {/* Sits above the composer's call buttons, and leaves while the seat
          sheet is open — it painted over the sheet's last rows. */}
      {(roomDetail?.type === "agent_hub" ||
        roomDetail?.type === "channel" ||
        !!roomDetail?.parent_room_id) &&
        !seatOpenFor && (
        <button
          type="button"
          onClick={() =>
            void beginThread({
              roomId: roomDetail?.parent_room_id || roomId,
              navigate,
            })
          }
          className="focus-ring fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-stable-purple text-white shadow-pop md:hidden"
          aria-label="New thread"
          data-testid="room-fab"
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
        {recordingSettingsOpen && (
          <RecordingSettingsModal
            roomId={roomId}
            roomName={displayName}
            onClose={() => setRecordingSettingsOpen(false)}
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
