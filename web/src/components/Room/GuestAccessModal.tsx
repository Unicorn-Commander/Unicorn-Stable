/**
 * Guest access — the room owner's console for letting an outsider in.
 *
 * Mint a link, see what every outstanding link actually grants, see who is in
 * the room on one right now, and revoke either. The server has had all of this
 * since the guest-access work landed (server/app/api/guests.py); until this
 * modal there was no way to reach any of it without curl.
 *
 * THE LINK IS A CREDENTIAL. It opens a live room — camera, microphone, chat —
 * with no sign-in, for whoever holds it. Two consequences run through this file:
 *
 *  1. The raw token is rendered ONCE, into component state, and nothing else.
 *     Not localStorage, not the URL, not a toast body, not the console. The
 *     server keeps only a SHA-256, so "show me that link again" does not exist
 *     anywhere — closing the panel really is the end of it, and the copy in the
 *     UI says so instead of letting a host discover it later.
 *  2. The framing is stated once, plainly, where the link appears — not as a
 *     banner on every row. A host who is told everything is dangerous stops
 *     reading.
 *
 * The two capability toggles and the history window start CLOSED, matching the
 * server's own defaults (see `DEFAULT_GUEST_INVITE_DRAFT`). Everything in the
 * form that is not rendering — validation, the wire body, the widening
 * warnings, the status of a link — lives in lib/guestInvite.ts and is tested
 * there.
 */
import { useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  AlertTriangle,
  Check,
  Copy,
  Link2,
  Loader2,
  Trash2,
  UserMinus,
  X,
} from "lucide-react";
import { api, type ApiError } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { useModalA11y } from "@/hooks/useModalA11y";
import { copyTextToClipboard } from "@/lib/clipboard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  DEFAULT_GUEST_INVITE_DRAFT,
  GUEST_HISTORY_MAX_HOURS,
  GUEST_INVITE_POLL_MS,
  GUEST_TTL_CHOICES,
  applyGuestInviteRevoked,
  applyGuestSessionRevoked,
  applyGuestSessionsRevokedForInvite,
  buildGuestInviteUrl,
  countLiveGuestSessions,
  guestExpiryLabel,
  guestInviteDraftErrors,
  guestInviteGrantChips,
  guestInviteMintBody,
  guestInviteStatus,
  guestInviteStatusLabel,
  guestInviteUsageLabel,
  guestInviteWideningWarnings,
  guestRevokeSummary,
  guestSessionStatus,
  mergeGuestSessionPages,
  type GuestGrantChip,
  type GuestInviteDraft,
  type GuestInviteRow,
  type GuestSessionRow,
} from "@/lib/guestInvite";

interface GuestAccessModalProps {
  roomId: string;
  roomName: string;
  onClose: () => void;
}

interface GuestAccessData {
  invites: GuestInviteRow[];
  sessions: GuestSessionRow[];
  /** At least one invite's session list could not be read. Rendered, never
   *  swallowed — "we didn't look" must not display as "nobody is here". */
  incomplete: boolean;
}

/**
 * The link, held for exactly as long as the panel showing it is open.
 *
 * Deliberately NOT in the query cache, a store, or storage of any kind: those
 * outlive the modal, and this must not.
 */
interface MintedLink {
  url: string;
  label: string;
  hasPassphrase: boolean;
}

const queryKeyFor = (roomId: string) => ["guest-access", roomId] as const;

/**
 * Cap on the per-invite session fan-out. The server has no room-wide session
 * route, so "who is here on a guest link" is one request per invite; without a
 * bound, a room with a long invite history would fire that every poll.
 */
const SESSION_FANOUT_LIMIT = 25;

export function GuestAccessModal({
  roomId,
  roomName,
  onClose,
}: GuestAccessModalProps) {
  const panelRef = useModalA11y(true, onClose);
  const qc = useQueryClient();

  const [draft, setDraft] = useState<GuestInviteDraft>(DEFAULT_GUEST_INVITE_DRAFT);
  const [minted, setMinted] = useState<MintedLink | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [minting, setMinting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<
    | { kind: "invite"; id: string; label: string; liveGuests: number }
    | { kind: "session"; id: string; label: string }
    | null
  >(null);

  const errors = useMemo(() => guestInviteDraftErrors(draft), [draft]);
  const warnings = useMemo(() => guestInviteWideningWarnings(draft), [draft]);
  const canMint = Object.keys(errors).length === 0 && !minting;

  /* ---------------------------------------------------------------- *
   * The live lists
   * ---------------------------------------------------------------- */

  const { data, isLoading, error } = useQuery<GuestAccessData>({
    queryKey: queryKeyFor(roomId),
    queryFn: async () => {
      const invites = await api.listGuestInvites(roomId);
      // A revoked invite's sessions were all terminated in the same server
      // call, and an invite nobody redeemed has none — so neither is worth a
      // request. What remains is the set that can still have somebody on it.
      const worthFetching = invites.filter(
        (i) => !i.revoked_at && i.use_count > 0,
      );
      const fetching = worthFetching.slice(0, SESSION_FANOUT_LIMIT);
      const pages = await Promise.all(
        fetching.map((i) =>
          api.listGuestSessions(roomId, i.id).catch(() => null),
        ),
      );
      const merged = mergeGuestSessionPages(pages);
      return {
        invites,
        sessions: merged.sessions,
        incomplete:
          merged.incomplete || worthFetching.length > fetching.length,
      };
    },
    refetchInterval: GUEST_INVITE_POLL_MS,
    // A non-owner gets a 403 and a server with guest access switched off gets a
    // 404. Neither is worth retrying, and both are rendered below as themselves.
    retry: false,
  });

  const invites = data?.invites ?? [];
  const sessions = data?.sessions ?? [];
  const status = (error as ApiError | null)?.status ?? 0;
  const featureOff = status === 404;
  const notOwner = status === 403;

  const now = Date.now();
  const liveInvites = invites.filter(
    (i) => guestInviteStatus(i, now) === "active",
  );
  const pastInvites = invites.filter(
    (i) => guestInviteStatus(i, now) !== "active",
  );
  const liveSessions = sessions.filter(
    (s) => guestSessionStatus(s, now) === "active",
  );

  /* ---------------------------------------------------------------- *
   * Mint
   * ---------------------------------------------------------------- */

  const mint = useCallback(async () => {
    if (!canMint) return;
    setMinting(true);
    // Drop the previous link before the request, not after: from here on there
    // is no going back to it anyway, and leaving it on screen through a mint
    // makes it ambiguous which link the Copy button is holding.
    setMinted(null);
    setCopyState("idle");
    try {
      const invite = await api.mintGuestInvite(roomId, guestInviteMintBody(draft));
      const url = buildGuestInviteUrl({
        origin: window.location.origin,
        token: invite.token,
        passphraseHint: invite.has_passphrase,
      });
      // Try the clipboard immediately — the overwhelmingly common next act is
      // pasting this into a DM, and the panel below is the fallback (and the
      // record) either way.
      const copied = await copyTextToClipboard(url);
      setMinted({
        url,
        label: invite.label || "Guest link",
        hasPassphrase: invite.has_passphrase,
      });
      setCopyState(copied ? "copied" : "failed");
      void qc.invalidateQueries({ queryKey: queryKeyFor(roomId) });
    } catch (e) {
      const err = e as ApiError;
      useAppStore.getState().pushToast({
        title: "Couldn't create the guest link",
        body:
          (typeof err?.detail === "string" && err.detail) ||
          err?.message ||
          "Request failed",
        kind: "error",
      });
    } finally {
      setMinting(false);
    }
  }, [canMint, draft, qc, roomId]);

  const copyMinted = useCallback(async () => {
    if (!minted) return;
    setCopyState((await copyTextToClipboard(minted.url)) ? "copied" : "failed");
  }, [minted]);

  /* ---------------------------------------------------------------- *
   * Revoke
   *
   * Revocation is already TRUE when these resolve — the server marks the row,
   * deletes the membership, force-disconnects the socket and evicts the LiveKit
   * publisher before answering. So the cache is written straight away rather
   * than waiting on the next poll: a link that reads "Live" for fifteen seconds
   * after a host killed it is the one kind of staleness that matters here.
   * ---------------------------------------------------------------- */

  const revokeInvite = useCallback(
    async (inviteId: string) => {
      setBusyId(inviteId);
      try {
        const result = await api.revokeGuestInvite(roomId, inviteId);
        qc.setQueryData<GuestAccessData>(queryKeyFor(roomId), (prev) =>
          prev
            ? {
                ...prev,
                invites: applyGuestInviteRevoked(prev.invites, inviteId),
                // The server terminated these in the same call. Without this the
                // link reads "Revoked" while the people it let in still read as
                // connected.
                sessions: applyGuestSessionsRevokedForInvite(
                  prev.sessions,
                  inviteId,
                ),
              }
            : prev,
        );
        void qc.invalidateQueries({ queryKey: queryKeyFor(roomId) });
        useAppStore.getState().pushToast({
          title: "Guest link revoked",
          body: guestRevokeSummary(result),
          kind: "success",
        });
      } catch (e) {
        const err = e as ApiError;
        useAppStore.getState().pushToast({
          title: "Couldn't revoke that link",
          body:
            (typeof err?.detail === "string" && err.detail) ||
            err?.message ||
            "Request failed",
          kind: "error",
          // A revoke that failed is a link still live. Never let that scroll away.
          sticky: true,
        });
      } finally {
        setBusyId(null);
      }
    },
    [qc, roomId],
  );

  const revokeSession = useCallback(
    async (sessionId: string) => {
      setBusyId(sessionId);
      try {
        await api.revokeGuestSession(roomId, sessionId);
        qc.setQueryData<GuestAccessData>(queryKeyFor(roomId), (prev) =>
          prev
            ? { ...prev, sessions: applyGuestSessionRevoked(prev.sessions, sessionId) }
            : prev,
        );
        void qc.invalidateQueries({ queryKey: queryKeyFor(roomId) });
        useAppStore.getState().pushToast({
          title: "Guest removed",
          body: "They're out of the room and off the call. Their link still works unless you revoke it too.",
          kind: "success",
        });
      } catch (e) {
        const err = e as ApiError;
        useAppStore.getState().pushToast({
          title: "Couldn't remove that guest",
          body:
            (typeof err?.detail === "string" && err.detail) ||
            err?.message ||
            "Request failed",
          kind: "error",
          sticky: true,
        });
      } finally {
        setBusyId(null);
      }
    },
    [qc, roomId],
  );

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Guest access for ${roomName}`}
          initial={{ scale: 0.96, y: 8 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.96, y: 8 }}
          className="glass-heavy flex max-h-[88vh] w-full max-w-lg flex-col rounded-2xl shadow-pop"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 className="font-display text-base font-semibold text-slate-100">
                Guest access — {roomName}
              </h2>
              {/* The framing, once, at the top. Everything below assumes it. */}
              <p className="text-xs text-slate-400">
                A guest link is a credential: whoever holds it walks into this
                room with no sign-in and no account.
              </p>
            </div>
            <button
              onClick={onClose}
              className="focus-ring ml-3 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {featureOff ? (
              <p className="rounded-xl border border-line bg-slate-950/50 p-3 text-sm text-slate-400">
                Guest access is switched off on this server. An administrator
                turns it on with <code className="text-slate-300">GUEST_ACCESS_ENABLED</code>.
              </p>
            ) : notOwner ? (
              <p className="rounded-xl border border-line bg-slate-950/50 p-3 text-sm text-slate-400">
                Only the room's owner can hand out guest links.
              </p>
            ) : (
              <>
                {minted && (
                  <MintedLinkPanel
                    minted={minted}
                    copyState={copyState}
                    onCopy={copyMinted}
                    onDismiss={() => {
                      setMinted(null);
                      setCopyState("idle");
                    }}
                  />
                )}

                <MintForm
                  draft={draft}
                  errors={errors}
                  warnings={warnings}
                  minting={minting}
                  canMint={canMint}
                  onChange={setDraft}
                  onMint={mint}
                />

                <Section
                  title="Links that still work"
                  count={liveInvites.length}
                  loading={isLoading}
                  empty="No guest links are live for this room."
                >
                  {liveInvites.map((invite) => (
                    <InviteRow
                      key={invite.id}
                      invite={invite}
                      now={now}
                      liveGuests={countLiveGuestSessions(
                        sessions.filter((s) => s.invite_id === invite.id),
                        now,
                      )}
                      busy={busyId === invite.id}
                      onRevoke={(liveGuests) =>
                        setConfirming({
                          kind: "invite",
                          id: invite.id,
                          label: invite.label || invite.token_prefix,
                          liveGuests,
                        })
                      }
                    />
                  ))}
                </Section>

                <Section
                  title="Guests in the room now"
                  count={liveSessions.length}
                  loading={isLoading}
                  empty="Nobody has joined on a guest link."
                  note={
                    data?.incomplete
                      ? "One or more links couldn't be checked, so this list may be short."
                      : undefined
                  }
                >
                  {liveSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      now={now}
                      busy={busyId === session.id}
                      onRemove={() =>
                        setConfirming({
                          kind: "session",
                          id: session.id,
                          label: session.display_name,
                        })
                      }
                    />
                  ))}
                </Section>

                {pastInvites.length > 0 && (
                  <details className="mt-4 rounded-xl border border-line bg-slate-950/40">
                    <summary className="focus-ring cursor-pointer list-none px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      {pastInvites.length} link
                      {pastInvites.length === 1 ? "" : "s"} no longer working
                    </summary>
                    <ul className="divide-y divide-line border-t border-line px-3 py-2">
                      {pastInvites.map((invite) => (
                        <InviteRow
                          key={invite.id}
                          invite={invite}
                          now={now}
                          liveGuests={0}
                          busy={false}
                          onRevoke={null}
                        />
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </div>
        </motion.div>
      </motion.div>

      <AnimatePresence>
        {confirming?.kind === "invite" && (
          <ConfirmDialog
            title="Revoke this guest link?"
            message={
              <>
                <strong className="text-slate-100">{confirming.label}</strong>{" "}
                stops working immediately.
                {confirming.liveGuests > 0 && (
                  <>
                    {" "}
                    The {confirming.liveGuests} guest
                    {confirming.liveGuests === 1 ? "" : "s"} on it right now
                    {confirming.liveGuests === 1 ? " is" : " are"} disconnected
                    and dropped from the call.
                  </>
                )}{" "}
                You can't undo this — mint a new link instead.
              </>
            }
            confirmLabel="Revoke link"
            busy={busyId === confirming.id}
            icon={Trash2}
            // Held open until the request settles, so the confirmation is what
            // reports the outcome — and so a second Escape or backdrop click
            // cannot fire the revoke twice while it is in flight.
            onConfirm={() => {
              void revokeInvite(confirming.id).finally(() => setConfirming(null));
            }}
            onClose={() => setConfirming(null)}
          />
        )}
        {confirming?.kind === "session" && (
          <ConfirmDialog
            title="Remove this guest?"
            message={
              <>
                <strong className="text-slate-100">{confirming.label}</strong> is
                disconnected and dropped from the call right now. Their link
                keeps working until you revoke it, so they could rejoin.
              </>
            }
            confirmLabel="Remove guest"
            busy={busyId === confirming.id}
            icon={UserMinus}
            onConfirm={() => {
              void revokeSession(confirming.id).finally(() => setConfirming(null));
            }}
            onClose={() => setConfirming(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The one-time link
 * ------------------------------------------------------------------ */

function MintedLinkPanel({
  minted,
  copyState,
  onCopy,
  onDismiss,
}: {
  minted: MintedLink;
  copyState: "idle" | "copied" | "failed";
  onCopy: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mb-4 rounded-xl border border-stable-purple/40 bg-stable-purple/10 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-stable-purple-light">
        <Link2 className="h-3.5 w-3.5" />
        {minted.label} — shown once
      </div>
      <div className="flex items-center gap-2">
        {/* A readOnly input rather than a <code> block so the whole value can be
            selected and copied by hand — which is the only path left when the
            clipboard API is missing, as it is on a plain-HTTP LAN self-host. */}
        <input
          readOnly
          value={minted.url}
          spellCheck={false}
          autoComplete="off"
          aria-label="Guest link"
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border border-line bg-slate-950/60 px-2 py-1.5 font-mono text-xs text-slate-200 outline-none focus:border-stable-purple/60"
        />
        <button
          onClick={onCopy}
          className="focus-ring flex shrink-0 items-center gap-1 rounded-md bg-stable-purple/25 px-2.5 py-1.5 text-xs font-medium text-stable-purple-light transition-colors hover:bg-stable-purple/35"
        >
          {copyState === "copied" ? (
            <>
              <Check className="h-3 w-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Copy
            </>
          )}
        </button>
      </div>
      {copyState === "failed" && (
        <p className="mt-2 text-xs text-amber-300">
          This browser wouldn't let us reach the clipboard. Select the link above
          and copy it by hand — it is not recoverable once this closes.
        </p>
      )}
      <p className="mt-2 text-xs text-slate-400">
        Stable keeps no copy of this link, so this is the only time it is
        readable. Send it the way you'd send a password.
        {minted.hasPassphrase && " The passphrase goes separately — not in the same message."}
      </p>
      <button
        onClick={onDismiss}
        className="focus-ring mt-2 rounded-md px-2 py-1 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
      >
        Done — hide it
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The mint form
 * ------------------------------------------------------------------ */

const FIELD_CLASS =
  "w-full rounded-lg border border-line bg-slate-950/60 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-stable-purple/60 focus:ring-2 focus:ring-stable-purple/20";

function MintForm({
  draft,
  errors,
  warnings,
  minting,
  canMint,
  onChange,
  onMint,
}: {
  draft: GuestInviteDraft;
  errors: ReturnType<typeof guestInviteDraftErrors>;
  warnings: string[];
  minting: boolean;
  canMint: boolean;
  onChange: (next: GuestInviteDraft) => void;
  onMint: () => void;
}) {
  const set = <K extends keyof GuestInviteDraft>(
    key: K,
    value: GuestInviteDraft[K],
  ) => onChange({ ...draft, [key]: value });

  return (
    <form
      className="mb-5"
      onSubmit={(e) => {
        e.preventDefault();
        onMint();
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 block">
          <span className="mb-1 block text-xs text-slate-400">
            What's it for? (only you see this)
          </span>
          <input
            type="text"
            value={draft.label}
            placeholder="e.g. Thursday's guest — Dana"
            onChange={(e) => set("label", e.target.value)}
            className={FIELD_CLASS}
          />
          <FieldError message={errors.label} />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-slate-400">Stops working after</span>
          <select
            value={draft.ttlHours}
            onChange={(e) => set("ttlHours", Number(e.target.value))}
            className={FIELD_CLASS}
          >
            {GUEST_TTL_CHOICES.map((choice) => (
              <option key={choice.hours} value={choice.hours}>
                {choice.label}
              </option>
            ))}
          </select>
          <FieldError message={errors.ttlHours} />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-slate-400">
            How many people can use it
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={draft.maxUses}
            placeholder="Any number"
            onChange={(e) => set("maxUses", e.target.value)}
            className={FIELD_CLASS}
          />
          <FieldError message={errors.maxUses} />
        </label>

        <label className="col-span-2 block">
          <span className="mb-1 block text-xs text-slate-400">
            Passphrase (optional — a second thing they must type)
          </span>
          <input
            type="text"
            value={draft.passphrase}
            placeholder="Leave blank for none"
            autoComplete="off"
            onChange={(e) => set("passphrase", e.target.value)}
            className={FIELD_CLASS}
          />
          <FieldError message={errors.passphrase} />
        </label>
      </div>

      {/* -- What the guest may do. Both start off; see lib/guestInvite.ts. -- */}
      <fieldset className="mt-3">
        <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          What this guest may do
        </legend>
        <Toggle
          checked={draft.canPublish}
          onChange={(v) => set("canPublish", v)}
          label="Turn on their camera and microphone"
          hint={
            draft.canPublish
              ? "They join as someone on the show, not an audience member."
              : "Watch-only: they can read and type, but never publish audio or video."
          }
        />
        <Toggle
          checked={draft.allowAgentTrigger}
          onChange={(v) => set("allowAgentTrigger", v)}
          label="Get answers from this room's agent"
          hint={
            draft.allowAgentTrigger
              ? undefined
              : "Off: the agent stays quiet for them. They can still talk to everyone in the room."
          }
        />
        <Toggle
          checked={draft.allowMentionEmail}
          onChange={(v) => set("allowMentionEmail", v)}
          label="Send email by @mentioning someone"
          hint={
            draft.allowMentionEmail
              ? undefined
              : "Off: nothing they type can put mail in an inbox from your domain."
          }
        />
      </fieldset>

      {/* -- How far back they can read. -- */}
      <fieldset className="mt-3">
        <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          What this guest may read
        </legend>
        <Radio
          name="guest-history"
          checked={draft.historyMode === "since_mint"}
          onChange={() => set("historyMode", "since_mint")}
          label="Only what's said from now on"
          hint="Nothing posted before this link existed."
        />
        <Radio
          name="guest-history"
          checked={draft.historyMode === "hours"}
          onChange={() => set("historyMode", "hours")}
          label={
            <span className="flex flex-wrap items-center gap-1.5">
              Also the last
              <input
                type="text"
                inputMode="numeric"
                value={draft.historyHours}
                aria-label="Hours of earlier history"
                onChange={(e) => set("historyHours", e.target.value)}
                onFocus={() => set("historyMode", "hours")}
                className="w-14 rounded-md border border-line bg-slate-950/60 px-1.5 py-0.5 text-center text-sm text-slate-100 outline-none focus:border-stable-purple/60"
              />
              hours
            </span>
          }
          hint={`Up to ${GUEST_HISTORY_MAX_HOURS} hours. Useful when they need to catch up on today.`}
        />
        <Radio
          name="guest-history"
          checked={draft.historyMode === "all"}
          onChange={() => set("historyMode", "all")}
          label="Everything this room has ever said"
          hint="The full back catalogue, including anything from long before they were invited."
        />
        <FieldError message={errors.historyHours} />
      </fieldset>

      {warnings.length > 0 && (
        <ul className="mt-3 space-y-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5">
          {warnings.map((warning) => (
            <li key={warning} className="flex gap-2 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}

      <button
        type="submit"
        disabled={!canMint}
        className="focus-ring mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-stable-purple/90 px-4 py-2 text-sm font-semibold text-white transition hover:bg-stable-purple active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {minting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Creating…
          </>
        ) : (
          <>
            <Link2 className="h-4 w-4" /> Create guest link
          </>
        )}
      </button>
    </form>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-xs text-rose-300">{message}</p>;
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer gap-2.5 rounded-lg px-1 py-1.5 transition-colors hover:bg-white/[0.03]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="focus-ring mt-0.5 h-4 w-4 shrink-0 accent-stable-purple"
      />
      <span className="min-w-0">
        <span className="block text-sm text-slate-200">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

function Radio({
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer gap-2.5 rounded-lg px-1 py-1.5 transition-colors hover:bg-white/[0.03]">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="focus-ring mt-0.5 h-4 w-4 shrink-0 accent-stable-purple"
      />
      <span className="min-w-0">
        <span className="block text-sm text-slate-200">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ *
 * The lists
 * ------------------------------------------------------------------ */

function Section({
  title,
  count,
  loading,
  empty,
  note,
  children,
}: {
  title: string;
  count: number;
  loading: boolean;
  empty: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4 border-t border-line pt-3">
      <h3 className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {title}
        {count > 0 && (
          <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-300">
            {count}
          </span>
        )}
      </h3>
      {note && <p className="mb-2 text-xs text-amber-300">{note}</p>}
      {count === 0 ? (
        <p className="text-xs text-slate-500">{loading ? "Loading…" : empty}</p>
      ) : (
        <ul className="divide-y divide-line">{children}</ul>
      )}
    </section>
  );
}

function Chip({ chip }: { chip: GuestGrantChip }) {
  return (
    <span
      title={chip.title}
      className={clsx(
        "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
        chip.tone === "wide"
          ? "bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/30"
          : "bg-white/[0.06] text-slate-400",
      )}
    >
      {chip.label}
    </span>
  );
}

function InviteRow({
  invite,
  now,
  liveGuests,
  busy,
  onRevoke,
}: {
  invite: GuestInviteRow;
  now: number;
  liveGuests: number;
  busy: boolean;
  /** null for a link that is already dead — nothing left to revoke. */
  onRevoke: ((liveGuests: number) => void) | null;
}) {
  const status = guestInviteStatus(invite, now);
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm text-slate-200">
          {invite.label || (
            <span className="font-mono text-xs text-slate-400">
              {invite.token_prefix}…
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {status === "active"
            ? guestExpiryLabel(invite.expires_at, now)
            : guestInviteStatusLabel(status)}
          {" · "}
          {guestInviteUsageLabel(invite)}
          {liveGuests > 0 && ` · ${liveGuests} here now`}
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {guestInviteGrantChips(invite).map((chip) => (
            <Chip key={chip.key} chip={chip} />
          ))}
        </div>
      </div>
      {onRevoke && (
        <button
          onClick={() => onRevoke(liveGuests)}
          disabled={busy}
          className="focus-ring flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
          aria-label={`Revoke guest link ${invite.label || invite.token_prefix}`}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
          Revoke
        </button>
      )}
    </li>
  );
}

function SessionRow({
  session,
  now,
  busy,
  onRemove,
}: {
  session: GuestSessionRow;
  now: number;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm text-slate-200">{session.display_name}</p>
        <p className="text-xs text-slate-500">
          {guestExpiryLabel(session.expires_at, now)}
        </p>
      </div>
      <button
        onClick={onRemove}
        disabled={busy}
        className="focus-ring flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
        aria-label={`Remove guest ${session.display_name}`}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <UserMinus className="h-3 w-3" />
        )}
        Remove
      </button>
    </li>
  );
}
