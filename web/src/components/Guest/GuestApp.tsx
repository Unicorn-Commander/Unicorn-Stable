/**
 * `/guest/*` — the whole guest surface, mounted ABOVE LandingGate and AuthGate.
 *
 * WHY IT LIVES OUTSIDE THE APP TREE, the same reason `/broadcast/*` does: the
 * person here has no Keycloak account and never will. A route inside AuthGate
 * would fire a top-level IdP redirect at them, and the internal realm brokers
 * the customer realm with `idp-create-user-if-unique` set to ALTERNATIVE and
 * `trust_email=true` — so an OIDC round trip does not merely fail, it SILENTLY
 * MINTS A REAL SUITE ACCOUNT for a stranger who was invited to one video call.
 *
 * Concretely: no component under this route imports the Keycloak client, the
 * federation store, the app store or the shared WebSocket singleton, and no
 * auth code RUNS for a guest — `services/auth.ts` has no module-level side
 * effects, and the only thing that ever constructs a Keycloak client is
 * `federationStore.initialize()`, which is called by AuthGate and by nothing
 * else. (`App.tsx` sits above this split and imports auth for the member path,
 * so the module is in the entry graph either way; what matters is that nothing
 * on this route reaches it or triggers it.)
 *
 * The whole `/guest/*` subtree is claimed on purpose: a typo'd guest URL must
 * land on the redeem page (which answers with the one uniform refusal), not
 * fall through to `*` and bounce a stranger into a Keycloak login screen.
 *
 * This component owns exactly one thing — the session lifecycle — and it does
 * it through `nextGuestState`, so "does a stale frame reopen a revoked room" is
 * answered by a unit test rather than by reading effects.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearStoredGuestSession,
  endReasonMessage,
  initialGuestState,
  isGuestSessionExpired,
  nextGuestState,
  parseGuestInviteLink,
  readStoredGuestSession,
  storedSessionMatchesLink,
  writeStoredGuestSession,
  type GuestEndReason,
  type GuestSession,
  type GuestState,
} from "@/lib/guest";
import { leaveGuestSession } from "@/services/guestApi";
import { GuestCard } from "./GuestChrome";
import { GuestRedeemPage } from "./GuestRedeemPage";
import { GuestRoom } from "./GuestRoom";

export function GuestApp() {
  // The URL does not change under this page, so parse it once. A guest never
  // navigates: there is nowhere else for them to go.
  const link = useMemo(
    () => parseGuestInviteLink(window.location.pathname, window.location.search),
    [],
  );

  const [state, setState] = useState<GuestState>(() => {
    // Restore across a reload so a refresh does not re-prompt for a name — and,
    // on a `max_uses` invite, does not burn another seat.
    const stored = readStoredGuestSession();
    if (!stored) return initialGuestState();
    // Two reasons to throw a stored session away rather than mount a room with
    // it: it belongs to a DIFFERENT invite than the one in the URL, or its own
    // clock says it is over. (The server would refuse it either way; this just
    // means the guest sees the form instead of a room that dies on first load.)
    if (
      !storedSessionMatchesLink(stored, link.token) ||
      isGuestSessionExpired(stored.expiresAt)
    ) {
      clearStoredGuestSession();
      return initialGuestState();
    }
    return initialGuestState(stored);
  });

  const dispatch = useCallback(
    (event: Parameters<typeof nextGuestState>[1]) => {
      setState((current) => nextGuestState(current, event));
    },
    [],
  );

  // The stored credential follows the state machine, so there is no path where
  // state says "ended" and storage still holds a live token for the next reload
  // to pick up.
  useEffect(() => {
    if (state.phase === "live" && state.session) {
      writeStoredGuestSession(state.session);
    } else {
      clearStoredGuestSession();
    }
  }, [state.phase, state.session]);

  const onJoined = useCallback(
    // The redeem page stamps `inviteKey` from the token it redeemed, so a later
    // reload can tell whether the stored session belongs to the invite in the
    // URL.
    (session: GuestSession) => dispatch({ type: "joined", session }),
    [dispatch],
  );

  const onEnded = useCallback(
    (reason: Exclude<GuestEndReason, "left">) => {
      dispatch({ type: reason === "expired" ? "expired" : "session_ended" });
    },
    [dispatch],
  );

  /** Leave is fire-and-forget on the wire but immediate in the UI: the guest
   *  asked to be out, so they are out whether or not the request lands. The
   *  server tears the session down properly when it does. */
  const leavingRef = useRef(false);
  const onLeave = useCallback(() => {
    const token = state.session?.token;
    if (leavingRef.current) return;
    leavingRef.current = true;
    if (token) void leaveGuestSession(token).catch(() => {});
    dispatch({ type: "left" });
  }, [state.session?.token, dispatch]);

  if (state.phase === "ended" && state.ended) {
    return (
      <GuestCard title={state.ended === "left" ? "You've left" : "Guest access ended"}>
        <p className="text-sm text-slate-400">{endReasonMessage(state.ended)}</p>
        {/* No "reconnect" button. `session_ended` means the credential is gone,
            and offering a retry that cannot work is worse than offering
            nothing. Re-opening the invite link is the only real path, and it
            answers honestly if the link is dead too. */}
        <a
          href={link.token ? `/guest/${encodeURIComponent(link.token)}` : "/"}
          className="focus-ring inline-flex items-center justify-center rounded-lg bg-white/[0.06] px-4 py-2 text-sm font-medium text-slate-200 hover:bg-white/[0.1]"
        >
          {link.token ? "Try the invite link again" : "Go to Stable"}
        </a>
      </GuestCard>
    );
  }

  if (state.phase === "live" && state.session) {
    return (
      <GuestRoom session={state.session} onEnded={onEnded} onLeave={onLeave} />
    );
  }

  return (
    <GuestRedeemPage
      token={link.token}
      passphraseHint={link.passphraseHint}
      onJoined={onJoined}
    />
  );
}

export default GuestApp;
