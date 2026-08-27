"""Agent workers hang up when the last human leaves the call.

Voice workers are dispatched into a call when humans join, but a worker only
ends when its LiveKit job shuts down — before this, nothing shut it down, so
agents sat alone in LiveKit rooms holding job slots and keeping the recording
idle-stop from ever seeing the room as empty.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock

from app.api.webhooks import _is_agent_identity, _release_agents_if_no_humans


def _room() -> SimpleNamespace:
    return SimpleNamespace(id=uuid.uuid4(), livekit_room_name="stable-testroom")


def _lk(identities: list[str]) -> AsyncMock:
    lk = AsyncMock()
    lk.get_room = AsyncMock(
        return_value={
            "participants": [SimpleNamespace(identity=i) for i in identities]
        }
    )
    lk.remove_participant = AsyncMock()
    return lk


class AgentIdentityTests(IsolatedAsyncioTestCase):
    def test_agent_prefix_matches_per_agent_and_legacy_workers(self) -> None:
        self.assertTrue(_is_agent_identity("agent-majik"))
        self.assertTrue(_is_agent_identity("agent-brigade"))
        self.assertTrue(_is_agent_identity("agent-triage"))
        self.assertFalse(_is_agent_identity("aaron_1234"))
        self.assertFalse(_is_agent_identity("broadcast-abc"))
        self.assertFalse(_is_agent_identity("EG_recorder"))
        self.assertFalse(_is_agent_identity(""))


class ReleaseAgentsTests(IsolatedAsyncioTestCase):
    async def test_humans_present_releases_nobody(self) -> None:
        lk = _lk(["aaron_1111", "agent-majik", "agent-the-general"])
        await _release_agents_if_no_humans(lk, _room())
        lk.remove_participant.assert_not_awaited()

    async def test_last_human_gone_releases_every_agent(self) -> None:
        room = _room()
        # Broadcast viewers and the egress recorder are service identities —
        # they neither count as humans nor get removed.
        lk = _lk(
            ["agent-majik", "agent-the-general", "broadcast-abc", "EG_rec"]
        )
        await _release_agents_if_no_humans(lk, room)
        removed = {
            c.args[1] for c in lk.remove_participant.await_args_list
        }
        self.assertEqual(removed, {"agent-majik", "agent-the-general"})
        for c in lk.remove_participant.await_args_list:
            self.assertEqual(c.args[0], room.livekit_room_name)

    async def test_legacy_bare_worker_identity_is_released_too(self) -> None:
        lk = _lk(["agent-brigade"])
        await _release_agents_if_no_humans(lk, _room())
        lk.remove_participant.assert_awaited_once()

    async def test_no_agents_means_no_removals(self) -> None:
        lk = _lk(["broadcast-abc"])
        await _release_agents_if_no_humans(lk, _room())
        lk.remove_participant.assert_not_awaited()

    async def test_room_already_gone_is_a_quiet_noop(self) -> None:
        lk = AsyncMock()
        lk.get_room = AsyncMock(side_effect=RuntimeError("room not found"))
        lk.remove_participant = AsyncMock()
        await _release_agents_if_no_humans(lk, _room())
        lk.remove_participant.assert_not_awaited()

    async def test_one_failed_removal_does_not_stop_the_rest(self) -> None:
        lk = _lk(["agent-majik", "agent-the-general"])
        lk.remove_participant = AsyncMock(
            side_effect=[RuntimeError("gone already"), None]
        )
        await _release_agents_if_no_humans(lk, _room())
        self.assertEqual(lk.remove_participant.await_count, 2)
