import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { X, Server } from "lucide-react";
import { useFederationStore } from "@/stores/federationStore";

/**
 * Add-a-server modal for the ServerRail. Replaces the bare window.prompt: a URL
 * field wired to federationStore.addInstance, which only lands the server on the
 * rail if it authenticates with the user's existing session AND the membership
 * probe passes — so we report success/failure by whether the accessible set grew.
 */
export function AddServerModal() {
  const setAddServerOpen = useFederationStore((s) => s.setAddServerOpen);
  const addInstance = useFederationStore((s) => s.addInstance);

  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAddServerOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setAddServerOpen]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const clean = url.trim().replace(/\/$/, "");
    if (!/^https?:\/\//i.test(clean)) {
      setError("Enter a full URL, e.g. https://stable.your-org.com");
      return;
    }
    const already = useFederationStore
      .getState()
      .instances.some((i) => i.webOrigin.replace(/\/$/, "") === clean);
    if (already) {
      setError("That server is already in your list.");
      return;
    }
    setBusy(true);
    setError(null);
    const before = useFederationStore.getState().accessibleInstances.length;
    try {
      await addInstance(clean);
    } catch {
      // addInstance is self-contained (swallows its own errors); success is
      // detected below via the accessible-set count.
    }
    const after = useFederationStore.getState().accessibleInstances.length;
    setBusy(false);
    if (after > before) {
      setAddServerOpen(false);
    } else {
      setError("Couldn't reach that server, or you don't have access to it.");
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) setAddServerOpen(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Add a Stable server"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="glass-heavy w-full max-w-md overflow-hidden rounded-2xl shadow-pop"
      >
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-slate-50">
            <Server className="h-5 w-5 text-stable-purple-light" />
            Add a server
          </h2>
          <button
            onClick={() => setAddServerOpen(false)}
            className="focus-ring rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5 px-6 py-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="server-url" className="text-xs font-medium text-slate-400">
              Server URL
            </label>
            <input
              ref={inputRef}
              id="server-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              placeholder="https://stable.your-org.com"
              className="rounded-xl border border-line bg-slate-950/60 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            />
            <p className="text-[11px] text-slate-500">
              You'll only see servers you can sign into with your existing account.
            </p>
          </div>

          {error && <p className="text-xs text-rose-400">{error}</p>}

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <button
              type="button"
              onClick={() => setAddServerOpen(false)}
              className="focus-ring rounded-xl px-4 py-2 text-sm text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!url.trim() || busy}
              className="focus-ring gradient-bg shadow-glow-iris rounded-xl px-4 py-2 text-sm font-semibold text-white transition hover:opacity-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Adding…" : "Add server"}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}
