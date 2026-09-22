import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { MoreVertical } from "lucide-react";
import { beginThread, openAgentHub } from "@/lib/beginThread";

/** ⋯ on a crew card: open the hub, or start a thread under it. */
export function CrewThreadMenu({ agentId, name }: { agentId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <span className="absolute right-2 top-1/2 z-10 -translate-y-1/2">
      <button
        type="button"
        aria-label={`More for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="focus-ring rounded-md p-1.5 text-slate-500 hover:bg-white/[0.06] hover:text-slate-200"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <span
          role="menu"
          className="glass-heavy absolute right-0 top-full z-20 mt-1 w-56 rounded-xl p-1 shadow-pop"
        >
          <button
            type="button"
            role="menuitem"
            className="focus-ring w-full rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/[0.06]"
            onClick={() => {
              setOpen(false);
              void openAgentHub(agentId, navigate);
            }}
          >
            Open {name}
          </button>
          <button
            type="button"
            role="menuitem"
            className="focus-ring w-full rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/[0.06]"
            onClick={() => {
              setOpen(false);
              void openAgentHub(agentId).then((hub) => {
                if (hub) void beginThread({ roomId: hub.id, navigate });
              });
            }}
          >
            New thread with {name}
          </button>
        </span>
      )}
    </span>
  );
}
