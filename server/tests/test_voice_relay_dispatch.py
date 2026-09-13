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

from unittest.mock import MagicMock

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
        self.assertEqual(got, (ROOK, "rook", "name"))

    def test_persona_is_overridable(self) -> None:
        got = _relay_source_and_persona(
            _room({"voice_relay_source": ROOK, "voice_relay_agent_id": "atlas"})
        )
        self.assertEqual(got, (ROOK, "atlas", "name"))


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
                "voice_relay_activation": "name",
                "agent_identity": ROOK,
            },
        )
        # Merging matters: replacing the room metadata would drop
        # brigade_agent_id and leave a restarted Brigade worker unable to tell
        # which persona it is.
        self.assertIs(kwargs["merge_metadata"], True)

    async def test_carries_the_sources_display_name_when_the_db_knows_it(self) -> None:
        """Without this the tile reads "stable-relay" wherever the client
        cannot cross-reference the room's member list."""
        lk = _livekit(["aaron_1111"])
        db = AsyncMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = "Rook"
        db.execute = AsyncMock(return_value=result)
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}), db)
        meta = lk.dispatch_agent.await_args.kwargs["metadata"]
        self.assertEqual(meta["agent_display_name"], "Rook")
        self.assertEqual(meta["agent_identity"], ROOK)

    async def test_an_unknown_source_still_dispatches_without_a_name(self) -> None:
        """A missing display name must not block the voice."""
        lk = _livekit(["aaron_1111"])
        db = AsyncMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        db.execute = AsyncMock(return_value=result)
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}), db)
        meta = lk.dispatch_agent.await_args.kwargs["metadata"]
        self.assertNotIn("agent_display_name", meta)

    async def test_a_broken_name_lookup_never_blocks_the_relay(self) -> None:
        lk = _livekit(["aaron_1111"])
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=RuntimeError("db down"))
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}), db)
        lk.dispatch_agent.assert_awaited_once()

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

    async def test_idempotent_against_the_source_identity_it_joins_as(self) -> None:
        """The relay joins as the participant it speaks for, so a room already
        holding that identity must not get a second one."""
        lk = _livekit(["aaron_1111", ROOK])
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}))
        lk.dispatch_agent.assert_not_awaited()

    async def test_idempotent_against_a_suffixed_worker_identity(self) -> None:
        """The runtime derives identities like `agent-relay-bec0`. An exact
        match misses that and dispatches a second copy of the same voice —
        found by live-fire, not by reading the code."""
        for identity in ("agent-relay-bec0", "agent-rook-9f2a"):
            lk = _livekit(["aaron_1111", identity])
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


class ActivationPassthroughTests(IsolatedAsyncioTestCase):
    """The worker reads LiveKit room metadata, not the database. A setting the
    dispatch does not carry never reaches it — which is exactly how rook-aaron
    kept behaving as "name" after being set to "always"."""

    async def test_the_rooms_activation_reaches_the_worker(self) -> None:
        lk = _livekit(["aaron_1111"])
        room = _room(
            {"voice_relay_source": ROOK, "voice_relay_activation": "always"}
        )
        await _ensure_voice_relay(lk, room)
        meta = lk.dispatch_agent.await_args.kwargs["metadata"]
        self.assertEqual(meta["voice_relay_activation"], "always")

    def test_it_reads_every_mode_and_defaults_conservatively(self) -> None:
        for mode in ("name", "always", "ptt", "off"):
            got = _relay_source_and_persona(
                _room({"voice_relay_source": ROOK, "voice_relay_activation": mode})
            )
            self.assertEqual(got[2], mode)
        # Junk falls back to the safe rule, not the permissive one.
        got = _relay_source_and_persona(
            _room({"voice_relay_source": ROOK, "voice_relay_activation": "  "})
        )
        self.assertEqual(got[2], "name")


class RoomMetadataScrubTests(IsolatedAsyncioTestCase):
    """The room's metadata copy never carries per-dispatch keys."""

    async def test_dispatch_room_copy_drops_identity_and_name(self) -> None:
        import json as _json

        from app.services.livekit_service import LiveKitService

        api = AsyncMock()
        svc = LiveKitService(api, "ws://x")
        svc.update_room_metadata = AsyncMock()
        await svc.dispatch_agent(
            room_name="stable-x",
            metadata={
                "agent_type": "relay",
                "voice_relay_source": ROOK,
                "agent_identity": ROOK,
                "agent_display_name": "Rook",
            },
        )
        room_copy = _json.loads(svc.update_room_metadata.await_args.args[1])
        self.assertNotIn("agent_identity", room_copy)
        self.assertNotIn("agent_display_name", room_copy)
        self.assertEqual(room_copy["voice_relay_source"], ROOK)


class VoiceMetadataSyncTests(IsolatedAsyncioTestCase):
    """The DB row is the durable truth; the LiveKit copy is what workers read.

    A recreated media room starts empty, and nothing copied these keys back —
    so primary_agent_id fell through to the last-dispatched brigade_agent_id
    and the co-host drifted to whoever joined most recently. The General
    answered a solo host who had configured Majik.
    """

    async def test_missing_keys_are_merged_in(self) -> None:
        import json as _json

        from app.api.webhooks import _sync_voice_metadata

        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(
            return_value={"brigade_agent_id": "the-general"}
        )
        room = _room(
            {
                "voice_primary_agent_id": "majik",
                "voice_relay_source": ROOK,
                "voice_relay_activation": "ptt",
            }
        )
        await _sync_voice_metadata(lk, room)
        merged = _json.loads(lk.update_room_metadata.await_args.args[1])
        self.assertEqual(merged["voice_primary_agent_id"], "majik")
        self.assertEqual(merged["voice_relay_activation"], "ptt")
        # Merge, not replace: what the dispatches wrote survives.
        self.assertEqual(merged["brigade_agent_id"], "the-general")

    async def test_already_synced_writes_nothing(self) -> None:
        from app.api.webhooks import _sync_voice_metadata

        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(
            return_value={"voice_primary_agent_id": "majik"}
        )
        await _sync_voice_metadata(lk, _room({"voice_primary_agent_id": "majik"}))
        lk.update_room_metadata.assert_not_awaited()

    async def test_a_room_with_no_voice_settings_is_untouched(self) -> None:
        from app.api.webhooks import _sync_voice_metadata

        lk = AsyncMock()
        await _sync_voice_metadata(lk, _room({"brigade_agent_id": "majik"}))
        lk.get_room_metadata.assert_not_awaited()

    async def test_failures_never_escape(self) -> None:
        from app.api.webhooks import _sync_voice_metadata

        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(side_effect=RuntimeError("down"))
        await _sync_voice_metadata(lk, _room({"voice_primary_agent_id": "majik"}))


class DispatchMergesByDefaultTests(IsolatedAsyncioTestCase):
    async def test_replacement_requires_opting_out(self) -> None:
        """Replacement was the bug class: client brigade dispatches wiped
        voice_primary_agent_id and the co-host drifted to the last invite."""
        import inspect

        from app.services.livekit_service import LiveKitService

        sig = inspect.signature(LiveKitService.dispatch_agent)
        self.assertIs(sig.parameters["merge_metadata"].default, True)


class FaceAndCastFlagPassthroughTests(IsolatedAsyncioTestCase):
    """``voice_relay_video`` / ``voice_relay_multi`` reach the worker the only
    way anything does: through the dispatch and the room's LiveKit metadata.
    Off is the default and is NOT sent on dispatch (byte-identical dispatch
    for a room that never asked); the sync carries an explicit false so a
    face switched off stays off after a room recreate."""

    async def test_flags_ride_the_dispatch_only_when_on(self) -> None:
        lk = _livekit(["aaron_1111"])
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}))
        meta = lk.dispatch_agent.await_args.kwargs["metadata"]
        self.assertNotIn("voice_relay_video", meta)
        self.assertNotIn("voice_relay_multi", meta)

        lk = _livekit(["aaron_1111"])
        await _ensure_voice_relay(
            lk,
            _room(
                {
                    "voice_relay_source": ROOK,
                    "voice_relay_video": True,
                    "voice_relay_multi": "true",
                    "voice_relay_voices": {"agent-grok": "am_onyx"},
                }
            ),
        )
        meta = lk.dispatch_agent.await_args.kwargs["metadata"]
        self.assertEqual(meta["voice_relay_video"], "true")
        self.assertEqual(meta["voice_relay_multi"], "true")
        self.assertEqual(meta["voice_relay_voices"], '{"agent-grok": "am_onyx"}')

    async def test_a_false_flag_is_not_sent_on_dispatch(self) -> None:
        lk = _livekit(["aaron_1111"])
        await _ensure_voice_relay(
            lk, _room({"voice_relay_source": ROOK, "voice_relay_video": False})
        )
        self.assertNotIn("voice_relay_video", lk.dispatch_agent.await_args.kwargs["metadata"])

    async def test_face_style_rides_dispatch_and_sync(self) -> None:
        """A room set to a tall, plateless face (the phone 1:1 shape) must
        reach the worker; before 2026-09-12 these keys were not in the
        whitelist and the relay kept publishing the 640x360 show face."""
        import json as _json

        from app.api.webhooks import _sync_voice_metadata

        lk = _livekit(["aaron_1111"])
        await _ensure_voice_relay(lk, _room({"voice_relay_source": ROOK}))
        meta = lk.dispatch_agent.await_args.kwargs["metadata"]
        self.assertNotIn("voice_relay_face_shape", meta)
        self.assertNotIn("voice_relay_face_plate", meta)

        row = {
            "voice_relay_source": ROOK,
            "voice_relay_video": True,
            "voice_relay_face_shape": "tall",
            "voice_relay_face_plate": "false",
        }
        lk = _livekit(["aaron_1111"])
        await _ensure_voice_relay(lk, _room(row))
        meta = lk.dispatch_agent.await_args.kwargs["metadata"]
        self.assertEqual(meta["voice_relay_face_shape"], "tall")
        self.assertEqual(meta["voice_relay_face_plate"], "false")

        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(return_value={})
        await _sync_voice_metadata(lk, _room({**row, "voice_relay_face_plate": False}))
        merged = _json.loads(lk.update_room_metadata.await_args.args[1])
        self.assertEqual(merged["voice_relay_face_shape"], "tall")
        self.assertEqual(merged["voice_relay_face_plate"], "false")

        # Junk shape is dropped, not forwarded.
        lk = _livekit(["aaron_1111"])
        await _ensure_voice_relay(
            lk, _room({"voice_relay_source": ROOK, "voice_relay_face_shape": "portrait"})
        )
        self.assertNotIn(
            "voice_relay_face_shape", lk.dispatch_agent.await_args.kwargs["metadata"]
        )

    async def test_sync_carries_true_and_false_as_strings(self) -> None:
        import json as _json

        from app.api.webhooks import _sync_voice_metadata

        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(return_value={"voice_relay_video": "true"})
        room = _room(
            {"voice_relay_source": ROOK, "voice_relay_video": False, "voice_relay_multi": True}
        )
        await _sync_voice_metadata(lk, room)
        merged = _json.loads(lk.update_room_metadata.await_args.args[1])
        self.assertEqual(merged["voice_relay_video"], "false")
        self.assertEqual(merged["voice_relay_multi"], "true")

    async def test_a_room_without_flags_syncs_none(self) -> None:
        import json as _json

        from app.api.webhooks import _sync_voice_metadata

        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(return_value={})
        await _sync_voice_metadata(lk, _room({"voice_relay_source": ROOK}))
        merged = _json.loads(lk.update_room_metadata.await_args.args[1])
        self.assertNotIn("voice_relay_video", merged)
        self.assertNotIn("voice_relay_multi", merged)
