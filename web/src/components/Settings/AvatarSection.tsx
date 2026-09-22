/**
 * "Your picture" — the per-user avatar override, and the escape hatch back to
 * the Ops-Center one.
 *
 * The model this UI has to communicate, because it is the part people get
 * wrong: your picture comes from Ops-Center automatically, and anything you
 * set here is a LOCAL override that applies in Stable only. It is never
 * written back to Keycloak, so it cannot disturb how you appear in Ops-Center,
 * Email-Ops, Meeting-Ops or anywhere else in the suite — and that is exactly
 * why "Reset to Ops-Center picture" can be a complete, one-step undo rather
 * than a "hope you kept the original" apology. The UI says so in words instead
 * of assuming anyone read this comment.
 *
 * Rendered by AppearanceSection (see the note there on why it lives at the top
 * of the settings body rather than being wired in from SettingsModal).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Loader2, RefreshCw, RotateCcw, Trash2, User } from "lucide-react";
import { Identity } from "@/components/ui/Identity";
import { resolveIdentity } from "@/lib/identity";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  ACCEPTED_AVATAR_TYPES,
  fetchMyAvatar,
  refreshMyOpsCenterAvatar,
  resetMyAvatar,
  uploadMyAvatar,
  validateAvatarFile,
  type AvatarState,
} from "@/lib/avatar";

type Busy = "idle" | "uploading" | "resetting" | "refreshing";

/** One line of plain English for each resolution tier, so the state of the
 *  system is legible without opening a console. */
function sourceCopy(state: AvatarState): string {
  switch (state.source) {
    case "override":
      return "Using a picture you uploaded here. This applies in Stable only.";
    case "keycloak":
      return "Pulled automatically from your Ops-Center profile.";
    default:
      return "No picture set. You appear as your initials in your own colour.";
  }
}

export function AvatarSection() {
  const [state, setState] = useState<AvatarState | null>(null);
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setState(await fetchMyAvatar());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your picture.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every mutation funnels through here so the button state, the error line
   *  and the confirmation line can never disagree with each other. Crucially,
   *  `note` is set only AFTER the server answers — a "Saved" that appears
   *  before the request succeeds is a lie the user finds out about later. */
  const run = useCallback(
    async (kind: Exclude<Busy, "idle">, fn: () => Promise<AvatarState>, ok: string) => {
      setBusy(kind);
      setError(null);
      setNote(null);
      try {
        const next = await fn();
        setState(next);
        setNote(ok);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        setBusy("idle");
      }
    },
    [],
  );

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the SAME file again still fires onChange.
    e.target.value = "";
    if (!file) return;
    const problem = validateAvatarFile(file);
    if (problem) {
      setNote(null);
      setError(problem);
      return;
    }
    void run("uploading", () => uploadMyAvatar(file), "Picture updated.");
  };

  const working = busy !== "idle";
  const hasOverride = state?.source === "override";

  return (
    <section className="mb-5">
      <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        <User className="h-3 w-3" /> Your picture
      </h3>

      <div className="rounded-xl border border-line bg-surface-1/60 p-3.5">
        <div className="flex items-start gap-4">
          <Identity
            {...resolveIdentity(
              state ?? {
                display_name: "You",
                participant_type: "human",
                is_self: true,
              },
            )}
            size={96}
          />

          <div className="min-w-0 flex-1">
            <p className="text-sm text-slate-200">
              {state?.display_name || state?.username || " "}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {state ? sourceCopy(state) : "Loading…"}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={working}
                className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "uploading" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Camera className="h-3.5 w-3.5" />
                )}
                {hasOverride ? "Change picture" : "Upload a picture"}
              </button>

              {hasOverride && (
                <Tooltip
                  content={
                    state?.has_keycloak_picture
                      ? "Removes your local picture and goes back to your Ops-Center one."
                      : "Removes your local picture. You have no Ops-Center picture, so you'll show as initials."
                  }
                >
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        "resetting",
                        resetMyAvatar,
                        state?.has_keycloak_picture
                          ? "Back to your Ops-Center picture."
                          : "Local picture removed.",
                      )
                    }
                    disabled={working}
                    className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy === "resetting" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : state?.has_keycloak_picture ? (
                      <RotateCcw className="h-3.5 w-3.5" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    {state?.has_keycloak_picture
                      ? "Reset to Ops-Center picture"
                      : "Remove picture"}
                  </button>
                </Tooltip>
              )}

              <Tooltip content="Changed your photo in Ops-Center? Stable normally picks it up on your next sign-in. This fetches it now.">
                <button
                  type="button"
                  onClick={() =>
                    void run(
                      "refreshing",
                      refreshMyOpsCenterAvatar,
                      "Checked Ops-Center for a newer picture.",
                    )
                  }
                  disabled={working}
                  className="focus-ring inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === "refreshing" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Re-check Ops-Center
                </button>
              </Tooltip>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept={ACCEPTED_AVATAR_TYPES}
              onChange={onPick}
              className="hidden"
            />

            {error && (
              <p className="mt-2.5 text-xs text-stable-coral" role="alert">
                {error}
              </p>
            )}
            {note && !error && (
              <p className="mt-2.5 text-xs text-stable-mint" role="status">
                {note}
              </p>
            )}

            <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
              PNG, JPEG, GIF or WEBP, up to 2&nbsp;MB. A picture you upload here
              is stored on this server and shown in Stable only — it never
              changes how you appear in Ops-Center or the rest of the suite.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export default AvatarSection;
