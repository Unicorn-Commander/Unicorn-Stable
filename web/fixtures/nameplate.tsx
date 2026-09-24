import { createRoot } from "react-dom/client";
import { CallTileName } from "../src/components/Room/TileNamePlate";
import { StageLowerThird } from "../src/components/Room/LowerThird";
import type { TileNameMode } from "../src/lib/tileChrome";
import "../src/styles/globals.css";

const scene = new URLSearchParams(window.location.search).get("scene") ?? "names-on";
const mode: TileNameMode = scene === "names-off" ? "off" : "always";

function Tile({
  name,
  local,
}: {
  name: string;
  local?: boolean;
}) {
  return (
    <div className="group relative flex aspect-video items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-slate-900">
      <div
        className={
          local
            ? "flex h-16 w-16 items-center justify-center rounded-full bg-violet-900 text-lg font-semibold text-violet-100"
            : "flex h-16 w-16 items-center justify-center rounded-full bg-cyan-950 text-lg font-semibold text-cyan-100"
        }
      >
        {name.slice(0, 1)}
      </div>
      <CallTileName
        name={name}
        isLocal={!!local}
        mode={mode}
        className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] py-0.5"
      />
    </div>
  );
}

function App() {
  return (
    <main
      data-testid="nameplate-stage"
      className="relative flex h-dvh flex-col gap-3 bg-slate-950 p-3 text-white"
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 content-center gap-3 sm:grid-cols-2">
        <Tile name="Aaron Stransky" local />
        <Tile name="Majik" />
      </div>
      {scene === "lower-third" ? (
        <StageLowerThird
          optedIn
          layout="stage"
          speakerId="majik"
          name="Majik"
          subtitle="Show host"
          holdMs={60_000}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
