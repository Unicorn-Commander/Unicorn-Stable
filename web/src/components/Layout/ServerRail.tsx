import { Plus, LoaderCircle } from "lucide-react";
import clsx from "clsx";
import { useFederationStore } from "@/stores/federationStore";

export function ServerRail({ mobile = false }: { mobile?: boolean }) {
  const instances = useFederationStore((state) => state.accessibleInstances);
  const activeId = useFederationStore((state) => state.activeInstanceId);
  const switching = useFederationStore((state) => state.switching);
  const switchInstance = useFederationStore((state) => state.switchInstance);
  const addInstance = useFederationStore((state) => state.addInstance);

  if (instances.length <= 1) return null;

  const addServer = () => {
    const origin = window.prompt("Stable instance URL");
    if (!origin) return;
    void addInstance(origin);
  };

  return (
    <div className={clsx(mobile ? "flex h-16 w-full items-center gap-2 overflow-x-auto border-b border-slate-700/50 px-3 md:hidden" : "hidden h-full w-[72px] shrink-0 flex-col items-center gap-3 border-r border-slate-700/50 bg-slate-950/60 py-3 md:flex")} aria-label="Stable instances">
      {instances.map((instance) => {
        const active = instance.id === activeId;
        return (
          <button key={instance.id} title={instance.name} aria-label={`Switch to ${instance.name}`} disabled={switching} onClick={() => void switchInstance(instance.id)} className={clsx("group relative flex shrink-0 items-center justify-center rounded-2xl bg-slate-800 text-sm font-semibold text-slate-200 transition-all hover:rounded-xl hover:bg-stable-purple", mobile ? "h-10 w-10" : "h-12 w-12", active && "rounded-xl bg-stable-purple ring-2 ring-stable-purple-light ring-offset-2 ring-offset-slate-950")}>
            {instance.icon?.startsWith("http") ? <img src={instance.icon} alt="" className="h-full w-full rounded-[inherit] object-cover" /> : instance.icon ?? instance.name.slice(0, 1).toUpperCase()}
            {active && <span className="absolute -left-3 h-8 w-1 rounded-r bg-white" />}
          </button>
        );
      })}
      <button title="Add server" aria-label="Add server" onClick={addServer} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-dashed border-slate-600 text-slate-400 transition-colors hover:border-stable-purple hover:text-white"><Plus className="h-5 w-5" /></button>
      {switching && <LoaderCircle className="h-4 w-4 animate-spin text-slate-400" />}
    </div>
  );
}
