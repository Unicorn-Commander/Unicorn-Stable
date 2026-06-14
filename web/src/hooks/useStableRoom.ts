import { useState, useEffect, useCallback, useRef } from "react";
import { Room, RoomEvent, ConnectionState } from "livekit-client";
import type { RemoteParticipant, LocalParticipant } from "livekit-client";
import { api } from "@/services/api";
import { useAppStore } from "@/stores/appStore";

interface UseStableRoomReturn {
  room: Room | null;
  localParticipant: LocalParticipant | null;
  remoteParticipants: RemoteParticipant[];
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

export function useStableRoom(roomId: string | null): UseStableRoomReturn {
  const [room, setRoom] = useState<Room | null>(null);
  const [localParticipant, setLocalParticipant] = useState<LocalParticipant | null>(null);
  const [remoteParticipants, setRemoteParticipants] = useState<RemoteParticipant[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const setVoiceActive = useAppStore((s) => s.setVoiceActive);

  const updateParticipants = useCallback((lkRoom: Room) => {
    setLocalParticipant(lkRoom.localParticipant);
    setRemoteParticipants(Array.from(lkRoom.remoteParticipants.values()));
  }, []);

  const connect = useCallback(async () => {
    if (!roomId || isConnecting) return;

    setIsConnecting(true);
    setError(null);

    try {
      const { token, ws_url } = await api.getLiveKitToken(roomId);

      const lkRoom = new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: { width: 1280, height: 720, frameRate: 30 },
        },
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      roomRef.current = lkRoom;

      lkRoom.on(RoomEvent.Connected, () => {
        setIsConnected(true);
        setIsConnecting(false);
        setVoiceActive(true);
        updateParticipants(lkRoom);
      });

      lkRoom.on(RoomEvent.Disconnected, () => {
        setIsConnected(false);
        setVoiceActive(false);
        updateParticipants(lkRoom);
      });

      lkRoom.on(RoomEvent.Reconnecting, () => {
        setIsConnecting(true);
      });

      lkRoom.on(RoomEvent.Reconnected, () => {
        setIsConnecting(false);
        setIsConnected(true);
        updateParticipants(lkRoom);
      });

      lkRoom.on(RoomEvent.ParticipantConnected, () => {
        updateParticipants(lkRoom);
      });

      lkRoom.on(RoomEvent.ParticipantDisconnected, () => {
        updateParticipants(lkRoom);
      });

      lkRoom.on(RoomEvent.TrackSubscribed, () => {
        updateParticipants(lkRoom);
      });

      lkRoom.on(RoomEvent.TrackUnsubscribed, () => {
        updateParticipants(lkRoom);
      });

      lkRoom.on(RoomEvent.LocalTrackPublished, () => {
        updateParticipants(lkRoom);
      });

      lkRoom.on(RoomEvent.LocalTrackUnpublished, () => {
        updateParticipants(lkRoom);
      });

      lkRoom.on(RoomEvent.TrackMuted, () => {
        updateParticipants(lkRoom);
      });

      lkRoom.on(RoomEvent.TrackUnmuted, () => {
        updateParticipants(lkRoom);
      });

      lkRoom.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        setIsConnected(state === ConnectionState.Connected);
        setIsConnecting(state === ConnectionState.Reconnecting);
      });

      await lkRoom.connect(ws_url, token);
      setRoom(lkRoom);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect to room";
      setError(message);
      setIsConnecting(false);
    }
  }, [roomId, isConnecting, setVoiceActive, updateParticipants]);

  const disconnect = useCallback(() => {
    if (roomRef.current) {
      roomRef.current.disconnect();
      roomRef.current = null;
    }
    setRoom(null);
    setLocalParticipant(null);
    setRemoteParticipants([]);
    setIsConnected(false);
    setIsConnecting(false);
    setVoiceActive(false);
  }, [setVoiceActive]);

  useEffect(() => {
    return () => {
      if (roomRef.current) {
        roomRef.current.disconnect();
        roomRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!roomId) {
      disconnect();
    }
  }, [roomId, disconnect]);

  return {
    room,
    localParticipant,
    remoteParticipants,
    isConnected,
    isConnecting,
    error,
    connect,
    disconnect,
  };
}
