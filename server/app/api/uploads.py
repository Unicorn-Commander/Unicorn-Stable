"""File upload endpoint.

Stores files on the mounted ``uploads/`` volume with a UUID-prefixed filename
and returns a URL the client can put into a message's metadata.attachments.

Limits:
  * MAX_FILE_BYTES: hard cap per file
  * Allowed MIME types: images, common docs — anything else is rejected
"""

from __future__ import annotations

import mimetypes
import uuid
from pathlib import Path
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel

from app.deps import get_current_user

logger = structlog.get_logger(__name__)

router = APIRouter()

UPLOAD_DIR = Path("/home/stable/server/uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

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


class UploadResponse(BaseModel):
    url: str
    filename: str
    size: int
    content_type: str


@router.post("/uploads", response_model=UploadResponse)
async def upload_file(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    file: UploadFile = File(...),
) -> UploadResponse:
    content_type = (file.content_type or "").lower() or (
        mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    )
    if not any(content_type.startswith(p) for p in ALLOWED_PREFIXES):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"File type not allowed: {content_type}",
        )

    # Read + size check
    body = await file.read(MAX_FILE_BYTES + 1)
    if len(body) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {MAX_FILE_BYTES // (1024 * 1024)} MB limit",
        )

    # Normalize filename (keep extension, prefix UUID)
    original = Path(file.filename or "file").name
    suffix = Path(original).suffix.lower() or (
        mimetypes.guess_extension(content_type) or ""
    )
    fid = uuid.uuid4().hex
    stored_name = f"{fid}{suffix}"
    (UPLOAD_DIR / stored_name).write_bytes(body)

    logger.info(
        "file_uploaded",
        participant_id=str(user["participant_id"]),
        filename=original,
        stored=stored_name,
        size=len(body),
        content_type=content_type,
    )

    return UploadResponse(
        url=f"/uploads/{stored_name}",
        filename=original,
        size=len(body),
        content_type=content_type,
    )
