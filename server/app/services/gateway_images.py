"""Room attachment projection and bounded local image reads for gateway seats."""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import parse_qs, quote, urlsplit

from fastapi import HTTPException

if TYPE_CHECKING:
    from app.config import Settings

IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif"})
_STORED_NAME = re.compile(r"^[0-9a-f]{32}(?:\.[A-Za-z0-9]{1,16})?$")
ATTACHMENT_ROOM_KEY = "room_id"
ATTACHMENT_SENDER_KEY = "sender_id"


def stored_name(attachment: dict) -> str | None:
    """Only local upload URLs, including old /uploads URLs; never fetch a URL."""
    url = attachment.get("url")
    if not isinstance(url, str):
        return None
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None
    if parsed.scheme or parsed.netloc or parsed.fragment:
        return None
    for prefix in ("/api/v1/uploads/", "/uploads/"):
        if parsed.path.startswith(prefix):
            name = parsed.path[len(prefix) :]
            return name if _STORED_NAME.fullmatch(name) else None
    return None


def attachments(metadata: dict | None) -> list[dict]:
    raw = (metadata or {}).get("attachments")
    return [a for a in raw if isinstance(a, dict)] if isinstance(raw, list) else []


def attachment_room_id(attachment: dict) -> str | None:
    """Return the room binding recorded when the message was created."""
    value = attachment.get(ATTACHMENT_ROOM_KEY)
    return str(value) if value is not None else None


def attachment_sender_id(attachment: dict) -> str | None:
    """Return the sender binding recorded when the message was created."""
    value = attachment.get(ATTACHMENT_SENDER_KEY)
    return str(value) if value is not None else None


def attachment_uploader_id(attachment: dict, settings: "Settings") -> str | None:
    """Validate a signed upload URL and return its optional uploader claim.

    Claimed URLs sign ``name:exp:uploader_id``; legacy URLs without a claim
    sign ``name:exp``. Both forms must verify before a local upload is bound,
    so removing a claim from a claimed URL invalidates its signature.
    """
    name = stored_name(attachment)
    if name is None:
        return None
    url = attachment.get("url")
    if not isinstance(url, str):
        return None
    try:
        parsed = urlsplit(url)
        query = parse_qs(parsed.query, keep_blank_values=True)
    except ValueError:
        raise HTTPException(400, "Attachment upload signature is invalid")
    values = query.get("uploader_id")
    if values is None:
        uploader_id = None
    elif len(values) != 1 or not values[0]:
        raise HTTPException(400, "Attachment upload signature is invalid")
    else:
        uploader_id = values[0]

    # Import lazily: uploads.py is an API router, while this service is also
    # imported by that router's gateway sibling during application startup.
    from app.api.uploads import _signature_ok

    if not _signature_ok(
        settings,
        name,
        query.get("exp", [None])[0],
        query.get("sig", [None])[0],
        uploader_id,
    ):
        raise HTTPException(400, "Attachment upload signature is invalid")
    return uploader_id


def bind_attachment(
    attachment: dict,
    *,
    room_id: object,
    sender_id: object,
    settings: "Settings",
) -> dict:
    """Bind one local upload to its message room and sender.

    The fields are server-written. If a client reuses an attachment already
    carrying a different binding, refuse it rather than overwrite the proof.
    Non-local attachment metadata is left unchanged for existing clients.
    """
    name = stored_name(attachment)
    if name is None:
        return dict(attachment)

    expected_room = str(room_id)
    expected_sender = str(sender_id)
    uploader_id = attachment_uploader_id(attachment, settings)
    if uploader_id is not None and uploader_id != expected_sender:
        raise HTTPException(403, "Attachment was uploaded by another sender")

    recorded_room = attachment_room_id(attachment)
    if recorded_room is not None and recorded_room != expected_room:
        raise HTTPException(403, "Attachment is bound to another room")
    recorded_sender = attachment_sender_id(attachment)
    if recorded_sender is not None and recorded_sender != expected_sender:
        raise HTTPException(403, "Attachment is bound to another sender")

    result = dict(attachment)
    result[ATTACHMENT_ROOM_KEY] = expected_room
    result[ATTACHMENT_SENDER_KEY] = expected_sender
    return result


def bind_attachment_metadata(
    metadata: dict | None,
    *,
    room_id: object,
    sender_id: object,
    settings: "Settings",
) -> dict | None:
    """Copy message metadata and bind every local attachment it contains."""
    raw = (metadata or {}).get("attachments") if isinstance(metadata, dict) else None
    if not isinstance(raw, list):
        return metadata

    result = dict(metadata)
    projected = []
    for item in raw:
        projected.append(
            bind_attachment(
                item,
                room_id=room_id,
                sender_id=sender_id,
                settings=settings,
            )
            if isinstance(item, dict)
            else item
        )
    result["attachments"] = projected
    return result


def gateway_metadata(metadata: dict | None, room: str, message_id: object) -> dict:
    """Copy metadata; give local images a stable id and a scoped download route.

    Uploads have no attachment table/id. Their random stored-name stem is the
    id. Size/type/filename remain upload metadata, not authorization or proof
    of the bytes; the download checks the file independently.
    """
    result = dict(metadata or {})
    if not isinstance(result.get("attachments"), list):
        return result
    projected = []
    for attachment in attachments(metadata):
        item = dict(attachment)
        name = stored_name(item)
        if name and str(item.get("content_type", "")).lower().startswith("image/"):
            attachment_id = name.split(".", 1)[0]
            item["id"] = attachment_id
            item["download_url"] = (
                f"/api/v1/gateway/rooms/{quote(room, safe='')}/messages/"
                f"{message_id}/attachments/{attachment_id}"
            )
        projected.append(item)
    result["attachments"] = projected
    return result


def image_type(body: bytes) -> str | None:
    if body.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if body.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if body.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if body.startswith(b"RIFF") and body[8:12] == b"WEBP":
        return "image/webp"
    return None


def read_image(upload_dir: str, attachment: dict, max_bytes: int) -> tuple[bytes, str]:
    """Read at most cap+1 bytes from a regular, non-symlink upload file."""
    content_type = attachment.get("content_type")
    if not isinstance(content_type, str) or content_type.lower() not in IMAGE_TYPES:
        raise HTTPException(415, "Only PNG, JPEG, WebP and GIF images are supported")
    name = stored_name(attachment)
    if name is None:
        raise HTTPException(404, "Attachment not found")
    try:
        # The regex allows exactly one basename; O_NOFOLLOW also closes a
        # symlink swap between a path check and open. O_NONBLOCK avoids FIFOs.
        fd = os.open(
            Path(upload_dir).resolve() / name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
        )
        with os.fdopen(fd, "rb") as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise HTTPException(404, "Attachment not found")
            if info.st_size > max_bytes:
                raise HTTPException(413, "Image exceeds gateway size limit")
            body = file.read(max_bytes + 1)
    except OSError as exc:
        raise HTTPException(404, "Attachment not found") from exc
    if len(body) > max_bytes:
        raise HTTPException(413, "Image exceeds gateway size limit")
    detected = image_type(body)
    if detected != content_type.lower():
        raise HTTPException(415, "Image bytes do not match a supported content type")
    return body, detected
