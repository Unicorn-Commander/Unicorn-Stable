"""JIT participant provisioning + cross-realm identity linking.

Stable runs against a Keycloak, but the suite has TWO Keycloaks with the same
realm name ``uchub``: auth.unicorncommander.ai (VPS) and auth.magicunicorn.dev
(bigboy). The same human exists in both with DIFFERENT ``sub`` values.
Participants are keyed by ``participants.keycloak_sub`` (unique), so a login
minted by the "other" Keycloak used to JIT-provision a brand-new participant
row — a duplicate persona. This happened to a real user (two participants, one
now orphaned); a third was one bigboy-realm login away.

The mitigation: before creating a participant for an unknown sub, look for an
existing HUMAN participant with the same email (case-insensitive) and RE-KEY
it to the incoming sub instead of inserting a duplicate.

There is no email column on participants. Email is matched against:

* ``metadata->>'email'`` — stamped here on every login going forward, so the
  mapping is durable even if the realm flips again; and
* ``username`` — social-login rows use the email as the username, and it is
  the only email-shaped fact older rows carry.

Linking is gated:

* the token must carry a non-empty ``email`` claim, AND
* ``email_verified`` must be true OR the token issuer must be one of our two
  admin-controlled Keycloaks (in practice the issuer is always the configured
  one — ``validate_token`` enforces it — so this is belt and braces);
* only HUMAN participants are ever link candidates (agent/pseudo rows are
  keyed by synthetic subs and must never be re-keyed);
* if MORE than one candidate matches, we refuse to guess and create a new row
  (logged loudly);
* if the candidate's old sub STILL resolves as a user in the currently
  configured realm, it is a live, different account — refuse to steal it and
  create a new row instead. If the admin check is unavailable (e.g. the
  service account lacks view-users, which is the current prod state → 403),
  we still link: both Keycloaks are admin-controlled, realm email uniqueness
  holds, and the email gate above already passed. Better one linked persona
  than a guaranteed duplicate.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import structlog
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.services.keycloak_admin import KeycloakAdmin

logger = structlog.get_logger(__name__)

# JSONB metadata key holding the participant's email as of their last login.
# Deliberately not a column: rides in the existing metadata JSONB so this
# ships against the live schema with no migration (same doctrine as the
# avatar override, see models/participant.py).
EMAIL_KEY = "email"

# Our two known admin-controlled Keycloaks (both serve realm "uchub").
TRUSTED_ISSUER_HOSTS = frozenset(
    {"auth.unicorncommander.ai", "auth.magicunicorn.dev"}
)


def _normalized_email(claims: dict[str, Any]) -> str | None:
    email = (claims.get("email") or "").strip().lower()
    return email or None


def _issuer_trusted(claims: dict[str, Any], settings: Settings) -> bool:
    """True when the token issuer is one of our own Keycloaks."""
    host = urlparse(claims.get("iss") or "").hostname
    if not host:
        return False
    configured = urlparse(settings.keycloak_url).hostname
    return host == configured or host in TRUSTED_ISSUER_HOSTS


def _stamp_email(participant: Participant, email: str | None) -> bool:
    """Record the login email in metadata. Returns True if it changed.

    Reassigns ``metadata_`` rather than mutating — SQLAlchemy does not track
    in-place mutation of a plain JSONB dict.
    """
    if not email:
        return False
    meta = dict(participant.metadata_ or {})
    if meta.get(EMAIL_KEY) == email:
        return False
    meta[EMAIL_KEY] = email
    participant.metadata_ = meta
    return True


def _is_gravatar_url(url: str | None) -> bool:
    """True when a URL points at gravatar.com (host-suffix matched)."""
    if not url:
        return False
    try:
        host = url.split("//", 1)[1].split("/", 1)[0].lower()
    except IndexError:
        return False
    host = host.split("@")[-1]  # strip any userinfo
    return host == "gravatar.com" or host.endswith(".gravatar.com")


def _sync_mutable_fields(
    participant: Participant, identity: dict[str, Any], email: str | None
) -> bool:
    """Mirror mutable Keycloak facts onto the row. Returns True if changed."""
    changed = False
    new_display = identity.get("display_name")
    if new_display and new_display != participant.display_name:
        participant.display_name = new_display
        changed = True
    new_avatar = identity.get("avatar_url")
    if new_avatar and new_avatar != participant.avatar_url:
        # Hybrid setter: writes land on the Keycloak mirror, never on a
        # Stable-local override (see models/participant.py).
        participant.avatar_url = new_avatar
        changed = True
    elif not new_avatar and _is_gravatar_url(participant.keycloak_avatar_url):
        # Stale fallback cleanup: the old identity spine minted gravatar.com
        # URLs keyed by email MD5 (d=404, so they only ever rendered broken
        # images and leaked an email hash to a third party). The newer spine
        # mints none, so once a token stops carrying a `picture` claim there
        # is nothing left to mirror — the stale URL must not survive it.
        # Guarded to the gravatar class on purpose: a real Ops-Center picture
        # (unicorncommander.ai) is never blanked by a transiently-absent
        # claim, and a Stable-local override is untouched by design.
        participant.avatar_url = None
        changed = True
    if _stamp_email(participant, email):
        changed = True
    return changed


async def _email_match_candidates(
    db: AsyncSession, email: str, *, exclude_sub: str
) -> list[Participant]:
    """HUMAN participants whose stamped email OR username equals ``email``."""
    result = await db.execute(
        select(Participant).where(
            Participant.participant_type == ParticipantType.HUMAN,
            Participant.keycloak_sub != exclude_sub,
            or_(
                func.lower(Participant.metadata_[EMAIL_KEY].astext) == email,
                func.lower(Participant.username) == email,
            ),
        )
    )
    return list(result.scalars().all())


async def _old_sub_still_live(settings: Settings, old_sub: str) -> bool | None:
    """Does ``old_sub`` still resolve in the CONFIGURED realm?

    True  -> resolves (a live account; do not re-key it)
    False -> 404 (gone / other-realm sub; safe to re-key)
    None  -> check unavailable (admin creds missing / 403 / network)
    """
    try:
        kc_user = await KeycloakAdmin(settings).get_user(old_sub)
    except Exception:
        logger.warning(
            "participant_link_subcheck_unavailable",
            old_sub=old_sub,
            exc_info=True,
        )
        return None
    return kc_user is not None


async def link_participant_by_email(
    db: AsyncSession,
    settings: Settings,
    *,
    new_sub: str,
    email: str,
) -> Participant | None:
    """Re-key an existing email-matched HUMAN participant to ``new_sub``.

    Returns the linked participant, or None when there is nothing safe to
    link (no candidate, ambiguous candidates, or the candidate's old sub is
    still a live account in the configured realm). Does NOT create anything.
    Caller is responsible for the email trust gate.
    """
    candidates = await _email_match_candidates(db, email, exclude_sub=new_sub)
    if not candidates:
        return None
    if len(candidates) > 1:
        logger.warning(
            "participant_link_ambiguous",
            email=email,
            new_sub=new_sub,
            candidate_ids=[str(c.id) for c in candidates],
        )
        return None

    candidate = candidates[0]
    old_sub = candidate.keycloak_sub
    still_live = await _old_sub_still_live(settings, old_sub)
    if still_live is True:
        logger.warning(
            "participant_link_refused",
            reason="old_sub_still_resolves_in_configured_realm",
            participant_id=str(candidate.id),
            old_sub=old_sub,
            new_sub=new_sub,
            email=email,
        )
        return None

    candidate.keycloak_sub = new_sub
    _stamp_email(candidate, email)
    await db.commit()
    await db.refresh(candidate)
    logger.info(
        "participant_identity_linked",
        participant_id=str(candidate.id),
        username=candidate.username,
        old_sub=old_sub,
        new_sub=new_sub,
        email=email,
        old_sub_check="gone" if still_live is False else "unavailable",
    )
    return candidate


async def resolve_participant_for_identity(
    db: AsyncSession,
    settings: Settings,
    identity: dict[str, Any],
    claims: dict[str, Any],
) -> Participant:
    """Resolve (or JIT-provision) the Participant for a validated login.

    Order: exact ``keycloak_sub`` match -> email-based link of an existing
    row -> create. Mutable Keycloak facts (display name, avatar, email
    stamp) are synced on every path.
    """
    sub = identity["sub"]
    email = _normalized_email(claims)

    result = await db.execute(
        select(Participant).where(Participant.keycloak_sub == sub)
    )
    participant = result.scalar_one_or_none()

    if participant is None and identity.get("participant_type") == "human":
        # Unknown sub: try to link an existing persona by email before
        # creating a duplicate. Gate: non-empty email AND (verified OR
        # issued by one of our own Keycloaks).
        if email and (
            claims.get("email_verified") is True
            or _issuer_trusted(claims, settings)
        ):
            participant = await link_participant_by_email(
                db, settings, new_sub=sub, email=email
            )
        elif email is None:
            logger.info(
                "participant_link_skipped", reason="no_email_claim", sub=sub
            )
        else:
            logger.info(
                "participant_link_skipped",
                reason="email_unverified_and_issuer_untrusted",
                sub=sub,
                iss=claims.get("iss"),
            )

    if participant is not None:
        if _sync_mutable_fields(participant, identity, email):
            await db.commit()
            await db.refresh(participant)
        return participant

    # Create. Guard the unique username constraint: the same human arriving
    # from the other realm with the same preferred_username but a non-matching
    # email would otherwise 500 on insert.
    username = identity["username"]
    taken = (
        await db.execute(
            select(Participant.id).where(
                func.lower(Participant.username) == username.lower()
            )
        )
    ).scalar_one_or_none()
    if taken is not None:
        username = f"{username}-{sub[:8]}"
        logger.warning(
            "participant_username_collision",
            requested=identity["username"],
            assigned=username,
            sub=sub,
        )

    participant = Participant(
        keycloak_sub=sub,
        username=username,
        display_name=identity.get("display_name") or username,
        avatar_url=identity.get("avatar_url"),
        participant_type=ParticipantType(identity["participant_type"]),
        status=ParticipantStatus.ONLINE,
        metadata_={EMAIL_KEY: email} if email else {},
    )
    db.add(participant)
    await db.commit()
    await db.refresh(participant)
    logger.info(
        "participant_auto_created",
        participant_id=str(participant.id),
        username=participant.username,
    )
    return participant
