import { Plus, LoaderCircle } from "lucide-react";
import clsx from "clsx";
import { useFederationStore } from "@/stores/federationStore";
import { identityFor } from "@/lib/identity";

export function ServerRail({ mobile = false }: { mobile?: boolean }) {
  const instances = useFederationStore((state) => state.accessibleInstances);
  const activeId = useFederationStore((state) => state.activeInstanceId);
  const switching = useFederationStore((state) => state.switching);
  const switchInstance = useFederationStore((state) => state.switchInstance);
  const setAddServerOpen = useFederationStore((state) => state.setAddServerOpen);
  const unreadByInstance = useFederationStore((state) => state.unreadByInstance);

  // The rail only earns its space when the user can reach more than one server.
  if (instances.length <= 1) return null;

  return (
    <div
      className={clsx(
        mobile
          ? "flex h-16 w-full items-center gap-2 overflow-x-auto border-b border-slate-700/50 px-3 md:hidden"
          : "hidden h-full w-[72px] shrink-0 flex-col items-center gap-3 border-r border-slate-700/50 bg-slate-950/60 py-3 md:flex",
      )}
      aria-label="Stable servers"
    >
      {instances.map((instance) => {
        const active = instance.id === activeId;
        const ident = identityFor(instance.id, instance.name);
        const isImg = instance.icon?.startsWith("http");
        const unread = unreadByInstance[instance.id] ?? 0;
        return (
          <button
            key={instance.id}
            title={instance.name}
            aria-label={`Switch to ${instance.name}${unread > 0 ? ` — ${unread} unread` : ""}`}
            aria-current={active ? "true" : undefined}
            disabled={switching}
            onClick={() => void switchInstance(instance.id)}
            className={clsx(
              "group relative flex shrink-0 items-center justify-center rounded-2xl text-sm font-semibold transition-all hover:rounded-xl disabled:opacity-60",
              mobile ? "h-10 w-10" : "h-12 w-12",
              active && "rounded-xl",
            )}
            style={
              isImg
                ? active
                  ? { boxShadow: `0 0 0 2px ${ident.color}` }
                  : undefined
                : {
                    background: active ? ident.color : ident.soft,
                    color: active ? "#ffffff" : ident.text,
                  }
            }
          >
            {isImg ? (
              <img
                src={instance.icon}
                alt=""
                className="h-full w-full rounded-[inherit] object-cover"
              />
            ) : instance.icon ? (
              instance.icon
            ) : (
              instance.name.slice(0, 1).toUpperCase()
            )}
            {active && !mobile && (
              <span className="absolute -left-3 top-1/2 h-8 w-1 -translate-y-1/2 rounded-r bg-white" />
            )}
            {!active && unread > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full border border-slate-950 bg-rose-500 px-1 text-[10px] font-bold leading-none text-white">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        );
      })}
      <button
        title="Add a server"
        aria-label="Add a server"
        onClick={() => setAddServerOpen(true)}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-dashed border-slate-600 text-slate-400 transition-colors hover:rounded-xl hover:border-stable-purple hover:text-white"
      >
        <Plus className="h-5 w-5" />
      </button>
      {switching && (
        <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-slate-400" />
      )}
    </div>
  );
}
