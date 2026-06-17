import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, BellOff, Hash, LogOut, MoreVertical, Pin, Search, UserPlus, Users } from "lucide-react";
import { isMuted, onMutedChange, toggleMute } from "@/utils/mute";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { ChatPanel } from "./ChatPanel";
import { ParticipantStrip } from "./ParticipantStrip";
import { StageView } from "./StageView";
import { VoiceVideoBar } from "./VoiceVideoBar";
import { BrigadeAgentPicker } from "./BrigadeAgentPicker";
import { InviteMembersModal } from "./InviteMembersModal";
import { ThreadPanel } from "./ThreadPanel";
import { SearchPanel } from "./SearchPanel";
import { PinsPanel } from "./PinsPanel";
import { LeaveRoomModal } from "./LeaveRoomModal";

interface RoomViewProps {
  roomId: string;
}

export function RoomView({ roomId }: RoomViewProps) {
  const participantPanelOpen = useAppStore((s) => s.ui.participantPanelOpen);
  const toggleParticipantPanel = useAppStore((s) => s.toggleParticipantPanel);
  const threadMessageId = useAppStore((s) => s.ui.threadMessageId);
  const setThreadMessageId = useAppStore((s) => s.setThreadMessageId);
  const stageAgentId = useAppStore((s) => s.ui.stageAgentId);
  const voiceActive = useAppStore((s) => s.voiceActive);
  const setParticipants = useAppStore((s) => s.setParticipants);
  const removeRoom = useAppStore((s) => s.removeRoom);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const navigate = useNavigate();
  const overflowRef = useRef<HTMLDivElement>(null);
  const [muted, setMuted] = useState(() => isMuted(roomId));
  useEffect(() => {
    setMuted(isMuted(roomId));
    return onMutedChange(() => setMuted(isMuted(roomId)));
  }, [roomId]);

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

  const { data: roomDetail } = useQuery({
    queryKey: ["room", roomId],
    queryFn: () => api.getRoom(roomId),
    staleTime: 30_000,
  });

  // getRoom doesn't include members in our wire-format. Fetch separately so
  // the participant strip + read receipts have someone to render.
  const { data: members } = useQuery({
    queryKey: ["room-members", roomId],
    queryFn: () => api.getRoomMembers(roomId),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (members) {
      setParticipants(roomId, members);
    }
  }, [members, roomId, setParticipants]);

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
  const qc = useQueryClient();

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
      alert("Couldn't rename: " + (e as Error).message);
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
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Room header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-700/50 px-4">
        <div className="flex items-center gap-2 min-w-0">
          <Hash className="h-4 w-4 shrink-0 text-slate-500" />
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
              className="rounded border border-stable-purple/40 bg-slate-950 px-2 py-0.5 text-sm font-semibold text-slate-100 focus:outline-none focus:ring-1 focus:ring-stable-purple"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="truncate text-sm font-semibold text-slate-100 hover:text-stable-purple-light"
              title="Click to rename"
            >
              {displayName}
            </button>
          )}
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
              className="flex-1 rounded border border-stable-purple/40 bg-slate-950 px-2 py-0.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-stable-purple"
            />
          ) : (
            <button
              onClick={() => setEditingTopic(true)}
              className="truncate text-xs text-slate-500 hover:text-slate-300"
              title="Click to edit topic"
            >
              {roomDetail?.description || "Add a topic…"}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setSearchOpen(true)}
            className="rounded-md p-2.5 md:p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Search messages"
            title="Search this channel"
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            onClick={() => setPinsOpen((v) => !v)}
            className="rounded-md p-2.5 md:p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Show pinned messages"
            title="Pinned messages"
          >
            <Pin className="h-4 w-4" />
          </button>
          <button
            onClick={() => setMuted(toggleMute(roomId))}
            className={`rounded-md p-2.5 md:p-1.5 ${muted ? "text-amber-400" : "text-slate-400"} hover:bg-slate-800 hover:text-slate-200`}
            aria-label={muted ? "Unmute channel" : "Mute channel"}
            title={muted ? "Channel muted — click to unmute" : "Mute notifications for this channel"}
          >
            {muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
          </button>
          <button
            onClick={() => setInviteOpen(true)}
            className="flex items-center gap-1 rounded-md bg-stable-purple/20 px-2.5 py-1 text-xs text-stable-purple hover:bg-stable-purple/30"
            aria-label="Invite members"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Invite
          </button>
          <button
            onClick={toggleParticipantPanel}
            className="rounded-md p-2.5 md:p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Toggle participants panel"
            title="Show/hide members & agents"
          >
            <Users className="h-4 w-4" />
          </button>
          <div className="relative" ref={overflowRef}>
            <button
              onClick={() => setOverflowOpen((v) => !v)}
              className="rounded-md p-2.5 md:p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              aria-label="More room actions"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              title="More"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            {overflowOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-lg border border-slate-700/60 bg-slate-900 py-1 shadow-xl"
              >
                <button
                  role="menuitem"
                  onClick={openLeave}
                  disabled={leaving}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
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
              // Open message in thread if it has replies, else just jump
              if (m.thread_id) {
                setThreadMessageId(m.thread_id);
              } else {
                setThreadMessageId(m.id);
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

      <AnimatePresence>
        {voiceActive && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="shrink-0 overflow-hidden"
          >
            <VoiceVideoBar roomId={roomId} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex min-h-0 flex-1">
        {(participantPanelOpen || pinsOpen || threadMessageId) && (
          <div
            className="fixed inset-0 z-30 bg-slate-950/60 md:hidden"
            aria-hidden="true"
            onClick={() => {
              if (participantPanelOpen) toggleParticipantPanel();
              setPinsOpen(false);
              setThreadMessageId(null);
            }}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <AnimatePresence>
            {stageAgentId && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 300, opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="shrink-0 overflow-hidden border-b border-slate-700/50"
              >
                <StageView agentId={stageAgentId} roomId={roomId} />
              </motion.div>
            )}
          </AnimatePresence>

          <ChatPanel roomId={roomId} />
        </div>

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

        <AnimatePresence>
          {participantPanelOpen && (
            <motion.div
              initial={{ x: "100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "100%", opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              className="fixed inset-y-0 right-0 z-40 flex w-[min(85vw,260px)] flex-col overflow-hidden border-l border-slate-700/50 bg-slate-900 shadow-2xl md:static md:z-auto md:w-auto md:bg-transparent md:shadow-none"
            >
              <ParticipantStrip roomId={roomId} />
              <div className="border-t border-slate-700/50 shrink-0">
                <BrigadeAgentPicker roomName={roomDetail?.name ?? roomId} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
