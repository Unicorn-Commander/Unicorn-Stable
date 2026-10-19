"""Room attachment projection and bounded local image reads for gateway seats."""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path
from urllib.parse import quote, urlsplit

from fastapi import HTTPException

IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif"})
_STORED_NAME = re.compile(r"^[0-9a-f]{32}(?:\.[A-Za-z0-9]{1,16})?$")


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
