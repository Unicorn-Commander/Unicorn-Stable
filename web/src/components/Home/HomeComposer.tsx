import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  defaultComposerSeat,
  startConversation,
  titleSource,
} from "@/lib/homeComposer";
import { seatPatchBody } from "@/lib/seatSettings";
import type { CallKind } from "@/lib/callEntry";
import { useAppStore } from "@/stores/appStore";
import { useConversationUi } from "@/stores/conversationUiStore";
import { useFederationStore } from "@/stores/federationStore";
import { clearDraft, getDraft, saveDraft } from "@/utils/drafts";
import { SeatPicker } from "./SeatPicker";

/** Home's one draft. Not a room id: no sidebar row ever reads it. */
export const HOME_DRAFT_KEY = "home:composer";

const DEFAULT_BRAIN: RoomSeat = { model: null, effort: null };

/**
 * Home's composer (Nav v3 §2.7): the room's composer, with who the message
 * is for at its left and the conversation's brain at its right. Enter starts
 * a new conversation with that seat — a thread under its hub — and goes
 * there. A partner's seat has no hub of yours: the message goes into the
 * room you share, and the line under the box says which before it is sent.
 */
export function HomeComposer({
  pinned = false,
  className,
}: {
  /** Pinned above the phone's tab bar: menus open upward, the padding is the bar's. */
  pinned?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scope = useFederationStore((s) => s.activeInstanceId);
  const rooms = useAppStore((s) => s.rooms);
  const roster = useAppStore((s) => s.agents);
  const currentParticipantId = useAppStore((s) => s.currentParticipantId);
  const currentUserId = useAppStore((s) => s.currentUser?.id);
  const focusNonce = useConversationUi((s) => s.homeComposerNonce);
  const { crew, loaded, crewAnswered } = useCrew();
  const preferences = useQuery({
    queryKey: ["my-preferences", scope],
    queryFn: () => api.getMyPreferences(),
    staleTime: 60_000,
  });

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [brains, setBrains] = useState<Record<string, RoomSeat>>({});
  const [brainOpen, setBrainOpen] = useState(false);

  // The default seat needs both answers; until then nothing is addressed,
  // so a fast Enter cannot go to the wrong seat. A preferences request that
  // has failed once is not waited for: the default agent is a preference,
  // and the composer is not.
  const loading = !loaded || (preferences.isPending && preferences.failureCount === 0);
  const seats = useMemo(() => (loading ? [] : composerSeats(crew, roster)), [loading, crew, roster]);
  const selected: CrewMember | null = useMemo(
    () =>
      seats.find((seat) => seat.agent_id === pickedId) ??
      defaultComposerSeat(seats, preferences.data?.default_agent_id ?? null),
    [seats, pickedId, preferences.data?.default_agent_id],
  );
  const target = useMemo(
    () => composerTarget(selected, rooms, [currentParticipantId, currentUserId], crewAnswered),
    [selected, rooms, currentParticipantId, currentUserId, crewAnswered],
  );
  const line = loading ? null : composerTargetLine(target);
  const brain = (selected && brains[selected.agent_id]) || DEFAULT_BRAIN;
  const sharedRoom =
    target.kind === "shared_room" ? rooms.find((room) => room.id === target.roomId) ?? null : null;

  const send = useCallback(
    async (
      content: string,
      _threadId?: string,
      attachments?: { url: string; filename: string; content_type: string; size: number }[],
      extraMetadata?: Record<string, unknown>,
    ): Promise<boolean> => {
      if (!selected) return false;
      const result = await startConversation(
        {
          ensureHub: (agentId) => api.ensureAgentHub(agentId),
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
          titleFrom: titleSource(getDraft(HOME_DRAFT_KEY), content),
        },
      );

      if (result.status === "failed") {
        useAppStore.getState().pushToast({
          ...conversationFailureNotice(result, selected.display_name),
          kind: "error",
        });
        return false;
      }

      // The conversation exists: the rail and the room know it before the
      // next poll does.
      const state = useAppStore.getState();
      if (result.hub) {
        if (state.rooms.some((room) => room.id === result.hub!.id)) state.updateRoom(result.hub.id, result.hub);
        else state.upsertRoom(result.hub);
      }
      if (result.thread) {
        const parentId = result.thread.parent_room_id;
        if (parentId) {
          state.setRooms(noteThreadOnParent(useAppStore.getState().rooms, parentId, result.thread));
        }
        if (!useAppStore.getState().rooms.some((room) => room.id === result.thread!.id)) {
          useAppStore.getState().upsertRoom(result.thread);
        }
      }
      void queryClient.invalidateQueries({ queryKey: ["rooms", scope] });
      void queryClient.invalidateQueries({ queryKey: ["crew", scope] });
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
        navigate(`/c/${result.roomId}`);
        return true;
      }

      // Not sent, and there is a conversation to be in: what was typed (as
      // typed, a command still a command) and what was attached go there.
      saveDraft(result.roomId, getDraft(HOME_DRAFT_KEY) || content);
      if (attachments?.length) {
        useConversationUi.getState().handAttachments(result.roomId, attachments);
      }
      clearDraft(HOME_DRAFT_KEY);
      useAppStore.getState().pushToast({
        ...conversationFailureNotice(result, selected.display_name),
        kind: "error",
      });
      navigate(`/c/${result.roomId}`);
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

  return (
    // Raised: the box has a backdrop filter, which pens its menus' layers
    // inside it, and what follows on the page is positioned too.
    <div
      className={clsx("relative z-20 min-w-0", className)}
      data-testid="home-composer"
      data-target={target.kind}
    >
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
              setPickedId(seat.agent_id);
              setBrainOpen(false);
            }}
          />
        }
        trailing={chip}
        call={call}
        blockedReason={loading ? "Loading your crew" : target.kind === "none" ? target.reason : null}
        focusNonce={focusNonce}
        menus={pinned ? "above" : "below"}
        className={pinned ? "px-2 pb-2 pt-1.5 sm:px-3" : "px-0 py-0"}
      />
      {line && (
        <p
          className={clsx(
            "mx-auto w-full max-w-[52rem] text-[11px] leading-snug",
            pinned ? "px-4 pb-1.5" : "px-2 pt-1.5",
            target.kind === "none" ? "text-stable-gold" : "text-slate-500",
          )}
          data-testid="home-composer-line"
        >
          {line}
        </p>
      )}
    </div>
  );
}
