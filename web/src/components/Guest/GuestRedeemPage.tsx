/**
 * The invite landing page: `/guest/<token>`.
 *
 * The person here has no account and did not choose to be in a product — they
 * clicked a link someone sent them. So the page says what is about to happen in
 * plain words (which room, that they are joining AS A GUEST, whether their
 * camera will be involved) before it asks for anything.
 *
 * THE ONE THING IT MUST NOT DO IS EXPLAIN A REFUSAL. The server answers unknown
 * token, revoked invite, expired invite, exhausted invite and wrong passphrase
 * with one identical 403, and burns the same PBKDF2 time on the miss path so
 * the five are indistinguishable by latency as well as by body. Distinguishing
 * them HERE would hand back the oracle the server spent that effort closing —
 * so there is exactly one failure string, `GUEST_LINK_INVALID_MESSAGE`, and the
 * outcome mapping that produces it lives in lib/guest.ts where it is tested.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Loader2, ShieldCheck, Video, VideoOff } from "lucide-react";
import { StableMark } from "@/components/StableMark";
import {
  MAX_GUEST_DISPLAY_NAME,
  cleanGuestDisplayName,
  guestSessionFromRedeem,
  isAcceptableGuestDisplayName,
  isRetryableRedeemOutcome,
  redeemMessageFor,
  redeemOutcomeFor,
  type GuestRedeemOutcome,
  type GuestSession,
} from "@/lib/guest";
import { GuestApiError, leaveGuestSession, redeemGuestInvite } from "@/services/guestApi";
import { guestRecordingConsent } from "@/lib/recording";

interface GuestRedeemPageProps {
  /** The raw invite token from the URL path. */
  token: string;
  /** `?p=1` — a UX hint that this invite carries a passphrase. */
  passphraseHint: boolean;
  onJoined: (session: GuestSession) => void;
}

export function GuestRedeemPage({
  token,
  passphraseHint,
  onJoined,
}: GuestRedeemPageProps) {
  const [name, setName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<GuestRedeemOutcome | null>(null);
  const [pending, setPending] = useState<GuestSession | null>(null);
  const consent = pending
    ? guestRecordingConsent({
        policy: pending.recordingPolicy,
        active: pending.recordingActive,
      })
    : null;

  useEffect(() => {
    document.title = "Join as a guest · Stable";
  }, []);

  // The name they will actually be given: the server re-cleans whatever we
  // send (control characters, bidi overrides, a 64-char cap), so showing the
  // cleaned form here means nobody is surprised by their own name plate.
  const cleaned = useMemo(() => cleanGuestDisplayName(name), [name]);
  const nameOk = isAcceptableGuestDisplayName(name);

  // A URL with no token is not an error worth a form. It is someone who
  // truncated a link — same uniform answer as a link that never existed.
  const missingToken = token.length === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !nameOk || missingToken) return;
    setBusy(true);
    setOutcome(null);
    try {
      const body = await redeemGuestInvite({
        token,
        display_name: cleaned,
        // The passphrase field is always sent when filled, even without the
        // `?p=1` hint: the hint is a query param anyone can drop, and an invite
        // that has no passphrase IGNORES one rather than refusing it.
        passphrase: passphrase.trim() || undefined,
      });
      // The invite token is passed in so the session remembers WHICH link
      // produced it (by prefix — see `guestInviteKey`), which is what lets a
      // later reload tell a restored session from a different invite's.
      const session = guestSessionFromRedeem(body, token);
      if (!session) {
        // A 200 we cannot build a session from is not a refusal — it is a
        // server we do not understand. Say "try again", not "bad link".
        setOutcome("unavailable");
        return;
      }
      const line = guestRecordingConsent({
        policy: session.recordingPolicy,
        active: session.recordingActive,
      });
      if (line) {
        setPending(session);
        return;
      }
      onJoined(session);
    } catch (error) {
      const status = error instanceof GuestApiError ? error.status : 0;
      setOutcome(redeemOutcomeFor(status));
    } finally {
      setBusy(false);
    }
  }

  const errorMessage =
    missingToken && outcome === null
      ? null
      : outcome
        ? redeemMessageFor(outcome)
        : null;

  if (pending && consent) {
    return (
      <div className="flex min-h-dvh w-full items-center justify-center bg-slate-900 p-4">
        <div className="glass flex w-full max-w-md flex-col gap-5 rounded-2xl p-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <StableMark className="h-12 w-12 drop-shadow-[0_0_24px_rgba(139,92,246,0.45)]" />
            <h1 className="font-display text-2xl font-bold tracking-tight text-slate-100">
              This room records
            </h1>
          </div>
          <p
            data-testid="guest-recording-consent"
            className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm leading-relaxed text-rose-100"
          >
            {consent}
          </p>
          <button
            type="button"
            className="gradient-bg focus-ring inline-flex w-full items-center justify-center rounded-lg px-6 py-3 text-sm font-semibold text-white"
            onClick={() => onJoined(pending)}
          >
            Join the room
          </button>
          <button
            type="button"
            className="focus-ring text-sm text-slate-400 hover:text-slate-200"
            onClick={() => {
              void leaveGuestSession(pending.token).catch(() => {});
              setPending(null);
            }}
          >
            Don't join
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-slate-900 p-4">
      <form
        onSubmit={submit}
        className="glass flex w-full max-w-md flex-col gap-5 rounded-2xl p-8"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <StableMark className="h-12 w-12 drop-shadow-[0_0_24px_rgba(139,92,246,0.45)]" />
          <h1 className="gradient-text font-display text-3xl font-bold tracking-tight">
            Stable
          </h1>
          <p className="text-sm text-slate-300">
            You&rsquo;ve been invited to join{" "}
            <span className="font-semibold text-slate-100">one room</span> as a
            guest.
          </p>
        </div>

        {/* Say what a guest IS, up front. Someone joining a stranger's video
            call deserves to know what they are and are not getting before they
            type their name into it. */}
        <div className="flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-xs text-slate-400">
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stable-mint" />
            <span>
              No account is created and nothing is linked to an email address.
              Your access ends when the link expires or the host revokes it.
            </span>
          </p>
          <p className="flex items-start gap-2">
            <Video className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
            <span>
              You&rsquo;ll see this one room and the people in it — nothing else
              in the workspace.
            </span>
          </p>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-300">
            Your name
            <span className="ml-1 font-normal text-slate-500">
              (shown to everyone in the room)
            </span>
          </span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            autoComplete="name"
            maxLength={MAX_GUEST_DISPLAY_NAME * 2}
            placeholder="Ada Lovelace"
            aria-describedby="guest-name-help"
            className="focus-ring rounded-lg border border-white/[0.08] bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
          />
          <span id="guest-name-help" className="text-[11px] text-slate-500">
            {cleaned && cleaned !== name.trim()
              ? `You'll appear as "${cleaned}".`
              : `Up to ${MAX_GUEST_DISPLAY_NAME} characters.`}
          </span>
        </label>

        {/* Always available, never required. `?p=1` only decides whether it is
            expanded on arrival — a missing or forged flag changes nothing about
            what redemption accepts, so a passphrase-protected link whose hint
            got stripped in a chat client is still redeemable here. */}
        <details open={passphraseHint} className="group">
          <summary className="cursor-pointer text-xs font-medium text-slate-400 hover:text-slate-200">
            {passphraseHint
              ? "This link needs a passphrase"
              : "Have a passphrase?"}
          </summary>
          <input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete="off"
            maxLength={128}
            placeholder="Passphrase"
            aria-label="Passphrase"
            className="focus-ring mt-2 w-full rounded-lg border border-white/[0.08] bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
          />
        </details>

        {errorMessage && (
          <p
            role="alert"
            className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
          >
            {errorMessage}
            {outcome && !isRetryableRedeemOutcome(outcome) && (
              <span className="mt-1 block text-rose-300/70">
                Nothing you can change here will help — the link itself needs
                replacing.
              </span>
            )}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !nameOk || missingToken}
          className="gradient-bg focus-ring inline-flex w-full items-center justify-center gap-2 rounded-lg px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? "Joining…" : "Join as guest"}
        </button>

        {missingToken && (
          <p className="flex items-center justify-center gap-1.5 text-[11px] text-slate-500">
            <VideoOff className="h-3 w-3" />
            This link is missing its invite code. Ask for the full link.
          </p>
        )}
      </form>
    </div>
  );
}

export default GuestRedeemPage;
