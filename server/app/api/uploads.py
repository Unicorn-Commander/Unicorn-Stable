"""File upload + authenticated download.

Uploads are written to a config-driven directory (``settings.upload_dir``,
overridable via ``UPLOAD_DIR``) with a UUID-prefixed filename.

Reads are gated. The static, unauthenticated ``/uploads`` mount is being
retired in favour of ``GET /api/v1/uploads/{stored_name}`` here, which serves
a file only when the request is authorized one of two ways:

  1. A valid HMAC signature (``?exp=...&sig=...``) minted by this service on
     upload. Possession of the signed URL is the authorization — the same
     model as S3 presigned URLs. This is what lets a browser render private
     attachments via ``<img src>`` / ``<a href>``, which cannot attach an
     ``Authorization`` header. Signatures are time-limited.
  2. A Bearer token whose participant is a member of a room that references
     this attachment (covers API clients and re-sharing). This makes reads
     room-scoped for first-class API access.

Limits:
  * MAX_FILE_BYTES: hard cap per file
  * Allowed MIME types: images, common docs — anything else is rejected
"""

from __future__ import annotations

import hashlib
import hmac
import mimetypes
import re
import time
import uuid
from pathlib import Path
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.deps import (
    get_current_user,
    get_db,
    get_settings_dep,
    rate_limit,
)
from app.security.upload_guard import (
    dangerous_suffix,
    is_dangerous_content_type,
    safe_download_headers,
    sniff_is_markup,
)

logger = structlog.get_logger(__name__)

router = APIRouter()

MAX_FILE_BYTES = 20 * 1024 * 1024  # 20 MB
ALLOWED_PREFIXES = (
    "image/",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "text/",
    "application/json",
    "application/zip",
)

# Stored names are always "<32 hex>.<ext>" — reject anything else outright so
# a crafted name can never escape the upload dir (path traversal) or hit a
# different file. This is defence-in-depth on top of resolving under the dir.
_STORED_NAME_RE = re.compile(r"^[0-9a-f]{32}(?:\.[A-Za-z0-9]{1,16})?$")


def _upload_dir(settings: Settings) -> Path:
    d = Path(settings.upload_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _signing_key(settings: Settings) -> bytes:
    # Prefer the dedicated secret; fall back to the LiveKit secret so a fresh
    # deploy still has a non-empty signing key. Set UPLOAD_URL_SECRET in prod.
    key = settings.upload_url_secret or settings.livekit_api_secret or "stable-dev"
    return key.encode("utf-8")


def _sign(settings: Settings, stored_name: str, exp: int) -> str:
    msg = f"{stored_name}:{exp}".encode("utf-8")
    return hmac.new(_signing_key(settings), msg, hashlib.sha256).hexdigest()


def _make_signed_url(settings: Settings, stored_name: str) -> str:
    exp = int(time.time()) + int(settings.upload_url_ttl_seconds or 3600)
    sig = _sign(settings, stored_name, exp)
    return f"/api/v1/uploads/{stored_name}?exp={exp}&sig={sig}"


def _signature_ok(settings: Settings, stored_name: str, exp_raw: str | None, sig: str | None) -> bool:
    if not exp_raw or not sig:
        return False
    try:
        exp = int(exp_raw)
    except (TypeError, ValueError):
        return False
    if exp < int(time.time()):
        return False  # expired
    expected = _sign(settings, stored_name, exp)
    return hmac.compare_digest(expected, sig)


class UploadResponse(BaseModel):
    url: str
    filename: str
    size: int
    content_type: str


@router.post("/uploads", response_model=UploadResponse)
async def upload_file(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    file: UploadFile = File(...),
    _rl: Annotated[
        None, Depends(rate_limit("upload", "rate_limit_upload_per_min"))
    ] = None,
) -> UploadResponse:
    content_type = (file.content_type or "").lower() or (
        mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    )
    if not any(content_type.startswith(p) for p in ALLOWED_PREFIXES):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"File type not allowed: {content_type}",
        )
    # B4: block browser-executable types (html/xhtml/svg/xml/js). ``text/`` and
    # ``image/`` in ALLOWED_PREFIXES otherwise wave through text/html + svg.
    if is_dangerous_content_type(content_type):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"File type not allowed (executable/markup): {content_type}",
        )

    # Read + size check
    body = await file.read(MAX_FILE_BYTES + 1)
    if len(body) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {MAX_FILE_BYTES // (1024 * 1024)} MB limit",
        )
    # B4: sniff the real bytes — a dangerous payload can be smuggled under a
    # benign client-supplied Content-Type. Reject anything that looks like
    # markup/script regardless of the declared type.
    if sniff_is_markup(body):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="File content looks like HTML/SVG/script and is not allowed",
        )

    # Normalize filename (keep extension, prefix UUID)
    original = Path(file.filename or "file").name
    suffix = Path(original).suffix.lower() or (
        mimetypes.guess_extension(content_type) or ""
    )
    # Keep only a safe extension; the body of the stored name is random hex.
    if suffix and not re.fullmatch(r"\.[A-Za-z0-9]{1,16}", suffix):
        suffix = ""
    # B4: never persist a suffix that would make download re-derive a
    # renderable type (a stored ``.html`` re-guesses text/html).
    if dangerous_suffix(suffix):
        suffix = ""
    fid = uuid.uuid4().hex
    stored_name = f"{fid}{suffix}"
    (_upload_dir(settings) / stored_name).write_bytes(body)

    logger.info(
        "file_uploaded",
        participant_id=str(user["participant_id"]),
        filename=original,
        stored=stored_name,
        size=len(body),
        content_type=content_type,
    )

    return UploadResponse(
        url=_make_signed_url(settings, stored_name),
        filename=original,
        size=len(body),
        content_type=content_type,
    )


async def _attachment_referenced_in_member_room(
    db: AsyncSession,
    stored_name: str,
    participant_id: Any,
) -> bool:
    """True if a message in a room the participant belongs to references this
    attachment in its metadata. Used for Bearer-token (non-signed) reads so
    access is scoped to room members.
    """
    from app.models.message import Message as _Msg
    from app.models.room import RoomMember as _RM

    # Limit the scan to rooms the caller is in, then check those rooms'
    # messages for the stored_name in metadata.attachments[].url. The url is
    # stored with the signed query string, so match on the path substring.
    rows = (
        await db.execute(
            select(_Msg.metadata_)
            .join(_RM, _RM.room_id == _Msg.room_id)
            .where(_RM.participant_id == participant_id)
            .where(_Msg.metadata_.isnot(None))
            .where(_Msg.metadata_["attachments"].isnot(None))
        )
    ).all()
    needle = f"/uploads/{stored_name}"
    for (meta,) in rows:
        for att in (meta or {}).get("attachments") or []:
            if isinstance(att, dict) and needle in str(att.get("url", "")):
                return True
    return False


@router.get("/uploads/{stored_name}")
async def download_upload(
    stored_name: str,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> FileResponse:
    """Serve an uploaded attachment if the request is authorized.

    Authorization is satisfied by EITHER a valid signed URL (browser-friendly)
    OR a Bearer token whose participant is a member of a room that references
    the attachment. Auth is NOT optional — a request with neither is rejected.
    """
    if not _STORED_NAME_RE.fullmatch(stored_name):
        # Malformed / traversal attempt.
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bad filename")

    base = _upload_dir(settings).resolve()
    target = (base / stored_name).resolve()
    # Resolved path must stay inside the upload dir.
    if base != target.parent or not target.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    # 1) Signed URL?
    authorized = _signature_ok(
        settings,
        stored_name,
        request.query_params.get("exp"),
        request.query_params.get("sig"),
    )

    # 2) Bearer token + room membership?
    if not authorized:
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required to access this file",
                headers={"WWW-Authenticate": "Bearer"},
            )
        # Reuse the standard validator to identify the participant.
        user = await get_current_user(request=request, settings=settings, db=db)
        if not await _attachment_referenced_in_member_room(
            db, stored_name, user["participant_id"]
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You do not have access to this file",
            )

    guessed_type = mimetypes.guess_type(stored_name)[0] or "application/octet-stream"
    # B4: neutralize the served type — dangerous types download as octet-stream
    # attachments, only an image/pdf allowlist renders inline, nosniff + a
    # locked-down CSP are always set. ``download_name`` restores a friendly name.
    download_name = request.query_params.get("name") or stored_name
    media_type, headers = safe_download_headers(guessed_type, download_name)
    return FileResponse(
        path=str(target),
        media_type=media_type,
        headers=headers,
    )
