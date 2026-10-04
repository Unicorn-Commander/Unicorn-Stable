"""Gateway key history floor and expiry against a REAL async PostgreSQL.

The unit test mocks the session, so it cannot see that ``not_before`` is a
WHERE clause. This script inserts a room, lines before and after a floor,
and a key with that floor, then calls the messages handler and the context
handler. It also rejects an expired key.

Run against a THROWAWAY database only (the script drops and recreates every
table), for example a local container:

    docker run -d --rm --name stable-floor-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16-alpine
    TEST_DATABASE_URL=postgresql+asyncpg://postgres:pw@127.0.0.1:55432/stable_floor_test \\
      python tests/test_gateway_key_expiry_floor_pg.py
    docker stop stable-floor-pg

No pytest dependency: the backend image does not ship one. Exit 0 = pass.

UNRUN by the lane that wrote it: docker is denied here. The orchestrator runs it.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.models  # noqa: E402, F401  — register every table before create_all
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.api import gateway as G  # noqa: E402
from app.auth.gateway_auth import GatewayAuthError, hash_key, verify_gateway_key  # noqa: E402
from app.models.base import Base  # noqa: E402
from app.models.message import ContentType, Message  # noqa: E402
from app.models.participant import Participant, ParticipantType  # noqa: E402
from app.models.room import Room, RoomType  # noqa: E402
from app.models.agent_gateway_key import AgentGatewayKey  # noqa: E402

FAILURES: list[str] = []

FLOOR = datetime(2026, 6, 1, tzinfo=timezone.utc)
PRE = "PRE-FLOOR-BODY"
PRE_REPLY = "PRE-FLOOR-REPLY"
POST = "POST-FLOOR-BODY"
POST_REPLY = "POST-FLOOR-REPLY"
SUMMARY = "PRE-FLOOR-SUMMARY secret venue"
# Fixture material for this throwaway database. Not a credential.
LIVE_KEY = "sbk-pg-floor-fixture"
EXPIRED_KEY = "sbk-pg-expired-fixture"


def check(label: str, got, want) -> None:
    if got != want:
        FAILURES.append(f"{label}: got {got!r}, want {want!r}")
    else:
        print(f"ok   {label}")


def check_true(label: str, ok: bool, detail: str = "") -> None:
    if not ok:
        FAILURES.append(f"{label}: {detail}")
    else:
        print(f"ok   {label}")


async def main() -> None:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        print("TEST_DATABASE_URL is required (a THROWAWAY database).")
        sys.exit(2)
    if url.rsplit("/", 1)[-1] in ("stable", "postgres"):
        print("Refusing to run against a non-throwaway database name.")
        sys.exit(2)

    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.execute(text('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    before_id = uuid.uuid4()
    async with session_factory() as db:
        sender = Participant(
            keycloak_sub="human-floor-fixture",
            username="aaron",
            display_name="Aaron",
            participant_type=ParticipantType.HUMAN,
        )
        db.add(sender)
        await db.flush()
        room = Room(
            name="floor-room",
            display_name="Floor",
            livekit_room_name="stable-floor-room",
            room_type=RoomType.CHANNEL,
            metadata_={
                "context_summary": {
                    "text": SUMMARY,
                    "watermark_ts": "2020-01-01T00:00:00+00:00",
                }
            },
        )
        db.add(room)
        await db.flush()
        before = Message(
            id=before_id,
            room_id=room.id,
            sender_id=sender.id,
            content=PRE,
            content_type=ContentType.TEXT,
            created_at=FLOOR - timedelta(days=30),
        )
        db.add(before)
        await db.flush()
        db.add_all(
            [
                Message(
                    room_id=room.id,
                    sender_id=sender.id,
                    content=PRE_REPLY,
                    content_type=ContentType.TEXT,
                    parent_id=before.id,
                    created_at=FLOOR - timedelta(days=29),
                ),
                Message(
                    room_id=room.id,
                    sender_id=sender.id,
                    content=POST,
                    content_type=ContentType.TEXT,
                    created_at=FLOOR + timedelta(days=30),
                ),
                Message(
                    room_id=room.id,
                    sender_id=sender.id,
                    content=POST_REPLY,
                    content_type=ContentType.TEXT,
                    parent_id=before.id,
                    created_at=FLOOR + timedelta(days=31),
                ),
            ]
        )
        db.add(
            AgentGatewayKey(
                key_hash=hash_key(LIVE_KEY),
                key_prefix=LIVE_KEY[:12],
                agent_id="floor-seat",
                allowed_rooms=["*"],
                rate_limit_rpm=30,
                history_from=FLOOR,
                expires_at=datetime(2027, 1, 1, tzinfo=timezone.utc),
            )
        )
        db.add(
            AgentGatewayKey(
                key_hash=hash_key(EXPIRED_KEY),
                key_prefix=EXPIRED_KEY[:12],
                agent_id="floor-seat",
                allowed_rooms=["*"],
                rate_limit_rpm=30,
                history_from=FLOOR,
                expires_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )
        )
        await db.commit()
        room_name = room.livekit_room_name

    async with session_factory() as db:
        try:
            principal = await verify_gateway_key(LIVE_KEY, db)
        except Exception as exc:  # noqa: BLE001
            FAILURES.append(f"live key raised {exc.__class__.__name__}: {exc}")
            principal = None
        if principal is not None:
            check_true(
                "live key carries the floor",
                principal.history_from is not None
                and principal.history_from.replace(tzinfo=timezone.utc) <= FLOOR + timedelta(seconds=1)
                and principal.history_from.replace(tzinfo=timezone.utc) >= FLOOR - timedelta(seconds=1),
                repr(principal.history_from),
            )

        try:
            await verify_gateway_key(EXPIRED_KEY, db)
            FAILURES.append("expired key was accepted")
        except GatewayAuthError as exc:
            check("expired key status", exc.status_code, 401)
            check("expired key message", exc.detail, "Gateway key expired")
        except Exception as exc:  # noqa: BLE001
            FAILURES.append(f"expired key raised {exc.__class__.__name__}: {exc}")

    if principal is not None:
        async with session_factory() as db:
            try:
                with (
                    patch.object(G, "_gateway_rate_limit", new=AsyncMock()),
                    patch.object(G, "touch_bridge_seen", new=AsyncMock()),
                    patch.object(G, "clear_relay_pending", new=AsyncMock()),
                ):
                    page = await G.gateway_get_messages(
                        room=room_name,
                        principal=principal,
                        db=db,
                        livekit=AsyncMock(),
                        redis=AsyncMock(),
                        cursor=None,
                        limit=50,
                    )
                bodies = [message.content for message in page.messages]
            except Exception as exc:  # noqa: BLE001
                FAILURES.append(f"messages handler raised {exc.__class__.__name__}: {exc}")
                bodies = None
            if bodies is not None:
                check("messages page is only the post-floor line", bodies, [POST])

        async with session_factory() as db:
            try:
                with (
                    patch.object(G, "_gateway_rate_limit", new=AsyncMock()),
                    patch.object(G, "touch_bridge_seen", new=AsyncMock()),
                    patch.object(G, "clear_relay_pending", new=AsyncMock()),
                ):
                    older = await G.gateway_get_messages(
                        room=room_name,
                        principal=principal,
                        db=db,
                        livekit=AsyncMock(),
                        redis=AsyncMock(),
                        cursor=str(before_id),
                        limit=50,
                    )
                older_bodies = [message.content for message in older.messages]
            except Exception as exc:  # noqa: BLE001
                FAILURES.append(f"cursor page raised {exc.__class__.__name__}: {exc}")
                older_bodies = None
            if older_bodies is not None:
                check("pre-floor cursor is an empty page", older_bodies, [])
                check("pre-floor cursor has no next page", older.has_more, False)

        async with session_factory() as db:
            try:
                with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
                    ctx = await G.gateway_get_context(
                        room=room_name,
                        principal=principal,
                        db=db,
                        redis=AsyncMock(),
                        budget_tokens=6000,
                        since=None,
                    )
                blob = json.dumps(ctx)
            except Exception as exc:  # noqa: BLE001
                FAILURES.append(f"context handler raised {exc.__class__.__name__}: {exc}")
                blob = None
            if blob is not None:
                check_true("context includes the post-floor line", POST in blob, blob)
                check_true("context includes the post-floor reply", POST_REPLY in blob, blob)
                check_true("context hides the pre-floor line", PRE not in blob, blob)
                check_true("context hides the pre-floor reply", PRE_REPLY not in blob, blob)
                check_true("context hides the rolling summary", SUMMARY not in blob and ctx.get("summary") is None, blob)

        async with session_factory() as db:
            try:
                with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
                    delta = await G.gateway_get_context(
                        room=room_name,
                        principal=principal,
                        db=db,
                        redis=AsyncMock(),
                        budget_tokens=6000,
                        since=before_id,
                    )
                delta_blob = json.dumps(delta)
            except Exception as exc:  # noqa: BLE001
                FAILURES.append(f"since page raised {exc.__class__.__name__}: {exc}")
                delta_blob = None
            if delta_blob is not None:
                check_true("since-before-floor still shows the post-floor line", POST in delta_blob, delta_blob)
                check_true("since-before-floor hides the pre-floor line", PRE not in delta_blob, delta_blob)

    await engine.dispose()
    if FAILURES:
        print("\nFAILED:")
        for failure in FAILURES:
            print(" -", failure)
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    asyncio.run(main())
