"""Instance branding (identity) — logo, display name, description.

Why a served endpoint and not `instances.json`
----------------------------------------------
`instances.json` is a per-deploy RUNTIME MOUNT: it is the *viewer's* list of
servers they can reach. Two properties make it the wrong home for branding:

  1. It is edited by whoever mounts the file on the viewing deploy — NOT by the
     admin of the server being described. Aaron's requirement ("the server admin
     should have the option of changing it") is a runtime, per-server-admin
     capability. A static file cannot express that.
  2. It is N-copies-per-fleet. A rename or a new logo on server B would have to
     be hand-propagated into every other server's mounted file.

So branding is OWNED AND SERVED BY THE SERVER IT DESCRIBES, at
``GET /api/v1/instance/meta`` on that server's own API origin, and edited by
that server's admins via ``PUT``. `instances.json` keeps only the *routing*
facts (id, origins, Keycloak coords) plus a fallback name — the client renders
those immediately and upgrades to live meta when it arrives.

Tradeoff, stated plainly: this costs one small cross-origin GET per federated
server at startup, it can be stale/unreachable when a peer is down (we fall
back to the static values and never block the rail), and the peer's response is
UNTRUSTED INPUT rendered in every viewer's client. That last point drives the
whole security posture below.

Security posture
----------------
* **No remote URL is ever honoured.** The meta document deliberately has NO
  `logo_url` field. It reports ``logo: true|false`` and a ``logo_version``; the
  client derives the URL as ``{that server's apiBaseUrl}/api/v1/instance/logo``.
  A hostile peer therefore cannot point every viewer's browser at a third-party
  tracker, an internal-network address (SSRF-by-browser), or a `javascript:` /
  `data:` URI. The only host that learns the viewer's IP is the host the client
  is already talking to.
* **The logo is bytes we serve, not markup.** Uploads are restricted to raster
  images (PNG/JPEG/WebP/GIF/AVIF), size-capped, and content-sniffed with the
  existing upload guard. **SVG is refused** — SVG is a script-execution vector.
  Responses carry `nosniff`, a `default-src 'none'` CSP and
  `Content-Disposition: inline` with a fixed filename.
* **Text is text.** Name/description are stripped of control characters and of
  Unicode bidi overrides (the classic rail-spoofing trick), length-capped, and
  rendered by React as text nodes. No HTML is produced or accepted.
* **Storage is a plain JSON file** under the existing persisted upload volume,
  written atomically. No new table, so no Alembic head to collide with the
  other agents working in parallel.
"""

from __future__ import annotations

import json
import os
import re
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from app.config import Settings
from app.deps import get_current_user, get_settings_dep, rate_limit
from app.security.upload_guard import is_dangerous_content_type, sniff_is_markup

logger = structlog.get_logger(__name__)

router = APIRouter()

# --- limits -----------------------------------------------------------------

MAX_LOGO_BYTES = 512 * 1024  # a rail icon renders at 48px; half a MB is generous
NAME_MAX = 40
DESCRIPTION_MAX = 280

# Raster only. SVG is intentionally absent: it is an active-content format and
# would execute in the <img>/CSS context of every viewer in the federation.
LOGO_TYPES: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
}

# Magic-byte prefixes, checked against the real bytes rather than the
# client-declared Content-Type.
_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)


def _sniff_image_type(body: bytes) -> str | None:
    """Return the true image type of ``body``, or None if it isn't one we allow."""
    for prefix, mime in _MAGIC:
        if body.startswith(prefix):
            return mime
    # RIFF....WEBP
    if len(body) >= 12 and body[0:4] == b"RIFF" and body[8:12] == b"WEBP":
        return "image/webp"
    # ISO-BMFF branded 'avif'/'avis'
    if len(body) >= 12 and body[4:8] == b"ftyp" and body[8:12] in (b"avif", b"avis"):
        return "image/avif"
    return None


# --- storage ----------------------------------------------------------------


def _meta_dir(settings: Settings) -> Path:
    """Branding lives beside uploads (an already-persisted volume) in its own
    subdirectory. The authenticated upload route only serves names matching
    ``^[0-9a-f]{32}...`` at the top level, so nothing here is reachable through
    it. Overridable with INSTANCE_META_DIR for operators who mount elsewhere."""
    override = os.environ.get("INSTANCE_META_DIR")
    d = Path(override) if override else Path(settings.upload_dir) / "_instance"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _meta_path(settings: Settings) -> Path:
    return _meta_dir(settings) / "meta.json"


def _admin_roles() -> set[str]:
    raw = os.environ.get("STABLE_ADMIN_ROLES", "stable-admin,realm-admin,admin")
    return {r.strip() for r in raw.split(",") if r.strip()}


def _require_admin(user: dict[str, Any]) -> None:
    roles = {str(r) for r in (user.get("roles") or [])}
    if not (roles & _admin_roles()):
        # 403, not 404: the caller is authenticated, they simply aren't an admin.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only a server admin can change this server's identity.",
        )


# --- sanitisation -----------------------------------------------------------

# Bidi overrides + invisible formatting. Left in a server NAME these let a
# hostile peer render itself as a different server in everyone's rail
# (e.g. "evil‮...moc.lio" reading as a trusted name). Stripped on write
# AND re-stripped on the client on read — a peer we federate with runs its own
# code and may not have this guard.
_BIDI = "".join(
    chr(c)
    for c in (
        0x200E, 0x200F, 0x061C,
        0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
        0x2066, 0x2067, 0x2068, 0x2069,
    )
)
_BIDI_RE = re.compile(f"[{_BIDI}]")


def clean_text(value: str | None, *, limit: int, allow_newlines: bool = False) -> str:
    """Normalize to a safe, renderable single- (or few-) line string."""
    if not value:
        return ""
    text = unicodedata.normalize("NFC", str(value))
    text = _BIDI_RE.sub("", text)
    keep_nl = "\n" if allow_newlines else ""
    text = "".join(
        ch
        for ch in text
        if ch in keep_nl or (unicodedata.category(ch) not in ("Cc", "Cf", "Co", "Cs"))
    )
    if allow_newlines:
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = "\n".join(line.strip() for line in text.split("\n"))
    text = re.sub(r"[ \t]{2,}", " ", text).strip()
    return text[:limit]


_ACCENT_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def clean_accent(value: str | None) -> str | None:
    if not value:
        return None
    v = value.strip()
    return v.lower() if _ACCENT_RE.match(v) else None


# --- model ------------------------------------------------------------------


class InstanceMetaIn(BaseModel):
    name: str | None = Field(default=None, max_length=NAME_MAX * 4)
    description: str | None = Field(default=None, max_length=DESCRIPTION_MAX * 4)
    accent: str | None = Field(default=None, max_length=16)


class InstanceMetaOut(BaseModel):
    name: str
    description: str
    accent: str | None = None
    # Presence flag + cache-buster ONLY. No URL: the client derives the logo
    # address from the origin it already trusts to talk to. See module docstring.
    logo: bool = False
    logo_version: str | None = None
    updated_at: float | None = None


def _read(settings: Settings) -> dict[str, Any]:
    path = _meta_path(settings)
    try:
        raw = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _write(settings: Settings, data: dict[str, Any]) -> None:
    path = _meta_path(settings)
    tmp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    os.replace(tmp, path)  # atomic: a concurrent reader never sees a half file


def _logo_file(settings: Settings, data: dict[str, Any]) -> Path | None:
    stored = data.get("logo_file")
    if not stored or not re.fullmatch(r"logo-[0-9a-f]{8,32}\.[a-z0-9]{1,5}", str(stored)):
        return None
    path = _meta_dir(settings) / str(stored)
    return path if path.is_file() else None


def _current(settings: Settings) -> InstanceMetaOut:
    data = _read(settings)
    has_logo = _logo_file(settings, data) is not None
    return InstanceMetaOut(
        name=clean_text(data.get("name"), limit=NAME_MAX),
        description=clean_text(data.get("description"), limit=DESCRIPTION_MAX, allow_newlines=True),
        accent=clean_accent(data.get("accent")),
        logo=has_logo,
        logo_version=str(data.get("logo_version")) if has_logo and data.get("logo_version") else None,
        updated_at=float(data["updated_at"]) if isinstance(data.get("updated_at"), (int, float)) else None,
    )


# --- routes -----------------------------------------------------------------


@router.get("/instance/meta", response_model=InstanceMetaOut)
async def get_instance_meta(
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> Response:
    """Public branding for THIS server.

    Deliberately unauthenticated: a viewer must be able to label a server on the
    rail before (or without) holding a session on it, and everything here is
    public-by-intent branding — no room names, no user data, no counts.

    ``Access-Control-Allow-Origin: *`` is set so sibling Stable deploys can read
    it without every peer's origin being listed in CORS_ORIGINS. It is safe here
    precisely because the response is credential-free and secret-free; when the
    caller's origin IS allow-listed, CORSMiddleware overwrites this with the
    specific origin and the credentialed policy.
    """
    body = _current(settings).model_dump()
    return JSONResponse(
        body,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=60",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.put("/instance/meta", response_model=InstanceMetaOut)
async def update_instance_meta(
    payload: InstanceMetaIn,
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    _rl: Annotated[None, Depends(rate_limit("instance_meta", "rate_limit_upload_per_min"))] = None,
) -> InstanceMetaOut:
    """Admin-only. Sets this server's display name / description / accent."""
    _require_admin(user)
    data = _read(settings)
    if payload.name is not None:
        data["name"] = clean_text(payload.name, limit=NAME_MAX)
    if payload.description is not None:
        data["description"] = clean_text(
            payload.description, limit=DESCRIPTION_MAX, allow_newlines=True
        )
    if payload.accent is not None:
        cleaned = clean_accent(payload.accent)
        if cleaned:
            data["accent"] = cleaned
        else:
            data.pop("accent", None)
    data["updated_at"] = time.time()
    _write(settings, data)
    logger.info("instance_meta_updated", by=str(user.get("username")))
    return _current(settings)


@router.post("/instance/logo", response_model=InstanceMetaOut)
async def upload_instance_logo(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
    file: UploadFile = File(...),
    _rl: Annotated[None, Depends(rate_limit("instance_logo", "rate_limit_upload_per_min"))] = None,
) -> InstanceMetaOut:
    """Admin-only. Replaces this server's rail logo.

    Four gates, in order: declared type is an allowed raster type; declared type
    isn't a known-dangerous/markup type; the bytes don't *look* like markup; and
    the magic bytes agree with an allowed raster type. The last gate is the one
    that matters — everything before it is client-supplied.
    """
    _require_admin(user)

    declared = (file.content_type or "").split(";")[0].strip().lower()
    if declared and (declared not in LOGO_TYPES or is_dangerous_content_type(declared)):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Logo must be a PNG, JPEG, WebP, GIF or AVIF image (got {declared}). "
            "SVG is not accepted.",
        )

    body = await file.read(MAX_LOGO_BYTES + 1)
    if len(body) > MAX_LOGO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Logo exceeds {MAX_LOGO_BYTES // 1024} KB.",
        )
    if not body:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file.")
    if sniff_is_markup(body):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="That file's contents look like markup/script, not an image.",
        )
    actual = _sniff_image_type(body)
    if actual is None:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="That file is not a PNG, JPEG, WebP, GIF or AVIF image.",
        )

    data = _read(settings)
    previous = _logo_file(settings, data)

    version = uuid.uuid4().hex[:12]
    stored = f"logo-{version}{LOGO_TYPES[actual]}"
    (_meta_dir(settings) / stored).write_bytes(body)

    data["logo_file"] = stored
    data["logo_type"] = actual
    data["logo_version"] = version
    data["updated_at"] = time.time()
    _write(settings, data)

    # Only after the pointer is committed — a crash mid-way leaves the old logo
    # serving rather than a broken one.
    if previous is not None and previous.name != stored:
        try:
            previous.unlink()
        except OSError:
            pass

    logger.info("instance_logo_updated", by=str(user.get("username")), type=actual, size=len(body))
    return _current(settings)


@router.delete("/instance/logo", response_model=InstanceMetaOut)
async def delete_instance_logo(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> InstanceMetaOut:
    """Admin-only. Reverts the rail to the generated initial + identity colour."""
    _require_admin(user)
    data = _read(settings)
    existing = _logo_file(settings, data)
    for key in ("logo_file", "logo_type", "logo_version"):
        data.pop(key, None)
    data["updated_at"] = time.time()
    _write(settings, data)
    if existing is not None:
        try:
            existing.unlink()
        except OSError:
            pass
    return _current(settings)


@router.get("/instance/logo")
async def get_instance_logo(
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> Response:
    """The raw logo bytes, served from this server's own origin.

    Served with the type we SNIFFED at upload (never a client-declared one),
    `nosniff`, and a `default-src 'none'` CSP so that even if a future format
    gains active-content behaviour it has nothing to reach. 404 when unset, which
    the client treats as "fall back to the generated initial".
    """
    data = _read(settings)
    path = _logo_file(settings, data)
    if path is None:
        return Response(status_code=status.HTTP_404_NOT_FOUND)
    media_type = str(data.get("logo_type") or "application/octet-stream")
    if media_type not in LOGO_TYPES:
        media_type = "application/octet-stream"
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=300",
            "Content-Disposition": 'inline; filename="logo"',
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
        },
    )
