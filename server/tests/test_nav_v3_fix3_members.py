"""Nav v3 fix lane 3 — what a guest may learn from the roster
(REVIEW-3.md P2-4).

``GET /rooms/{id}/members`` called by a GUEST returns agent rows with
``metadata: {kind}`` and nothing else: never who owns a seat (their username
or display name, even when that owner is not in the room) nor which agents
have shell hands (``backend``). Members keep the full subset.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from app.models.participant import ParticipantType
from app.models.room import MemberRole

NOW = datetime(2026, 9, 29, 1, 0, tzinfo=timezone.utc)


def _human(username="aaron"):
    return SimpleNamespace(id=uuid.uuid4(), username=username, display_name=username.title(), keycloak_sub=f"kc-{username}",
                           participant_type=ParticipantType.HUMAN, metadata_={}, avatar_url=None, avatar_emoji=None)


def _seat(agent_id="persephone", owner="aaron", **extra):
    meta = {"backend": "runner", "crew": True}
    if owner is not None:
        meta["owner"] = owner
    meta.update(extra)
    return SimpleNamespace(id=uuid.uuid4(), username=f"agent-{agent_id}", keycloak_sub=f"brigade:{agent_id}",
                           display_name=agent_id.title(), participant_type=ParticipantType.AGENT, metadata_=meta,
                           avatar_url=None, avatar_emoji=None)


def _brigade(agent_id="majik", metadata=None):
    return SimpleNamespace(id=uuid.uuid4(), username=f"agent-{agent_id}", keycloak_sub=f"brigade:{agent_id}",
                           display_name=agent_id.title(), participant_type=ParticipantType.AGENT, metadata_=metadata,
                           avatar_url=None, avatar_emoji=None)


class _Result:
    def __init__(self, *, scalar=None, scalars=None, rows=None, rowcount=1):
        self._scalar, self._scalars, self._rows, self.rowcount = scalar, list(scalars or []), list(rows or []), rowcount

    def scalar_one_or_none(self):
        return self._scalar

    def scalars(self):
        return SimpleNamespace(all=lambda: list(self._scalars))

    def all(self):
        return list(self._rows)

    def one_or_none(self):
        return self._rows[0] if self._rows else None


# ---------------------------------------------------------------------------
# P2-4 — a guest learns an agent's kind and nothing else
# ---------------------------------------------------------------------------


class P2_4_GuestsSeeKindOnly(IsolatedAsyncioTestCase):
    """GET /rooms/{id}/members through the route function and the real
    RoomService — the guest-ness comes from the caller's credential."""

    GUEST = {"participant_id": uuid.uuid4(), "participant_type": "guest", "is_guest": True, "sub": "guest:abc"}
    MEMBER = {"participant_id": uuid.uuid4(), "participant_type": "human", "sub": "kc-jordan"}

    def _rows(self):
        def membership(mode=None):
            return SimpleNamespace(id=uuid.uuid4(), role=MemberRole.MEMBER, joined_at=NOW, last_read_at=None, is_muted=False,
                                   agent_mode=mode, context_depth=None)
        relay = _seat("texts-relay", owner=None, kind="integration")
        return [(membership(), _human("aaron")), (membership("answers_all"), _seat()), (membership(), _brigade()), (membership(), relay)]

    async def _list(self, user):
        from app.api import rooms as R

        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_Result(rows=self._rows()), _Result(rows=[("aaron", "Aaron Stransky")])])
        presence = SimpleNamespace(get_online_in_room=AsyncMock(return_value=set()), redis=AsyncMock())
        with patch("app.services.room_service.get_agent_availability", new=AsyncMock(return_value={})):
            rows = await R.list_members(room_id=uuid.uuid4(), user=user, db=db, livekit=AsyncMock(), presence=presence)
        return {row.username: row for row in rows}, db

    async def test_a_guest_gets_kind_and_nothing_else(self) -> None:
        by_name, db = await self._list(self.GUEST)
        self.assertEqual(by_name["agent-persephone"].metadata, {"kind": None})
        self.assertEqual(by_name["agent-majik"].metadata, {"kind": None})
        self.assertEqual(by_name["agent-texts-relay"].metadata, {"kind": "integration"})
        self.assertIsNone(by_name["aaron"].metadata)
        dumped = str([row.model_dump(mode="json") for row in by_name.values()])
        for leaked in ("owner", "Aaron Stransky", "backend", "runner"):
            self.assertNotIn(leaked, dumped)
        self.assertEqual(db.execute.await_count, 1)   # the owner lookup never runs for a guest

    async def test_a_member_still_gets_the_full_subset(self) -> None:
        """PIN (already true on 5ee32e9): members keep the round-3 subset."""
        by_name, db = await self._list(self.MEMBER)
        self.assertEqual(by_name["agent-persephone"].metadata,
                         {"kind": None, "backend": "runner", "owner": "aaron", "owner_display_name": "Aaron Stransky"})
        self.assertEqual(db.execute.await_count, 2)
