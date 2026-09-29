import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  Activity,
  Bell,
  BellOff,
  Bookmark,
  ChevronDown,
  Circle,
  Cpu,
  Database,
  ExternalLink,
  Keyboard,
  LayoutTemplate,
  ListTree as ListTreeIcon,
  Link2,
  ListChecks,
  ListTree,
  LogOut,
  MessageSquarePlus,
  Mic,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Phone,
  Pin,
  Plus,
  Search,
  Settings,
  UserPlus,
  UserRound,
  Users,
  Video,
} from "lucide-react";
import { RecordMenu } from "@/components/Call/RecordMenu";
import { useDirectCall } from "@/hooks/useDirectCall";
import { useMenuKeyboard } from "@/hooks/useMenuKeyboard";
import { useRoomPanels } from "@/hooks/useRoomPanels";
import { popPanel } from "@/lib/callLayoutActions";
import { requestOpenActivity } from "@/lib/shellEvents";
import { logout } from "@/services/auth";
import { useAppStore } from "@/stores/appStore";
import { usePanelChromeStore } from "@/stores/panelChromeStore";
import type { RoomPanelId } from "@/stores/panelRegistry";
import { isMuted, onMutedChange, toggleMute } from "@/utils/mute";
import { PhotoNudge, useShowPhotoNudge } from "@/components/ui/Identity";
import { BrigadeAgentPicker } from "./BrigadeAgentPicker";
import { ModelSwitcher } from "./ModelSwitcher";

/**
 * The room's only bar. 44px: identity on the left, then Call, Record,
 * Members, Threads, Pop out, and More. The app bar unmounts while a room
 * is open, so account actions that used to live there sit in More on desktop.
 */

const POP_TARGETS: { id: RoomPanelId; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "members", label: "Members" },
  { id: "threads", label: "Threads" },
  { id: "canvas", label: "Canvas" },
  { id: "tasks", label: "Tasks" },
  { id: "transcript", label: "Transcript" },
];

// The display utility is kept apart: a button that hides below `sm` says
// `hidden sm:inline-flex` itself — `inline-flex` in the shared string would
// win over `hidden` and the button would still be drawn on a phone.
const ICON_BTN_BASE =
  "focus-ring h-10 w-10 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100";
const ICON_BTN = `inline-flex ${ICON_BTN_BASE}`;
const ICON_BTN_DESKTOP = `hidden sm:inline-flex ${ICON_BTN_BASE}`;

export interface RoomHeaderAgent {
  id: string;
  name: string;
  color: string;
  text: string;
}

export interface RoomHeaderProps {
  roomId: string;
  children: ReactNode;
  membersOpen: boolean;
  onToggleMembers: () => void;
  showTasks: boolean;
  showInvite: boolean;
  onInvite: () => void;
  onNewThread: () => void;
  pinsOpen: boolean;
  onTogglePins: () => void;
  canvasOpen: boolean;
  canvasCount: number;
  canvasUnseen: number;
  onToggleCanvas: () => void;
  knowledgeOpen: boolean;
  onToggleKnowledge: () => void;
  onOpenSearch: () => void;
  showRename: boolean;
  onStartRename: () => void;
  showGuestAccess: boolean;
  onOpenGuestAccess: () => void;
  showRecordingSettings: boolean;
  onOpenRecordingSettings: () => void;
  showVoiceSettings: boolean;
  onOpenVoiceSettings: () => void;
  showStartGroup: boolean;
  startGroupLabel: string;
  onStartGroup: () => void;
  onLeave: () => void;
  leaving: boolean;
  roomAgent: RoomHeaderAgent | null;
  onStartGroupWithAgent: (agent: { id: string; name: string }) => void;
  /**
   * Agent hubs (Nav v3 §2.2): "New conversation" starts a thread under the
   * hub — ChatGPT's "New chat", with the contact staying one contact.
   */
  onNewConversation?: () => void;
  /**
   * The Brigade model switcher in More. Off on rooms with a runner-backed
   * seat, where the seat chip's popover is the brain (C2) and this menu
   * would do nothing.
   */
  showModelSwitcher?: boolean;
  /**
   * Phones: the seat chip does not fit the 44px row, so More carries a
   * "Brain · Fable 5.1 · high" entry per seat of yours that opens the same
   * popover.
   */
  seatMenus?: Array<{ key: string; label: string; onOpen: () => void }>;
}

export function RoomHeader({
  roomId,
  children,
  membersOpen,
  onToggleMembers,
  showTasks,
  showInvite,
  onInvite,
  onNewThread,
  pinsOpen,
  onTogglePins,
  canvasOpen,
  canvasCount,
  canvasUnseen,
  onToggleCanvas,
  knowledgeOpen,
  onToggleKnowledge,
  onOpenSearch,
  showRename,
  onStartRename,
  showGuestAccess,
  onOpenGuestAccess,
  showRecordingSettings,
  onOpenRecordingSettings,
  showVoiceSettings,
  onOpenVoiceSettings,
  showStartGroup,
  startGroupLabel,
  onStartGroup,
  onLeave,
  leaving,
  roomAgent,
  onStartGroupWithAgent,
  onNewConversation,
  showModelSwitcher = true,
  seatMenus = [],
}: RoomHeaderProps) {
  const sidebarOpen = useAppStore((s) => s.ui.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setPeopleDrawerOpen = useAppStore((s) => s.setPeopleDrawerOpen);
  const setSavedOpen = useAppStore((s) => s.setSavedOpen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const openSettings = useAppStore((s) => s.openSettings);
  const toggleCheatsheet = useAppStore((s) => s.toggleCheatsheet);
  const showPhotoNudge = useShowPhotoNudge();
  const currentUser = useAppStore((s) => s.currentUser);
  const roomPanels = useRoomPanels(roomId);
  const { startCall } = useDirectCall();

  const [callOpen, setCallOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [agentSwitchOpen, setAgentSwitchOpen] = useState(false);
  const [muted, setMuted] = useState(() => isMuted(roomId));

  const callRef = useRef<HTMLDivElement>(null);
  const callBtnRef = useRef<HTMLButtonElement>(null);
  const callMenuRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popBtnRef = useRef<HTMLButtonElement>(null);
  const popMenuRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMuted(isMuted(roomId));
    return onMutedChange(() => setMuted(isMuted(roomId)));
  }, [roomId]);

  useEffect(() => {
    if (!callOpen && !popOpen && !overflowOpen && !agentSwitchOpen) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (callRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      if (overflowRef.current?.contains(target)) return;
      setCallOpen(false);
      setPopOpen(false);
      setOverflowOpen(false);
      setAgentSwitchOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [callOpen, popOpen, overflowOpen, agentSwitchOpen]);

  useMenuKeyboard(callOpen, callMenuRef, callBtnRef, () => setCallOpen(false));
  useMenuKeyboard(popOpen, popMenuRef, popBtnRef, () => setPopOpen(false));
  useMenuKeyboard(overflowOpen, overflowMenuRef, overflowBtnRef, () =>
    setOverflowOpen(false),
  );

  function closeMenus() {
    setCallOpen(false);
    setPopOpen(false);
    setOverflowOpen(false);
    setAgentSwitchOpen(false);
  }

  function run(fn: () => void) {
    closeMenus();
    fn();
  }

  function toggleThreads() {
    usePanelChromeStore.getState().setPanelMode(
      roomId,
      "threads",
      roomPanels.threads.mode === "hidden" ? "docked" : "hidden",
    );
  }

  function toggleTasks() {
    usePanelChromeStore.getState().setPanelMode(
      roomId,
      "tasks",
      roomPanels.tasks.mode === "hidden" ? "docked" : "hidden",
    );
  }

  function pop(id: RoomPanelId) {
    setPopOpen(false);
    if (popPanel(roomId, id)) return;
    useAppStore.getState().pushToast({
      title: "Couldn't pop that out",
      body: "Allow pop-ups for Stable, or open the panel and try again.",
      kind: "error",
    });
  }

  const threadsOpen = roomPanels.threads.mode !== "hidden";
  const tasksOpen = roomPanels.tasks.mode !== "hidden";
  const anyPopped = POP_TARGETS.some((item) => roomPanels[item.id].mode === "popped");
  const canvasDot = !canvasOpen && (canvasCount > 0 || canvasUnseen > 0);

  return (
    <header
      data-testid="room-header"
      className="relative z-30 flex h-11 max-h-11 min-w-0 shrink-0 items-center justify-between gap-1 border-b border-line px-2 sm:px-4"
    >
      {/* Glass paint lives on an inner layer: backdrop-filter on the header
          itself would make it the containing block for fixed descendants. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-stable-glass backdrop-blur-xl"
      />
      <div className="relative flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
        <button
          type="button"
          onClick={toggleSidebar}
          className={clsx(ICON_BTN, "-ml-1")}
          aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        >
          {sidebarOpen ? (
            <PanelLeftClose className="h-5 w-5" />
          ) : (
            <PanelLeftOpen className="h-5 w-5" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setPeopleDrawerOpen(true)}
          className={clsx(ICON_BTN, "md:hidden")}
          aria-label="People"
          title="People"
        >
          <UserRound className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      </div>

      <div
        data-testid="room-header-actions"
        className="relative flex shrink-0 items-center gap-0.5"
      >
        {/* Desktop only: on a phone the 44px row is full and the FAB inside
            a hub already starts a thread, so the entry sits in More there. */}
        {onNewConversation && (
          <button
            type="button"
            onClick={onNewConversation}
            className="focus-ring hidden h-10 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-slate-200 hover:bg-white/[0.06] sm:inline-flex"
            aria-label="New conversation"
            title="New conversation — a fresh thread with this agent"
            data-testid="hub-new-conversation"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            <span>New conversation</span>
          </button>
        )}
        <div className="relative" ref={callRef}>
          <button
            ref={callBtnRef}
            type="button"
            onClick={() => {
              setCallOpen((open) => !open);
              setPopOpen(false);
              setOverflowOpen(false);
              setAgentSwitchOpen(false);
            }}
            className="focus-ring inline-flex h-10 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-slate-200 hover:bg-white/[0.06]"
            aria-label="Call"
            aria-haspopup="menu"
            aria-expanded={callOpen}
          >
            <Phone className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Call</span>
            <ChevronDown className="h-3 w-3 text-slate-500" />
          </button>
          {callOpen && (
            <div
              ref={callMenuRef}
              role="menu"
              aria-label="Call"
              className="glass-heavy absolute right-0 top-full z-50 mt-1 w-36 rounded-xl p-1 shadow-pop"
            >
              <button
                type="button"
                role="menuitem"
                className="focus-ring flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/[0.06]"
                onClick={() =>
                  run(() => {
                    void startCall(roomId, { video: false });
                  })
                }
              >
                <Phone className="h-3.5 w-3.5" /> Voice
              </button>
              <button
                type="button"
                role="menuitem"
                className="focus-ring flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/[0.06]"
                onClick={() =>
                  run(() => {
                    void startCall(roomId, { video: true });
                  })
                }
              >
                <Video className="h-3.5 w-3.5" /> Video
              </button>
            </div>
          )}
        </div>

        <RecordMenu
          roomId={roomId}
          placement="down"
          density="header"
          testId="room-header-record"
        />

        {/* Phones keep the row to Call and More so the name can be read;
            Members and Threads move into More there, Pop out is desktop. */}
        <button
          type="button"
          onClick={onToggleMembers}
          className={clsx(ICON_BTN_DESKTOP, membersOpen && "bg-white/[0.08] text-slate-100")}
          aria-label="Members"
          aria-pressed={membersOpen}
          title="Members"
        >
          <Users className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={toggleThreads}
          className={clsx(ICON_BTN_DESKTOP, threadsOpen && "bg-white/[0.08] text-slate-100")}
          aria-label="Threads"
          aria-pressed={threadsOpen}
          title="Threads"
        >
          <ListTree className="h-4 w-4" />
        </button>
        <div className="relative hidden sm:block" ref={popRef}>
          <button
            ref={popBtnRef}
            type="button"
            onClick={() => {
              setPopOpen((open) => !open);
              setCallOpen(false);
              setOverflowOpen(false);
              setAgentSwitchOpen(false);
            }}
            className={clsx(ICON_BTN, anyPopped && "bg-white/[0.08] text-slate-100")}
            aria-label="Pop out"
            aria-haspopup="menu"
            aria-expanded={popOpen}
            aria-pressed={anyPopped}
            title="Pop out"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
          {popOpen && (
            <div
              ref={popMenuRef}
              role="menu"
              aria-label="Pop out"
              className="glass-heavy absolute right-0 top-full z-50 mt-1 w-48 rounded-xl py-1 shadow-pop"
            >
              {POP_TARGETS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="focus-ring flex w-full items-center px-3 py-2 text-left text-sm text-slate-200 hover:bg-white/[0.06]"
                  onClick={() => pop(item.id)}
                >
                  Pop out {item.label.toLowerCase()}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="relative" ref={overflowRef}>
          <button
            ref={overflowBtnRef}
            type="button"
            onClick={() => {
              setOverflowOpen((open) => !open);
              setCallOpen(false);
              setPopOpen(false);
              setAgentSwitchOpen(false);
            }}
            className={clsx(ICON_BTN, overflowOpen && "bg-white/[0.08] text-slate-100")}
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
              className="glass-heavy absolute right-0 top-full z-50 mt-1 max-h-[min(70vh,32rem)] w-72 overflow-y-auto rounded-xl py-1 shadow-pop"
            >
              {showModelSwitcher && (
                <>
                  <div className="px-3 py-1.5">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      Model
                    </div>
                    <ModelSwitcher roomId={roomId} embedded className="max-w-full" />
                  </div>
                  <div className="my-1 h-px bg-white/[0.06]" />
                </>
              )}
              <MenuItem onClick={() => run(onOpenSearch)}>
                <Search className="h-4 w-4" /> Search
              </MenuItem>
              <MenuItem onClick={() => run(onTogglePins)}>
                <Pin className="h-4 w-4" />
                {pinsOpen ? "Hide pinned messages" : "Pinned messages"}
              </MenuItem>
              <MenuItem onClick={() => run(onToggleCanvas)}>
                <LayoutTemplate className="h-4 w-4" />
                {canvasOpen ? "Hide canvas" : "Open canvas"}
                {canvasDot && (
                  <span className="ml-auto rounded-full bg-stable-purple/20 px-1.5 py-0.5 text-[10px] text-stable-purple-light">
                    {canvasUnseen > 0 ? `${canvasUnseen} new` : canvasCount}
                  </span>
                )}
              </MenuItem>
              <MenuItem onClick={() => run(onToggleKnowledge)}>
                <Database className="h-4 w-4" />
                {knowledgeOpen ? "Hide knowledge" : "Knowledge bases"}
              </MenuItem>
              <MenuItem onClick={() => run(() => setMuted(toggleMute(roomId)))}>
                {muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                {muted ? "Unmute room" : "Mute room"}
              </MenuItem>
              <MenuItem onClick={() => run(onToggleMembers)} className="sm:hidden" data-testid="phone-members">
                <Users className="h-4 w-4" />
                {membersOpen ? "Hide members" : "Members"}
              </MenuItem>
              <MenuItem onClick={() => run(toggleThreads)} className="sm:hidden" data-testid="phone-threads">
                <ListTreeIcon className="h-4 w-4" />
                {threadsOpen ? "Hide threads" : "Threads"}
              </MenuItem>
              {seatMenus.map((entry) => (
                <MenuItem
                  key={entry.key}
                  onClick={() => run(entry.onOpen)}
                  className="sm:hidden"
                  data-testid="seat-menu-entry"
                >
                  <Cpu className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate">Brain · {entry.label}</span>
                </MenuItem>
              ))}
              {onNewConversation && (
                <MenuItem
                  onClick={() => run(onNewConversation)}
                  className="sm:hidden"
                  data-testid="hub-new-conversation-menu"
                >
                  <MessageSquarePlus className="h-4 w-4" /> New conversation
                </MenuItem>
              )}
              <MenuItem onClick={() => run(onNewThread)}>
                <Plus className="h-4 w-4" /> New thread
              </MenuItem>
              {showTasks && (
                <MenuItem onClick={() => run(toggleTasks)}>
                  <ListChecks className="h-4 w-4" />
                  {tasksOpen ? "Hide tasks" : "Tasks"}
                </MenuItem>
              )}
              {showInvite && (
                <MenuItem onClick={() => run(onInvite)}>
                  <UserPlus className="h-4 w-4" /> Invite members
                </MenuItem>
              )}
              {roomAgent && (
                <MenuItem
                  onClick={() => {
                    setOverflowOpen(false);
                    setAgentSwitchOpen(true);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: roomAgent.color }}
                  />
                  <span className="min-w-0 truncate">Switch agent · {roomAgent.name}</span>
                </MenuItem>
              )}
              {showRename && (
                <MenuItem onClick={() => run(onStartRename)} className="md:hidden">
                  <Pencil className="h-4 w-4" /> Rename channel
                </MenuItem>
              )}
              {showGuestAccess && (
                <MenuItem onClick={() => run(onOpenGuestAccess)}>
                  <Link2 className="h-4 w-4" /> Guest access…
                </MenuItem>
              )}
              {showRecordingSettings && (
                <MenuItem onClick={() => run(onOpenRecordingSettings)}>
                  <Circle className="h-4 w-4 fill-rose-500 text-rose-400" />
                  Recording…
                </MenuItem>
              )}
              {showVoiceSettings && (
                <MenuItem onClick={() => run(onOpenVoiceSettings)}>
                  <Mic className="h-4 w-4" /> Voice settings…
                </MenuItem>
              )}
              {showStartGroup && (
                <MenuItem onClick={() => run(onStartGroup)}>
                  <UserPlus className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate">
                    Start a group with {startGroupLabel}…
                  </span>
                </MenuItem>
              )}
              <div className="my-1 h-px bg-white/[0.06]" />
              <MenuItem
                onClick={() => run(onLeave)}
                disabled={leaving}
                className="text-rose-400 hover:bg-rose-500/10"
              >
                <LogOut className="h-4 w-4" />
                {leaving ? "Leaving…" : "Leave room"}
              </MenuItem>
              <div className="hidden md:block">
                <div className="my-1 h-px bg-white/[0.06]" />
                {showPhotoNudge && (
                  <div className="px-3 py-1.5">
                    <PhotoNudge onAdd={() => run(() => openSettings("appearance"))} />
                  </div>
                )}
                {currentUser && (
                  <p className="truncate px-3 py-1 text-xs text-slate-500">
                    {currentUser.displayName}
                  </p>
                )}
                <MenuItem onClick={() => run(() => setPeopleDrawerOpen(true))}>
                  <UserRound className="h-4 w-4" /> People
                </MenuItem>
                <MenuItem onClick={() => run(requestOpenActivity)}>
                  <Activity className="h-4 w-4" /> Activity Center
                </MenuItem>
                <MenuItem onClick={() => run(() => setSavedOpen(true))}>
                  <Bookmark className="h-4 w-4" /> Saved messages
                </MenuItem>
                <MenuItem onClick={() => run(toggleSettings)}>
                  <Settings className="h-4 w-4" /> Settings
                </MenuItem>
                <MenuItem onClick={() => run(toggleCheatsheet)}>
                  <Keyboard className="h-4 w-4" /> Keyboard shortcuts
                </MenuItem>
                <MenuItem
                  onClick={() => run(() => logout())}
                  className="text-rose-400 hover:bg-rose-500/10"
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </MenuItem>
              </div>
            </div>
          )}
          {agentSwitchOpen && roomAgent && (
            <>
              <div
                className="fixed inset-0 z-40"
                aria-hidden="true"
                onClick={() => setAgentSwitchOpen(false)}
              />
              <div className="absolute right-0 top-full z-50 mt-1 w-80">
                <BrigadeAgentPicker
                  roomName={roomId}
                  defaultOpen
                  onInvited={() => setAgentSwitchOpen(false)}
                  onStartGroup={(agent) => {
                    setAgentSwitchOpen(false);
                    onStartGroupWithAgent(agent);
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function MenuItem({
  onClick,
  children,
  className,
  disabled,
  "data-testid": testId,
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  "data-testid"?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={clsx(
        "focus-ring flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11",
        className,
      )}
    >
      {children}
    </button>
  );
}
