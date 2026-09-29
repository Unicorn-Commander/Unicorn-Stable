import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, Settings2 } from "lucide-react";
import clsx from "clsx";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { beginThread, openAgentHub } from "@/lib/beginThread";
import { crewPresence } from "@/lib/crew";
import { useCrew } from "@/hooks/useCrew";
import { useAppStore } from "@/stores/appStore";
import { useFederationStore } from "@/stores/federationStore";
import { badgeCount } from "@/utils/unreadModel";
import { onMutedChange } from "@/utils/mute";
import { CrewMenuItem, CrewRowMenu } from "@/components/Sidebar/CrewSection";
import { buildCrewSection, type CrewRow } from "@/components/Sidebar/sidebarModel";
import { previewText } from "./widgets/HomeRow";
import { seatCardFacts } from "./homeModel";
import type { CrewCard } from "./homeClient";

/** "2m", "3h", "8d": how long a seat has been at what it is doing, in a card's width. */
export function compactSince(iso: string | null | undefined, now: number): string | null {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Your seats, as the rail counts them: every one, its hub and its badge. */
export function useOwnSeatRows(): CrewRow[] {
  const { crew, crewAnswered } = useCrew();
  const rooms = useAppStore((s) => s.rooms);
  const agents = useAppStore((s) => s.agents);
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const currentParticipantId = useAppStore((s) => s.currentParticipantId);
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  // mute.ts persists outside React; recount when a level changes.
  const [mutedVersion, setMutedVersion] = useState(0);
  useEffect(() => onMutedChange(() => setMutedVersion((v) => v + 1)), []);
  return useMemo(
    () =>
      buildCrewSection({
        crew: crew.filter((member) => member.group === "own_seat"),
        crewAnswered,
        selfIds: [currentParticipantId, currentUserId],
        rooms,
        agents,
        searchQuery: "",
        showAll: true,
        collapsed: {},
        roomUnread: (room) => badgeCount(room.id, unreadCounts[room.id] ?? room.unread_count ?? 0),
      }).groups.flatMap((group) => group.rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutedVersion recounts after a mute
    [crew, crewAnswered, currentParticipantId, currentUserId, rooms, agents, unreadCounts, mutedVersion],
  );
}

/**
 * Your seats (Nav v3 §2.7): one row of cards under the composer. A card is
 * the seat's face and presence, what it is doing now, its last line and its
 * unread. Tap opens the hub; ⋯ is New conversation and Settings — a seat
 * takes no calls until voice ships, so there is no Call.
 */
export function SeatCards({ rows, cards }: { rows: readonly CrewRow[]; cards: readonly CrewCard[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scope = useFederationStore((s) => s.activeInstanceId);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.now();

  async function hubOf(row: CrewRow): Promise<string | null> {
    if (row.roomId) return row.roomId;
    const hub = await openAgentHub(row.member.agent_id);
    if (hub) void queryClient.invalidateQueries({ queryKey: ["rooms", scope] });
    return hub?.id ?? null;
  }

  function run(row: CrewRow, job: (hubId: string) => Promise<void> | void) {
    if (busy) return;
    setBusy(row.id);
    setMenuFor(null);
    void (async () => {
      try {
        const hubId = await hubOf(row);
        if (hubId) await job(hubId);
      } finally {
        setBusy(null);
      }
    })();
  }

  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="home-seats-heading" data-testid="home-seats">
      <h2
        id="home-seats-heading"
        className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500"
      >
        Your seats
      </h2>
      <ul
        className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]"
        role="list"
      >
        {rows.map((row) => {
          const { member } = row;
          const facts = seatCardFacts(member, cards);
          const presence = crewPresence(member, now);
          const since = facts.task ? compactSince(facts.since, now) : null;
          return (
            <li
              key={row.id}
              className={clsx(
                // Narrower than a third of the row from `sm` up, so a
                // fourth seat shows its edge: the row says it scrolls.
                "relative w-64 shrink-0 snap-start rounded-xl border border-line bg-white/[0.03] transition-colors hover:border-line-strong sm:w-60",
                menuFor === row.id && "z-30",
              )}
              data-testid="seat-card"
              data-agent-id={member.agent_id}
            >
              <button
                type="button"
                disabled={busy === row.id}
                onClick={() =>
                  run(row, (hubId) => {
                    useAppStore.getState().clearUnread(hubId);
                    navigate(`/c/${hubId}`);
                  })
                }
                className="focus-ring flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left disabled:opacity-60"
                title={`Open your conversation with ${member.display_name}`}
                data-testid={`seat-card-open-${member.agent_id}`}
              >
                <span className="relative mt-0.5 shrink-0">
                  <Identity
                    {...resolveIdentity({
                      id: member.agent_id,
                      participant_id: member.participant_id || undefined,
                      participant_type: "agent",
                      display_name: member.display_name,
                      avatar_url: member.avatar_url,
                      username: member.agent_id,
                    })}
                    presence={null}
                    size={36}
                    alt=""
                  />
                  {presence.dotClass && (
                    <span
                      role="img"
                      aria-label={presence.label}
                      title={presence.label}
                      className={clsx(
                        "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border",
                        presence.dotClass,
                      )}
                      data-testid="seat-card-presence"
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  {/* Only the name's row makes room for the menu. */}
                  <span className="flex items-center gap-1.5 pr-7">
                    <span className="min-w-0 truncate text-sm font-medium text-slate-100">
                      {member.display_name}
                    </span>
                    {row.unread > 0 && (
                      <span
                        className="gradient-bg grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums text-white"
                        aria-label={`${row.unread} unread`}
                        data-testid="seat-card-unread"
                      >
                        {row.unread > 99 ? "99+" : row.unread}
                      </span>
                    )}
                  </span>
                  {facts.task && (
                    <span className="flex items-baseline gap-1 text-xs" data-testid="seat-card-task">
                      <span className="min-w-0 truncate text-stable-cyan">{facts.task}</span>
                      {since && <span className="shrink-0 text-slate-500">· {since}</span>}
                    </span>
                  )}
                  {facts.lastLine && (
                    <span className="block truncate text-xs text-slate-400" data-testid="seat-card-line">
                      {previewText(facts.lastLine)}
                    </span>
                  )}
                  {!facts.task && !facts.lastLine && (
                    <span className="block truncate text-xs text-slate-500">{presence.label}</span>
                  )}
                </span>
              </button>
              <span className="absolute right-1.5 top-1.5">
                <CrewRowMenu
                  name={member.display_name}
                  agentId={member.agent_id}
                  open={menuFor === row.id}
                  alwaysVisible
                  onOpenChange={(next) => setMenuFor(next ? row.id : null)}
                  testId={`seat-card-menu-${member.agent_id}`}
                >
                  <CrewMenuItem
                    onClick={() =>
                      run(row, async (hubId) => {
                        await beginThread({ roomId: hubId, navigate });
                      })
                    }
                    testId="seat-card-new"
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5" /> New conversation
                  </CrewMenuItem>
                  <CrewMenuItem
                    onClick={() => run(row, (hubId) => navigate(`/c/${hubId}?seat=1`))}
                    testId="seat-card-settings"
                  >
                    <Settings2 className="h-3.5 w-3.5" /> Settings
                  </CrewMenuItem>
                </CrewRowMenu>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
