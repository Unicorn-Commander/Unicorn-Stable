"""Real PostgreSQL webhook proof; run explicitly against an EMPTY throwaway DB.

PYTHONPATH=. TEST_DATABASE_URL=postgresql+asyncpg://.../stable_webhook_test \
    python tests/projectops_database_proof.py

Creates tables, never drops existing data. Refuses other database names.
LiveKit is doubled; routing, transactions and constraints are real.
"""
import asyncio
import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from unittest.mock import AsyncMock

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.project_ops import router
from app.config import Settings
from app.deps import get_db, get_livekit, get_redis, get_settings_dep
from app.models import Base, Message, Participant, Room, RoomMember


async def main():
    url = os.environ["TEST_DATABASE_URL"]
    assert make_url(url).database == "stable_webhook_test", "throwaway DB required"
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as connection:
            assert not await connection.scalar(text(
                "SELECT EXISTS (SELECT FROM information_schema.tables "
                "WHERE table_schema='public' AND table_type='BASE TABLE')"
            )), "database must be empty"
            await connection.execute(text('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'))
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as db:
            db.add(Room(name="fixture-room", display_name="Fixture", livekit_room_name="fixture"))
            await db.commit()

        async def database():
            async with sessions() as db:
                yield db

        settings = Settings(
            projectops_webhook_secret="synthetic-test-secret",
            projectops_workspace_id="fixture-workspace",
            projectops_room_mapping={"fixture-assignee": "fixture-room"},
            rate_limit_enabled=False,
        )
        app = FastAPI()
        app.include_router(router, prefix="/api/v1")
        app.dependency_overrides.update({
            get_db: database,
            get_livekit: lambda: AsyncMock(),
            get_redis: lambda: None,
            get_settings_dep: lambda: settings,
        })
        envelope = {
            "event": "task.assigned", "workspaceId": "fixture-workspace",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": {"assignedToId": "fixture-assignee", "taskId": "fixture-task", "title": "Fixture"},
        }

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            async def post(body, delivery="fixture", invalid=False):
                raw = json.dumps(body).encode()
                signature = hmac.new(settings.projectops_webhook_secret.encode(), raw, hashlib.sha256).hexdigest()
                return await client.post("/api/v1/webhooks/project-ops", content=raw, headers={
                    "X-ProjectOps-Signature": "sha256=" + ("invalid" if invalid else signature),
                    "X-ProjectOps-Delivery": delivery,
                })

            assert (await post(envelope, invalid=True)).status_code == 401
            assert (await post({**envelope, "workspaceId": "other-workspace"})).status_code == 403
            async with sessions() as db:
                assert await db.scalar(select(func.count()).select_from(Message)) == 0
                assert await db.scalar(select(func.count()).select_from(Participant)) == 0
            responses = await asyncio.gather(*(post(envelope, str(i)) for i in range(8)))
            assert all(r.status_code == 200 for r in responses), [r.status_code for r in responses]
            assert sum(r.json()["status"] == "ok" for r in responses) == 1
            assert (await post(envelope, "changed-unsigned-id")).json()["status"] == "duplicate"
            async with sessions() as db:
                for model in (Message, Participant, RoomMember):
                    assert await db.scalar(select(func.count()).select_from(model)) == 1, model
            print("PASS: invalid signature, foreign workspace, no unauthorized rows, eight concurrent first deliveries, unsigned-header replay, one message/sender/membership")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
