"""Regression tests for cross-realm participant identity linking.

The duplicate-persona bug: two Keycloaks share the realm name ``uchub``
(auth.unicorncommander.ai and auth.magicunicorn.dev); the same human has a
DIFFERENT ``sub`` in each. JIT provisioning keyed only on ``keycloak_sub``
created a second participant for the second sub (or crashed on the unique
username constraint when the preferred_username matched). The fix links by
verified email instead of inserting a duplicate.

Run inside the backend image with this worktree's ``server/`` mounted and a
THROWAWAY postgres database (never the real one — the script drops and
recreates all tables):

    docker exec stable-flagship-postgres createdb -U stable stable_identity_link_test
    docker exec stable-flagship-postgres psql -U stable -d stable_identity_link_test \
      -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'
    docker run --rm --network stable-flagship-network \
      -v /tmp/wt-identity-link/server:/home/stable/server -w /home/stable/server \
      -e TEST_DATABASE_URL="postgresql+asyncpg://stable:<pw>@stable-flagship-postgres:5432/stable_identity_link_test" \
      unicorn-stable-backend:main-346d256 python tests/test_identity_link.py
    docker exec stable-flagship-postgres dropdb -U stable stable_identity_link_test

No pytest dependency — the backend image does not ship one.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from typing import Any

sys.path.insert(0, "/home/stable/server")

from sqlalchemy import delete, select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.config import Settings  # noqa: E402
from app.auth.keycloak import extract_user_identity  # noqa: E402
from app.models.base import Base  # noqa: E402
from app.models.participant import (  # noqa: E402
    Participant,
    ParticipantStatus,
    ParticipantType,
)
from app.services import participant_identity as pi  # noqa: E402

ISSUER = "https://auth.unicorncommander.ai/realms/uchub"
OTHER_ISSUER = "https://auth.magicunicorn.dev/realms/uchub"
UNTRUSTED_ISSUER = "https://evil.example.com/realms/uchub"

FAILURES: list[str] = []

SETTINGS = Settings(
    keycloak_url="https://auth.unicorncommander.ai", keycloak_realm="uchub"
)


def check(name: str, got: Any, want: Any) -> None:
    if got != want:
        FAILURES.append(f"{name}: expected {want!r}, got {got!r}")


def claims_for(
    sub: str,
    *,
    email: str | None,
    verified: bool = True,
    iss: str = ISSUER,
    username: str = "user",
    name: str = "Some User",
) -> dict[str, Any]:
    c: dict[str, Any] = {
        "sub": sub,
        "iss": iss,
        "preferred_username": username,
        "name": name,
        "realm_access": {"roles": []},
    }
    if email is not None:
        c["email"] = email
        c["email_verified"] = verified
    return c


class FakeAdminGone:
    """Old sub does NOT resolve in the configured realm (404)."""

    def __init__(self, settings: Settings) -> None:
        pass

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        return None


class FakeAdminLive:
    """Old sub STILL resolves (a live account — linking must refuse)."""

    def __init__(self, settings: Settings) -> None:
        pass

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        return {"id": user_id, "email": "someone@example.com"}


class FakeAdminBroken:
    """Admin check unavailable (403 / creds missing — current prod state)."""

    def __init__(self, settings: Settings) -> None:
        pass

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        raise RuntimeError("403 Forbidden")


async def resolve(db, claims):
    identity = extract_user_identity(claims)
    return await pi.resolve_participant_for_identity(db, SETTINGS, identity, claims)


async def wipe(db) -> None:
    await db.execute(delete(Participant))
    await db.commit()


async def human_count(db) -> int:
    rows = (
        (
            await db.execute(
                select(Participant).where(
                    Participant.participant_type == ParticipantType.HUMAN
                )
            )
        )
        .scalars()
        .all()
    )
    return len(rows)


def seed(db, **kw) -> Participant:
    p = Participant(
        keycloak_sub=kw.get("keycloak_sub", str(uuid.uuid4())),
        username=kw["username"],
        display_name=kw.get("display_name", kw["username"]),
        participant_type=kw.get("participant_type", ParticipantType.HUMAN),
        status=ParticipantStatus.OFFLINE,
        metadata_=kw.get("metadata_", {}),
    )
    db.add(p)
    return p


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
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    email = "shafenkhan@users.noreply.github.com"

    async def run_case(name: str, fn, admin=FakeAdminGone) -> None:
        """Run one case; an exception is a FAILURE, not an abort.

        Pre-fix, the duplicate-persona path can crash outright (unique
        username IntegrityError) — that must register as a failing check, not
        stack-trace the whole run out.
        """
        pi.KeycloakAdmin = admin
        try:
            async with session_factory() as db:
                await wipe(db)
                await fn(db)
        except Exception as exc:  # noqa: BLE001
            FAILURES.append(f"{name}: raised {exc.__class__.__name__}: {exc}")

    # T1+T2: THE BUG. First login creates; the same human arriving with the
    # other realm's sub and the same verified email must LINK (re-key the
    # same row), not create a duplicate persona (or crash on username).
    async def t1_t2(db) -> None:
        sub_vps, sub_bigboy = str(uuid.uuid4()), str(uuid.uuid4())
        p1 = await resolve(db, claims_for(sub_vps, email=email, username="shafen"))
        check("T1 created", await human_count(db), 1)
        check("T1 sub", p1.keycloak_sub, sub_vps)
        p2 = await resolve(db, claims_for(sub_bigboy, email=email, username="shafen"))
        check("T2 linked same participant", p2.id, p1.id)
        check("T2 re-keyed sub", p2.keycloak_sub, sub_bigboy)
        check("T2 no duplicate persona", await human_count(db), 1)

    await run_case("T1/T2", t1_t2)

    # T3: username-as-email fallback (social-login rows carry the email as
    # username and have no stamped metadata email). Case-insensitive.
    async def t3(db) -> None:
        legacy = seed(
            db, username="person53@example.com", display_name="Jordan"
        )
        await db.commit()
        new_sub = str(uuid.uuid4())
        p = await resolve(
            db,
            claims_for(
                new_sub, email="person53@example.com", username="jordan"
            ),
        )
        check("T3 linked by username-as-email", p.id, legacy.id)
        check("T3 re-keyed", p.keycloak_sub, new_sub)
        check("T3 count", await human_count(db), 1)

    await run_case("T3", t3)

    # T4: old sub still resolves in the configured realm -> refuse, create new.
    async def t4(db) -> None:
        sub_vps, sub_bigboy = str(uuid.uuid4()), str(uuid.uuid4())
        await resolve(db, claims_for(sub_vps, email=email, username="a"))
        p = await resolve(db, claims_for(sub_bigboy, email=email, username="b"))
        check("T4 refused link", p.keycloak_sub, sub_bigboy)
        check("T4 two rows", await human_count(db), 2)

    await run_case("T4", t4, admin=FakeAdminLive)

    # T5: admin check unavailable (prod's current 403) -> still links.
    async def t5(db) -> None:
        sub_vps, sub_bigboy = str(uuid.uuid4()), str(uuid.uuid4())
        p1 = await resolve(db, claims_for(sub_vps, email=email, username="a"))
        p2 = await resolve(db, claims_for(sub_bigboy, email=email, username="a"))
        check("T5 linked despite broken admin", p2.id, p1.id)
        check("T5 count", await human_count(db), 1)

    await run_case("T5", t5, admin=FakeAdminBroken)

    # T6: no email claim -> never links, creates a new row.
    async def t6(db) -> None:
        sub_vps, sub_bigboy = str(uuid.uuid4()), str(uuid.uuid4())
        await resolve(db, claims_for(sub_vps, email=email, username="a"))
        p = await resolve(db, claims_for(sub_bigboy, email=None, username="b"))
        check("T6 no-email creates", p.keycloak_sub, sub_bigboy)
        check("T6 two rows", await human_count(db), 2)

    await run_case("T6", t6)

    # T7a: unverified email + untrusted issuer -> no link.
    async def t7a(db) -> None:
        sub_vps, sub_bigboy = str(uuid.uuid4()), str(uuid.uuid4())
        await resolve(db, claims_for(sub_vps, email=email, username="a"))
        p = await resolve(
            db,
            claims_for(
                sub_bigboy,
                email=email,
                verified=False,
                iss=UNTRUSTED_ISSUER,
                username="b",
            ),
        )
        check("T7a untrusted+unverified creates", await human_count(db), 2)
        check("T7a new row", p.keycloak_sub, sub_bigboy)

    await run_case("T7a", t7a)

    # T7b: unverified email but issued by our OTHER admin-controlled
    # Keycloak -> links.
    async def t7b(db) -> None:
        sub_vps, sub_bigboy = str(uuid.uuid4()), str(uuid.uuid4())
        p1 = await resolve(db, claims_for(sub_vps, email=email, username="a"))
        p2 = await resolve(
            db,
            claims_for(
                sub_bigboy, email=email, verified=False, iss=OTHER_ISSUER, username="a"
            ),
        )
        check("T7b trusted-issuer unverified links", p2.id, p1.id)
        check("T7b count", await human_count(db), 1)

    await run_case("T7b", t7b)

    # T8: ambiguous (two candidates) -> refuse to guess, create new.
    async def t8(db) -> None:
        for uname in ("amb1", "amb2"):
            seed(db, username=uname, metadata_={pi.EMAIL_KEY: "amb@example.com"})
        await db.commit()
        sub_new = str(uuid.uuid4())
        p = await resolve(db, claims_for(sub_new, email="amb@example.com", username="c"))
        check("T8 ambiguous creates", p.keycloak_sub, sub_new)
        check("T8 three rows", await human_count(db), 3)

    await run_case("T8", t8)

    # T9: agent-typed rows are never link candidates.
    async def t9(db) -> None:
        seed(
            db,
            keycloak_sub="brigade:quill",
            username="agent-quill",
            participant_type=ParticipantType.AGENT,
            metadata_={pi.EMAIL_KEY: "quill@example.com"},
        )
        await db.commit()
        sub_new = str(uuid.uuid4())
        p = await resolve(
            db, claims_for(sub_new, email="quill@example.com", username="quillfan")
        )
        check("T9 agent not linked", p.keycloak_sub, sub_new)
        agent = (
            await db.execute(
                select(Participant).where(Participant.keycloak_sub == "brigade:quill")
            )
        ).scalar_one_or_none()
        check("T9 agent row untouched", agent is not None, True)

    await run_case("T9", t9)

    # T10: username collision WITHOUT an email match must not 500 — the new
    # row gets a disambiguated username.
    async def t10(db) -> None:
        sub_vps, sub_bigboy = str(uuid.uuid4()), str(uuid.uuid4())
        await resolve(db, claims_for(sub_vps, email="a@x.com", username="samename"))
        p = await resolve(db, claims_for(sub_bigboy, email="b@x.com", username="samename"))
        check("T10 created", p.keycloak_sub, sub_bigboy)
        check("T10 disambiguated username", p.username, f"samename-{sub_bigboy[:8]}")

    await run_case("T10", t10)

    await engine.dispose()

    if FAILURES:
        print("FAIL")
        for f in FAILURES:
            print("  -", f)
        sys.exit(1)
    print("PASS — all identity-link checks green")


if __name__ == "__main__":
    asyncio.run(main())
