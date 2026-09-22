import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { ArrowDown, ArrowUp, Loader2, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useChat } from "@/hooks/useChat";
import { Identity } from "@/components/ui/Identity";
import { identityFor, resolveIdentity } from "@/lib/identity";
import { usePresence } from "@/hooks/usePresence";
import { useAppStore } from "@/stores/appStore";
import { ws } from "@/services/websocket";
import { StableMark } from "@/components/StableMark";

import {
  EMPTY_AGENT_ACTIVITY,
  EMPTY_MEMBERS,
  EMPTY_READ_RECEIPTS,
} from "@/stores/selectors";
import type { AgentActivity } from "@/stores/appStore";
import { MessageBubble } from "./MessageBubble";

// Virtuoso prepend anchoring base: firstItemIndex starts here and DECREMENTS by
// the number of older messages prepended by loadMore, so the viewport stays
// visually anchored automatically (replaces manual scrollHeight bookkeeping).
const START = 100_000;

/** How long after YOUR send we keep the missed-reply resync poll armed. */
const RESYNC_WINDOW_MS = 60_000;

/** Floor between mark_read assertions for one room. "How far I have read" is
 *  a coarse fact — asserting it more than once every few seconds buys nothing
 *  and costs a DB write plus a read_receipt frame to every member of the
 *  room. Trailing-edge, so the newest message is never left unmarked. */
const MARK_READ_THROTTLE_MS = 3_000;

/** "Perry is thinking…" / "Perry and Quill are thinking…" / "3 agents are
 * thinking…". Names the agents while the list stays readable. */
function describeAgents(rows: AgentActivity[]): string {
  const names = rows.map((r) => r.label);
  if (names.length === 1) return `${names[0]} is thinking…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are thinking…`;
  if (names.length === 3)
    return `${names[0]}, ${names[1]} and ${names[2]} are thinking…`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more are thinking…`;
}

/**
 * "Jordan is typing…" / "Jordan and Jason are typing…" / "Several people are
 * typing…". PEOPLE, deliberately — this line is only ever fed by the human
 * `typing` event, and reads a few pixels above the separate agent lines below,
 * which say "thinking" and name agents. Keeping the two vocabularies apart is
 * what stops the room from having to guess which kind of thing is busy.
 *
 * Three-and-up collapses to "Several people" rather than a count: past two
 * names the exact number is noise, and a number that ticks 3→4→3 as keepalives
 * lapse draws the eye to a fact nobody needs. One vague-but-stable line beats a
 * precise flickering one.
 */
function describeTypists(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

/** Bridge agents get an honest delivery statement, never a fake liveness one. */
function describeRelay(rows: AgentActivity[]): string {
  const names = rows.map((r) => r.label);
  if (names.length === 1)
    return `Waiting for Stable bridge relay — ${names[0]}`;
  if (names.length === 2)
    return `Waiting for Stable bridge relay — ${names[0]} and ${names[1]}`;
  return `Waiting for Stable bridge relay — ${names[0]} and ${names.length - 1} more`;
}

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
  const { messages, hasMore, loading, error, retryInitial, sendMessage, loadMore, editMessage, deleteMessage, retryMessage, resync } =
    useChat(roomId);
  const { typingUsers, sendTypingIndicator, clearTypingIndicator } =
    usePresence(roomId);
  const currentUser = useAppStore((s) => s.currentUser);
  const [editFocusId, setEditFocusId] = useState<string | null>(null);
  const [editTick, setEditTick] = useState(0);
  const queryClient = useQueryClient();
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

  // Agent status is REPORTED, never assumed.
  //
  // This used to be an optimistic local flag: sending into any room that merely
  // CONTAINED an agent asserted "<agent> is thinking…" for up to 150 seconds,
  // regardless of whether anything was running. Mere membership is not activity,
  // so that indicator was wrong far more often than it was right.
  //
  // Now it is driven entirely by server events (see useGlobalNotifications):
  //   • "thinking" — the backend emitted agent_typing around a real Brigade
  //     call, so an agent genuinely is generating a reply.
  //   • "relay"    — a gateway/bridge agent, which has no thinking signal at
  //     all, has an uncollected message. We say exactly that and nothing more.
  // Rows are keyed per agent, so the line names whoever is actually working.
  const agentActivity = useAppStore(
    (s) => s.agentActivity[roomId] ?? EMPTY_AGENT_ACTIVITY,
  );
  const thinkingAgents = useMemo(
    () => agentActivity.filter((a) => a.kind === "thinking"),
    [agentActivity],
  );
  const relayAgents = useMemo(
    () => agentActivity.filter((a) => a.kind === "relay"),
    [agentActivity],
  );

  // Identity hue for the status dot — the agent actually being reported on,
  // not an arbitrary room member.
  const leadAgent = thinkingAgents[0] ?? relayAgents[0];
  const leadMember = leadAgent
    ? participants.find(
        (p) =>
          (leadAgent.participant_id && p.participant_id === leadAgent.participant_id) ||
          p.display_name === leadAgent.label,
      )
    : undefined;

  // Safety net for a MISSED reply, not a claim about agent activity: for a
  // bounded window after YOU send INTO A ROOM THAT CONTAINS AN AGENT, poll a
  // merge-refetch so the answer appears even if its live WS event was dropped
  // (e.g. the socket wasn't yet subscribed to a brand-new room).
  //
  // The membership gate and the "stop as soon as the reply lands" termination
  // are load control, and are deliberately kept from the old implementation.
  // A human-only room has no reply to miss, so arming there would buy nothing
  // and cost a full getMessages refetch every 5s per active chatter.
  const roomHasAgent = participants.some((p) => p.participant_type === "agent");
  const [resyncUntil, setResyncUntil] = useState<number | null>(null);
  useEffect(() => {
    if (resyncUntil === null) return;
    if (Date.now() >= resyncUntil) {
      setResyncUntil(null);
      return;
    }
    const id = window.setInterval(() => {
      if (Date.now() >= resyncUntil) {
        setResyncUntil(null);
        return;
      }
      void resync();
    }, 5_000);
    return () => window.clearInterval(id);
  }, [resyncUntil, resync]);

  // Terminate the window early on success: the reply we were covering for has
  // arrived, so keep polling no longer. (`armedAt` is derived rather than
  // stored so there is exactly one piece of state to reason about.)
  useEffect(() => {
    if (resyncUntil === null) return;
    const armedAt = resyncUntil - RESYNC_WINDOW_MS;
    const last = messages[messages.length - 1];
    if (
      last &&
      last.sender_type === "agent" &&
      new Date(last.created_at).getTime() >= armedAt - 1_000
    ) {
      setResyncUntil(null);
    }
  }, [resyncUntil, messages]);

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
  // Gap #14: a big backlog needs a door back to where the user left off. The
  // seeded unread count is captured ONCE at anchor resolution (the server
  // count zeroes via mark_read/60s refetch, but the door must not evaporate
  // mid-look) and the chip stays until the user jumps, dismisses, or leaves.
  const [anchorUnreadCount, setAnchorUnreadCount] = useState(0);
  const [jumpAnchorDismissed, setJumpAnchorDismissed] = useState(false);
  useEffect(() => {
    if (unreadAnchorRef.current.roomId !== roomId) {
      unreadAnchorRef.current = { roomId, resolved: false };
      setUnreadAnchorId(null);
      setAnchorUnreadCount(0);
      setJumpAnchorDismissed(false);
    }
    if (messages.length === 0) {
      // List wiped for refetch — recompute the anchor from the fresh page.
      if (unreadAnchorRef.current.resolved) {
        unreadAnchorRef.current.resolved = false;
        setUnreadAnchorId(null);
        setAnchorUnreadCount(0);
        setJumpAnchorDismissed(false);
      }
      return;
    }
    if (unreadAnchorRef.current.resolved || loading) return;
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
    if (anchor) {
      setUnreadAnchorId(anchor.id);
      const seeded =
        state.rooms.find((r) => r.id === roomId)?.unread_count ?? 0;
      setAnchorUnreadCount(seeded);
      setJumpAnchorDismissed(false);
    }
  }, [roomId, loading, messages, currentUser?.id]);

  // Virtuoso owns scrolling — its handle drives all programmatic scrolls
  // (jump-to-latest, scroll-on-send, scroll-to-message).
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const listWrapRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  // Mirror of isAtBottomRef: the ref drives scroll decisions without
  // re-rendering, but the jump pill needs a render when it flips.
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [pageVisible, setPageVisible] = useState(
    () => document.visibilityState === "visible",
  );
  useEffect(() => {
    const onVis = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  // Others' messages that landed while scrolled up — the pill's count.
  const [newWhileScrolledUp, setNewWhileScrolledUp] = useState(0);
  const prevLastMessageIdRef = useRef<string | null>(null);
  // Which room we've already force-pinned to newest after its first render.
  const didInitialPinRef = useRef<string | null>(null);
  // Which room:message deep-link we've already centered — so live arrivals
  // don't re-scroll the permalink target on every list change.
  const handledDeepLinkRef = useRef<string | null>(null);

  // Send mark_read for the newest message whenever (a) the room becomes
  // active, (b) a new message arrives while we're at bottom + visible.
  //
  // Keyed on the newest message's ID, NOT `messages.length`. `loadMore`
  // PREPENDS older history, which moves the length without changing what the
  // newest read message is — so a length key re-fired this on every
  // pagination page, re-asserting a fact that had not changed. It also now
  // honours `isAtBottomRef`, which the comment above always claimed but the
  // code never checked, and throttles per room: a burst of arrivals is
  // exactly when the room's sockets are busiest, and each mark_read costs one
  // DB write plus a read_receipt frame to EVERY member.
  //
  // This is now LIVE server-side: ws/handler.py unwraps `payload` for
  // mark_read (`_event_body`), so each of these frames advances the sender's
  // RoomMember.last_read_at and fans a `read_receipt` out to the room. Which
  // is exactly why the throttling above matters — it is a real DB write plus
  // a frame to every member, not a no-op any more.
  const lastMarkedRef = useRef<{ roomId: string; id: string; at: number } | null>(
    null,
  );
  const newestMessageId =
    messages.length > 0 ? messages[messages.length - 1]!.id : null;
  useEffect(() => {
    if (!newestMessageId) return;
    // Never assert "read" off an optimistic bubble: the id isn't a real
    // message id (the server-side UUID parse would discard/choke on it), and
    // more importantly the message it names may never be persisted — a read
    // receipt fanning out for an unACKed send is exactly the "my message
    // showed my own receipt yet was never saved" silent-loss symptom. Once
    // the send is ACKed the bubble's id flips to the server id, this effect
    // re-runs, and the mark_read fires with a real id.
    if (newestMessageId.startsWith("optimistic-")) return;
    if (document.visibilityState !== "visible") return;
    if (!isAtBottomRef.current) return;

    const prev = lastMarkedRef.current;
    // Already asserted for this exact message — nothing has changed.
    if (prev && prev.roomId === roomId && prev.id === newestMessageId) return;

    const send = () => {
      lastMarkedRef.current = {
        roomId,
        id: newestMessageId,
        at: Date.now(),
      };
      ws.send("mark_read", { room_id: roomId, message_id: newestMessageId });
      useAppStore.getState().clearUnread(roomId);
    };

    // A room switch is a fresh subject: never make the user wait out the
    // previous room's throttle window for it.
    const sameRoom = prev?.roomId === roomId;
    const since = sameRoom ? Date.now() - prev!.at : Infinity;
    if (since >= MARK_READ_THROTTLE_MS) {
      send();
      return;
    }

    // Inside the window: defer to the TRAILING edge rather than dropping, so
    // the newest message is always eventually marked read. If a newer message
    // lands first this effect re-runs and the cleanup cancels this timer —
    // which is the intended coalescing, not a lost update.
    const timer = setTimeout(send, MARK_READ_THROTTLE_MS - since);
    return () => clearTimeout(timer);
  }, [roomId, newestMessageId, isAtBottom, pageVisible]);

  // Prepend anchor for Virtuoso: decremented by exactly the number of older
  // messages prepended on each loadMore so the viewport doesn't jump.
  const [firstItemIndex, setFirstItemIndex] = useState(START);
  // Fresh view of `messages` so we can measure how many were prepended after an
  // async loadMore resolves (a state closure would read a stale length).
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // Reset the prepend anchor SYNCHRONOUSLY on room change, before Virtuoso
  // (keyed by roomId) remounts, so its mount-time firstItemIndex baseline is
  // START rather than the previous room's decremented value (Virtuoso only
  // supports firstItemIndex DEcreasing on an existing instance).
  const prevRoomForAnchorRef = useRef(roomId);
  if (prevRoomForAnchorRef.current !== roomId) {
    prevRoomForAnchorRef.current = roomId;
    setFirstItemIndex(START);
  }

  useEffect(() => {
    // Rooms always open pinned to bottom — Virtuoso's initialTopMostItemIndex
    // (plus its per-room key) does the actual scroll on mount; here we just
    // clear pill/anchor state carried over from the last room.
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    setNewWhileScrolledUp(0);
    prevLastMessageIdRef.current = null;
    setFirstItemIndex(START);
    setJumpAnchorDismissed(false);
    setAnchorUnreadCount(0);
  }, [roomId]);

  // Double-tap scroll to the newest message that survives the variable-height
  // reflow: pin on the next frame, then again after a beat once real markdown
  // heights have settled.
  const pinTimersRef = useRef<{ interval?: number }>({});
  const clearPinTimers = useCallback(() => {
    if (pinTimersRef.current.interval) {
      window.clearInterval(pinTimersRef.current.interval);
    }
    pinTimersRef.current = {};
  }, []);
  const pinToNewest = useCallback(() => {
    clearPinTimers();
    // Hold the list at the bottom, EVERY FRAME, until layout stops moving.
    // Fixed-delay settle taps (150/400/800ms) all lost to reality: a first
    // page of heavy markdown keeps re-measuring past any schedule, and each
    // late reflow re-opened a gap above the fold — the room then showed the
    // TOP of the page. So instead: drive the real scroller (scrollToIndex is
    // not used here — under firstItemIndex reverse-scroll its LAST index math
    // repeatedly landed on the top of the loaded page) and only stop once
    // scrollHeight has been stable for ~6 frames, capped at 2.5s. While the
    // loop runs the user cannot scroll away from the bottom; that window is
    // typically ~300ms on room open and the pin fires once per room, so it
    // never fights a reader afterward.
    const startedAt = performance.now();
    let lastHeight = -1;
    let stableTicks = 0;
    // setInterval, NOT requestAnimationFrame: rAF is fully suspended in
    // hidden tabs, and a room can legitimately need its pin while hidden
    // (restored session in a background tab, automation, prerender). A 50ms
    // tick is imperceptible when visible — each tick is a no-op once the list
    // is anchored — and browsers clamp it to ~1s when hidden, which still
    // lands the pin.
    const timer = window.setInterval(() => {
      const scroller = listWrapRef.current?.querySelector<HTMLElement>(
        '[data-virtuoso-scroller="true"]',
      );
      if (!scroller) return;
      scroller.scrollTop = scroller.scrollHeight;
      if (scroller.scrollHeight === lastHeight) {
        stableTicks += 1;
      } else {
        stableTicks = 0;
        lastHeight = scroller.scrollHeight;
      }
      if (stableTicks >= 6 || performance.now() - startedAt > 2500) {
        window.clearInterval(timer);
        if (pinTimersRef.current.interval === timer) {
          pinTimersRef.current.interval = undefined;
        }
      }
    }, 50);
    pinTimersRef.current.interval = timer;
  }, [clearPinTimers]);

  // Keep the list pinned to the newest message when the scroller SHRINKS —
  // mobile keyboard opening (--app-height collapses) or the composer growing.
  // "auto" so the pin lands on every observer tick during the keyboard
  // animation; gated on isAtBottomRef so it never fights a user who scrolled
  // up.
  useEffect(() => {
    const el = listWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!isAtBottomRef.current) return;
      requestAnimationFrame(() =>
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" }),
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One-shot pin-to-newest on room open. `initialTopMostItemIndex` positions
  // Virtuoso using ESTIMATED row heights at mount; with variable-height markdown
  // the real measured heights then shift the target off-screen, leaving the room
  // looking blank / scrolled-up — so we force an explicit scroll to the newest
  // message once the first page is available. Guarded to fire ONCE per room
  // (didInitialPinRef === roomId) so it never fights a user who scrolls up
  // afterward; comparing the ref to roomId re-arms it on a room switch. Skipped
  // when a ?message deep-link owns the initial scroll target.
  //
  // Virtuoso renders 0 items while the tab is hidden (and rAF is suspended), so
  // a room opened in a backgrounded tab CANNOT pin yet: leave the pin PENDING
  // (do NOT stamp the ref) and let the visibilitychange handler below finish it
  // once the tab is focused.
  useEffect(() => {
    if (messages.length === 0) {
      // fetchInitial wiped the list — the Virtuoso instance the pin was armed
      // against is gone. Re-arm so the fresh page pins again.
      if (didInitialPinRef.current === roomId) didInitialPinRef.current = null;
      return;
    }
    if (didInitialPinRef.current === roomId) return;
    if (document.visibilityState !== "visible") return;
    didInitialPinRef.current = roomId;
    if (new URLSearchParams(window.location.search).get("message")) return;
    pinToNewest();
  }, [roomId, messages.length, pinToNewest]);
  // Pin timers must survive list growth (a message landing <150ms after the pin
  // must not cancel the settle tap); clear only on unmount.
  useEffect(() => clearPinTimers, [roomId, clearPinTimers]);

  // Finish a pin that couldn't run while the tab was hidden: when the tab
  // becomes visible and the initial pin is still PENDING for this room, pin to
  // newest and stamp it done. Because the initial-pin effect only stamps while
  // visible, a room pinned normally is already stamped and this never re-fires
  // over a user who has since scrolled up.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState !== "visible") return;
      if (didInitialPinRef.current === roomId) return;
      if (messages.length === 0) return;
      didInitialPinRef.current = roomId;
      if (new URLSearchParams(window.location.search).get("message")) return;
      pinToNewest();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [roomId, messages.length, pinToNewest]);

  // Count what arrived while scrolled up (the pill's "N new messages" label).
  // Keyed on the last message ID, not list length, so loadMore prepends and
  // the optimistic→server-id reconcile never count as new. Reads isAtBottomRef,
  // which Virtuoso's atBottomStateChange keeps current.
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

  // Deep-link scroll-to-message (?message=<id>). Under virtualization the row
  // may be off-screen (unmounted), so first scroll Virtuoso to its index, then
  // — once it's rendered — grab the element and flash the ring. Fail-safe: if
  // the id isn't in the loaded window, do nothing.
  useEffect(() => {
    const messageId = new URLSearchParams(window.location.search).get("message");
    if (!messageId) return;
    const key = `${roomId}:${messageId}`;
    if (messages.length === 0) {
      if (handledDeepLinkRef.current === key) handledDeepLinkRef.current = null;
      return;
    }
    if (handledDeepLinkRef.current === key) return;
    // Read via messagesRef: keying this effect on the array itself would let a
    // mid-flash edit/reaction cancel the highlight; length is the real trigger.
    const arrayIndex = messagesRef.current.findIndex((m) => m.id === messageId);
    if (arrayIndex === -1) return;
    handledDeepLinkRef.current = key;
    virtuosoRef.current?.scrollToIndex({
      index: arrayIndex,
      align: "center",
      behavior: "smooth",
    });
    let removeTimeout: number | undefined;
    const addTimeout = window.setTimeout(() => {
      const target = document.getElementById(`m-${messageId}`);
      if (!target) return;
      target.classList.add("rounded-lg", "ring-1", "ring-emerald-400/60");
      removeTimeout = window.setTimeout(() => {
        target.classList.remove("rounded-lg", "ring-1", "ring-emerald-400/60");
      }, 4000);
    }, 300);
    return () => {
      window.clearTimeout(addTimeout);
      if (removeTimeout) window.clearTimeout(removeTimeout);
    };
  }, [roomId, messages.length]);

  // Prepend older history via Virtuoso's startReached / the manual Header
  // button. Both funnel here so firstItemIndex is decremented by exactly the
  // number of items prepended, keeping the viewport anchored.
  const handleLoadMore = useCallback(() => {
    if (!hasMore || loading) return;
    const prevLen = messagesRef.current.length;
    void loadMore().then(() => {
      const added = messagesRef.current.length - prevLen;
      if (added > 0) setFirstItemIndex((f) => f - added);
    });
  }, [hasMore, loading, loadMore]);

  const autoTitleDoneRef = useRef(false);

  // The done-latch is per ROOM. ChatPanel is normally remounted per room via
  // the surrounding key'd boundary, but don't lean on that from this far away.
  useEffect(() => {
    autoTitleDoneRef.current = false;
  }, [roomId]);

  function handleSend(
    content: string,
    threadId?: string,
    attachments?: { url: string; filename: string; content_type: string; size: number }[],
    extraMetadata?: Record<string, unknown>,
  ) {
    // Sending is the end of typing. Retract BEFORE the message goes out so the
    // stop cannot land after the message it belongs to — a room that shows
    // "Jordan is typing…" underneath a message Jordan just posted is the stuck
    // indicator in its most obvious form.
    clearTypingIndicator();
    // Auto-title eligibility is decided from the PRE-send state: the message
    // being sent must be the room's first human message. Any older page still
    // on the server (hasMore) or any human message already in the loaded
    // window means this room has history — never retitle an old "Chat with X"
    // room because message #31 happened to be sent in it.
    const hadPriorHumanMessage =
      hasMore || messages.some((m) => m.sender_type === "human");
    void sendMessage(content, threadId, attachments, extraMetadata).then((outcome) => {
      // Only a server-confirmed send earns follow-up work. The promise now
      // settles at the send's TERMINAL state (acked/failed, spanning the
      // automatic retry) — renaming a room after a message that was never
      // delivered would be titling it off nothing.
      if (outcome !== "acked") return;
      // Auto-title agent DMs: after the first human message, replace the
      // default "chat with <agent>" with a one-line summary ≤42 chars, and set
      // metadata.auto_titled so we never overwrite a user rename (the server
      // persists the flag via the RoomUpdate metadata allowlist and it rides
      // back on room.metadata_).
      if (autoTitleDoneRef.current || hadPriorHumanMessage || threadId) return;
      const room = useAppStore.getState().rooms.find((r) => r.id === roomId);
      if (!room) return;
      const isAgentDm =
        room.type === "dm" &&
        !!room.brigade_agent_id;
      const isDefaultName = /^chat with /i.test(room.display_name || room.name);
      const meta = room.metadata_;
      if (isAgentDm && isDefaultName && !meta?.auto_titled) {
        autoTitleDoneRef.current = true;
        const summary = content.trim().slice(0, 42);
        if (summary.length > 0) {
          api.updateRoom(roomId, {
            display_name: summary,
            metadata: { auto_titled: true },
          }).then(() => {
            queryClient.invalidateQueries({ queryKey: ["rooms"] });
          }).catch((err) => {
            console.debug("[chat] auto-title failed", err);
            autoTitleDoneRef.current = false;
          });
        }
      }
    });
    // Arm the missed-reply resync poll, but only where a reply can actually be
    // missed. This says nothing about whether an agent is working — it only
    // covers a dropped WS event on our own send.
    if (roomHasAgent) setResyncUntil(Date.now() + RESYNC_WINDOW_MS);
    requestAnimationFrame(() =>
      virtuosoRef.current?.scrollToIndex({ index: "LAST", behavior: "smooth", align: "end" }),
    );
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

  // Virtuoso Header: the manual "Load older messages" affordance, rendered
  // above the first message. Coexists with startReached (auto-load on scroll).
  const Header = useMemo(() => {
    function LoadOlderHeader() {
      if (!hasMore || messages.length === 0) return null;
      return (
        <div className="mx-auto w-full max-w-[52rem] px-4 md:px-8">
          <div className="flex justify-center py-2">
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
            ) : (
              <button
                onClick={handleLoadMore}
                className="rounded-full border border-line bg-white/[0.03] px-3 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:border-line-strong hover:text-slate-200 focus-ring"
              >
                Load older messages
              </button>
            )}
          </div>
        </div>
      );
    }
    return LoadOlderHeader;
  }, [hasMore, messages.length, loading, handleLoadMore]);

  const virtuosoComponents = useMemo(() => ({ Header }), [Header]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Relative wrapper so the jump pill can float over the scroll area —
          above the composer/typing rows, which live outside it. */}
      <div ref={listWrapRef} className="relative flex min-h-0 flex-1 flex-col">
        {messages.length === 0 ? (
          <div
            className="flex flex-1 flex-col overflow-y-auto px-4 py-3 md:px-8"
            role="log"
            aria-label="Chat messages"
            aria-live="polite"
          >
            {loading ? (
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
            ) : error ? (
              <div className="m-auto flex max-w-xs flex-col items-center gap-3 text-center">
                <p className="font-display text-sm font-semibold text-slate-200">
                  Couldn't load messages
                </p>
                <p className="text-xs text-slate-500">
                  Check your connection and try again.
                </p>
                <button
                  onClick={() => void retryInitial()}
                  className="focus-ring rounded-lg border border-line bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-line-strong hover:text-white"
                >
                  Try again
                </button>
              </div>
            ) : (
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
          </div>
        ) : (
          <Virtuoso
            key={roomId}
            ref={virtuosoRef}
            data={messages}
            firstItemIndex={firstItemIndex}
            // Deliberately NO initialTopMostItemIndex: combined with
            // firstItemIndex (reverse infinite scroll) it parks Virtuoso in
            // its pending-initial-location state — item list visibility:hidden
            // with a full-height padding placeholder, zero rows ever rendered,
            // and scrollToIndex silently ignored, so the room looks
            // permanently blank and even "Jump to latest" is dead. Mounting
            // visible-at-top and letting the pin effect below scroll to the
            // newest message (rAF + settle tap) lands identically and cannot
            // wedge.
            computeItemKey={(_index, message) => message.id}
            followOutput={(atBottom) => (atBottom ? "smooth" : false)}
            atBottomStateChange={(atBottom) => {
              isAtBottomRef.current = atBottom;
              setIsAtBottom(atBottom);
              if (atBottom) setNewWhileScrolledUp(0);
            }}
            startReached={() => handleLoadMore()}
            atTopThreshold={400}
            components={virtuosoComponents}
            style={{ flex: 1, minHeight: 0 }}
            role="log"
            aria-label="Chat messages"
            aria-live="polite"
            itemContent={(index, message) => {
              const arrayIndex = index - firstItemIndex;
              const prevMessage =
                arrayIndex > 0 ? messages[arrayIndex - 1] : undefined;
              const showAvatar =
                !prevMessage ||
                prevMessage.sender_id !== message.sender_id ||
                new Date(message.created_at).getTime() -
                  new Date(prevMessage.created_at).getTime() >
                  300_000;

              const showDaySeparator =
                !prevMessage ||
                !sameDay(
                  new Date(prevMessage.created_at),
                  new Date(message.created_at),
                );

              return (
                <div className="mx-auto w-full max-w-[52rem] px-4 md:px-8">
                  <div id={`m-${message.id}`}>
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
                        className="my-3 flex items-center gap-3 px-2"
                        role="separator"
                        aria-label="New messages"
                      >
                        <div className="h-px flex-1 bg-gradient-to-r from-transparent to-stable-purple/40" />
                        <span className="rounded-full border border-stable-purple/40 bg-stable-purple/15 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-stable-purple-light">
                          New messages
                        </span>
                        <div className="h-px flex-1 bg-gradient-to-l from-transparent to-stable-purple/40" />
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
                        other participants have read past. Shows up to 3 avatars.
                        Never on an unACKed (optimistic) send: nobody can have
                        seen a message the server hasn't confirmed persisting,
                        and receipt timestamps landing after the bubble's local
                        created_at would fake exactly that. */}
                    {message.sender_id === currentUser?.id &&
                      !message.id.startsWith("optimistic-") &&
                      arrayIndex === messages.length - 1 &&
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
                                <Identity
                                  key={p.participant_id || p.user_id}
                                  {...resolveIdentity(p)}
                                  presence={null}
                                  size={20}
                                  className="ring-1 ring-slate-900"
                                />
                              ))}
                            </div>
                            {seers.length > 3 && <span>+{seers.length - 3}</span>}
                          </div>
                        );
                      })()}
                  </div>
                </div>
              );
            }}
          />
        )}

        {/* Jump-to-first-unread chip — gap #14. Only for a BIG cold backlog
            (seeded unread > 25): opening pinned to the bottom of an 80-message
            backlog hides the "New messages" divider far above, so this is the
            door back to where the user left off. Dismissed on jump, on X, or
            on room switch. */}
        {unreadAnchorId &&
          !jumpAnchorDismissed &&
          anchorUnreadCount > 25 &&
          messages.length > 0 && (
            <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 animate-slide-up items-center gap-2">
              <button
                onClick={() => {
                  const arrayIndex = messages.findIndex(
                    (m) => m.id === unreadAnchorId,
                  );
                  if (arrayIndex < 0) return;
                  isAtBottomRef.current = false;
                  setIsAtBottom(false);
                  setJumpAnchorDismissed(true);
                  virtuosoRef.current?.scrollToIndex({
                    index: firstItemIndex + arrayIndex,
                    behavior: "smooth",
                    align: "start",
                  });
                }}
                className="glass-heavy flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium text-slate-200 shadow-pop transition-colors hover:border-stable-purple/40 hover:text-white focus-ring"
                aria-label={`Jump to first unread — ${anchorUnreadCount} new messages`}
              >
                <ArrowUp className="h-3.5 w-3.5 text-stable-purple" aria-hidden="true" />
                <span>
                  {anchorUnreadCount} new since your last visit
                </span>
                <span className="font-semibold text-stable-purple-light">
                  Jump to first unread
                </span>
              </button>
              <button
                onClick={() => setJumpAnchorDismissed(true)}
                className="glass-heavy grid h-7 w-7 shrink-0 place-items-center rounded-full text-slate-400 shadow-pop transition-colors hover:bg-white/[0.08] hover:text-white focus-ring"
                aria-label="Dismiss jump-to-unread banner"
                title="Dismiss"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

        {/* Jump-to-latest pill — only while scrolled up, so it can't cover the
            "Seen by" row (that row lives at the bottom of the scrolled content,
            off-screen whenever the pill is showing). */}
        {!isAtBottom && messages.length > 0 && (
          <button
            onClick={() => {
              setNewWhileScrolledUp(0);
              isAtBottomRef.current = true;
              setIsAtBottom(true);
              virtuosoRef.current?.scrollToIndex({
                index: "LAST",
                behavior: "smooth",
                align: "end",
              });
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

      {(typingUsers.length > 0 || agentActivity.length > 0) && (
        <div className="shrink-0 px-4 py-1.5 md:px-8">
          <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-1">
            {typingUsers.length > 0 && (
              // aria-live="polite" so a screen reader hears it without being
              // interrupted mid-message; the region is only mounted while
              // someone is actually typing, so it announces transitions rather
              // than re-reading a persistent label.
              <p
                className="animate-pulse-soft text-xs text-slate-500"
                aria-live="polite"
                aria-atomic="true"
              >
                {describeTypists(typingUsers.map((u) => u.username || "Someone"))}
              </p>
            )}
            {thinkingAgents.length > 0 && (
              <div className="flex items-center gap-2">
                <Identity
                  {...resolveIdentity({
                    id:
                      leadAgent?.participant_id ||
                      leadMember?.participant_id ||
                      leadAgent?.agent_id,
                    display_name: leadAgent?.label ?? leadMember?.display_name ?? "Agent",
                    avatar_url: leadMember?.avatar_url,
                    participant_type: "agent",
                  })}
                  size={20}
                />
                <p className="animate-shimmer text-xs font-medium">
                  {describeAgents(thinkingAgents)}
                </p>
              </div>
            )}
            {relayAgents.length > 0 && (
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-slate-500"
                />
                {/* Deliberately NOT "thinking": a bridge agent gives us no
                    liveness signal, so we report the delivery fact we can
                    actually observe. */}
                <p className="text-xs font-medium text-slate-400">
                  {describeRelay(relayAgents)}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Blur clears typing.
          React's onBlur is really focusout, so it fires for the textarea (and
          every button) inside MessageInput and bubbles to here — which lets the
          composer own its own focus without this needing to reach into it.
          `relatedTarget` is the element receiving focus: if that is still
          inside the composer (tabbing textarea → send button, opening the emoji
          picker) you have not stopped typing, so only a focus move OUT of the
          subtree retracts. relatedTarget is null when focus leaves the document
          entirely — clicked another window, dismissed the mobile keyboard —
          which counts as leaving. */}
      <div
        // The wrapper becomes the flex item MessageInput's root used to be, so
        // it repeats that root's `shrink-0`. Without it the composer is
        // allowed to compress under a long message list.
        className="shrink-0"
        onBlur={(e) => {
          if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) {
            clearTypingIndicator();
          }
        }}
      >
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
          {/* The portrait is the point of this screen. Every character ships
              as 512² art and every surface rendered it at 32-48px, throwing
              away the detail we generated; this is the one moment where you
              are META a resident rather than scanning a list, so it gets a
              real portrait. Sized in rem so it scales with the user's text
              size, and capped on short viewports so the starter prompts stay
              above the fold on a laptop. */}
          <div className="relative mx-auto mb-5 h-32 w-32 max-[900px]:h-24 max-[900px]:w-24">
            <div
              aria-hidden="true"
              className="absolute -inset-3 rounded-full blur-2xl opacity-70"
              style={{ background: ident.ring }}
            />
            <Identity
              {...resolveIdentity(onlyAgent)}
              size={128}
              className="relative"
            />
          </div>
          <p className="font-display text-lg font-semibold text-slate-100">
            <span style={{ color: ident.text }}>{onlyAgent.display_name}</span>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Private chat — mentions are off, every message goes to them.
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
    <div className="flex min-w-0 flex-1 items-center justify-center overflow-hidden px-4">
      <div className="w-full max-w-md min-w-0 text-center animate-fade-in">
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
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
          Be the first to say something — others see it the moment you hit enter.
        </p>
        <div className="mx-auto mt-5 grid w-full max-w-sm grid-cols-1 gap-2 min-[430px]:flex min-[430px]:flex-wrap min-[430px]:justify-center">
          {CHANNEL_CHIPS.map((chip) => (
            <button
              key={chip.action}
              onClick={() => runChip(chip.action)}
              className="min-h-11 rounded-xl border border-line bg-white/[0.04] px-3 py-2 text-xs text-slate-400 transition-colors hover:border-stable-purple/40 hover:bg-white/[0.06] hover:text-slate-200 focus-ring min-[430px]:min-h-0 min-[430px]:rounded-full min-[430px]:py-1"
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
