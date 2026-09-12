import { Phone } from "lucide-react";
export function CallStartMenu({ onRing, onQuiet }: { onRing: () => void; onQuiet: () => void }) {
  return <details className="relative shrink-0" onKeyDown={(event) => {
    if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
  }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false; }}>
    <summary aria-label="Call options" title="Call options" className="focus-ring cursor-pointer list-none rounded-lg p-2.5 text-emerald-400 [&::-webkit-details-marker]:hidden"><Phone className="h-4 w-4" /></summary>
    <div className="glass-heavy absolute bottom-full right-0 z-50 mb-2 w-52 rounded-xl border border-line p-1 shadow-pop">
      <button className="focus-ring min-h-11 w-full rounded-lg px-3 text-left text-sm text-slate-100 hover:bg-white/10" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onRing(); }}>Call and ring people</button>
      <button className="focus-ring min-h-11 w-full rounded-lg px-3 text-left text-sm text-slate-100 hover:bg-white/10" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onQuiet(); }}>Join without ringing</button>
    </div>
  </details>;
}
