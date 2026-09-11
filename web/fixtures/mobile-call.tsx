import { createRoot } from "react-dom/client";
import { useEffect, useRef } from "react";
import { PortraitCallStage } from "../src/components/Room/PortraitCallStage";
import { useIsLandscape } from "../src/hooks/useIsLandscape";
import { shouldUsePortraitStage } from "../src/lib/portraitCall";
import "../src/styles/globals.css";
function Video({ self = false }: { self?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 432;
    canvas.height = 768;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = self ? "#194450" : "#35145b";
    ctx.fillRect(0, 0, 432, 768);
    ctx.fillStyle = self ? "#82efe2" : "#d6b2ff";
    ctx.beginPath();
    ctx.ellipse(216, 330, 130, 195, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#19122b";
    ctx.fillRect(160, 280, 20, 25);
    ctx.fillRect(260, 280, 20, 25);
    ctx.fillRect(190, 380, 50, 8);
    ctx.fillStyle = "white";
    ctx.font = "22px sans-serif";
    ctx.fillText(
      self ? "Self-view fixture" : "432 × 768 portrait fixture",
      75,
      650,
    );
    const stream = canvas.captureStream(1);
    ref.current!.srcObject = stream;
    return () => stream.getTracks().forEach((t) => t.stop());
  }, [self]);
  return (
    <video
      data-testid={self ? "self-video" : "remote-video"}
      ref={ref}
      autoPlay
      muted
      playsInline
      className="h-full w-full object-cover"
    />
  );
}
function App() {
  const landscape = useIsLandscape();
  const portrait = shouldUsePortraitStage({
    desktop: false,
    landscape,
    mode: "video",
    remoteCount: 1,
    screenCount: 0,
    view: "grid",
    chips: false,
  });
  return (
    <main
      style={{
        height: "100dvh",
        display: "flex",
        background: "#080810",
        color: "white",
      }}
    >
      {portrait ? (
        <PortraitCallStage remote={<Video />} self={<Video self />} />
      ) : (
        <div
          data-testid="landscape-grid"
          className="grid h-full w-full grid-cols-2 gap-3 p-3"
        >
          <Video />
          <Video self />
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
