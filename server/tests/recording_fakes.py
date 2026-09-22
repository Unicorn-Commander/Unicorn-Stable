"""Test doubles for the recording lane (design §8).

LiveKit, Redis, S3 and Postgres are all MOCKED here — these tests pin the
decision surfaces and the exact calls made, not the infrastructure. The
first real proof is the live call documented in deploy/RECORDING.md.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Callable

from sqlalchemy.exc import IntegrityError


class FakeRedis:
    """Just enough of redis.asyncio for the composite semaphore."""

    def __init__(self) -> None:
        self.zsets: dict[str, dict[str, float]] = {}
        self.published: list[tuple[str, str]] = []
        self.fail = False

    def _z(self, key: str) -> dict[str, float]:
        return self.zsets.setdefault(key, {})

    def _check(self) -> None:
        if self.fail:
            raise ConnectionError("redis down")

    async def zremrangebyscore(self, key: str, lo: Any, hi: Any) -> int:
        self._check()
        z = self._z(key)
        hi_f = float("inf") if hi in ("+inf", "inf") else float(hi)
        lo_f = float("-inf") if lo in ("-inf",) else float(lo)
        gone = [m for m, s in z.items() if lo_f <= s <= hi_f]
        for m in gone:
            del z[m]
        return len(gone)

    async def zadd(self, key: str, mapping: dict[str, float]) -> int:
        self._check()
        z = self._z(key)
        added = 0
        for m, s in mapping.items():
            if m not in z:
                added += 1
            z[m] = float(s)
        return added

    async def zrank(self, key: str, member: str) -> int | None:
        self._check()
        z = self._z(key)
        if member not in z:
            return None
        ordered = sorted(z.items(), key=lambda kv: (kv[1], kv[0]))
        return [m for m, _ in ordered].index(member)

    async def zrem(self, key: str, *members: str) -> int:
        self._check()
        z = self._z(key)
        n = 0
        for m in members:
            if m in z:
                del z[m]
                n += 1
        return n

    async def zcard(self, key: str) -> int:
        self._check()
        return len(self._z(key))

    async def zrange(self, key: str, start: int, end: int) -> list[bytes]:
        self._check()
        ordered = sorted(self._z(key).items(), key=lambda kv: (kv[1], kv[0]))
        members = [m.encode() for m, _ in ordered]
        return members if end == -1 else members[start : end + 1]

    async def publish(self, channel: str, payload: str) -> int:
        self.published.append((channel, payload))
        return 1


class FakeResult:
    def __init__(self, scalar: Any = None, rows: list[Any] | None = None) -> None:
        self._scalar = scalar
        self._rows = rows or []

    def scalar_one_or_none(self) -> Any:
        return self._scalar

    def scalar_one(self) -> Any:
        return self._scalar

    def scalars(self) -> "FakeResult":
        return self

    def all(self) -> list[Any]:
        return list(self._rows)

    def one_or_none(self) -> Any:
        return self._rows[0] if self._rows else None

    def first(self) -> Any:
        if self._rows:
            return self._rows[0]
        return self._scalar


class FakeDB:
    """An AsyncSession double driven by a ``router`` callable.

    ``router(statement) -> FakeResult`` answers every ``execute``; ``get``
    answers from ``objects`` by id; ``add``/``delete``/``commit``/``refresh``
    are recorded. ``fail_next_commit`` raises IntegrityError once (the lease
    race).
    """

    def __init__(
        self,
        router: Callable[[Any], FakeResult] | None = None,
        objects: dict[Any, Any] | None = None,
    ) -> None:
        self.router = router or (lambda stmt: FakeResult())
        self.objects = objects or {}
        self.added: list[Any] = []
        self.deleted: list[Any] = []
        self.commits = 0
        self.rollbacks = 0
        self.executed: list[Any] = []
        self.fail_next_commit = False

    def add(self, obj: Any) -> None:
        self.added.append(obj)
        oid = getattr(obj, "id", None)
        if oid is not None:
            self.objects[oid] = obj

    async def delete(self, obj: Any) -> None:
        self.deleted.append(obj)
        self.objects.pop(getattr(obj, "id", None), None)

    async def commit(self) -> None:
        if self.fail_next_commit:
            self.fail_next_commit = False
            raise IntegrityError("INSERT", {}, Exception("duplicate key"))
        self.commits += 1
        # Emulate server defaults on flush.
        for obj in self.added:
            if getattr(obj, "created_at", None) is None:
                try:
                    obj.created_at = datetime.now(timezone.utc)
                except Exception:
                    pass

    async def rollback(self) -> None:
        self.rollbacks += 1

    async def refresh(self, obj: Any, *args: Any, **kwargs: Any) -> None:
        return None

    async def flush(self) -> None:
        return None

    async def get(self, model: Any, ident: Any, **kwargs: Any) -> Any:
        return self.objects.get(ident)

    async def execute(self, stmt: Any) -> FakeResult:
        self.executed.append(stmt)
        return self.router(stmt)

    async def __aenter__(self) -> "FakeDB":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


def room(**overrides: Any) -> SimpleNamespace:
    base = dict(
        id=uuid.uuid4(),
        livekit_room_name="stable-test-room",
        recording_policy="on_request",
        recording_kind="audio",
        display_name="Test Room",
        name="test-room",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def participant(**overrides: Any) -> SimpleNamespace:
    base = dict(
        id=uuid.uuid4(),
        username="aaron",
        display_name="Aaron",
        metadata_={},
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def livekit(identities: list[str] | None = None) -> SimpleNamespace:
    """A LiveKitService double recording every egress call."""
    from unittest.mock import AsyncMock

    lk = SimpleNamespace()
    lk.get_room = AsyncMock(
        return_value={
            "participants": [SimpleNamespace(identity=i) for i in (identities or [])]
        }
    )
    lk.start_room_audio_egress = AsyncMock(return_value=SimpleNamespace(egress_id="EG_audio"))
    lk.start_room_composite_video_egress = AsyncMock(
        return_value=SimpleNamespace(egress_id="EG_video")
    )
    lk.stop_egress = AsyncMock(return_value=None)
    lk.remove_participant = AsyncMock(return_value=None)
    lk.generate_token = lambda **kw: "lk-jwt"
    return lk


def stmt_sql(stmt: Any) -> str:
    """Compile a SQLAlchemy statement to Postgres SQL for assertions."""
    from sqlalchemy.dialects import postgresql

    return str(stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": False}))
