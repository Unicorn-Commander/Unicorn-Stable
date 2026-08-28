"""The server side of the voice relay: who gets one, and when.

The relay is dispatched from the join webhook rather than the client so it is
present whoever starts the call and from whichever device. That makes the
opt-in and the idempotency the things worth pinning.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock

from app.api.webhooks import _ensure_voice_relay, _relay_source_and_persona

ROOK = "agent-claude-code"


def _room(metadata: dict | None) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        livekit_room_name="stable-rook-aaron",
        metadata_=metadata,
    )


def _livekit(identities: list[str]) -> AsyncMock:
    lk = AsyncMock()
    lk.get_room = AsyncMock(
        return_value={
            "participants": [SimpleNamespace(identity=i) for i in identities]
        }
    )
    lk.dispatch_agent = AsyncMock(return_value={"dispatched": True})
    return lk


class OptInTests(IsolatedAsyncioTestCase):
    def test_a_room_without_the_key_wants_no_relay(self) -> None:
        for meta in (None, {}, {"brigade_agent_id": "majik"}, {"voice_relay_source": "  "}):
            self.assertIsNone(_relay_source_and_persona(_room(meta)), meta)

    def test_source_opts_in_and_persona_defaults_to_rook(self) -> None:
        got = _relay_source_and_persona(_room({"voice_relay_source": ROOK}))
        self.assertEqual(got, (ROOK, "rook"))

    def test_persona_is_overridable(self) -> None:
        got = _relay_source_and_persona(
            _room({"voice_relay_source": ROOK, "voice_relay_agent_id": "atlas"})
        )
        self.assertEqual(got, (ROOK, "atlas"))


class EnsureRelayTests(IsolatedAsyncioTestCase):
    async def test_no_opt_in_means_no_dispatch_and_no_probe(self) -> None:
        lk = _livekit(["aaron_1111"])
        await _ensure_voice_relay(lk, _room(None))
        lk.dispatch_agent.assert_not_awaited()
        lk.get_room.assert_not_awaited()

    async def test_dispatches_when_a_human_is_in_the_call(self) -> None:
        lk = _livekit(["aaron_1111"])
        room = _room({"voice_relay_source": ROOK})
        await _ensure_voice_relay(lk, room)
        lk.dispatch_agent.assert_awaited_once()
        kwargs = lk.dispatch_agent.await_args.kwargs
        self.assertEqual(kwargs["room_name"], room.livekit_room_name)
        self.assertEqual(
            kwargs["metadata"],
            {
                "agent_type": "relay",
                "voice_relay_source": ROOK,
                "voice_relay_agent_id": "rook",
            },
        )

    async def test_empty_call_gets_no_relay(self) -> None:
        """An empty room needs no voice — and dispatching into one burns a
        worker slot for nobody."""
        lk = _livekit([])
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}))
        lk.dispatch_agent.assert_not_awaited()

    async def test_a_room_of_only_agents_and_recorders_gets_no_relay(self) -> None:
        lk = _livekit(["agent-majik", "EG_recorder", "broadcast-abc"])
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}))
        lk.dispatch_agent.assert_not_awaited()

    async def test_idempotent_when_the_relay_is_already_present(self) -> None:
        """The relay's own join fires this webhook again — a second dispatch
        would put two copies of one voice in the room."""
        lk = _livekit(["aaron_1111", "agent-rook"])
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}))
        lk.dispatch_agent.assert_not_awaited()

    async def test_idempotent_on_the_generic_relay_identity_too(self) -> None:
        lk = _livekit(["aaron_1111", "agent-relay"])
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}))
        lk.dispatch_agent.assert_not_awaited()

    async def test_a_failed_probe_is_silent_not_fatal(self) -> None:
        lk = AsyncMock()
        lk.get_room = AsyncMock(side_effect=RuntimeError("livekit down"))
        lk.dispatch_agent = AsyncMock()
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}))
        lk.dispatch_agent.assert_not_awaited()

    async def test_a_failed_dispatch_never_raises_into_the_webhook(self) -> None:
        lk = _livekit(["aaron_1111"])
        lk.dispatch_agent = AsyncMock(side_effect=RuntimeError("no worker"))
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}))  # must not raise
