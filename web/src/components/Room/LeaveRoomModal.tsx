import { LogOut } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface LeaveRoomModalProps {
  roomName: string;
  leaving: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * In-app confirmation for leaving a room. Thin wrapper over ConfirmDialog
 * (generalized from this modal's original markup) so every destructive flow
 * shares one primitive.
 */
export function LeaveRoomModal({
  roomName,
  leaving,
  onConfirm,
  onClose,
}: LeaveRoomModalProps) {
  return (
    <ConfirmDialog
      title="Leave room?"
      message={
        <>
          Leave <span className="font-semibold text-slate-100">{roomName}</span>?
          You can rejoin from Browse channels.
        </>
      }
      confirmLabel="Leave"
      busyLabel="Leaving…"
      busy={leaving}
      icon={LogOut}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
