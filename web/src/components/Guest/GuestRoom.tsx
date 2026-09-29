/**
 * The guest room shell — the ONE room, and deliberately nothing else.
 *
 * WHAT IS NOT HERE, AND WHY IT IS NOT HERE AS AN ABSENCE RATHER THAN A HIDDEN
 * BUTTON: no channel browser, no room list, no agent roster, no knowledge
 * bases, no search, no server rail, no settings, no people directory. Those are
 * not conditionally rendered — this tree never imports AppShell, the sidebar,
 * the app store or the shared WebSocket singleton, so there is no state a URL
 * edit or a devtools poke can put the shell into where they appear. That is the
 * point: a guest surface built by hiding controls in the member shell is one
 * refactor away from leaking the workspace, and the server would still be the
 * only thing stopping it.
 *
 * (The server agrees independently — `deps.get_current_user` refuses a guest
 * credential by name, so every one of those endpoints 401s for a guest whatever
 * the client does. This shell is the honest half of that, not the enforcement.)
 *
 * The three things a guest DOES get: the room's video, the room's chat, and the
 * room's roster with everyone's status plainly labelled.
 */
import {
  isSupersededReceipt,
  isSystemLine,
  recordingIdOf,
  systemLineText,
} from "@/lib/systemLines";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { LogOut, Send, Users } from "lucide-react";
import clsx from "clsx";
import { StableMark } from "@/components/StableMark";
import {
  GUEST_BADGE_LABEL,
  guestCan,
  guestExpiryNotice,
  isGuestSender,
  isGuestSessionExpired,
  isMessageVisibleToGuest,
  type GuestSession,
} from "@/lib/guest";
import {
  GuestSessionEnded,
  getGuestMembers,
  getGuestMessages,
  sendGuestMessage,
  type GuestMessage,
  type GuestRoomMember,
} from "@/services/guestApi";
import { GuestSocket, type GuestSocketStatus } from "@/services/guestSocket";
import { GuestVideoStage } from "./GuestVideoStage";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { GuestBadge, GuestParticipantRow } from "./GuestChrome";
import { RecPillLive } from "@/components/Call/RecPill";
import { playCue } from "@/lib/sounds";
import {
  IDLE_RECORDING,
  recordingSystemLine,
  starterDisplayName,
} from "@/lib/recording";
import { useRecordingStore } from "@/stores/recordingStore";

interface GuestRoomProps {
  session: GuestSession;
  /** Terminal: revoked, expired, or the credential stopped authenticating. */
  onEnded: (reason: "revoked" | "expired") => void;
  onLeave: () => void;
}

/** Poll floor for the roster. The socket's `members_changed` is the live path;
 *  this is the backstop for a socket that is reconnecting. */
const MEMBER_POLL_MS = 30_000;
/** How often the local expiry clock is re-read. The server is the authority —
 *  this only drives the countdown line and the local give-up. */
const EXPIRY_TICK_MS = 20_000;

function statusLabel(status: GuestSocketStatus): string {
  switch (status) {
    case "live":
      return "Connected";
    case "reconnecting":
      return "Reconnecting…";
    case "ended":
      return "Disconnected";
    case "connecting":
    default:
      return "Connecting…";
  }
}

/** One line of the guest transcript. Exported for the guest-shape tests. */
export function GuestMessageRow({
  message,
  members,
}: {
  message: GuestMessage;
  members: GuestRoomMember[];
}) {
  // `sender_type` is serialized straight from the sender's participant_type, so
  // a guest's message arrives as "guest" — no roster join needed here.
  const guest = isGuestSender(message.sender_type);
  const agent = message.sender_type === "agent";
  // Server-worded system lines (recording notices, the parent's thread
  // line) are put back together from their metadata; a guest's roster may
  // resolve no name, and then the line simply says less.
  if (isSystemLine(message)) {
    return (
      <li
        className="px-2 py-1 text-center text-[11px] italic text-slate-500"
        data-testid="guest-system-line"
      >
        {systemLineText(message, members) ?? message.content}
      </li>
    );
  }
  // A member's row is the fallback path for anything the message itself does
  // not carry (a display name the sender changed since posting).
  const member = members.find(
    (m) => (m.participant_id || m.user_id) === message.sender_id,
  );
  const name = message.sender_name || member?.display_name || "Someone";
  return (
    <li className="flex gap-2.5 px-2 py-1.5">
      <Identity
        {...resolveIdentity(
          member
            ? { ...member, display_name: name }
            : {
                id: message.sender_id,
                display_name: name,
                participant_type: message.sender_type,
              },
        )}
        presence={null}
        size={28}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-semibold text-slate-200">
            {name}
          </span>
          {guest && <GuestBadge />}
          {agent && (
            <span className="rounded-md bg-stable-purple/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stable-purple-light">
              AI
            </span>
          )}
        </div>
        {/* Plain text on purpose. The member shell renders markdown, code,
            canvases and embeds; none of that is worth the sanitiser surface on
            a page whose whole audience is strangers with no account. */}
        <p className="whitespace-pre-wrap break-words text-sm text-slate-300">
          {message.content}
        </p>
      </div>
    </li>
  );
}

export function GuestRoom({ session, onEnded, onLeave }: GuestRoomProps) {
  const [messages, setMessages] = useState<GuestMessage[]>([]);
  const [members, setMembers] = useState<GuestRoomMember[]>([]);
  const [status, setStatus] = useState<GuestSocketStatus>("connecting");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showRoster, setShowRoster] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLUListElement | null>(null);
  const membersRef = useRef(members);
  membersRef.current = members;

  const canChat = guestCan(session, "chat", true);

  /** One terminal path for every way the credential can die, so the shell can
   *  never end up in two of them at once. */
  const endedRef = useRef(false);
  const end = useCallback(
    (reason: "revoked" | "expired") => {
      if (endedRef.current) return;
      endedRef.current = true;
      onEnded(reason);
    },
    [onEnded],
  );

  useEffect(() => {
    document.title = session.roomName
      ? `${session.roomName} · Guest · Stable`
      : "Guest · Stable";
  }, [session.roomName]);

  useEffect(() => {
    if (!session.recordingActive) return;
    useRecordingStore.getState().seedIfIdle(session.roomId, {
      ...IDLE_RECORDING,
      active: true,
    });
  }, [session.roomId, session.recordingActive]);

  /** Upsert by id — the POST response and the socket echo carry the same
   *  message, and the room's own history may re-deliver it on a reconnect. */
  const upsert = useCallback(
    (message: GuestMessage) => {
      if (!message?.id) return;
      setMessages((current) => {
        const index = current.findIndex((m) => m.id === message.id);
        if (index >= 0) {
          const next = current.slice();
          next[index] = { ...next[index], ...message };
          return next;
        }
        return [...current, message];
      });
    },
    [],
  );

  const refreshMembers = useCallback(async () => {
    try {
      setMembers(await getGuestMembers(session.token, session.roomId));
    } catch (error) {
      if (error instanceof GuestSessionEnded) end("revoked");
    }
  }, [session.token, session.roomId, end]);

  /* History + roster. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await getGuestMessages(session.token, session.roomId);
        if (cancelled) return;
        // The server returns newest-first; the transcript reads oldest-first.
        setMessages(page.messages.slice().reverse());
      } catch (error) {
        if (error instanceof GuestSessionEnded) end("revoked");
      }
    })();
    void refreshMembers();
    const poll = setInterval(() => void refreshMembers(), MEMBER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [session.token, session.roomId, refreshMembers, end]);

  /* The socket. */
  useEffect(() => {
    const socket = new GuestSocket(session.token, {
      onStatus: setStatus,
      // `session_ended` (or a close code that is the server's verdict on this
      // credential) is TERMINAL. Not a retry, not a banner — the invite is over
      // and the shell says so.
      onSessionEnded: () => end("revoked"),
      onEvent: (type, payload) => {
        switch (type) {
          case "message": {
            const roomId = payload.room_id;
            const message = payload.message as GuestMessage | undefined;
            // The socket is scoped to this one room server-side, but a frame
            // for another room would be a bug worth not rendering.
            if (roomId === session.roomId && message) upsert(message);
            break;
          }
          case "message_edit": {
            const id = payload.message_id;
            if (typeof id !== "string") break;
            setMessages((current) =>
              current.map((m) =>
                m.id === id
                  ? { ...m, content: String(payload.content ?? m.content) }
                  : m,
              ),
            );
            break;
          }
          case "message_delete": {
            const id = payload.message_id;
            if (typeof id !== "string") break;
            setMessages((current) => current.filter((m) => m.id !== id));
            break;
          }
          case "members_changed":
            void refreshMembers();
            break;
          case "recording_state": {
            const result = useRecordingStore
              .getState()
              .applyFrame(session.roomId, payload);
            if (!result || result.transition === "none") break;
            playCue(result.transition === "start" ? "rec-start" : "rec-stop");
            const subject = result.transition === "stop" ? result.prev : result.next;
            const line = recordingSystemLine(
              result.transition,
              subject,
              starterDisplayName(subject, membersRef.current),
            );
            if (line) {
              upsert({
                id: `recording:${session.roomId}:${result.transition}:${subject.startedAt ?? "none"}`,
                room_id: session.roomId,
                sender_id: "system",
                sender_type: "system",
                sender_name: "Stable",
                sender_avatar: null,
                content: line,
                content_type: "system",
                created_at: new Date().toISOString(),
                // The recording's id is how the persisted notice finds
                // this receipt, whatever this device's clock says.
                metadata: {
                  recording_receipt: true,
                  ...(recordingIdOf(payload) ? { recording_id: recordingIdOf(payload) } : {}),
                },
              });
            }
            break;
          }
          default:
            // Unknown event types are IGNORED, not logged as errors: the server
            // adds frames over time and an old guest tab must keep working.
            break;
        }
      },
    });
    socket.connect();
    return () => socket.close();
  }, [session.token, session.roomId, upsert, refreshMembers, end]);

  /* Local expiry clock. The server re-checks the credential on every request
     and every 4s on the socket, so this is a courtesy countdown — and a
     last-resort give-up for a tab that has lost the socket entirely and would
     otherwise sit on a dead session with no idea. */
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), EXPIRY_TICK_MS);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    if (isGuestSessionExpired(session.expiresAt, now)) end("expired");
  }, [session.expiresAt, now, end]);

  /* Keep the transcript pinned to the newest message. */
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  const visible = useMemo(() => {
    const shown = messages.filter((m) =>
      isMessageVisibleToGuest(m.created_at, session.historyFromMs),
    );
    // The local recording receipt (drawn from the socket's frame) is the same
    // fact as the server's persisted notice, and yields to it in either
    // arrival order — or the transcript says "recording started" twice.
    return shown.filter((m) => !isSupersededReceipt(m, shown));
  }, [messages, session.historyFromMs]);

  /** MEMOIZED, not inline: GuestVideoStage lists this in the dependency array
   *  of the effect that owns the LiveKit connection, so a fresh identity per
   *  render would re-mint a token and reconnect the call on every keystroke in
   *  the composer. */
  const onStageEnded = useCallback(() => end("revoked"), [end]);

  const expiryNotice = guestExpiryNotice(session.expiresAt, now);
  const guestCount = members.filter((m) => m.participant_type === "guest").length;

  async function send(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending || !canChat) return;
    setSending(true);
    setSendError(null);
    try {
      const sent = await sendGuestMessage(
        session.token,
        session.roomId,
        content,
        // Idempotency id: the server dedupes a retried send on
        // (room, sender, client_msg_id), so a resend after a lost response
        // collapses instead of double-posting.
        `guest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      );
      upsert(sent);
      setDraft("");
    } catch (error) {
      if (error instanceof GuestSessionEnded) {
        end("revoked");
        return;
      }
      // Keep the draft. Losing what someone typed because a request failed is
      // the rudest possible failure for a message box.
      setSendError("Couldn't send that. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="flex h-dvh w-full flex-col bg-slate-900 text-slate-200"
      data-testid="guest-room"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-4 py-3">
        <StableMark className="h-6 w-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold text-slate-100">
              {session.roomName || "Room"}
            </h1>
            <GuestBadge />
            <RecPillLive roomId={session.roomId} members={members} />
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span
              className={clsx(
                "inline-block h-1.5 w-1.5 rounded-full",
                status === "live"
                  ? "bg-stable-mint"
                  : status === "ended"
                    ? "bg-rose-400"
                    : "bg-amber-400",
              )}
            />
            {statusLabel(status)}
            <span className="text-slate-600">·</span>
            You&rsquo;re here as {session.displayName}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowRoster((open) => !open)}
          aria-expanded={showRoster}
          aria-label={`People in this room (${members.length})`}
          data-testid="guest-roster-toggle"
          className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 lg:hidden"
        >
          <Users className="h-4 w-4" />
          {members.length}
        </button>
        <button
          type="button"
          onClick={onLeave}
          className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 hover:bg-rose-500/10 hover:text-rose-200"
        >
          <LogOut className="h-4 w-4" />
          Leave
        </button>
      </header>

      {expiryNotice && (
        <p
          role="status"
          className="shrink-0 border-b border-amber-400/20 bg-amber-400/10 px-4 py-1.5 text-center text-[11px] text-amber-200"
        >
          {expiryNotice}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
        <div className="flex min-h-0 flex-1 flex-col">
          <GuestVideoStage
            session={session}
            members={members}
            onSessionEnded={onStageEnded}
          />
        </div>

        <aside className="flex min-h-0 w-full flex-col gap-3 lg:w-80 lg:shrink-0">
          <section
            className={clsx(
              "flex flex-col rounded-xl border border-white/[0.06] bg-slate-950/40 p-2",
              showRoster ? "flex" : "hidden lg:flex",
            )}
            data-testid="guest-roster"
          >
            <h2 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              In this room ({members.length})
              {guestCount > 0 && (
                <span className="ml-1 font-normal normal-case tracking-normal text-slate-600">
                  · {guestCount} {GUEST_BADGE_LABEL.toLowerCase()}
                  {guestCount === 1 ? "" : "s"}
                </span>
              )}
            </h2>
            <ul role="list" className="max-h-48 overflow-y-auto lg:max-h-64">
              {members.map((member) => (
                <GuestParticipantRow
                  key={member.participant_id || member.user_id || member.username}
                  member={member}
                />
              ))}
            </ul>
          </section>

          <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-white/[0.06] bg-slate-950/40">
            <h2 className="shrink-0 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Chat
            </h2>
            <ul
              ref={listRef}
              role="log"
              aria-live="polite"
              className="min-h-32 flex-1 overflow-y-auto pb-2"
            >
              {visible.length === 0 ? (
                <li className="px-3 py-4 text-center text-xs italic text-slate-600">
                  No messages yet.
                </li>
              ) : (
                visible.map((message) => (
                  <GuestMessageRow
                    key={message.id}
                    message={message}
                    members={members}
                  />
                ))
              )}
            </ul>
            {canChat ? (
              <form
                onSubmit={send}
                className="flex shrink-0 items-end gap-2 border-t border-white/[0.06] p-2"
              >
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send(event as unknown as FormEvent);
                    }
                  }}
                  rows={1}
                  placeholder="Message the room…"
                  aria-label="Message the room"
                  className="focus-ring max-h-24 min-h-9 flex-1 resize-none rounded-lg border border-white/[0.08] bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
                />
                <button
                  type="submit"
                  disabled={sending || draft.trim().length === 0}
                  aria-label="Send message"
                  className="focus-ring inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg bg-stable-purple text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Send className="h-4 w-4" />
                </button>
              </form>
            ) : (
              // A capability the server denied. The composer is absent, not
              // disabled-looking, and the server would 403 the post anyway.
              <p className="shrink-0 border-t border-white/[0.06] p-2 text-center text-[11px] text-slate-500">
                This invite is view-only for chat.
              </p>
            )}
            {sendError && (
              <p role="alert" className="px-3 pb-2 text-[11px] text-rose-300">
                {sendError}
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

export default GuestRoom;
