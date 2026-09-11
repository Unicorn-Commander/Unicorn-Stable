/** Feature detection keeps browsers without the Audio Session API unchanged. */
export function enterDuplexSession(nav: unknown = navigator): () => void {
  const session = (nav as { audioSession?: { type: string } }).audioSession;
  if (!session) return () => {};
  const previous = session.type;
  try {
    session.type = "play-and-record";
  } catch {
    return () => {};
  }
  return () => {
    try {
      if (session.type === "play-and-record") session.type = previous;
    } catch {
      /* unsupported */
    }
  };
}
export async function recoverCallAudio(
  room: {
    localParticipant: {
      isMicrophoneEnabled: boolean;
      getTrackPublication: (
        source: any,
      ) => { track?: { restartTrack: () => Promise<void> } } | undefined;
    };
    startAudio: () => Promise<void>;
  },
  microphoneSource: unknown,
) {
  // Never enable an intentionally muted microphone. restartTrack retains its
  // capture options, including an explicitly selected input.
  if (room.localParticipant.isMicrophoneEnabled) {
    await room.localParticipant
      .getTrackPublication(microphoneSource)
      ?.track?.restartTrack();
  }
  await room.startAudio();
}
