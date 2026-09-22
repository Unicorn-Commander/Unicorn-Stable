"""S3-compatible recording storage: SigV4 against the published AWS vectors,
and the exact PUT/DELETE conversation (httpx.MockTransport — no network)."""

from __future__ import annotations

import asyncio
import hashlib
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from app.config import Settings
from app.services import recording_storage as rs

# The three worked examples from "Examples: Signature Calculations in AWS
# Signature Version 4" (S3 docs). Matching them pins the canonicalisation,
# the signing-key chain and the presign path all at once.
_AK = "AKIA0000000000000000"
_SK = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
_WHEN = datetime(2013, 5, 24, 0, 0, 0, tzinfo=timezone.utc)


def _settings(**overrides):
    values = {
        "recording_s3_endpoint": "https://garage.test:3900",
        "recording_s3_bucket": "stable",
        "recording_s3_access_key": "GKtestaccess",
        "recording_s3_secret_key": "testsecret",
        "recording_s3_region": "garage",
        "recording_s3_prefix": "stable-recordings/",
        **overrides,
    }
    return Settings(**values)


def test_sigv4_get_object_matches_aws_example():
    headers = rs.sign_request(
        method="GET",
        url="https://examplebucket.s3.amazonaws.com/test.txt",
        headers={"host": "examplebucket.s3.amazonaws.com", "range": "bytes=0-9"},
        payload_hash=hashlib.sha256(b"").hexdigest(),
        access_key=_AK,
        secret_key=_SK,
        region="us-east-1",
        now=_WHEN,
    )
    assert headers["authorization"].endswith(
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    )
    assert "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date" in headers["authorization"]


def test_sigv4_put_object_matches_aws_example():
    body = b"Welcome to Amazon S3."
    headers = rs.sign_request(
        method="PUT",
        url="https://examplebucket.s3.amazonaws.com/test%24file.text",
        headers={
            "host": "examplebucket.s3.amazonaws.com",
            "date": "Fri, 24 May 2013 00:00:00 GMT",
            "x-amz-storage-class": "REDUCED_REDUNDANCY",
        },
        payload_hash=hashlib.sha256(body).hexdigest(),
        access_key=_AK,
        secret_key=_SK,
        region="us-east-1",
        now=_WHEN,
    )
    assert headers["authorization"].endswith(
        "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
    )


def test_presigned_get_matches_aws_example():
    url = rs.presign_url(
        method="GET",
        url="https://examplebucket.s3.amazonaws.com/test.txt",
        expires_seconds=86400,
        access_key=_AK,
        secret_key=_SK,
        region="us-east-1",
        now=_WHEN,
    )
    assert url.endswith(
        "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    )
    assert "X-Amz-Credential=AKIA0000000000000000%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" in url


def test_config_errors_name_the_missing_variable_without_values():
    assert rs.storage_config_error(_settings()) is None
    assert "ENDPOINT" in rs.storage_config_error(_settings(recording_s3_endpoint=""))
    assert "http" in rs.storage_config_error(_settings(recording_s3_endpoint="garage.test"))
    assert "BUCKET" in rs.storage_config_error(_settings(recording_s3_bucket=""))
    assert "ACCESS_KEY" in rs.storage_config_error(_settings(recording_s3_access_key=""))
    assert "SECRET_KEY" in rs.storage_config_error(_settings(recording_s3_secret_key=""))
    # repr never carries the secret
    assert "testsecret" not in repr(rs.storage_config(_settings()))


def test_object_key_url_and_inverse_round_trip():
    cfg = rs.storage_config(_settings())
    key = rs.object_key(cfg, room_id="room-1", row_id="row-1", kind="composite")
    assert key == "stable-recordings/room-1/row-1.mp4"
    url = rs.object_url(cfg, key)
    assert url == "https://garage.test:3900/stable/stable-recordings/room-1/row-1.mp4"
    assert rs.key_from_url(cfg, url) == key
    # A URL from another bucket/config is refused, never deleted by mistake.
    assert rs.key_from_url(cfg, "https://garage.test:3900/other/x.mp4") is None
    # Virtual-host style
    vcfg = rs.storage_config(_settings(recording_s3_path_style=False))
    assert rs.object_url(vcfg, key) == "https://stable.garage.test:3900/stable-recordings/room-1/row-1.mp4"
    assert rs.key_from_url(vcfg, rs.object_url(vcfg, key)) == key


def test_put_object_streams_the_file_with_a_signed_single_put(tmp_path: Path, monkeypatch):
    media = tmp_path / "call.mp4"
    media.write_bytes(b"x" * (3 * 1024 * 1024 + 17))  # spans several stream chunks
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["body"] = request.read()
        return httpx.Response(200)

    monkeypatch.setattr(rs, "TRANSPORT", httpx.MockTransport(handler))
    result = asyncio.run(
        rs.put_object(_settings(), file_path=media, key="stable-recordings/r/x.mp4", content_type="video/mp4")
    )
    assert result["ok"] is True
    assert result["url"] == "https://garage.test:3900/stable/stable-recordings/r/x.mp4"
    assert seen["method"] == "PUT"
    assert seen["body"] == media.read_bytes()
    assert seen["headers"]["content-length"] == str(media.stat().st_size)
    assert "transfer-encoding" not in seen["headers"]
    assert seen["headers"]["x-amz-content-sha256"] == hashlib.sha256(media.read_bytes()).hexdigest()
    assert seen["headers"]["authorization"].startswith("AWS4-HMAC-SHA256 Credential=GKtestaccess/")
    assert "testsecret" not in seen["headers"]["authorization"]
    assert seen["headers"]["content-type"] == "video/mp4"


def test_put_object_classifies_failures(tmp_path: Path, monkeypatch):
    media = tmp_path / "a.ogg"
    media.write_bytes(b"abc")

    monkeypatch.setattr(rs, "TRANSPORT", httpx.MockTransport(lambda r: httpx.Response(503)))
    res = asyncio.run(rs.put_object(_settings(), file_path=media, key="k", content_type="audio/ogg"))
    assert res["ok"] is False and res["retryable"] is True

    monkeypatch.setattr(rs, "TRANSPORT", httpx.MockTransport(lambda r: httpx.Response(403)))
    res = asyncio.run(rs.put_object(_settings(), file_path=media, key="k", content_type="audio/ogg"))
    assert res["ok"] is False and res["retryable"] is False

    res = asyncio.run(rs.put_object(_settings(), file_path=tmp_path / "nope", key="k", content_type="audio/ogg"))
    assert res["ok"] is False and res["retryable"] is True

    res = asyncio.run(
        rs.put_object(_settings(recording_s3_endpoint=""), file_path=media, key="k", content_type="audio/ogg")
    )
    assert res["ok"] is False and "ENDPOINT" in res["detail"]


def test_delete_object_treats_404_as_gone(monkeypatch):
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url}")
        assert request.headers["authorization"].startswith("AWS4-HMAC-SHA256")
        return httpx.Response(404)

    monkeypatch.setattr(rs, "TRANSPORT", httpx.MockTransport(handler))
    res = asyncio.run(rs.delete_object(_settings(), key="stable-recordings/r/x.mp4"))
    assert res["ok"] is True
    assert calls == ["DELETE https://garage.test:3900/stable/stable-recordings/r/x.mp4"]

    monkeypatch.setattr(rs, "TRANSPORT", httpx.MockTransport(lambda r: httpx.Response(500)))
    res = asyncio.run(rs.delete_object(_settings(), key="k"))
    assert res["ok"] is False and res["retryable"] is True


def test_presigned_download_link_is_time_bounded():
    url = rs.presigned_get_url(_settings(recording_download_link_seconds=600), key="stable-recordings/r/x.mp4")
    assert url.startswith("https://garage.test:3900/stable/stable-recordings/r/x.mp4?")
    assert "X-Amz-Expires=600" in url
    assert "testsecret" not in url
    assert rs.presigned_get_url(_settings(recording_s3_endpoint=""), key="k") is None


@pytest.mark.parametrize("kind,ext,ct", [("audio", "ogg", "audio/ogg"), ("composite", "mp4", "video/mp4")])
def test_kinds_map_to_extensions_and_content_types(kind, ext, ct):
    assert rs.EXTENSIONS[kind] == ext
    assert rs.CONTENT_TYPES[kind] == ct
