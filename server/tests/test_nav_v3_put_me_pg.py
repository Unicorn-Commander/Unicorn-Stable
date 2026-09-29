"""PUT /gateway/me against a REAL async PostgreSQL session.

The mocked test (``test_nav_v3_gateway_seat.PutMe``) replaces the session, so
it cannot see SQLAlchemy's session synchronisation. On dogfood (2026-09-29)
every announce answered 500: the ORM ``UPDATE ... SET metadata = metadata ||
patch`` expired the loaded seat's ``metadata_`` (a JSONB ``||`` cannot be
evaluated in Python), and the in-memory mirror that followed lazy-loaded it:
``MissingGreenlet`` under asyncpg. This script runs the handler on a real
session and checks the row.

Run against a THROWAWAY database only (the script drops and recreates every
table), for example a local container:

    docker run -d --rm --name stable-putme-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16-alpine
    TEST_DATABASE_URL=postgresql+asyncpg://postgres:pw@127.0.0.1:55432/stable_putme_test \\
      python tests/test_nav_v3_put_me_pg.py
    docker stop stable-putme-pg

No pytest dependency: the backend image does not ship one. Exit 0 = pass.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select, text  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.api import gateway as G  # noqa: E402
from app.models.base import Base  # noqa: E402
from app.models.participant import Participant, ParticipantType  # noqa: E402

FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    if got != want:
        FAILURES.append(f"{label}: got {got!r}, want {want!r}")
    else:
        print(f"ok   {label}")


def body() -> G.SeatCapabilitiesBody:
    return G.SeatCapabilitiesBody(
        harness="claude-code",
        default_model="claude-fable-5-1",
        default_effort="high",
        models=[{"id": "claude-fable-5-1", "label": "Fable 5.1"}, {"id": "claude-opus-5-5", "label": "Opus 5.5"}],
        efforts=["low", "medium", "high", "max"],
    )


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
    # The app's own factory setting (app/main.py).
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with session_factory() as db:
        db.add(
            Participant(
                keycloak_sub="brigade:persephone",
                username="agent-persephone",
                display_name="Persephone",
                participant_type=ParticipantType.AGENT,
                metadata_={"backend": "runner", "owner": "aaron", "crew": True, "avatar_emoji": "🌸"},
            )
        )
        await db.commit()

    principal = SimpleNamespace(agent_id="persephone", auth_kind="key", human_sub=None)

    # 1. The announce on a real session: no exception, the stored shape back.
    async with session_factory() as db:
        try:
            with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
                out = await G.gateway_put_me(body=body(), principal=principal, db=db, redis=AsyncMock())
        except Exception as exc:  # noqa: BLE001
            FAILURES.append(f"announce raised {exc.__class__.__name__}: {exc}")
            out = None
        if out is not None:
            check("announce returns the harness", out.get("harness"), "claude-code")
            check("announce returns the models", [m["id"] for m in out.get("models", [])], ["claude-fable-5-1", "claude-opus-5-5"])

    # 2. The row, read fresh: capabilities stored by merge, nothing clobbered.
    async with session_factory() as db:
        row = (
            await db.execute(select(Participant).where(Participant.keycloak_sub == "brigade:persephone"))
        ).scalar_one()
        meta = row.metadata_ or {}
        check("row has seat_capabilities", (meta.get("seat_capabilities") or {}).get("default_model"), "claude-fable-5-1")
        for key, want in {"backend": "runner", "owner": "aaron", "crew": True, "avatar_emoji": "🌸"}.items():
            check(f"row keeps {key}", meta.get(key), want)

    # 3. A second announce (the hourly one) on a real session also succeeds.
    async with session_factory() as db:
        try:
            with patch.object(G, "_gateway_rate_limit", new=AsyncMock()):
                again = await G.gateway_put_me(body=body(), principal=principal, db=db, redis=AsyncMock())
            check("second announce returns", again.get("harness"), "claude-code")
        except Exception as exc:  # noqa: BLE001
            FAILURES.append(f"second announce raised {exc.__class__.__name__}: {exc}")

    await engine.dispose()
    if FAILURES:
        print("\nFAILED:")
        for failure in FAILURES:
            print(" -", failure)
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    asyncio.run(main())
