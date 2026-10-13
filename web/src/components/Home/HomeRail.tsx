import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import clsx from "clsx";
import { api, type Agent, type Room } from "@/services/api";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { useAppStore } from "@/stores/appStore";
import { useFederationStore } from "@/stores/federationStore";
import { usePresentedRooms } from "@/hooks/usePresentedRooms";
import { PresenterHiddenLine } from "@/components/Layout/PresenterHiddenLine";
import { LIVE_CALLS_POLL_MS } from "@/hooks/useLiveCalls";
import { hasDraft, subscribeDrafts } from "@/utils/drafts";
import { previewText } from "./widgets/HomeRow";
import {
  homeRailConversations,
  modeLabel,
} from "./homeModel";
import {
  ensureAgentHub,
  fetchHomeSummaryV3,
  type CrewCard,
} from "./homeClient";

const NO_FAVORITES: readonly string[] = [];

/**
 * Home's sidebar body: the crew (face, mode, tap opens the hub) and the
 * conversations you starred or touched. The destination switcher stays in the
 * server rail; this replaces the old "pick a destination" paragraph.
 */
export function HomeRail({ onOpenRoom }: { onOpenRoom: (roomId: string) => void }) {
  const { rooms, hiddenCount, rule, enabled: presenterEnabled } = usePresentedRooms();
  const agents = useAppStore((s) => s.agents);
  const selfId = useAppStore((s) => s.currentParticipantId ?? s.currentUser?.id ?? null);
  const activeRoomId = useAppStore((s) => s.activeRoomId);
  const pushToast = useAppStore((s) => s.pushToast);
  const scope = useFederationStore((s) => s.activeInstanceId);
  const [busy, setBusy] = useState<string | null>(null);
  const [draftTick, setDraftTick] = useState(0);
  useEffect(() => subscribeDrafts(() => setDraftTick((n) => n + 1)), []);

  const summaryQuery = useQuery({
    queryKey: ["home-summary-v3", scope],
    queryFn: fetchHomeSummaryV3,
    refetchInterval: LIVE_CALLS_POLL_MS,
  });
  const prefsQuery = useQuery({
    queryKey: ["my-preferences", scope],
    queryFn: () => api.getMyPreferences(),
    staleTime: 60_000,
  });

  const favoriteIds = prefsQuery.data?.favorite_people_ids ?? NO_FAVORITES;
  const { pinned, recent } = useMemo(
    () => homeRailConversations(rooms, favoriteIds),
    [rooms, favoriteIds],
  );

  async function openHub(card: CrewCard) {
    if (busy) return;
    setBusy(card.agent_id);
    try {
      onOpenRoom(await ensureAgentHub(card));
    } catch (error) {
      pushToast({
        title: "Couldn't open the hub",
        body: error instanceof Error ? error.message : "Request failed",
        kind: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  const summaryReady = summaryQuery.isSuccess;
  const allCrew = summaryReady ? summaryQuery.data.crew : [];
  const crew = presenterEnabled
    ? allCrew.filter((card) => rule.isIdentityAllowed(card.agent_id, card.display_name))
    : allCrew;

  return (
    <div className="space-y-4" data-testid="home-rail">
      <PresenterHiddenLine
        count={hiddenCount + (presenterEnabled ? allCrew.length - crew.length : 0)}
        className="px-2.5"
      />
      {summaryQuery.isPending ? (
        <div className="space-y-1" data-testid="home-rail-skeleton" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="flex animate-pulse-soft items-center gap-2.5 px-2.5 py-2"
            >
              <div className="h-6 w-6 shrink-0 rounded-full bg-white/[0.05]" />
              <div className="h-2.5 flex-1 rounded bg-white/[0.06]" />
            </div>
          ))}
        </div>
      ) : crew.length > 0 ? (
        <section aria-labelledby="home-rail-crew-heading" data-testid="home-rail-crew">
          <RailHeading id="home-rail-crew-heading">Your crew</RailHeading>
          <ul>
            {crew.map((card) => (
              <li key={card.agent_id}>
                <button
                  type="button"
                  disabled={busy === card.agent_id}
                  onClick={() => void openHub(card)}
                  className="focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-white/[0.04] disabled:opacity-50 md:min-h-0 md:py-1.5"
                  data-testid={`home-rail-crew-${card.agent_id}`}
                >
                  <Identity
                    {...resolveIdentity({
                      participant_id: card.participant_id,
                      participant_type: "agent",
                      display_name: card.display_name,
                      avatar_url: card.avatar_url,
                      id: card.agent_id,
                      username: card.agent_id,
                    })}
                    size={24}
                    alt=""
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100">
                    {card.display_name}
                  </span>
                  <span className="shrink-0 rounded-full bg-stable-purple/15 px-1.5 py-0.5 text-[10px] font-semibold text-stable-purple-light">
                    {modeLabel(card.agent_mode)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {pinned.length > 0 && (
        <section aria-labelledby="home-rail-pinned-heading" data-testid="home-rail-pinned">
          <RailHeading id="home-rail-pinned-heading">Pinned</RailHeading>
          <ul>
            {pinned.map((room) => (
              <li key={room.id}>
                <RoomJump
                  room={room}
                  selfId={selfId}
                  agents={agents}
                  active={room.id === activeRoomId}
                  showDraft={draftTick >= 0 && hasDraft(room.id)}
                  showPreview={!presenterEnabled || rule.isOpenRoom(room.id)}
                  onOpen={onOpenRoom}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="home-rail-recent-heading" data-testid="home-rail-recent">
        <RailHeading id="home-rail-recent-heading">Recent</RailHeading>
        {recent.length === 0 ? (
          <p className="px-2.5 text-xs text-slate-500">No conversations yet.</p>
        ) : (
          <ul>
            {recent.map((room) => (
              <li key={room.id}>
                <RoomJump
                  room={room}
                  selfId={selfId}
                  agents={agents}
                  active={room.id === activeRoomId}
                  showDraft={draftTick >= 0 && hasDraft(room.id)}
                  showPreview={!presenterEnabled || rule.isOpenRoom(room.id)}
                  onOpen={onOpenRoom}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RailHeading({ id, children }: { id: string; children: string }) {
  return (
    <h2
      id={id}
      className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500"
    >
      {children}
    </h2>
  );
}

function RoomJump({
  room,
  selfId,
  agents,
  active,
  showDraft,
  showPreview,
  onOpen,
}: {
  room: Room;
  selfId: string | null;
  agents: Agent[];
  active: boolean;
  showDraft: boolean;
  showPreview: boolean;
  onOpen: (roomId: string) => void;
}) {
  const title = room.display_name || room.name;
  const preview = room.last_message ? previewText(room.last_message.content) : "";
  return (
    <button
      type="button"
      onClick={() => onOpen(room.id)}
      className={clsx(
        "focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-white/[0.04] md:min-h-0 md:py-1.5",
        active && "bg-white/[0.06]",
      )}
    >
      <Identity {...resolveIdentity(room, { selfId, agents })} size={24} alt="" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-slate-100">{title}</span>
          {showDraft && (
            <Pencil className="h-3 w-3 shrink-0 text-slate-400" aria-label="Draft" />
          )}
        </span>
        {preview && showPreview && (
          <span className="block truncate text-[11px] text-slate-500">{preview}</span>
        )}
      </span>
    </button>
  );
}
