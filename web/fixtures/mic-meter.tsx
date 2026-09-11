import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { LiveMicMeter } from "../src/components/Call/LiveMicMeter";
import "../src/styles/globals.css";
function App() {
  const [track, setTrack] = useState<MediaStreamTrack>();
  const [muted, setMuted] = useState(false);
  const gain = useRef<GainNode>();
  return (
    <main
      style={{
        padding: 28,
        background: "#121222",
        color: "white",
        minHeight: "100dvh",
      }}
    >
      <h1>Call microphone — isolated fixture</h1>
      <p>Synthetic signal; no microphone permission or live call.</p>
      <button className="m-1 rounded border border-slate-500 px-3 py-2"
        onClick={() => {
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          const volume = context.createGain();
          volume.gain.value = 0.08;
          gain.current = volume;
          const output = context.createMediaStreamDestination();
          oscillator.connect(volume).connect(output);
          oscillator.start();
          setTrack(output.stream.getAudioTracks()[0]);
        }}
      >
        Start signal
      </button>
      <button className="m-1 rounded border border-slate-500 px-3 py-2"
        onClick={() => {
          if (gain.current) gain.current.gain.value = 0;
        }}
      >
        Silence
      </button>
      <button onClick={() => setMuted((v) => !v)}>Toggle mute</button>
      <LiveMicMeter track={track} muted={muted} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
