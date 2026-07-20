"""Avatars: the per-user override tier, and the served bytes.

WHAT THIS FILE OWNS
-------------------
The auto-pull half of avatars is NOT here and never was — the Keycloak
``picture`` claim (Ops-Center) is mirrored onto ``Participant.avatar_url`` by
``deps.get_current_user`` on every sign-in, and ~20 render sites already read
it. That works today (verified: Aaron's row carries a real
``unicorncommander.ai/avatars/...png``).

This file adds the OVERRIDE tier on top of it, plus a way to re-pull the
Ops-Center picture without waiting for a token refresh:

    GET    /api/v1/participants/me/avatar    what am I resolving to, and why
    POST   /api/v1/participants/me/avatar    upload an override (multipart)
    DELETE /api/v1/participants/me/avatar    reset to the Ops-Center picture
    POST   /api/v1/participants/me/avatar/refresh
                                             re-pull the picture from Keycloak
    GET    /api/v1/avatars/{stored_name}     serve stored avatar bytes

Resolution order (also documented on the model, and mirrored client-side in
``web/src/lib/avatar.ts`` — change all three together):

    1. Stable-local override  (metadata->>'avatar_override_url')
    2. Keycloak `picture`     (the Ops-Center identity, mirrored on sign-in)
    3. emoji glyph / initials on the identity colour  (client-side)

An override is written ONLY here and ONLY to Stable's own database. It is never
written back to Keycloak — a local picture must not be able to clobber the
suite-wide identity that Ops-Center, Email-Ops, Meeting-Ops et al. render.

SECURITY
--------
Avatar URLs render in an ``<img>`` in every connected client, so an arbitrary
remote URL would be a tracking pixel that leaks every viewer's IP and user
agent to whatever host the uploader chose. So:

* There is no "set my avatar to this URL" endpoint at all. The only way to set
  an override is to upload bytes, which we store and serve from our own origin.
* Bytes are sniffed by magic number and must really be PNG / JPEG / GIF /
  WEBP. Content-Type from the client is not trusted for anything. SVG is
  rejected outright (it executes script).
* Stored bytes are served with a server-derived Content-Type, ``nosniff``,
  ``default-src 'none'; sandbox`` CSP, and an immutable cache — never with a
  client-supplied type and never inline as markup.

Note the pre-existing GRAVATAR fallback in ``auth/keycloak.py`` has exactly the
problem described above (it puts a third-party ``gravatar.com`` URL, keyed by
an MD5 of the user's email, into every viewer's DOM). It is out of scope for
this file — see the handoff notes.
"""

from __future__ import annotations

import re
import secrets
from pathlib import Path
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import get_current_user, get_db, get_settings_dep, rate_limit
from app.models.participant import Participant

logger = structlog.get_logger(__name__)

router = APIRouter()

# Avatars are small by definition. This is a display asset, not an attachment.
MAX_AVATAR_BYTES = 2 * 1024 * 1024  # 2 MB

# Magic-number → (extension, served content type). The CLIENT'S content-type is
# never consulted; only these bytes decide. Anything not matching is rejected,
# which is what keeps SVG/HTML/XML (all of which can execute script when served
# inline from our origin) out by construction rather than by blocklist.
_MAGIC: tuple[tuple[bytes, str, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "png", "image/png"),
    (b"\xff\xd8\xff", "jpg", "image/jpeg"),
    (b"GIF87a", "gif", "image/gif"),
    (b"GIF89a", "gif", "image/gif"),
)

_STORED_NAME_RE = re.compile(r"^[0-9a-f]{32}\.(png|jpg|gif|webp)$")
_EXT_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
}


def _sniff(body: bytes) -> tuple[str, str] | None:
    """Return (extension, content_type) if these bytes are a real raster image.

    WEBP needs a two-part check: "RIFF" ....  "WEBP" at offset 8. Checking only
    "RIFF" would also accept WAV/AVI containers.
    """
    for magic, ext, ctype in _MAGIC:
        if body.startswith(magic):
            return ext, ctype
    if len(body) >= 12 and body[0:4] == b"RIFF" and body[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None


def _avatar_dir(settings: Settings) -> Path:
    d = Path(settings.upload_dir) / "avatars"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _avatar_public_url(stored_name: str) -> str:
    """Same-origin path. Deliberately relative: the app is reachable on more
    than one origin (dogfood/flagship/federated), and baking an absolute host
    in here would pin every stored override to whichever one happened to
    receive the upload."""
    return f"/api/v1/avatars/{stored_name}"


class AvatarState(BaseModel):
    """Everything the settings UI needs to explain what it is showing."""

    # The URL that actually renders (same as Participant.avatar_url).
    effective_url: str | None = None
    # Which tier won: "override" | "keycloak" | "none".
    source: str = "none"
    # The Ops-Center picture on its own, so the UI can preview what "Reset to
    # Ops-Center picture" would give you back BEFORE you commit to it.
    keycloak_url: str | None = None
    # The Stable-local override on its own.
    override_url: str | None = None
    # True when there is a picture to reset TO. If this is false, "reset" just
    # falls through to initials, and the UI should say so rather than implying
    # a picture will reappear.
    has_keycloak_picture: bool = False
    display_name: str = ""
    username: str = ""


def _state(p: Participant) -> AvatarState:
    override = p.avatar_override_url
    kc = p.keycloak_avatar_url
    return AvatarState(
        effective_url=override or kc,
        source="override" if override else ("keycloak" if kc else "none"),
        keycloak_url=kc,
        override_url=override,
        has_keycloak_picture=bool(kc),
        display_name=p.display_name or "",
        username=p.username or "",
    )


async def _load_me(db: AsyncSession, user: dict[str, Any]) -> Participant:
    p = await db.get(Participant, user["participant_id"])
    if p is None:
        raise HTTPException(status_code=404, detail="Participant not found")
    return p


@router.get("/participants/me/avatar", response_model=AvatarState)
async def get_my_avatar(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AvatarState:
    """What the caller's avatar currently resolves to, and from which tier."""
    return _state(await _load_me(db, user))


@router.post("/participants/me/avatar", response_model=AvatarState)
async def set_my_avatar(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    file: UploadFile = File(...),
    _rl: Annotated[
        None, Depends(rate_limit("upload", "rate_limit_upload_per_min"))
    ] = None,
) -> AvatarState:
    """Upload a picture that overrides the Ops-Center one, in Stable only.

    Writes ``metadata->>'avatar_override_url'``. Does NOT touch
    ``avatar_url`` (the Keycloak mirror) and does NOT call Keycloak, so the
    suite-wide identity is unaffected and the override stays reversible.
    """
    # Read one byte past the cap so an oversized file is detected rather than
    # silently truncated to something that still sniffs as a valid image.
    body = await file.read(MAX_AVATAR_BYTES + 1)
    if not body:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(body) > MAX_AVATAR_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Avatar must be {MAX_AVATAR_BYTES // (1024 * 1024)} MB or smaller",
        )

    sniffed = _sniff(body)
    if sniffed is None:
        # Intentionally does not echo the client's content-type back — the
        # point is that we did not believe it.
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="That file is not a PNG, JPEG, GIF or WEBP image.",
        )
    ext, _ctype = sniffed

    stored_name = f"{secrets.token_hex(16)}.{ext}"
    dest = _avatar_dir(settings) / stored_name
    dest.write_bytes(body)

    p = await _load_me(db, user)
    previous = p.avatar_override_url
    p.set_avatar_override(_avatar_public_url(stored_name))
    await db.commit()
    await db.refresh(p)

    # Best-effort cleanup of the replaced file. A failure here is a disk-space
    # nuisance, never a request failure — the new avatar is already committed.
    _unlink_if_ours(settings, previous)

    logger.info(
        "avatar_override_set",
        participant_id=str(p.id),
        stored_name=stored_name,
        bytes=len(body),
    )
    return _state(p)


@router.delete("/participants/me/avatar", response_model=AvatarState)
async def reset_my_avatar(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> AvatarState:
    """Drop the override and fall back to the Ops-Center picture.

    First-class and non-destructive to identity: the Keycloak mirror was never
    overwritten, so this is a one-step, complete undo.
    """
    p = await _load_me(db, user)
    previous = p.avatar_override_url
    p.set_avatar_override(None)
    await db.commit()
    await db.refresh(p)
    _unlink_if_ours(settings, previous)
    logger.info("avatar_override_cleared", participant_id=str(p.id))
    return _state(p)


@router.post("/participants/me/avatar/refresh", response_model=AvatarState)
async def refresh_my_keycloak_avatar(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> AvatarState:
    """Re-pull the Ops-Center picture NOW, without a sign-out.

    The mirror is otherwise only refreshed when a new access token carries a
    new ``picture`` claim — i.e. on next sign-in or token refresh. Change your
    photo in Ops-Center and Stable can lag by the token lifetime, which reads
    as "it didn't work". This closes that gap on demand by asking the Keycloak
    admin API for the user's current ``picture`` attribute.

    Degrades quietly: if Keycloak is unreachable or exposes no picture, the
    stored mirror is left exactly as it was rather than being blanked.
    """
    from app.services.keycloak_admin import KeycloakAdmin

    p = await _load_me(db, user)
    picture: str | None = None
    try:
        kc_user = await KeycloakAdmin(settings).get_user(p.keycloak_sub)
        attrs = (kc_user or {}).get("attributes") or {}
        raw = attrs.get("picture")
        if isinstance(raw, list):
            raw = raw[0] if raw else None
        if isinstance(raw, str) and raw.strip():
            picture = raw.strip()
    except Exception:
        logger.warning(
            "avatar_keycloak_refresh_failed",
            participant_id=str(p.id),
            exc_info=True,
        )

    if picture and picture != p.keycloak_avatar_url:
        # Assign through the mirror attribute, not the hybrid, to be explicit
        # about which tier is being written.
        p.keycloak_avatar_url = picture
        await db.commit()
        await db.refresh(p)
        logger.info("avatar_keycloak_refreshed", participant_id=str(p.id))

    return _state(p)


def _unlink_if_ours(settings: Settings, url: str | None) -> None:
    """Delete a previously stored avatar file, if that URL is one of ours.

    Guarded by the strict stored-name regex and a resolved-path containment
    check, so a hand-edited metadata value can never make this delete anything
    outside the avatar directory.
    """
    if not url:
        return
    name = url.rsplit("/", 1)[-1]
    if not _STORED_NAME_RE.match(name):
        return
    try:
        d = _avatar_dir(settings).resolve()
        target = (d / name).resolve()
        if target.parent == d and target.is_file():
            target.unlink()
    except OSError:
        logger.debug("avatar_cleanup_failed", url=url, exc_info=True)


@router.get("/avatars/{stored_name}")
async def get_avatar(
    stored_name: str,
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> FileResponse:
    """Serve stored avatar bytes.

    Unauthenticated by design, and that is a deliberate, bounded choice:

    * An ``<img src>`` cannot carry an Authorization header, and avatars render
      in message rows, member lists, the participant strip and PiP tiles — a
      signed, expiring URL (the model ``uploads.py`` uses for attachments)
      would break every one of them the moment the signature aged out of a
      persisted ``avatar_url``.
    * The filename is 128 bits of ``secrets`` entropy, so the URL is
      unguessable; this is the "public bucket, random key" model.
    * The content is a profile picture the user chose to show to everyone they
      talk to. It is not attachment-grade material, and it never carries the
      user's name, email or id in the URL.

    Hardening on the response: server-derived Content-Type (never the
    uploader's), ``nosniff``, and a locked-down CSP, so even a file that
    somehow got past the magic-number sniff cannot execute anything.
    """
    if not _STORED_NAME_RE.match(stored_name):
        raise HTTPException(status_code=404, detail="Not found")

    d = _avatar_dir(settings).resolve()
    path = (d / stored_name).resolve()
    # Containment check on top of the regex — defence in depth against any
    # future loosening of the pattern.
    if path.parent != d or not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")

    ext = stored_name.rsplit(".", 1)[-1]
    return FileResponse(
        path,
        media_type=_EXT_TYPES.get(ext, "application/octet-stream"),
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            # Immutable: the name is content-random, so a changed avatar is
            # always a new URL and this can never serve a stale picture.
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )
