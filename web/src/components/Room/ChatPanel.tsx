import { useRef, useEffect, useState, useCallback } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useChat } from "@/hooks/useChat";
import { usePresence } from "@/hooks/usePresence";
import { useAppStore } from "@/stores/appStore";
import { ws } from "@/services/websocket";
import { Avatar } from "@/components/Avatar";
import { StableMark } from "@/components/StableMark";
import { identityFor } from "@/lib/identity";
import { EMPTY_MEMBERS, EMPTY_READ_RECEIPTS } from "@/stores/selectors";
import { MessageBubble } from "./MessageBubble";

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatDayLabel(d: Date): string {
  const today = new Date();
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yest)) return "Yesterday";
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}
import { MessageInput } from "./MessageInput";

interface ChatPanelProps {
  roomId: string;
  /** Opens the room's invite flow — wired from RoomView; used by the empty
   * channel's "Invite an agent" chip. */
  onInviteAgent?: () => void;
}

export function ChatPanel({ roomId, onInviteAgent }: ChatPanelProps) {
  const { messages, hasMore, loading, sendMessage, loadMore, editMessage, deleteMessage, retryMessage, resync } =
    useChat(roomId);
  const { typingUsers, sendTypingIndicator } = usePresence(roomId);
  const currentUser = useAppStore((s) => s.currentUser);
  const [editFocusId, setEditFocusId] = useState<string | null>(null);
  const [editTick, setEditTick] = useState(0);
  const setThreadMessageId = useAppStore((s) => s.setThreadMessageId);
  const readReceipts = useAppStore(
    (s) => s.readReceipts[roomId] ?? EMPTY_READ_RECEIPTS,
  );
  const participants = useAppStore(
    (s) => s.participants[roomId] ?? EMPTY_MEMBERS,
  );
  // Governed model override: when this room overrides the agent's model, agent
  // replies carry a visible "via <model>" chip (transparency per the
  // badged-override pattern). Model list is only fetched while overridden.
  const modelOverride = useAppStore((s) => s.modelOverrides[roomId]);
  const { data: chatModels } = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => api.getModels(),
    staleTime: 5 * 60_000,
    enabled: !!modelOverride,
  });
  const overrideModelLabel = modelOverride
    ? (chatModels?.find((m) => m.id === modelOverride)?.label ?? modelOverride)
    : null;
  // Room-aware composer placeholder ("Message #general" / "Message Majik").
  const roomForLabel = useAppStore((s) =>
    s.rooms.find((r) => r.id === roomId),
  );
  const composerPlaceholder = roomForLabel
    ? roomForLabel.type === "channel"
      ? `Message #${roomForLabel.display_name || roomForLabel.name}`
      : `Message ${(roomForLabel.display_name || roomForLabel.name).replace(/^chat with /i, "")}`
    : undefined;
  // If a moderator muted me in this room, replace the composer with a notice
  // (the server also blocks the post; this just avoids a dead-end 403).
  const iAmMuted = participants.find((p) => p.is_self)?.is_muted === true;

  // Optimistic "agent is working" feedback. The moment you send into a room
  // with an agent, show a "thinking…" line immediately rather than waiting on
  // the backend's agent_typing event (which can lag or be missed). It hands off
  // to the real typing/streaming display and clears once the agent's reply
  // lands (a new agent message) or after a safety timeout.
  const agentMembers = participants.filter((p) => p.participant_type === "agent");
  const [awaitingAgentSince, setAwaitingAgentSince] = useState<number | null>(null);
  const agentLabel =
    agentMembers.length === 1
      ? agentMembers[0]?.display_name ?? "The agent"
      : "An agent";
  // Identity hue for the "thinking…" dot — single-agent rooms wear their
  // resident's color; multi-agent rooms fall back to the first resident's.
  const firstAgent = agentMembers[0];
  const thinkingIdent = identityFor(
    firstAgent?.participant_id || firstAgent?.user_id || firstAgent?.display_name,
    firstAgent?.display_name,
  );

  useEffect(() => {
    if (awaitingAgentSince === null) return;
    const last = messages[messages.length - 1];
    if (
      last &&
      last.sender_type === "agent" &&
      new Date(last.created_at).getTime() >= awaitingAgentSince - 1000
    ) {
      setAwaitingAgentSince(null);
      return;
    }
    const t = window.setTimeout(() => setAwaitingAgentSince(null), 150_000);
    return () => window.clearTimeout(t);
  }, [awaitingAgentSince, messages]);

  // Safety net: while we're waiting on an agent reply, poll a merge-refetch
  // every few seconds so the answer shows up even if its live WS event was
  // missed (e.g. the socket wasn't yet subscribed to a brand-new room). The
  // effect above clears `awaitingAgentSince` — and this poll — as soon as the
  // reply lands.
  useEffect(() => {
    if (awaitingAgentSince === null) return;
    const id = window.setInterval(() => {
      void resync();
    }, 5_000);
    return () => window.clearInterval(id);
  }, [awaitingAgentSince, resync]);

  // Slack-style "New messages" divider: snapshot the last-read point ONCE per
  // room open — before the mark_read effect below tells the server we've read
  // everything — then freeze it, so the divider never moves or vanishes while
  // the user sits in the room. Resolution is deferred to the first render that
  // has history (the initial page loads async). Preferred source is our own
  // participant's last_read_at (live receipt first, then the member row): it
  // stays correct through the stale-unread_count window after a quick
  // leave/re-enter, since rooms[].unread_count only resets on the 60s refetch.
  const unreadAnchorRef = useRef<{ roomId: string; resolved: boolean }>({
    roomId,
    resolved: false,
  });
  const [unreadAnchorId, setUnreadAnchorId] = useState<string | null>(null);
  useEffect(() => {
    if (unreadAnchorRef.current.roomId !== roomId) {
      unreadAnchorRef.current = { roomId, resolved: false };
      setUnreadAnchorId(null);
    }
    if (unreadAnchorRef.current.resolved || loading || messages.length === 0)
      return;
    unreadAnchorRef.current.resolved = true;

    const state = useAppStore.getState();
    const self = (state.participants[roomId] ?? []).find((p) => p.is_self);
    const selfPid = self?.participant_id || self?.user_id || "";
    const lastReadAt =
      (selfPid ? state.readReceipts[roomId]?.[selfPid] : undefined) ||
      self?.last_read_at ||
      null;
    // Own optimistic sends can never anchor the divider (and persisted own
    // messages have selfPid as sender — currentUser.id is the Keycloak id and
    // never matches server sender_ids, so it only guards optimistic copies).
    const history = messages.filter((m) => !m.id.startsWith("optimistic-"));
    let anchor: (typeof history)[number] | undefined;
    if (lastReadAt) {
      const readUpTo = new Date(lastReadAt).getTime();
      anchor = history.find(
        (m) =>
          new Date(m.created_at).getTime() > readUpTo &&
          m.sender_id !== currentUser?.id &&
          (!selfPid || m.sender_id !== selfPid),
      );
    } else {
      // No read receipt yet (participants may not have loaded): count back the
      // room's cold-load unread_count from the end of the fetched history.
      const unread = state.rooms.find((r) => r.id === roomId)?.unread_count ?? 0;
      if (unread > 0) {
        anchor = history[Math.max(0, history.length - unread)];
      }
    }
    if (anchor) setUnreadAnchorId(anchor.id);
  }, [roomId, loading, messages, currentUser?.id]);

  // Send mark_read for the latest message whenever (a) the room becomes
  // active, (b) a new message arrives while we're at bottom + visible.
  useEffect(() => {
    if (messages.length === 0) return;
    if (document.visibilityState !== "visible") return;
    const last = messages[messages.length - 1];
    if (!last) return;
    ws.send("mark_read", { room_id: roomId, message_id: last.id });
  }, [roomId, messages.length]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  // Mirror of isAtBottomRef: the ref drives scroll decisions without
  // re-rendering, but the jump pill needs a render when it flips.
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Others' messages that landed while scrolled up — the pill's count.
  const [newWhileScrolledUp, setNewWhileScrolledUp] = useState(0);
  const prevMessageCountRef = useRef(0);
  const prevLastMessageIdRef = useRef<string | null>(null);
  // Which room we've already pinned to bottom after its content rendered.
  const pinnedRoomRef = useRef<string | null>(null);

  const scrollToBottom = useCallback((smooth = false) => {
    bottomRef.current?.scrollIntoView({
      behavior: smooth ? "smooth" : "instant",
    });
  }, []);

  useEffect(() => {
    // Rooms always open pinned to bottom; clear pill state from the last room.
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    setNewWhileScrolledUp(0);
    prevLastMessageIdRef.current = null;
  }, [roomId]);

  useEffect(() => {
    if (isAtBottomRef.current && messages.length > prevMessageCountRef.current) {
      scrollToBottom(true);
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, scrollToBottom]);

  // Instant-pin to bottom on room open, re-pinning until the room's first page
  // has rendered (the initial fetch is async). After that the at-bottom effect
  // above owns auto-scroll, so a reader who scrolled up is never yanked down
  // by new traffic or a loadMore prepend.
  useEffect(() => {
    if (pinnedRoomRef.current === roomId && messages.length > 0) return;
    if (messages.length > 0) pinnedRoomRef.current = roomId;
    scrollToBottom(false);
    prevMessageCountRef.current = messages.length;
  }, [roomId, scrollToBottom, messages.length]);

  // Count what arrived while scrolled up (the pill's "N new messages" label).
  // Keyed on the last message ID, not list length, so loadMore prepends and
  // the optimistic→server-id reconcile never count as new.
  useEffect(() => {
    const lastId = messages[messages.length - 1]?.id ?? null;
    const prevId = prevLastMessageIdRef.current;
    prevLastMessageIdRef.current = lastId;
    if (!lastId || !prevId || lastId === prevId) return;
    if (isAtBottomRef.current) return;
    const prevIdx = messages.findIndex((m) => m.id === prevId);
    if (prevIdx === -1) return; // room switch or in-place id reconcile
    const fresh = messages
      .slice(prevIdx + 1)
      .filter(
        (m) =>
          !m.id.startsWith("optimistic-") && m.sender_id !== currentUser?.id,
      );
    if (fresh.length > 0) setNewWhileScrolledUp((c) => c + fresh.length);
  }, [messages, currentUser?.id]);

  useEffect(() => {
    const messageId = new URLSearchParams(window.location.search).get("message");
    if (!messageId) return;
    const target = document.getElementById(`m-${messageId}`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("rounded-lg", "ring-1", "ring-emerald-400/60");
    const timeout = window.setTimeout(() => {
      target.classList.remove("rounded-lg", "ring-1", "ring-emerald-400/60");
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [roomId, messages.length]);

  function handleScroll() {
    const container = scrollContainerRef.current;
    if (!container) return;

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceFromBottom < 80;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
    // Reaching the bottom means everything's been seen — reset the pill count.
    if (atBottom) setNewWhileScrolledUp(0);

    if (container.scrollTop < 100 && hasMore && !loading) {
      const prevScrollHeight = container.scrollHeight;
      loadMore().then(() => {
        requestAnimationFrame(() => {
          if (scrollContainerRef.current) {
            const newScrollHeight = scrollContainerRef.current.scrollHeight;
            scrollContainerRef.current.scrollTop = newScrollHeight - prevScrollHeight;
          }
        });
      });
    }
  }

  function handleSend(
    content: string,
    threadId?: string,
    attachments?: { url: string; filename: string; content_type: string; size: number }[],
    extraMetadata?: Record<string, unknown>,
  ) {
    sendMessage(content, threadId, attachments, extraMetadata);
    if (agentMembers.length > 0) setAwaitingAgentSince(Date.now());
    requestAnimationFrame(() => scrollToBottom(true));
  }

  function handleReply(messageId: string) {
    setThreadMessageId(messageId);
  }

  function triggerEditLast() {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.sender_id === currentUser?.id && m.content_type !== "system") {
        setEditFocusId(m.id);
        setEditTick((t) => t + 1);
        return;
      }
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Relative wrapper so the jump pill can float over the scroll area —
          above the composer/typing rows, which live outside it. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex flex-1 flex-col overflow-y-auto px-4 py-3 md:px-8"
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
      >
        {loading && messages.length === 0 && (
          <div
            className="mx-auto w-full max-w-[52rem] space-y-6 px-2 pt-6"
            aria-hidden="true"
          >
            {[68, 42, 84].map((w, i) => (
              <div
                key={i}
                className="flex animate-pulse-soft gap-3"
                style={{ animationDelay: `${i * 150}ms` }}
              >
                <div className="h-9 w-9 shrink-0 rounded-full bg-white/[0.05]" />
                <div className="min-w-0 flex-1 space-y-2 pt-1">
                  <div className="h-3 w-24 rounded bg-white/[0.06]" />
                  <div
                    className="h-3 rounded bg-white/[0.04]"
                    style={{ width: `${w}%` }}
                  />
                  {i !== 1 && (
                    <div
                      className="h-3 rounded bg-white/[0.04]"
                      style={{ width: `${Math.round(w * 0.6)}%` }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && messages.length === 0 && (
          <EmptyChannel
            roomId={roomId}
            participants={participants}
            currentUserId={currentUser?.id}
            onPrompt={(text: string) => {
              void sendMessage(text);
            }}
            onInviteAgent={onInviteAgent}
          />
        )}

        {/* Message column — capped for readable line lengths on wide screens. */}
        <div className="mx-auto w-full max-w-[52rem]">
        {hasMore && messages.length > 0 && (
          <div className="flex justify-center py-2">
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
            ) : (
              <button
                onClick={() => loadMore()}
                className="rounded-full border border-line bg-white/[0.03] px-3 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:border-line-strong hover:text-slate-200 focus-ring"
              >
                Load older messages
              </button>
            )}
          </div>
        )}

        <div className="flex flex-col gap-0.5">
          {messages.map((message, idx) => {
            const prevMessage = idx > 0 ? messages[idx - 1] : undefined;
            const showAvatar =
              !prevMessage ||
              prevMessage.sender_id !== message.sender_id ||
              new Date(message.created_at).getTime() -
                new Date(prevMessage.created_at).getTime() >
                300_000;

            const showDaySeparator =
              !prevMessage ||
              !sameDay(new Date(prevMessage.created_at), new Date(message.created_at));

            return (
              <div key={message.id} id={`m-${message.id}`}>
                {showDaySeparator && (
                  <div className="my-4 flex items-center gap-3 px-2">
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent to-slate-700/60" />
                    <span className="glass rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      {formatDayLabel(new Date(message.created_at))}
                    </span>
                    <div className="h-px flex-1 bg-gradient-to-l from-transparent to-slate-700/60" />
                  </div>
                )}
                {message.id === unreadAnchorId && (
                  <div
                    className="my-2 flex items-center gap-2 px-2"
                    role="separator"
                    aria-label="New messages"
                  >
                    <div className="h-px flex-1 bg-stable-purple/40" />
                    <span className="rounded-full border border-stable-purple/40 bg-stable-purple/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-stable-purple">
                      New
                    </span>
                  </div>
                )}
                <MessageBubble
                  message={message}
                  isOwn={message.sender_id === currentUser?.id}
                  showAvatar={showAvatar}
                  onEdit={editMessage}
                  onDelete={deleteMessage}
                  onReply={handleReply}
                  onRetry={retryMessage}
                  forceEditTick={editFocusId === message.id ? editTick : 0}
                  overrideModelLabel={overrideModelLabel}
                />
                {/* "Seen by" pill — only on the most recent OWN message that
                    other participants have read past. Shows up to 3 avatars. */}
                {message.sender_id === currentUser?.id &&
                  idx === messages.length - 1 &&
                  (() => {
                    const seers = participants.filter((p) => {
                      const pid = p.participant_id || p.user_id || "";
                      if (!pid || pid === currentUser?.id) return false;
                      const at = readReceipts[pid];
                      if (!at) return false;
                      return new Date(at) >= new Date(message.created_at);
                    });
                    if (seers.length === 0) return null;
                    return (
                      <div className="ml-12 mt-1 flex items-center gap-1 text-[10px] text-slate-500">
                        <span>Seen by</span>
                        <div className="flex -space-x-1">
                          {seers.slice(0, 3).map((p) => (
                            <Avatar
                              key={p.participant_id || p.user_id}
                              name={p.display_name}
                              src={p.avatar_url}
                              size="xs"
                              id={p.participant_id || p.user_id}
                              className="ring-1 ring-slate-900"
                            />
                          ))}
                        </div>
                        {seers.length > 3 && <span>+{seers.length - 3}</span>}
                      </div>
                    );
                  })()}
              </div>
            );
          })}
        </div>
        </div>

        <div ref={bottomRef} />
      </div>

      {/* Jump-to-latest pill — only while scrolled up, so it can't cover the
          "Seen by" row (that row lives at the bottom of the scrolled content,
          off-screen whenever the pill is showing). */}
      {!isAtBottom && messages.length > 0 && (
        <button
          onClick={() => {
            setNewWhileScrolledUp(0);
            isAtBottomRef.current = true;
            setIsAtBottom(true);
            scrollToBottom(true);
          }}
          className="glass-heavy absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 animate-slide-up items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium text-slate-200 shadow-pop transition-colors hover:border-stable-purple/40 hover:text-white focus-ring"
          aria-label={
            newWhileScrolledUp > 0
              ? `Jump to latest — ${newWhileScrolledUp} new ${newWhileScrolledUp === 1 ? "message" : "messages"}`
              : "Jump to latest"
          }
        >
          <ArrowDown className="h-3.5 w-3.5 text-stable-purple" aria-hidden="true" />
          {newWhileScrolledUp > 0
            ? `${newWhileScrolledUp} new ${newWhileScrolledUp === 1 ? "message" : "messages"}`
            : "Jump to latest"}
        </button>
      )}
      </div>

      {(typingUsers.length > 0 || awaitingAgentSince !== null) && (
        <div className="shrink-0 px-4 py-1.5 md:px-8">
          <div className="mx-auto flex w-full max-w-[52rem] items-center gap-2">
            {typingUsers.length > 0 ? (
              <p className="animate-pulse-soft text-xs text-slate-500">
                {typingUsers.length === 1
                  ? `${typingUsers[0]?.username ?? "Someone"} is typing...`
                  : typingUsers.length === 2
                    ? `${typingUsers[0]?.username ?? "Someone"} and ${typingUsers[1]?.username ?? "someone"} are typing...`
                    : `${typingUsers.length} people are typing...`}
              </p>
            ) : (
              <>
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full"
                  style={{ background: thinkingIdent.color }}
                />
                <p className="animate-shimmer text-xs font-medium">
                  {agentLabel} is thinking…
                </p>
              </>
            )}
          </div>
        </div>
      )}

      <MessageInput
        roomId={roomId}
        onSend={handleSend}
        onTyping={sendTypingIndicator}
        onEditLast={triggerEditLast}
        disabledReason={
          iAmMuted ? "You've been muted in this channel by a moderator." : undefined
        }
        placeholder={composerPlaceholder}
      />
    </div>
  );
}


interface EmptyChannelProps {
  roomId: string;
  participants: Array<{
    participant_id?: string | null;
    user_id?: string | null;
    display_name: string;
    participant_type?: string;
    avatar_url?: string | null;
  }>;
  currentUserId?: string;
  onPrompt: (content: string) => void;
  onInviteAgent?: () => void;
}

const AGENT_PROMPTS = [
  "Give me a 30-second intro of what you do best.",
  "What questions should I ask you first?",
  "Walk me through a typical task you handle.",
];

// Empty-channel starter chips. Each wires to a real action (see runChip):
// "invite-agent" opens the room's invite flow; the other two seed the composer
// and focus it via the store's requestInsert (consumed + focused by
// MessageInput) — a safe, real default since there's nothing to pin yet in a
// brand-new channel.
type ChipAction = "say-hi" | "pin-goal" | "invite-agent";
const CHANNEL_CHIPS: { label: string; action: ChipAction }[] = [
  { label: "👋 Say hi", action: "say-hi" },
  { label: "📌 Pin a goal for this channel", action: "pin-goal" },
  { label: "🤖 Invite an agent", action: "invite-agent" },
];

function EmptyChannel({ roomId, participants, currentUserId, onPrompt, onInviteAgent }: EmptyChannelProps) {
  const requestInsert = useAppStore((s) => s.requestInsert);

  function runChip(action: ChipAction) {
    switch (action) {
      case "say-hi":
        requestInsert(roomId, "👋 ");
        break;
      case "pin-goal":
        requestInsert(roomId, "🎯 Our goal for this channel: ");
        break;
      case "invite-agent":
        // Fall back to focusing the composer if the invite flow isn't wired
        // (e.g. rendered outside a RoomView), rather than doing nothing.
        if (onInviteAgent) onInviteAgent();
        else requestInsert(roomId, "👋 ");
        break;
    }
  }

  const others = participants.filter(
    (p) => (p.participant_id || p.user_id) !== currentUserId,
  );
  const onlyAgent = others.length === 1 && others[0]?.participant_type === "agent"
    ? others[0]
    : null;

  if (onlyAgent) {
    const ident = identityFor(
      onlyAgent.participant_id || onlyAgent.user_id || onlyAgent.display_name,
      onlyAgent.display_name,
    );
    return (
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md text-center animate-fade-in">
          <div className="relative mx-auto mb-4 h-12 w-12">
            <div
              aria-hidden="true"
              className="absolute -inset-1 rounded-full blur-xl"
              style={{ background: ident.ring }}
            />
            <Avatar
              name={onlyAgent.display_name}
              id={onlyAgent.participant_id || onlyAgent.user_id}
              src={onlyAgent.avatar_url}
              isAgent
              size="lg"
              className="relative"
            />
          </div>
          <p className="font-display text-base font-semibold text-slate-100">
            Chatting privately with{" "}
            <span style={{ color: ident.text }}>{onlyAgent.display_name}</span>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Mentions are off in DMs — every message goes to them.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            {AGENT_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => onPrompt(p)}
                className="rounded-xl border border-line bg-white/[0.03] px-3.5 py-2.5 text-left text-sm text-slate-300 transition-colors hover:border-stable-purple/40 hover:bg-white/[0.05] hover:text-slate-100 focus-ring"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="max-w-md text-center animate-fade-in">
        <div className="relative mx-auto mb-4 h-12 w-12">
          <div
            aria-hidden="true"
            className="absolute -inset-1 rounded-2xl bg-stable-purple/25 blur-xl"
          />
          <StableMark className="relative h-12 w-12" />
        </div>
        <p className="font-display text-base font-semibold text-slate-100">
          The start of the conversation
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Be the first to say something — others see it the moment you hit enter.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {CHANNEL_CHIPS.map((chip) => (
            <button
              key={chip.action}
              onClick={() => runChip(chip.action)}
              className="rounded-full border border-line bg-white/[0.04] px-3 py-1 text-xs text-slate-400 transition-colors hover:border-stable-purple/40 hover:bg-white/[0.06] hover:text-slate-200 focus-ring"
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
