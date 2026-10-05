import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X, Image as ImageIcon, Trash2 } from "lucide-react";
import { useFederationStore } from "@/stores/federationStore";
import { getInstanceToken } from "@/services/auth";
import { DESCRIPTION_MAX, NAME_MAX, displayName, instanceHost } from "@/lib/instances";
import { isServerAdmin } from "./admin";
import { ServerLogo } from "./ServerLogo";
import { usePresenterStore } from "@/stores/presenterStore";

/**
 * Admin editor for THIS server's rail identity — logo, name, description,
 * accent. Writes go to the ACTIVE instance only: a server's identity is owned
 * by that server's admins, never edited remotely.
 *
 * The role check here is cosmetic; `PUT/POST /api/v1/instance/*` re-derives the
 * caller's roles from the Keycloak token and 403s a non-admin regardless.
 */

/** Mirrors the server's raster allow-list. SVG is refused on both sides. */
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif";
const MAX_LOGO_BYTES = 512 * 1024;

export function ServerIdentityModal() {
  const open = useFederationStore((state) => state.identityOpen);
  const setOpen = useFederationStore((state) => state.setIdentityOpen);
  const instances = useFederationStore((state) => state.accessibleInstances);
  const activeId = useFederationStore((state) => state.activeInstanceId);
  const metaByInstance = useFederationStore((state) => state.metaByInstance);
  const refreshInstanceMeta = useFederationStore((state) => state.refreshInstanceMeta);
  const presenterEnabled = usePresenterStore((state) => state.enabled);

  const instance = instances.find((item) => item.id === activeId) ?? null;
  const meta = activeId ? metaByInstance[activeId] : undefined;

  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the fields from live meta each time the dialog opens (not on every
  // meta refresh, which would stomp what the admin is currently typing).
  useEffect(() => {
    if (!open || !instance) return;
    setName(meta?.name ?? "");
    setDescription(meta?.description ?? "");
    setError(null);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, instance?.id]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (presenterEnabled || !open || !instance || !isServerAdmin()) return null;

  async function send(path: string, init: RequestInit): Promise<boolean> {
    if (!instance || !activeId) return false;
    const token = getInstanceToken(activeId);
    if (!token) {
      setError("Your session expired. Reload and try again.");
      return false;
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${instance.apiBaseUrl}${path}`, { ...init, headers });
    if (response.ok) return true;
    setError(
      response.status === 403
        ? "You don't have permission to change this server's identity."
        : response.status === 413
          ? "That image is too large."
          : response.status === 415
            ? "That file isn't an accepted image (PNG, JPEG, WebP, GIF or AVIF)."
            : "Couldn't save. Try again.",
    );
    return false;
  }

  async function saveText(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const ok = await send("/api/v1/instance/meta", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    }).catch(() => {
      setError("Couldn't reach this server.");
      return false;
    });
    if (ok) {
      await refreshInstanceMeta();
      setSaved(true);
    }
    setBusy(false);
  }

  async function uploadLogo(file: File) {
    setError(null);
    setSaved(false);
    // Client-side pre-check for a fast, kind error. The server re-checks size,
    // declared type, markup-sniff AND magic bytes — this is convenience only.
    if (file.size > MAX_LOGO_BYTES) {
      setError(`Logo must be under ${MAX_LOGO_BYTES / 1024} KB.`);
      return;
    }
    setBusy(true);
    const body = new FormData();
    body.append("file", file);
    const ok = await send("/api/v1/instance/logo", { method: "POST", body }).catch(() => {
      setError("Couldn't reach this server.");
      return false;
    });
    if (ok) {
      await refreshInstanceMeta();
      setSaved(true);
    }
    setBusy(false);
  }

  async function removeLogo() {
    setBusy(true);
    setError(null);
    const ok = await send("/api/v1/instance/logo", { method: "DELETE" }).catch(() => false);
    if (ok) await refreshInstanceMeta();
    setBusy(false);
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Edit this server's identity"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.15 }}
        className="glass-heavy flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl shadow-pop"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
          <h2 className="font-display text-lg font-semibold text-slate-50">This server</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="focus-ring rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={saveText} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
          <div className="flex items-center gap-4">
            <ServerLogo instance={instance} size="lg" active />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                  className="focus-ring flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  {meta?.logo ? "Replace logo" : "Upload logo"}
                </button>
                {meta?.logo && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void removeLogo()}
                    className="focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-rose-300 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                PNG, JPEG, WebP, GIF or AVIF, under {MAX_LOGO_BYTES / 1024} KB. SVG isn't accepted —
                it can carry scripts into every viewer's client.
              </p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = ""; // allow re-picking the same file
                if (file) void uploadLogo(file);
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="instance-name" className="text-xs font-medium text-slate-400">
              Display name
            </label>
            <input
              id="instance-name"
              type="text"
              maxLength={NAME_MAX}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={displayName(instance)}
              className="rounded-xl border border-line bg-slate-950/60 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            />
            <p className="text-[11px] text-slate-500">
              Shown to everyone who federates with {instanceHost(instance)}.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="instance-description" className="text-xs font-medium text-slate-400">
              Description
            </label>
            <textarea
              id="instance-description"
              rows={3}
              maxLength={DESCRIPTION_MAX}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What is this server for?"
              className="resize-none rounded-xl border border-line bg-slate-950/60 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20"
            />
            <p className="text-[11px] text-slate-500">
              {description.length}/{DESCRIPTION_MAX} — plain text, no formatting.
            </p>
          </div>

          {error && <p className="text-xs text-rose-400">{error}</p>}
          {saved && !error && <p className="text-xs text-emerald-400">Saved.</p>}

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="focus-ring rounded-xl px-4 py-2 text-sm text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={busy}
              className="focus-ring gradient-bg shadow-glow-iris rounded-xl px-4 py-2 text-sm font-semibold text-white transition hover:opacity-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}
