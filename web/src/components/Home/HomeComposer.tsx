import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api, type CrewMember, type RoomSeat } from "@/services/api";
import { MessageInput } from "@/components/Room/MessageInput";
import { SeatSettings } from "@/components/Room/SeatSettings";
import { useCrew } from "@/hooks/useCrew";
import { canEditSeat, isRunnerSeat } from "@/lib/crew";
import { noteThreadOnParent } from "@/lib/conversation";
import {
  composerSeats,
  composerTarget,
  composerTargetLine,
  conversationFailureNotice,
  firstRunIntro,
  HOME_STARTERS,
  openingSeat,
  readLastSeat,
  startConversation,
  titleSource,
  writeLastSeat,
} from "@/lib/homeComposer";
import { seatPatchBody } from "@/lib/seatSettings";
import { sendFingerprint } from "@/lib/sendPipeline";
import type { CallKind } from "@/lib/callEntry";
import { useAppStore } from "@/stores/appStore";
import { useConversationUi } from "@/stores/conversationUiStore";
import { useFederationStore } from "@/stores/federationStore";
import { clearDraft, getDraft, saveDraft } from "@/utils/drafts";
import { SeatPicker } from "./SeatPicker";
import { usePresentedRooms } from "@/hooks/usePresentedRooms";

/** Home's one draft. Not a room id: no sidebar row ever reads it. */
export const HOME_DRAFT_KEY = "home:composer";

const DEFAULT_BRAIN: RoomSeat = { model: null, effort: null };

/** What the composer says while /crew is failing: it waits rather than re-address. */
export const CREW_UNAVAILABLE = "Crew unavailable — retrying";

function isTouch(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)")?.matches ?? false);
}

/**
 * Home's composer (Nav v3 §2.7): the room's composer, with who the message
 * is for at its left and the conversation's brain at its right. Enter starts
 * a new conversation with that seat — a thread under its hub — and goes
 * there. A partner's seat has no hub of yours: the message goes into the
 * room you share, and the line under the box says which before it is sent.
 */
export function HomeComposer({
  pinned = false,
  starters = false,
  firstRun = false,
  className,
}: {
  /** Pinned above the phone's tab bar: menus open upward, the padding is the bar's. */
  pinned?: boolean;
  /** A quiet page: three prompts to start from, under the box (above it when pinned). */
  starters?: boolean;
  /** No conversations yet: the line under the box says who Sidekick is. */
  firstRun?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  // A send can outlive Home (a slow network, a click elsewhere): it goes to
  // the conversation only while Home is still what is on screen (review 2,
  // P2-5); otherwise it says where the message went.
  const mounted = useRef(true);
  const path = useRef(location.pathname);
  path.current = location.pathname;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const scope = useFederationStore((s) => s.activeInstanceId);
  const rooms = useAppStore((s) => s.rooms);
  const roster = useAppStore((s) => s.agents);
  const currentParticipantId = useAppStore((s) => s.currentParticipantId);
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  const focusNonce = useConversationUi((s) => s.homeComposerNonce);
  const { crew, loaded, crewAnswered, unavailable } = useCrew();
  const {
    enabled: presenterEnabled,
    rooms: presentedRooms,
    rule: presenterRule,
  } = usePresentedRooms();
  const visibleRooms = presenterEnabled ? presentedRooms : rooms;
  const visibleRoster = presenterEnabled
    ? roster.filter((agent) => presenterRule.isIdentityAllowed(agent.id, agent.display_name || agent.name))
    : roster;
  const preferences = useQuery({
    queryKey: ["my-preferences", scope],
    queryFn: () => api.getMyPreferences(),
    staleTime: 60_000,
  });

  // The last seat picked on this device, per server (ruling 9): read once
  // per server, written on every pick.
  const [picked, setPicked] = useState(() => ({ scope, id: readLastSeat(scope) }));
  const pickedId = picked.scope === scope ? picked.id : readLastSeat(scope);
  const [brains, setBrains] = useState<Record<string, RoomSeat>>({});
  const [brainOpen, setBrainOpen] = useState(false);
  const [fill, setFill] = useState<{ text: string; nonce: number } | null>(null);

  // The default seat needs both answers; until then nothing is addressed,
  // so a fast Enter cannot go to the wrong seat. A preferences request that
  // has failed once is not waited for: the default agent is a preference,
  // and the composer is not. A /crew that is failing holds the box too: the
  // roster's house is not who you meant (review 2, P2-7).
  const loading = !loaded || unavailable || (preferences.isPending && preferences.failureCount === 0);
  const seats = useMemo(() => {
    if (loading) return [];
    const allSeats = composerSeats(crew, visibleRoster);
    return presenterEnabled
      ? allSeats.filter((seat) => presenterRule.isIdentityAllowed(seat.agent_id, seat.display_name))
      : allSeats;
  }, [loading, crew, visibleRoster, presenterEnabled, presenterRule]);
  const selected: CrewMember | null = useMemo(
    () => openingSeat(seats, pickedId, preferences.data?.default_agent_id ?? null),
    [seats, pickedId, preferences.data?.default_agent_id],
  );
  const target = useMemo(
    () => composerTarget(selected, visibleRooms, [currentParticipantId, currentUserId], crewAnswered),
    [selected, visibleRooms, currentParticipantId, currentUserId, crewAnswered],
  );
  const intro = firstRun && !loading ? firstRunIntro(selected, isTouch()) : null;
  const line = unavailable ? CREW_UNAVAILABLE : loading ? null : (composerTargetLine(target) ?? intro);
  const brain = (selected && brains[selected.agent_id]) || DEFAULT_BRAIN;
  const sharedRoom =
    target.kind === "shared_room" ? visibleRooms.find((room) => room.id === target.roomId) ?? null : null;

  const send = useCallback(
    async (
      content: string,
      _threadId?: string,
      attachments?: { url: string; filename: string; content_type: string; size: number }[],
      extraMetadata?: Record<string, unknown>,
    ): Promise<boolean> => {
      if (!selected) return false;
      const startedOn = path.current;
      const stillHere = () => mounted.current && path.current === startedOn;
      const typed = getDraft(HOME_DRAFT_KEY);
      const result = await startConversation(
        {
          ensureHub: (agentId) => api.ensureAgentHub(agentId),
          setArchived: (roomId, archived) => api.updateRoom(roomId, { is_archived: archived }),
          createThread: (hubId, body) => api.createThread(hubId, body),
          setSeat: (roomId, agentId, seat) => api.updateRoom(roomId, seatPatchBody(agentId, seat)),
          post: (roomId, body) => api.sendMessage(roomId, body),
        },
        {
          target,
          content,
          attachments,
          extraMetadata,
          seat: canEditSeat(selected) ? brain : null,
          titleFrom: titleSource(typed, content),
        },
      );

      // What exists now is in the list before the next poll: a hub made (or
      // reopened) on the way, and the conversation — carrying the brain it
      // was given, so its chip says so from the first frame (review 2, P2-2).
      const state = useAppStore.getState();
      const hub = result.hub;
      if (hub) {
        if (state.rooms.some((room) => room.id === hub.id)) state.updateRoom(hub.id, hub);
        else state.upsertRoom(hub);
      }
      const thread = result.status === "failed" ? result.left : result.thread;
      if (thread) {
        const parentId = thread.parent_room_id;
        if (parentId) {
          state.setRooms(noteThreadOnParent(useAppStore.getState().rooms, parentId, thread));
        }
        if (!useAppStore.getState().rooms.some((room) => room.id === thread.id)) {
          useAppStore.getState().upsertRoom(thread);
        }
      }
      if (hub || thread) {
        void queryClient.invalidateQueries({ queryKey: ["rooms", scope] });
        void queryClient.invalidateQueries({ queryKey: ["crew", scope] });
      }

      if (result.status === "failed") {
        // Nothing was posted, and nothing empty is left (it was taken back):
        // the box keeps the text and the files.
        useAppStore.getState().pushToast({
          ...conversationFailureNotice(result, selected.display_name),
          kind: "error",
        });
        return false;
      }
      void queryClient.invalidateQueries({ queryKey: ["home-summary-v3"] });

      if (result.status === "sent") {
        useAppStore.getState().addMessage(result.roomId, result.message);
        useAppStore.getState().clearUnread(result.roomId);
        // The first conversation with an agent is the checklist's "agent" step.
        const checklist = preferences.data?.onboarding_checklist;
        if (target.kind === "new_conversation" && checklist?.agent !== true) {
          void api
            .setOnboardingChecklist({ ...(checklist ?? {}), agent: true })
            .then(() => queryClient.invalidateQueries({ queryKey: ["my-preferences", scope] }))
            .catch(() => {
              /* A checklist that did not save is not the message's problem. */
            });
        }
        if (stillHere()) {
          navigate(`/c/${result.roomId}`);
        } else {
          useAppStore.getState().pushToast({
            title: `Sent to ${selected.display_name}`,
            body: "Open the conversation",
            roomId: result.roomId,
            kind: "success",
          });
        }
        return true;
      }

      // The post got no answer and may have landed. The conversation stays;
      // what was typed (a command still a command), the files and the send's
      // id go there, so sending it again cannot post it twice (P2-6).
      saveDraft(result.roomId, typed || content);
      if (attachments?.length) {
        useConversationUi.getState().handAttachments(result.roomId, attachments);
      }
      useConversationUi.getState().handSend(result.roomId, {
        clientMsgId: result.clientMsgId,
        fingerprint: sendFingerprint(content, attachments, extraMetadata),
      });
      clearDraft(HOME_DRAFT_KEY);
      const opened = stillHere();
      useAppStore.getState().pushToast({
        ...conversationFailureNotice(result, selected.display_name, opened),
        ...(opened ? {} : { roomId: result.roomId }),
        kind: "error",
      });
      if (opened) navigate(`/c/${result.roomId}`);
      return true;
    },
    [selected, target, brain, navigate, queryClient, scope, preferences.data?.onboarding_checklist],
  );

  // A call reaches a house agent in its hub. A seat takes no calls until
  // voice ships, and a call into a shared room would ring its people.
  const call = useMemo(() => {
    if (!selected || target.kind !== "new_conversation" || isRunnerSeat(selected)) return null;
    return {
      onCall: (kind: CallKind) => {
        void (async () => {
          try {
            const hubId = target.hubRoomId ?? (await api.ensureAgentHub(target.agentId)).id;
            navigate(`/c/${hubId}?join=1&kind=${kind}`);
          } catch (error) {
            useAppStore.getState().pushToast({
              title: `Couldn't call ${selected.display_name}`,
              body: (error as { detail?: string; message?: string }).detail || (error as Error).message || "Request failed",
              kind: "error",
            });
          }
        })();
      },
    };
  }, [selected, target, navigate]);

  const chip =
    selected && isRunnerSeat(selected) ? (
      canEditSeat(selected) ? (
        <SeatSettings
          variant="composer"
          match={{
            member: selected,
            participantId: selected.participant_id,
            editable: true,
            agentMode: null,
          }}
          open={brainOpen}
          onOpenChange={setBrainOpen}
          draft={{
            seat: brain,
            onChange: (next) => setBrains((current) => ({ ...current, [selected.agent_id]: next })),
          }}
        />
      ) : (
        <SeatSettings
          variant="composer"
          roomId={sharedRoom?.id}
          room={sharedRoom}
          match={{
            member: selected,
            participantId: selected.participant_id,
            editable: false,
            agentMode: null,
          }}
          open={false}
          onOpenChange={() => {}}
          labelled
        />
      )
    ) : null;

  // A quiet page's three prompts (review 2, D4): a pick fills the box and
  // sends nothing. On a phone they sit above the pinned box, in one row
  // that scrolls; on a wider screen, under it.
  const starterRow =
    starters && selected && !loading ? (
      <div
        className={clsx(
          "mx-auto flex w-full max-w-[52rem] gap-1.5",
          pinned
            ? "overflow-x-auto px-2 pb-0.5 pt-2 [scrollbar-width:none] sm:px-3"
            : "flex-wrap px-1 pt-3",
        )}
        role="group"
        aria-label="Start from"
        data-testid="home-starters"
      >
        {HOME_STARTERS.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => setFill((current) => ({ text, nonce: (current?.nonce ?? 0) + 1 }))}
            className="focus-ring shrink-0 rounded-full border border-line bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-line-strong hover:bg-white/[0.05] hover:text-slate-100 pointer-coarse:min-h-11"
            data-testid="home-starter"
          >
            {text}
          </button>
        ))}
      </div>
    ) : null;

  return (
    // Raised: the box has a backdrop filter, which pens its menus' layers
    // inside it, and what follows on the page is positioned too.
    <div
      className={clsx("relative z-20 min-w-0", className)}
      data-testid="home-composer"
      data-target={target.kind}
    >
      {pinned && starterRow}
      <MessageInput
        roomId={null}
        draftKey={HOME_DRAFT_KEY}
        onSend={send}
        placeholder={selected ? `Message ${selected.display_name}…` : "Message…"}
        leading={
          <SeatPicker
            seats={seats}
            selected={selected}
            loading={loading}
            onSelect={(seat) => {
              setPicked({ scope, id: seat.agent_id });
              writeLastSeat(scope, seat.agent_id);
              setBrainOpen(false);
            }}
          />
        }
        trailing={chip}
        call={call}
        blockedReason={
          unavailable
            ? CREW_UNAVAILABLE
            : loading
              ? "Loading your crew"
              : target.kind === "none"
                ? target.reason
                : null
        }
        focusNonce={focusNonce}
        fill={fill}
        menus={pinned ? "above" : "below"}
        className={pinned ? "px-1.5 pb-2 pt-1.5 sm:px-3" : "px-0 py-0"}
      />
      {line && (
        <p
          className={clsx(
            "mx-auto w-full max-w-[52rem] text-[11px] leading-snug",
            pinned ? "px-4 pb-1.5" : "px-2 pt-1.5",
            target.kind === "none" || unavailable ? "text-stable-gold" : "text-slate-500",
          )}
          data-testid="home-composer-line"
        >
          {line}
        </p>
      )}
      {!pinned && starterRow}
    </div>
  );
}
