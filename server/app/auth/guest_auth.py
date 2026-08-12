"""Guest credentials — Stable-native, room-scoped, and deliberately NOT OIDC.

WHY GUESTS NEVER TOUCH KEYCLOAK
-------------------------------
The internal ``.dev`` realm brokers the customer realm with an
``idp-create-user-if-unique`` execution set to ALTERNATIVE and
``trust_email=true``, which SILENTLY auto-creates a real realm account on first
login. Routing a guest through ANY OIDC path would therefore mint a permanent
suite identity for a stranger who was invited to one video call. So a guest
credential is a Stable row and nothing else: no realm, no broker, no
entitlement, no cross-app federation.

WHY IT IS A SEPARATE CREDENTIAL KIND
------------------------------------
``deps.get_current_user`` is a POSITIVE dependency named explicitly by ~100
routes. Teaching it about guests would hand a guest token every one of them in
a single edit, and every route written after that too. It therefore REJECTS a
guest credential outright (see ``deps.get_current_user``), and guest-reachable
routes opt in one at a time via ``deps.get_guest_or_member``. That inversion is
the whole default-deny story: a route that does not exist yet is guest-proof
with no reviewer vigilance required.

This mirrors ``auth/gateway_auth.py`` on purpose — hashed at rest, scope on the
row, identity DERIVED server-side, instant ``revoked_at``. Do not invent a
third scheme.

THE PASSPHRASE
--------------
Optional, and the ONLY human-guessable secret in the design (the tokens are
256-bit random). It is therefore the thing that gets brute-forced, so it is
PBKDF2-stretched with a per-row salt and compared with ``compare_digest``.
``verify_passphrase`` is also run against a dummy hash when the token is
unknown, so "no such invite" and "wrong passphrase" cost the same wall-clock
time as well as returning the same response.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.gateway_auth import hash_key
from app.models.guest_access import GuestInvite, GuestSession

# Credential prefixes. These are what makes a guest credential RECOGNIZABLE to
# get_current_user so it can refuse it loudly instead of falling through to a
# JWT parse error, and they are the only thing an outsider ever sees of the
# scheme. Keep them distinct from the gateway's ("sbk-", "ubk-", "sk-") and the
# broadcast token's ("sbt-").
GUEST_INVITE_PREFIX = "sgi-"
GUEST_SESSION_PREFIX = "sgs-"
GUEST_TOKEN_PREFIXES = (GUEST_INVITE_PREFIX, GUEST_SESSION_PREFIX)

# Pseudo-sub namespace for the guest's Participant row.
# Participant.keycloak_sub is String(255), unique, NOT NULL — a guest has no
# Keycloak identity and NULL is not an option, so it gets a synthetic sub, the
# same trick already used by "brigade:<agent_id>" and "webhook:<name>". The
# prefix is also a cheap, greppable "this row is not a real person in the
# realm" marker for anything that resolves subs against Keycloak.
GUEST_SUB_PREFIX = "guest:"

# Attacker-chosen display names are untrusted text. 64 chars is generous for a
# human name and short enough not to wreck a member list.
MAX_DISPLAY_NAME = 64

_PBKDF2_ALGO = "pbkdf2_sha256"
_PBKDF2_ITERATIONS = 200_000

# Verified against when the presented invite token matches no row, so an
# attacker cannot distinguish "unknown token" from "wrong passphrase" by
# timing. Shaped exactly like a real stored hash so verify_passphrase does the
# identical amount of work; it can never match a real passphrase because the
# stored digest is all zeroes.
_DUMMY_PASSPHRASE_HASH = f"{_PBKDF2_ALGO}${_PBKDF2_ITERATIONS}${'00' * 16}${'00' * 32}"

# Zero-width joiners/spaces, the bidi overrides, the isolate controls, and the
# BOM. Stripped from guest display names because they are the standard way to
# make "Aaron" and "Aaron" different strings, or to reverse-render a name in a
# member list. (``str.isprintable()`` below already rejects most of these; the
# explicit class is here so the intent survives a refactor of that line.)
_INVISIBLE_RE = re.compile(
    "["
    "\u200b-\u200f"  # zero-width space/joiner + LRM/RLM
    "\u202a-\u202e"  # bidi embedding + OVERRIDE (name reversal)
    "\u2060-\u2064"  # word joiner + invisible operators
    "\u2066-\u2069"  # bidi isolates
    "\ufeff"          # BOM / zero-width no-break space
    "]"
)


class GuestAuthError(Exception):
    """Failed/expired/revoked guest credential. Carries an HTTP status."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


@dataclass
class GuestPrincipal:
    """An authenticated guest. Every field is DERIVED from the session row.

    Nothing here is read off the request, so a guest cannot assert a different
    participant, a different room, or a publish grant they were not issued.
    """

    session_id: uuid.UUID
    invite_id: uuid.UUID
    room_id: uuid.UUID
    participant_id: uuid.UUID
    keycloak_sub: str  # "guest:<uuid>" — synthetic, never a realm subject
    username: str
    display_name: str
    can_publish: bool
    expires_at: datetime

    # Per-invite grants, read LIVE off the invite row on every credential
    # check rather than copied onto the session at redemption. That is the
    # difference that matters operationally: an owner who turns a grant off
    # mid-show has it off on the guest's very next request, instead of only
    # for guests who redeem afterwards. (``can_publish`` above is deliberately
    # the other way round — it is denormalized onto the session so an in-flight
    # A/V session keeps the grant it was issued under.)
    #
    # Both default False so any construction path that has not heard of them
    # produces a CLOSED principal.
    allow_agent_trigger: bool = False
    allow_mention_email: bool = False
    # Oldest message this guest may read. Never None for a principal built by
    # ``verify_guest_session``; the enforcement point treats a missing value as
    # "now" (i.e. nothing), so the failure direction is closed.
    history_from: datetime | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    """Treat a naive DB timestamp as UTC (asyncpg can hand back either)."""
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _effective_history_from(invite: Any, session: Any) -> datetime:
    """The oldest message this guest may read, resolved fail-CLOSED.

    Normally just ``invite.history_from`` (NOT NULL since 015). The fallbacks
    exist so that a row predating the column, or any future caller that hands
    us a partial object, lands on a RESTRICTIVE answer rather than on "the
    whole room": first the session's own creation time (a guest can always see
    the conversation from the moment they joined), and only if even that is
    missing, ``now()`` — which shows nothing at all.
    """
    floor = _aware(getattr(invite, "history_from", None))
    if floor is not None:
        return floor
    redeemed = _aware(getattr(session, "created_at", None))
    return redeemed if redeemed is not None else _now()


def is_guest_credential(token: str | None) -> bool:
    """True for anything minted by this module. Used by get_current_user to
    refuse a guest credential EXPLICITLY rather than by accident."""
    return bool(token) and str(token).startswith(GUEST_TOKEN_PREFIXES)


def is_guest_sub(sub: str | None) -> bool:
    """True for a synthetic guest Participant subject."""
    return bool(sub) and str(sub).startswith(GUEST_SUB_PREFIX)


def mint_invite_token() -> str:
    return f"{GUEST_INVITE_PREFIX}{secrets.token_urlsafe(32)}"


def mint_session_token() -> str:
    return f"{GUEST_SESSION_PREFIX}{secrets.token_urlsafe(32)}"


def hash_passphrase(passphrase: str) -> str:
    """PBKDF2-HMAC-SHA256 with a fresh 128-bit salt.

    Stdlib only, on purpose: adding argon2/bcrypt to this image for one
    optional field is a dependency the deployment does not need. The iteration
    count is stored in the record so it can be raised later without
    invalidating existing invites.
    """
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", passphrase.encode("utf-8"), salt, _PBKDF2_ITERATIONS
    )
    return f"{_PBKDF2_ALGO}${_PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_passphrase(passphrase: str, stored: str | None) -> bool:
    """Constant-time verify. A malformed/absent record is a plain False."""
    if not stored:
        return False
    try:
        algo, raw_iters, salt_hex, digest_hex = stored.split("$")
        if algo != _PBKDF2_ALGO:
            return False
        iterations = int(raw_iters)
        salt = bytes.fromhex(salt_hex)
    except (ValueError, AttributeError):
        return False
    candidate = hashlib.pbkdf2_hmac(
        "sha256", (passphrase or "").encode("utf-8"), salt, iterations
    )
    return hmac.compare_digest(candidate.hex(), digest_hex)


def burn_passphrase_time(passphrase: str) -> None:
    """Do the SAME PBKDF2 work as a real check, and throw the result away.

    Called on the unknown-token path so a timing observer cannot use response
    latency to learn that a token exists. Always returns None; it is not a
    check and must never be treated as one.
    """
    verify_passphrase(passphrase or "", _DUMMY_PASSPHRASE_HASH)


def clean_display_name(raw: str | None, *, fallback: str = "Guest") -> str:
    """Sanitize an ATTACKER-CHOSEN display name.

    Strips control and invisible/bidi characters (homograph + RTL-override
    tricks), collapses whitespace, and hard-caps the length. Authorization
    NEVER keys on this value — it exists to be rendered, and the member list
    also carries ``participant_type: "guest"`` so a client can badge it rather
    than trusting the string.
    """
    text = unicodedata.normalize("NFC", str(raw or ""))
    text = _INVISIBLE_RE.sub("", text)
    # Non-printables become a SPACE when they were whitespace (newline, tab)
    # and vanish otherwise. Dropping a newline outright would silently join
    # "Ada\nLovelace" into "AdaLovelace"; turning it into a separator keeps
    # the name the person meant while still collapsing to one line.
    text = "".join(
        ch if ch.isprintable() else (" " if ch.isspace() else "") for ch in text
    )
    text = " ".join(text.split())
    return text[:MAX_DISPLAY_NAME] or fallback


def guest_user_dict(principal: GuestPrincipal) -> dict[str, Any]:
    """Shape a GuestPrincipal like ``get_current_user``'s return value.

    Existing handler bodies read ``user["participant_id"]`` /
    ``user["username"]`` / ``user["roles"]``, so guests must present the same
    keys or every opted-in route needs a branch. Two things are load bearing:

    * ``roles`` is ALWAYS empty — every admin gate in the codebase reads it.
    * ``participant_type`` is ``"guest"``, which is a value no pre-existing
      comparison matches, so guests fall out of every ``== HUMAN`` and
      ``== AGENT`` branch rather than quietly joining one.
    """
    return {
        "sub": principal.keycloak_sub,
        "email": None,
        "username": principal.username,
        "display_name": principal.display_name,
        "roles": [],
        "participant_type": "guest",
        "participant_id": principal.participant_id,
        # Guest-only keys. `is_guest` is what deps.ensure_guest_room_scope and
        # the opted-in handlers branch on.
        "is_guest": True,
        "guest_room_id": principal.room_id,
        "guest_session_id": principal.session_id,
        "guest_invite_id": principal.invite_id,
        "guest_can_publish": principal.can_publish,
        "guest_expires_at": principal.expires_at,
        # Per-invite grants. Namespaced with the `guest_` prefix like every
        # other guest-only key so a member dict can never accidentally satisfy
        # a check written against one of them (a member's dict has no such key,
        # so `.get()` is False/None — closed).
        "guest_allow_agent_trigger": principal.allow_agent_trigger,
        "guest_allow_mention_email": principal.allow_mention_email,
        "guest_history_from": principal.history_from,
    }


def new_guest_identity() -> tuple[str, str]:
    """Mint (keycloak_sub, username) for a fresh guest Participant.

    Both derive from one random UUID so the pair is always consistent, and the
    username contains NO underscore — ``webhooks._extract_participant_id``
    parses a LiveKit identity as ``username_<uuid>`` with ``rsplit("_", 1)``,
    so an underscore in the username would break attribution.
    """
    token = uuid.uuid4()
    return f"{GUEST_SUB_PREFIX}{token}", f"guest-{token.hex}"


async def verify_guest_session(raw_token: str, db: AsyncSession) -> GuestPrincipal:
    """Resolve a guest session token to a scoped principal, or raise.

    Checks, in order: prefix, SHA-256 row lookup, constant-time hash compare,
    session revocation, session expiry, then the INVITE's revocation and
    expiry. The invite cascade is what makes "revoke the link" true for guests
    who are already connected — the websocket force-close is the fast path,
    this is the authoritative one.

    Every failure returns the same 401 detail. The caller learns "not valid",
    never which of the six checks failed.
    """
    token = (raw_token or "").strip()
    if not token.startswith(GUEST_SESSION_PREFIX):
        raise GuestAuthError(401, "Guest session is not valid")

    token_hash = hash_key(token)
    row = (
        await db.execute(
            select(GuestSession).where(GuestSession.token_hash == token_hash)
        )
    ).scalar_one_or_none()
    # compare_digest against the resolved row as well — defense in depth
    # against a hash-collision/timing seam, exactly as verify_gateway_key does.
    if row is None or not hmac.compare_digest(row.token_hash, token_hash):
        raise GuestAuthError(401, "Guest session is not valid")

    now = _now()
    session_expires = _aware(row.expires_at)
    if row.revoked_at is not None:
        raise GuestAuthError(401, "Guest session is not valid")
    if session_expires is None or session_expires <= now:
        raise GuestAuthError(401, "Guest session is not valid")

    invite = (
        await db.execute(select(GuestInvite).where(GuestInvite.id == row.invite_id))
    ).scalar_one_or_none()
    invite_expires = _aware(invite.expires_at) if invite is not None else None
    if (
        invite is None
        or invite.revoked_at is not None
        or invite_expires is None
        or invite_expires <= now
    ):
        raise GuestAuthError(401, "Guest session is not valid")

    # The guest's own Participant row carries the name the rest of the app
    # renders; read it here so the principal is self-contained.
    from app.models.participant import Participant  # local: avoids a cycle

    participant = (
        await db.execute(
            select(Participant).where(Participant.id == row.participant_id)
        )
    ).scalar_one_or_none()
    if participant is None:
        raise GuestAuthError(401, "Guest session is not valid")

    return GuestPrincipal(
        session_id=row.id,
        invite_id=row.invite_id,
        room_id=row.room_id,
        participant_id=row.participant_id,
        keycloak_sub=participant.keycloak_sub,
        username=participant.username,
        display_name=participant.display_name or row.display_name,
        can_publish=bool(row.can_publish),
        expires_at=session_expires,
        # Read off the INVITE, which this function already had to load for the
        # revocation cascade — so the live value costs nothing extra. getattr
        # with a False default keeps the direction closed if the attribute is
        # ever absent.
        allow_agent_trigger=bool(getattr(invite, "allow_agent_trigger", False)),
        allow_mention_email=bool(getattr(invite, "allow_mention_email", False)),
        history_from=_effective_history_from(invite, row),
    )


async def guest_session_is_live(
    db: AsyncSession, session_id: uuid.UUID | str
) -> bool:
    """Is this guest session still valid RIGHT NOW (session and invite)?

    HTTP re-checks the credential on every request, so an expired or revoked
    guest is refused there automatically. A WebSocket has no such moment — it
    authenticates once at connect and then lives for hours. Without a periodic
    re-check, a guest whose session simply EXPIRED would keep receiving the
    room's messages until their browser closed, and a revoked guest would
    survive any Redis hiccup that swallowed the force-disconnect message.

    ``ws/handler.py`` calls this on its existing 4-second refresh tick, so this
    is the backstop that makes the socket agree with the credential.
    """
    now = _now()
    row = (
        await db.execute(
            select(GuestSession.id)
            .join(GuestInvite, GuestInvite.id == GuestSession.invite_id)
            .where(
                GuestSession.id == session_id,
                GuestSession.revoked_at.is_(None),
                GuestSession.expires_at > now,
                GuestInvite.revoked_at.is_(None),
                GuestInvite.expires_at > now,
            )
        )
    ).scalar_one_or_none()
    return row is not None


async def touch_guest_session(db: AsyncSession, session_id: uuid.UUID | str) -> None:
    """Stamp ``last_seen_at`` on a live guest session. Never raises.

    ``GuestSession.last_seen_at`` is surfaced on the owner's "who is actually
    on my link" view (``GET /rooms/{id}/guest-invites/{id}/sessions``) and, as
    shipped, NOTHING ever wrote it — so that column read NULL forever and the
    owner's live-session view was decorative. The websocket liveness tick is
    the only periodic guest signal the server has, so it is what stamps this,
    throttled to once a minute (see ws/handler.py).

    The value therefore means exactly "the last time this guest's socket was
    confirmed alive", not "the last time they did anything". Best-effort by
    design: a failed stamp is an instrumentation loss, never an authorization
    one, so it is swallowed rather than allowed to kill the socket.
    """
    from sqlalchemy import update  # local: keeps the module import list flat

    try:
        await db.execute(
            update(GuestSession)
            .where(GuestSession.id == session_id)
            .values(last_seen_at=_now())
        )
        await db.commit()
    except Exception:  # pragma: no cover - defensive
        import structlog

        structlog.get_logger(__name__).debug(
            "guest_session_touch_failed", session_id=str(session_id), exc_info=True
        )


__all__ = [
    "GUEST_INVITE_PREFIX",
    "GUEST_SESSION_PREFIX",
    "GUEST_TOKEN_PREFIXES",
    "GUEST_SUB_PREFIX",
    "MAX_DISPLAY_NAME",
    "GuestAuthError",
    "GuestPrincipal",
    "burn_passphrase_time",
    "clean_display_name",
    "guest_session_is_live",
    "guest_user_dict",
    "hash_passphrase",
    "is_guest_credential",
    "is_guest_sub",
    "mint_invite_token",
    "mint_session_token",
    "new_guest_identity",
    "touch_guest_session",
    "verify_guest_session",
    "verify_passphrase",
]
