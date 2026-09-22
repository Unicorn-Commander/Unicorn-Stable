"""Finished-recording storage: S3-compatible PUT / DELETE / presigned GET.

Target is Garage ("Studio Storage") on our own hardware, reached with plain
AWS Signature V4 over the ``httpx`` client the server already depends on —
no boto3 (80 MB of botocore for one PUT and one DELETE), and every byte of
the request is visible in a unit test with ``httpx.MockTransport``.

Only the public S3 facts are configuration: endpoint, bucket, region, key
prefix, path-style addressing. Credentials come from the environment and are
never logged, never echoed into a row, never part of an error string.

Uploads stream the file from disk (one pass to hash it for
``x-amz-content-sha256``, one to send) with an explicit ``Content-Length`` so
the request is a single non-chunked PUT — what every S3 implementation
accepts. A single PUT is good to 5 GB; a two-hour 1080p composite is well
under that.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import quote, urlsplit

import httpx
import structlog

from app.config import Settings

logger = structlog.get_logger(__name__)

_EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
_UNSIGNED = "UNSIGNED-PAYLOAD"
_CHUNK = 1024 * 1024

#: Tests replace this with an ``httpx.MockTransport``; production leaves None.
TRANSPORT: Any = None

CONTENT_TYPES = {
    "audio": "audio/ogg",
    "composite": "video/mp4",
    "track": "video/mp4",
}
EXTENSIONS = {"audio": "ogg", "composite": "mp4", "track": "mp4"}


@dataclass(frozen=True)
class StorageConfig:
    endpoint: str
    bucket: str
    access_key: str
    secret_key: str
    region: str
    path_style: bool
    prefix: str

    def __repr__(self) -> str:  # never leak credentials via repr/log
        return (
            f"StorageConfig(endpoint={self.endpoint!r}, bucket={self.bucket!r}, "
            f"region={self.region!r}, path_style={self.path_style})"
        )


def storage_config_error(settings: Settings) -> str | None:
    """Non-secret reason storage cannot be used, or None when configured."""
    endpoint = (settings.recording_s3_endpoint or "").strip()
    if not endpoint:
        return "RECORDING_S3_ENDPOINT is not configured"
    if not endpoint.startswith(("http://", "https://")):
        return "RECORDING_S3_ENDPOINT must be an http(s) URL"
    if not (settings.recording_s3_bucket or "").strip():
        return "RECORDING_S3_BUCKET is not configured"
    if not (settings.recording_s3_access_key or "").strip():
        return "RECORDING_S3_ACCESS_KEY is not configured"
    if not (settings.recording_s3_secret_key or "").strip():
        return "RECORDING_S3_SECRET_KEY is not configured"
    return None


def storage_configured(settings: Settings) -> bool:
    return storage_config_error(settings) is None


def storage_config(settings: Settings) -> StorageConfig | None:
    if not storage_configured(settings):
        return None
    prefix = (settings.recording_s3_prefix or "").strip().strip("/")
    return StorageConfig(
        endpoint=settings.recording_s3_endpoint.strip().rstrip("/"),
        bucket=settings.recording_s3_bucket.strip(),
        access_key=settings.recording_s3_access_key.strip(),
        secret_key=settings.recording_s3_secret_key.strip(),
        region=(settings.recording_s3_region or "garage").strip() or "garage",
        path_style=bool(settings.recording_s3_path_style),
        prefix=f"{prefix}/" if prefix else "",
    )


def object_key(cfg: StorageConfig, *, room_id: Any, row_id: Any, kind: str) -> str:
    """``<prefix><room>/<row>.<ext>`` — one object per recording row."""
    ext = EXTENSIONS.get(kind, "bin")
    return f"{cfg.prefix}{room_id}/{row_id}.{ext}"


def object_url(cfg: StorageConfig, key: str) -> str:
    """The canonical (unsigned) URL of an object — what ``storage_url`` holds."""
    encoded = _encode_path(key)
    if cfg.path_style:
        return f"{cfg.endpoint}/{cfg.bucket}/{encoded}"
    scheme, host = cfg.endpoint.split("://", 1)
    return f"{scheme}://{cfg.bucket}.{host}/{encoded}"


def key_from_url(cfg: StorageConfig, url: str) -> str | None:
    """Inverse of :func:`object_url` for THIS configuration, else None."""
    if not url:
        return None
    parts = urlsplit(url)
    path = parts.path.lstrip("/")
    if cfg.path_style:
        prefix = f"{cfg.bucket}/"
        if not path.startswith(prefix):
            return None
        path = path[len(prefix):]
    from urllib.parse import unquote

    return unquote(path) or None


# ---------------------------------------------------------------------------
# AWS Signature V4 (S3 flavour)
# ---------------------------------------------------------------------------


def _encode_path(path: str) -> str:
    # S3: encode each segment once, keep the slashes, RFC 3986 unreserved safe.
    return "/".join(quote(seg, safe="-_.~") for seg in path.split("/"))


def _encode_query(params: dict[str, str]) -> str:
    return "&".join(
        f"{quote(k, safe='-_.~')}={quote(v, safe='-_.~')}"
        for k, v in sorted(params.items())
    )


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret: str, date: str, region: str, service: str = "s3") -> bytes:
    k_date = _hmac(("AWS4" + secret).encode("utf-8"), date)
    k_region = _hmac(k_date, region)
    k_service = _hmac(k_region, service)
    return _hmac(k_service, "aws4_request")


def _canonical_headers(headers: dict[str, str]) -> tuple[str, str]:
    items = sorted((k.lower().strip(), " ".join(v.strip().split())) for k, v in headers.items())
    canonical = "".join(f"{k}:{v}\n" for k, v in items)
    signed = ";".join(k for k, _ in items)
    return canonical, signed


def sign_request(
    *,
    method: str,
    url: str,
    headers: dict[str, str],
    payload_hash: str,
    access_key: str,
    secret_key: str,
    region: str,
    now: datetime | None = None,
) -> dict[str, str]:
    """Return ``headers`` plus ``x-amz-date``, ``x-amz-content-sha256`` and
    ``Authorization`` for a SigV4 header-authenticated request.

    ``headers`` must already carry ``host``. Every header passed is signed.
    """
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    date = stamp[:8]
    parts = urlsplit(url)
    all_headers = {k.lower(): v for k, v in headers.items()}
    all_headers["x-amz-date"] = stamp
    all_headers["x-amz-content-sha256"] = payload_hash

    canonical_headers, signed_headers = _canonical_headers(all_headers)
    query: dict[str, str] = {}
    if parts.query:
        from urllib.parse import parse_qsl

        query = dict(parse_qsl(parts.query, keep_blank_values=True))
    canonical_request = "\n".join(
        [
            method.upper(),
            parts.path or "/",
            _encode_query(query),
            canonical_headers,
            signed_headers,
            payload_hash,
        ]
    )
    scope = f"{date}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            stamp,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        _signing_key(secret_key, date, region),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    all_headers["authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return all_headers


def presign_url(
    *,
    method: str,
    url: str,
    expires_seconds: int,
    access_key: str,
    secret_key: str,
    region: str,
    now: datetime | None = None,
) -> str:
    """A query-string-authenticated URL (``X-Amz-*`` params), host-only signed."""
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    date = stamp[:8]
    parts = urlsplit(url)
    scope = f"{date}/{region}/s3/aws4_request"
    params = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key}/{scope}",
        "X-Amz-Date": stamp,
        "X-Amz-Expires": str(int(expires_seconds)),
        "X-Amz-SignedHeaders": "host",
    }
    if parts.query:
        from urllib.parse import parse_qsl

        params.update(dict(parse_qsl(parts.query, keep_blank_values=True)))
    canonical_query = _encode_query(params)
    canonical_request = "\n".join(
        [
            method.upper(),
            parts.path or "/",
            canonical_query,
            f"host:{parts.netloc}\n",
            "host",
            _UNSIGNED,
        ]
    )
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            stamp,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        _signing_key(secret_key, date, region),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{parts.scheme}://{parts.netloc}{parts.path}?{canonical_query}&X-Amz-Signature={signature}"


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(_CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


async def _stream_file(path: Path) -> AsyncIterator[bytes]:
    def _read(fh: Any) -> bytes:
        return fh.read(_CHUNK)

    with path.open("rb") as fh:
        while True:
            block = await asyncio.to_thread(_read, fh)
            if not block:
                return
            yield block


def _client() -> httpx.AsyncClient:
    kwargs: dict[str, Any] = {"timeout": httpx.Timeout(600.0, connect=10.0)}
    if TRANSPORT is not None:
        kwargs["transport"] = TRANSPORT
    return httpx.AsyncClient(**kwargs)


def _retryable(status_code: int) -> bool:
    return status_code == 429 or status_code >= 500


async def put_object(
    settings: Settings,
    *,
    file_path: Path,
    key: str,
    content_type: str,
) -> dict[str, Any]:
    """Upload one file. Returns ``{ok, url|detail, retryable}``; never raises."""
    cfg = storage_config(settings)
    if cfg is None:
        return {
            "ok": False,
            "retryable": False,
            "detail": storage_config_error(settings) or "storage not configured",
        }
    try:
        size = file_path.stat().st_size
    except OSError as exc:
        return {"ok": False, "retryable": True, "detail": f"file unreadable: {exc}"}
    if size <= 0:
        return {"ok": False, "retryable": False, "detail": "file is empty"}

    url = object_url(cfg, key)
    host = urlsplit(url).netloc
    try:
        payload_hash = await asyncio.to_thread(_sha256_file, file_path)
        headers = sign_request(
            method="PUT",
            url=url,
            headers={
                "host": host,
                "content-type": content_type,
                "content-length": str(size),
            },
            payload_hash=payload_hash,
            access_key=cfg.access_key,
            secret_key=cfg.secret_key,
            region=cfg.region,
        )
        async with _client() as client:
            resp = await client.request(
                "PUT", url, headers=headers, content=_stream_file(file_path)
            )
    except Exception as exc:
        return {
            "ok": False,
            "retryable": True,
            "detail": f"storage PUT failed: {type(exc).__name__}: {exc}"[:500],
        }
    if resp.status_code >= 300:
        return {
            "ok": False,
            "retryable": _retryable(resp.status_code),
            "http_status": resp.status_code,
            "detail": f"storage PUT returned HTTP {resp.status_code}",
        }
    logger.info("recording_storage_uploaded", key=key, bytes=size)
    return {"ok": True, "url": url, "bytes": size, "sha256": payload_hash}


async def delete_object(settings: Settings, *, key: str) -> dict[str, Any]:
    """Delete one object. 404 counts as success (already gone). Never raises."""
    cfg = storage_config(settings)
    if cfg is None:
        return {
            "ok": False,
            "retryable": False,
            "detail": storage_config_error(settings) or "storage not configured",
        }
    url = object_url(cfg, key)
    host = urlsplit(url).netloc
    try:
        headers = sign_request(
            method="DELETE",
            url=url,
            headers={"host": host},
            payload_hash=_EMPTY_SHA256,
            access_key=cfg.access_key,
            secret_key=cfg.secret_key,
            region=cfg.region,
        )
        async with _client() as client:
            resp = await client.request("DELETE", url, headers=headers)
    except Exception as exc:
        return {
            "ok": False,
            "retryable": True,
            "detail": f"storage DELETE failed: {type(exc).__name__}: {exc}"[:500],
        }
    if resp.status_code in (200, 202, 204, 404):
        logger.info("recording_storage_deleted", key=key, http_status=resp.status_code)
        return {"ok": True, "http_status": resp.status_code}
    return {
        "ok": False,
        "retryable": _retryable(resp.status_code),
        "http_status": resp.status_code,
        "detail": f"storage DELETE returned HTTP {resp.status_code}",
    }


def presigned_get_url(settings: Settings, *, key: str, expires_seconds: int | None = None) -> str | None:
    cfg = storage_config(settings)
    if cfg is None:
        return None
    ttl = int(expires_seconds or settings.recording_download_link_seconds or 900)
    return presign_url(
        method="GET",
        url=object_url(cfg, key),
        expires_seconds=max(60, ttl),
        access_key=cfg.access_key,
        secret_key=cfg.secret_key,
        region=cfg.region,
    )


__all__ = [
    "CONTENT_TYPES",
    "EXTENSIONS",
    "StorageConfig",
    "storage_config",
    "storage_config_error",
    "storage_configured",
    "object_key",
    "object_url",
    "key_from_url",
    "sign_request",
    "presign_url",
    "put_object",
    "delete_object",
    "presigned_get_url",
]
