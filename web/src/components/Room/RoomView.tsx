import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { ChatPanel } from "./ChatPanel";
import { ParticipantStrip } from "./ParticipantStrip";
import { StageView } from "./StageView";
import { VoiceVideoBar } from "./VoiceVideoBar";

interface RoomViewProps {
  roomId: string;
}

export function RoomView({ roomId }: RoomViewProps) {
  const participantPanelOpen = useAppStore((s) => s.ui.participantPanelOpen);
  const stageAgentId = useAppStore((s) => s.ui.stageAgentId);
  const voiceActive = useAppStore((s) => s.voiceActive);
  const setParticipants = useAppStore((s) => s.setParticipants);

  const { data: roomDetail } = useQuery({
    queryKey: ["room", roomId],
    queryFn: () => api.getRoom(roomId),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (roomDetail?.members) {
      setParticipants(roomId, roomDetail.members);
    }
  }, [roomDetail, roomId, setParticipants]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
          {participantPanelOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 240, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              className="shrink-0 overflow-hidden border-l border-slate-700/50"
            >
              <ParticipantStrip roomId={roomId} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
