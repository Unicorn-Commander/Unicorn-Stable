"""Gateway photo metadata, authenticated room/history scope and bounded bytes."""

from __future__ import annotations

import base64
import uuid
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.api import gateway as G
from app.api import messages as M
from app.api.uploads import _make_signed_url, _signature_ok
from app.auth.gateway_auth import GatewayAuthError
from app.config import Settings
from app.models.message import ContentType
from app.services.gateway_images import (
    bind_attachment,
    gateway_metadata,
    read_image,
    stored_name,
)
from app.services.room_class import RoomClassFacts
from test_nav_v3_gateway_seat import NOW, _human, _res, _room, _seat

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
)
ATTACHMENT_ID = "a" * 32
NAME = ATTACHMENT_ID + ".png"


def attachment(**kw):
    return {
        "url": f"/api/v1/uploads/{NAME}?exp=1&sig=expired-test-signature",
        "filename": "phone.png",
        "size": len(PNG),
        "content_type": "image/png",
        **kw,
    }


def signed_attachment(settings, uploader_id=None, **kw):
    return attachment(
        url=_make_signed_url(settings, NAME, uploader_id),
        **kw,
    )


@pytest.fixture
def photo(tmp_path):
    (tmp_path / NAME).write_bytes(PNG)
    return attachment()


@pytest.fixture
def room():
    return _room([], name="persephone")


@pytest.fixture
def principal():
    return SimpleNamespace(
        agent_id="persephone",
        allowed_rooms=["persephone"],
        history_from=None,
        auth_kind="key",
        human_sub=None,
    )


def test_payload_has_stable_id_and_scoped_url_without_mutating_stored_metadata():
    metadata = {"attachments": [attachment()], "client_msg_id": "client-1"}
    result = gateway_metadata(metadata, "stable-persephone", "message-1")
    assert result == {
        "attachments": [
            {
                **attachment(),
                "id": ATTACHMENT_ID,
                "download_url": (
                    "/api/v1/gateway/rooms/stable-persephone/messages/"
                    f"message-1/attachments/{ATTACHMENT_ID}"
                ),
            }
        ],
        "client_msg_id": "client-1",
    }
    assert "id" not in metadata["attachments"][0]
    assert "sig=" in metadata["attachments"][0]["url"]


@pytest.mark.parametrize(
    "url",
    [
        "https://other.invalid/api/v1/uploads/" + NAME,
        "//other.invalid/uploads/" + NAME,
        "/api/v1/uploads/../" + NAME,
        "/api/v1/uploads/%2e%2e/" + NAME,
        "/api/v1/uploads/" + NAME + "/extra",
        "/api/v1/uploads/" + NAME + "#fragment",
        None,
    ],
)
def test_attachment_url_cannot_select_an_arbitrary_path_or_host(url):
    assert stored_name(attachment(url=url)) is None


def test_legacy_local_upload_and_malformed_metadata():
    assert stored_name(attachment(url=f"/uploads/{NAME}")) == NAME
    assert gateway_metadata({}, "room", "message") == {}
    assert gateway_metadata({"attachments": [None, "bad"]}, "room", "message") == {
        "attachments": []
    }


@pytest.mark.parametrize(
    "body,content_type",
    [
        (PNG, "image/png"),
        (b"\xff\xd8\xff\xe0jpeg", "image/jpeg"),
        (b"GIF89aimage", "image/gif"),
        (b"RIFF\x04\x00\x00\x00WEBP", "image/webp"),
    ],
)
def test_allowed_image_bytes(tmp_path, photo, body, content_type):
    (tmp_path / NAME).write_bytes(body)
    assert read_image(
        str(tmp_path), {**photo, "content_type": content_type}, len(body)
    ) == (body, content_type)


@pytest.mark.parametrize(
    "content_type",
    ["image/heic", "image/svg+xml", "text/html", "application/pdf", None],
)
def test_unsupported_type_rejected(tmp_path, photo, content_type):
    with pytest.raises(HTTPException) as error:
        read_image(str(tmp_path), {**photo, "content_type": content_type}, 1024)
    assert error.value.status_code == 415


def test_declared_image_type_is_not_enough(tmp_path, photo):
    (tmp_path / NAME).write_bytes(b"<svg>not an image</svg>")
    with pytest.raises(HTTPException) as error:
        read_image(str(tmp_path), photo, 1024)
    assert error.value.status_code == 415


def test_cap_checks_real_size_even_if_metadata_lies(tmp_path, photo):
    with pytest.raises(HTTPException) as error:
        read_image(str(tmp_path), {**photo, "size": 1}, len(PNG) - 1)
    assert error.value.status_code == 413


def test_missing_file_and_symlink_are_not_served(tmp_path, photo):
    (tmp_path / NAME).unlink()
    for symlink in (False, True):
        if symlink:
            target = tmp_path / "other.png"
            target.write_bytes(PNG)
            (tmp_path / NAME).symlink_to(target)
        with pytest.raises(HTTPException) as error:
            read_image(str(tmp_path), photo, 1024)
        assert error.value.status_code == 404


def test_config_has_10_mib_default_and_positive_env_override(monkeypatch):
    monkeypatch.delenv("GATEWAY_IMAGE_MAX_BYTES", raising=False)
    assert Settings(_env_file=None).gateway_image_max_bytes == 10 * 1024 * 1024
    monkeypatch.setenv("GATEWAY_IMAGE_MAX_BYTES", "1234")
    assert Settings(_env_file=None).gateway_image_max_bytes == 1234
    monkeypatch.setenv("GATEWAY_IMAGE_MAX_BYTES", "0")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


@pytest.mark.asyncio
async def test_poll_keeps_sender_scrubbing_and_exposes_photo(room, principal, photo):
    sender = _human()
    sender.avatar_url = None
    message = SimpleNamespace(
        id=uuid.uuid4(),
        room_id=room.id,
        sender_id=sender.id,
        sender=sender,
        content="What is this?",
        content_type=ContentType.TEXT,
        metadata_={"attachments": [photo], "agent_id": "spoofed-seat"},
        parent_id=None,
        is_edited=False,
        edited_at=None,
        is_deleted=False,
        created_at=NOW,
    )
    service = SimpleNamespace(
        get_messages=AsyncMock(
            return_value={
                "messages": [{"message": message, "reply_count": 0}],
                "cursor": None,
                "has_more": False,
            }
        )
    )
    facts = RoomClassFacts(
        room_class="private", humans=1, own_seats=0, foreign_seats=0, guests=0
    )
    with (
        patch.object(G, "_gateway_rate_limit", new=AsyncMock()),
        patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)),
        patch.object(G, "_seat_agent_mode", new=AsyncMock(return_value="answers_all")),
        patch.object(G, "_find_seat_participant", new=AsyncMock(return_value=_seat())),
        patch.object(G, "_classify_for_seat", new=AsyncMock(return_value=facts)),
        patch.object(G, "touch_bridge_seen", new=AsyncMock()),
        patch.object(G, "clear_relay_pending", new=AsyncMock()),
        patch.object(G, "_build_message_service", return_value=service),
    ):
        result = await G.gateway_get_messages(
            room=room.name,
            principal=principal,
            db=AsyncMock(),
            livekit=AsyncMock(),
            redis=AsyncMock(),
            cursor=None,
            limit=50,
        )
    wire = result.model_dump(mode="json")["messages"][0]
    assert wire["sender"]["username"] == "aaron"
    assert wire["sender_type"] == "human"
    assert "agent_id" not in wire["metadata"]
    assert wire["metadata"]["attachments"][0]["id"] == ATTACHMENT_ID
    assert (
        f"/messages/{message.id}/attachments/"
        in wire["metadata"]["attachments"][0]["download_url"]
    )
    assert "agent_id" in message.metadata_  # projection did not change storage


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case,expected",
    [
        ("valid", 200),
        ("bound_same_room", 200),
        ("no_auth", 401),
        ("bad_key", 401),
        ("other_room", 403),
        ("member_revoked", 403),
        ("bound_other_room", 404),
        ("other_message", 404),
        ("message_in_another_room", 404),
        ("deleted", 404),
        ("before_floor", 404),
        ("missing_attachment", 404),
        ("heic", 415),
        ("over_cap", 413),
    ],
)
async def test_download_auth_scope_history_and_bytes(
    tmp_path, room, principal, photo, case, expected
):
    mid = uuid.uuid4()
    msg = SimpleNamespace(
        id=mid,
        room_id=room.id,
        is_deleted=case == "deleted",
        created_at=NOW,
        metadata_={"attachments": [photo]},
    )
    principal.history_from = (
        NOW + timedelta(seconds=1) if case == "before_floor" else NOW
    )
    if case == "other_room":
        principal.allowed_rooms = ["another-room"]
    if case == "message_in_another_room":
        msg.room_id = uuid.uuid4()
    if case == "bound_same_room":
        photo["room_id"] = str(room.id)
    if case == "bound_other_room":
        photo["room_id"] = str(uuid.uuid4())
    if case == "member_revoked":
        principal.allowed_rooms = ["@member"]
    if case == "heic":
        photo["content_type"] = "image/heic"
    cap = len(PNG) - 1 if case == "over_cap" else len(PNG)
    settings = Settings(
        _env_file=None, upload_dir=str(tmp_path), gateway_image_max_bytes=cap
    )
    db = AsyncMock()

    async def execute(query):
        compiled = query.compile()
        sql, params = str(compiled), compiled.params
        if case == "member_revoked":
            return _res(scalar=None)
        # Mirror the predicates in the existing SQL-backed fixtures; a query
        # missing any of these conditions must fail instead of leaking bytes.
        assert "messages.is_deleted IS false" in sql
        assert "messages.created_at >=" in sql
        visible = (
            params["id_1"] == msg.id
            and params["room_id_1"] == msg.room_id
            and not msg.is_deleted
            and msg.created_at >= params["created_at_1"]
        )
        return _res(scalar=msg if visible else None)

    db.execute.side_effect = execute
    app = FastAPI()
    app.include_router(G.router, prefix="/api/v1")
    app.dependency_overrides[G.get_db] = lambda: db
    app.dependency_overrides[G.get_redis] = lambda: AsyncMock()
    app.dependency_overrides[G.get_settings_dep] = lambda: settings
    verify = AsyncMock(return_value=principal)
    if case == "bad_key":
        verify.side_effect = GatewayAuthError(401, "Invalid gateway key")
    headers = (
        {}
        if case == "no_auth"
        else {"Authorization": "Bearer sbk-unit-photo-not-a-real-secret"}
    )
    target_mid = uuid.uuid4() if case == "other_message" else mid
    aid = "b" * 32 if case == "missing_attachment" else ATTACHMENT_ID
    with (
        patch.object(G, "_gateway_enabled", return_value=True),
        patch.object(G, "verify_gateway_key", new=verify),
        patch.object(G, "touch_bridge_fresh", new=AsyncMock()),
        patch.object(G, "_gateway_rate_limit", new=AsyncMock()),
        patch.object(G, "_resolve_room", new=AsyncMock(return_value=room)),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get(
                f"/api/v1/gateway/rooms/{room.name}/messages/{target_mid}/attachments/{aid}",
                headers=headers,
            )
    assert response.status_code == expected, response.text
    if expected == 200:
        assert response.content == PNG
        assert response.headers["content-type"] == "image/png"
        assert response.headers["cache-control"] == "private, no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
    if expected == 401:
        db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_message_create_binds_upload_to_room_and_sender(tmp_path):
    sender_id = uuid.uuid4()
    room_id = uuid.uuid4()
    settings = Settings(
        _env_file=None,
        upload_dir=str(tmp_path),
        upload_url_secret="upload-signing-test",
        upload_url_ttl_seconds=60,
    )
    db = AsyncMock()
    db.execute.return_value = SimpleNamespace(all=lambda: [])
    body = M.MessageCreate(
        content="photo",
        metadata={"attachments": [signed_attachment(settings, str(sender_id))]},
    )
    with patch.object(M, "get_settings", return_value=settings):
        bound_body = await M._bind_message_attachments(
            body,
            room_id=room_id,
            user={"participant_id": sender_id},
            db=db,
        )
    bound = bound_body.metadata["attachments"][0]
    assert bound["room_id"] == str(room_id)
    assert bound["sender_id"] == str(sender_id)


def test_message_create_refuses_attachment_bound_to_another_room(tmp_path):
    settings = Settings(
        _env_file=None,
        upload_dir=str(tmp_path),
        upload_url_secret="upload-signing-test",
        upload_url_ttl_seconds=60,
    )
    room_id = uuid.uuid4()
    sender_id = uuid.uuid4()
    with pytest.raises(HTTPException) as error:
        bind_attachment(
            signed_attachment(
                settings,
                str(sender_id),
                room_id=str(uuid.uuid4()),
                sender_id=str(sender_id),
            ),
            room_id=room_id,
            sender_id=sender_id,
            settings=settings,
        )
    assert error.value.status_code == 403


def test_new_upload_signature_binds_the_uploader(tmp_path):
    settings = Settings(
        _env_file=None,
        upload_dir=str(tmp_path),
        upload_url_secret="upload-signing-test",
        upload_url_ttl_seconds=60,
    )
    sender_id = uuid.uuid4()
    other_sender_id = uuid.uuid4()
    room_id = uuid.uuid4()
    url = _make_signed_url(settings, NAME, str(sender_id))
    query = dict(item.split("=", 1) for item in url.split("?", 1)[1].split("&"))
    assert _signature_ok(
        settings,
        NAME,
        query["exp"],
        query["sig"],
        str(sender_id),
    )
    assert not _signature_ok(
        settings,
        NAME,
        query["exp"],
        query["sig"],
        str(other_sender_id),
    )
    bound = bind_attachment(
        {"url": url, "room_id": str(room_id), "sender_id": str(sender_id)},
        room_id=room_id,
        sender_id=sender_id,
        settings=settings,
    )
    assert bound["sender_id"] == str(sender_id)
    with pytest.raises(HTTPException) as error:
        bind_attachment(
            {"url": url},
            room_id=uuid.uuid4(),
            sender_id=other_sender_id,
            settings=settings,
        )
    assert error.value.status_code == 403


def test_legacy_signed_upload_without_claim_is_still_accepted(tmp_path):
    settings = Settings(
        _env_file=None,
        upload_dir=str(tmp_path),
        upload_url_secret="upload-signing-test",
        upload_url_ttl_seconds=60,
    )
    room_id = uuid.uuid4()
    sender_id = uuid.uuid4()
    url = _make_signed_url(settings, NAME)
    query = dict(item.split("=", 1) for item in url.split("?", 1)[1].split("&"))

    assert "uploader_id" not in query
    assert _signature_ok(settings, NAME, query["exp"], query["sig"])
    bound = bind_attachment(
        {"url": url},
        room_id=room_id,
        sender_id=sender_id,
        settings=settings,
    )
    assert bound["room_id"] == str(room_id)
    assert bound["sender_id"] == str(sender_id)


def test_stripping_claim_from_signed_upload_is_refused(tmp_path):
    settings = Settings(
        _env_file=None,
        upload_dir=str(tmp_path),
        upload_url_secret="upload-signing-test",
        upload_url_ttl_seconds=60,
    )
    sender_id = uuid.uuid4()
    url = _make_signed_url(settings, NAME, str(sender_id))
    path, raw_query = url.split("?", 1)
    stripped_url = (
        path
        + "?"
        + "&".join(
            part for part in raw_query.split("&") if not part.startswith("uploader_id=")
        )
    )

    with pytest.raises(HTTPException) as error:
        bind_attachment(
            {"url": stripped_url},
            room_id=uuid.uuid4(),
            sender_id=sender_id,
            settings=settings,
        )
    assert error.value.status_code == 400


def test_stripping_whole_signed_query_is_refused(tmp_path):
    settings = Settings(
        _env_file=None,
        upload_dir=str(tmp_path),
        upload_url_secret="upload-signing-test",
        upload_url_ttl_seconds=60,
    )
    sender_id = uuid.uuid4()
    signed_url = _make_signed_url(settings, NAME, str(sender_id))
    path = signed_url.split("?", 1)[0]

    with pytest.raises(HTTPException) as error:
        bind_attachment(
            {"url": path},
            room_id=uuid.uuid4(),
            sender_id=sender_id,
            settings=settings,
        )
    assert error.value.status_code == 400


def test_forged_signature_is_refused(tmp_path):
    settings = Settings(
        _env_file=None,
        upload_dir=str(tmp_path),
        upload_url_secret="upload-signing-test",
        upload_url_ttl_seconds=60,
    )
    sender_id = uuid.uuid4()
    signed_url = _make_signed_url(settings, NAME, str(sender_id))
    path, raw_query = signed_url.split("?", 1)
    exp = next(
        part.split("=", 1)[1]
        for part in raw_query.split("&")
        if part.startswith("exp=")
    )
    forged_url = f"{path}?exp={exp}&sig={'0' * 64}"

    with pytest.raises(HTTPException) as error:
        bind_attachment(
            {"url": forged_url},
            room_id=uuid.uuid4(),
            sender_id=sender_id,
            settings=settings,
        )
    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_message_create_refuses_legacy_upload_reused_in_another_room():
    room_id = uuid.uuid4()
    sender_id = uuid.uuid4()
    prior_room_id = uuid.uuid4()
    settings = Settings(
        _env_file=None,
        upload_url_secret="upload-signing-test",
        upload_url_ttl_seconds=60,
    )
    legacy_attachment = signed_attachment(settings)
    db = AsyncMock()
    db.execute.return_value = SimpleNamespace(
        all=lambda: [(prior_room_id, sender_id, {"attachments": [legacy_attachment]})]
    )
    body = M.MessageCreate(
        content="photo",
        metadata={"attachments": [legacy_attachment]},
    )
    with pytest.raises(HTTPException) as error:
        with patch.object(M, "get_settings", return_value=settings):
            await M._bind_message_attachments(
                body,
                room_id=room_id,
                user={"participant_id": sender_id},
                db=db,
            )
    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_gateway_download_fails_closed_when_redis_is_unavailable(room, tmp_path):
    class BrokenRedis:
        async def incr(self, _key):
            raise ConnectionError("redis unavailable")

    principal = SimpleNamespace(rate_key="gateway-test", rate_limit_rpm=30)
    with pytest.raises(HTTPException) as error:
        await G.gateway_download_attachment(
            room=room.name,
            message_id=uuid.uuid4(),
            attachment_id=ATTACHMENT_ID,
            principal=principal,
            db=AsyncMock(),
            redis=BrokenRedis(),
            settings=Settings(_env_file=None, upload_dir=str(tmp_path)),
        )
    assert error.value.status_code == 503
    assert error.value.detail == (
        "Gateway download rate limiter unavailable; try again shortly."
    )


@pytest.mark.asyncio
async def test_gateway_message_reads_remain_fail_open_when_redis_is_unavailable():
    class BrokenRedis:
        async def incr(self, _key):
            raise ConnectionError("redis unavailable")

    principal = SimpleNamespace(rate_key="gateway-test", rate_limit_rpm=30)
    await G._gateway_rate_limit(
        principal,
        BrokenRedis(),
        bucket="gw_msg_read",
        fail_open=True,
    )
