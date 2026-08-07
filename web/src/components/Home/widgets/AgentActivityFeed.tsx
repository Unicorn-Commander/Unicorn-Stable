import type { Agent, Message } from "@/services/api";
import { Bot } from "lucide-react";
import { brandAvatarFor } from "@/lib/brandAvatars";
import { identityFor } from "@/lib/identity";
import { UnicornAvatar } from "@/components/Agents/UnicornAvatar";
import {
  unreadCountFor,
  type AgentFeedModel,
  type AgentThreadRow,
  type UnreadMap,
} from "@/components/Home/homeModel";

/** "+3 more threads" — the folded duplicate rooms with the same agent. */
function FoldedThreads({ row }: { row: AgentThreadRow }) {
  if (row.extraThreads === 0) return null;
  return (
    <span className="shrink-0 rounded bg-white/[0.05] px-1.5 py-px text-[10px] font-medium text-slate-500">
      +{row.extraThreads} more thread{row.extraThreads === 1 ? "" : "s"}
      {row.extraUnread > 0 ? ` · ${row.extraUnread} unread` : ""}
    </span>
  );
}
import { HomeRow, SenderLine, previewText } from "./HomeRow";

/**
 * W5 — the agent activity feed. Absorbs the old "Needs your attention"
 * section as its first group and adds the half that was missing: most of the
 * fleet's output is agent messages the user has already read (or that landed
 * in channels), and home used to show agent work ONLY while it was unread.
 * Group one is "act on this"; group two is "know about this".
 */

/** Portrait ladder for a feed row, matching the fleet card's precedence:
 * the message's own avatar → the roster's (matched by name — feed rows come
 * from `last_message`, which carries no agent id) → puppet art by name →
 * generated unicorn. */
function AgentPortrait({ message, roster }: { message: Message; roster: Agent[] }) {
  const rosterMatch = roster.find(
    (a) =>
      a.display_name === message.sender_name || a.name === message.sender_name,
  );
  const src =
    message.sender_avatar ||
    rosterMatch?.avatar_url ||
    brandAvatarFor(message.sender_name);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        className="mt-0.5 h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-white/10"
      />
    );
  }
  return (
    <span className="mt-0.5 shrink-0">
      <UnicornAvatar
        id={message.sender_id}
        name={message.sender_name}
        size={36}
        state="idle"
      />
    </span>
  );
}

function GroupHeader({ label, divider }: { label: string; divider?: boolean }) {
  return (
    <li
      className={
        "bg-white/[0.02] px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500" +
        (divider ? " border-t border-line" : "")
      }
    >
      {label}
    </li>
  );
}

export function AgentActivityFeed({
  feed,
  unreadCounts,
  roster,
  onOpenRoom,
  onBrowseAgents,
}: {
  feed: AgentFeedModel;
  unreadCounts: UnreadMap;
  roster: Agent[];
  onOpenRoom: (roomId: string) => void;
  onBrowseAgents: () => void;
}) {
  const { waiting, recent } = feed;
  const empty = waiting.length === 0 && recent.length === 0;

  return (
    <section aria-labelledby="home-agent-feed-heading">
      <div className="mb-2 flex items-center gap-2">
        <Bot className="h-4 w-4 text-item-agent" />
        <h2
          id="home-agent-feed-heading"
          className="font-display text-sm font-semibold text-slate-200"
        >
          Agent activity
        </h2>
      </div>

      {empty ? (
        <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-slate-500">
          No agent activity yet — invite an agent to a room or DM one from the{" "}
          <button
            type="button"
            onClick={onBrowseAgents}
            className="focus-ring rounded font-medium text-stable-purple-light hover:underline"
          >
            Agents page
          </button>
          .
        </p>
      ) : (
        <ul className="card overflow-hidden">
          {/* Group labels render only when their group has rows: "no agents
              waiting" as a standing line inside a feed that HAS content would
              be noise the stat strip already carries. */}
          {waiting.length > 0 && <GroupHeader label="Waiting on you" />}
          {waiting.map((row: AgentThreadRow) => {
            const room = row.room;
            const unread = unreadCountFor(room, unreadCounts);
            const m = room.last_message;
            return (
              <li key={room.id}>
                <HomeRow
                  leading={(() => {
                    const src = brandAvatarFor(room.display_name || room.name);
                    return src ? (
                      <img
                        src={src}
                        alt=""
                        loading="lazy"
                        className="mt-0.5 h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-white/10"
                      />
                    ) : (
                      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stable-purple/15 text-stable-purple-light">
                        <Bot className="h-4 w-4" />
                      </span>
                    );
                  })()}
                  title={room.display_name || room.name}
                  at={m?.created_at ?? null}
                  unread={unread}
                  tint="border-l-2 border-l-stable-coral/60 bg-stable-coral/[0.04]"
                  divider
                  onClick={() => onOpenRoom(room.id)}
                  line={
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                      {m ? (
                        <SenderLine message={m} />
                      ) : (
                        <span className="truncate text-xs text-slate-500">
                          Unread agent messages
                        </span>
                      )}
                      <FoldedThreads row={row} />
                    </span>
                  }
                />
              </li>
            );
          })}

          {recent.length > 0 && (
            <GroupHeader label="Recent agent activity" divider={waiting.length > 0} />
          )}
          {recent.map((row: AgentThreadRow) => {
            const room = row.room;
            // recent rows are guaranteed a last_message by construction
            // (that message is WHY the room is in the list).
            const m = room.last_message!;
            return (
              <li key={room.id}>
                <HomeRow
                  leading={<AgentPortrait message={m} roster={roster} />}
                  title={m.sender_name}
                  titleStyle={{
                    color: identityFor(m.sender_id, m.sender_name).text,
                  }}
                  at={m.created_at}
                  divider
                  onClick={() => onOpenRoom(room.id)}
                  line={
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-slate-400">
                      <span className="shrink-0 rounded bg-white/[0.05] px-1.5 py-px text-[10px] font-medium text-slate-400">
                        {room.display_name || room.name}
                      </span>
                      <span className="truncate">{previewText(m.content)}</span>
                      <FoldedThreads row={row} />
                    </span>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
