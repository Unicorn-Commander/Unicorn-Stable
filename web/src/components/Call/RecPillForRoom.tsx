import { RecPillLive } from "@/components/Call/RecPill";
import { useAppStore } from "@/stores/appStore";

/** Member call bar / phone top pills. Resolves "started by" from the room roster. */
export function RecPillForRoom({
  roomId,
  className,
}: {
  roomId: string;
  className?: string;
}) {
  const members = useAppStore((s) => s.participants[roomId]);
  return <RecPillLive roomId={roomId} members={members} className={className} />;
}
