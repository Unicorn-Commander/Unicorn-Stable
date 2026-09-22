"""Voice turn model, server side: shared mic, dispatch fan-out, co-host schema."""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.api.rooms import RoomVoiceSettingsBody, update_voice_settings
from app.api.voice import SharedMicBody, VoiceDispatchBody, ingest_voice_dispatch, update_my_call
from app.models.room import MemberRole, RoomType


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


def _row(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


class SharedMicTests(IsolatedAsyncioTestCase):
    async def test_shared_mic_merges_into_participant_metadata(self) -> None:
        pid = _uuid()
        room = SimpleNamespace(id=_uuid(), livekit_room_name="stable-show")
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_row(room))
        info = SimpleNamespace(metadata=json.dumps({"hand": "raised"}))
        livekit = AsyncMock()
        livekit.get_participant = AsyncMock(return_value=info)
        livekit._api = SimpleNamespace(room=SimpleNamespace(update_participant=AsyncMock()))
        result = await update_my_call(
            room_id=room.id,
            body=SharedMicBody(shared_mic=True),
            user={"participant_id": pid, "username": "aaron"},
            db=db,
            livekit=livekit,
        )
        self.assertTrue(result["shared_mic"])
        self.assertEqual(result["identity"], f"aaron_{pid}")
        request = livekit._api.room.update_participant.await_args.args[0]
        merged = json.loads(request.metadata)
        self.assertEqual(merged["hand"], "raised")
        self.assertIs(merged["shared_mic"], True)

    async def test_not_in_the_call_is_a_409(self) -> None:
        room = SimpleNamespace(id=_uuid(), livekit_room_name="stable-show")
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_row(room))
        livekit = AsyncMock()
        livekit.get_participant = AsyncMock(side_effect=RuntimeError("missing"))
        with self.assertRaises(HTTPException) as ctx:
            await update_my_call(
                room_id=room.id,
                body=SharedMicBody(shared_mic=True),
                user={"participant_id": _uuid(), "username": "aaron"},
                db=db,
                livekit=livekit,
            )
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_unknown_room_is_a_404(self) -> None:
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_row(None))
        with self.assertRaises(HTTPException) as ctx:
            await update_my_call(
                room_id=_uuid(),
                body=SharedMicBody(shared_mic=False),
                user={"participant_id": _uuid(), "username": "aaron"},
                db=db,
                livekit=AsyncMock(),
            )
        self.assertEqual(ctx.exception.status_code, 404)


class DispatchLogTests(IsolatedAsyncioTestCase):
    async def test_decide_is_stored_and_fanned_out(self) -> None:
        room = SimpleNamespace(id=_uuid(), livekit_room_name="stable-show")
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_row(room))
        db.add = MagicMock()
        db.commit = AsyncMock()
        request = SimpleNamespace(headers={"Authorization": "Bearer test"})
        body = VoiceDispatchBody(
            room="stable-show",
            speaker="aaron_1",
            text_hash="abcdef0123456789",
            rule="addressed_by_name",
            winner="majik",
            human_count=2,
            shared_mic=False,
            agent_identity="agent-majik",
        )
        with (
            patch("app.api.voice.verify_internal_bearer"),
            patch("app.api.voice.get_settings", return_value=SimpleNamespace(instance_org_id="")),
            patch("app.api.messages._ws_broadcast_room", new=AsyncMock()) as fanout,
        ):
            result = await ingest_voice_dispatch(body=body, request=request, db=db)
        self.assertEqual(result["winner"], "majik")
        self.assertEqual(result["rule"], "addressed_by_name")
        event = db.add.call_args.args[0]
        self.assertEqual(event.event_type, "voice_dispatch")
        self.assertEqual(event.event_data["text_hash"], "abcdef0123456789")
        self.assertEqual(event.event_data["human_count"], 2)
        self.assertNotIn("text", event.event_data)
        envelope = fanout.await_args.args[2]
        self.assertEqual(envelope["type"], "voice_dispatch")
        self.assertEqual(envelope["payload"], {"winner": "majik", "rule": "addressed_by_name"})


class VoiceSettingsSchemaTests(IsolatedAsyncioTestCase):
    async def _call(self, body: RoomVoiceSettingsBody, *, metadata: dict | None = None, room_type=None, executes=None):
        db = AsyncMock()
        room = SimpleNamespace(
            id=_uuid(),
            livekit_room_name="stable-hub",
            metadata_=metadata if metadata is not None else {"voice_relay_source": "agent-claude-code"},
            room_type=room_type,
        )
        membership = SimpleNamespace(role=MemberRole.OWNER)
        if executes is None:
            executes = [_row(room), _row(membership)]
        db.execute = AsyncMock(side_effect=executes)
        db.commit = AsyncMock()
        livekit = AsyncMock()
        result = await update_voice_settings(
            room_id=room.id,
            body=body,
            user={"participant_id": _uuid()},
            db=db,
            livekit=livekit,
        )
        return result, room, livekit

    async def test_primary_and_spoken_length_are_stored(self) -> None:
        result, room, livekit = await self._call(
            RoomVoiceSettingsBody(
                activation="name",
                primary_agent_id="majik",
                max_spoken_chars=0,
                agent_id="rook",
                aliases=["rook", "corporal"],
                face_shape="tall",
                face_plate=False,
            )
        )
        self.assertEqual(room.metadata_["voice_primary_agent_id"], "majik")
        self.assertEqual(room.metadata_["voice_relay_max_spoken_chars"], 0)
        self.assertEqual(room.metadata_["voice_relay_agent_id"], "rook")
        self.assertEqual(room.metadata_["voice_relay_aliases"], ["rook", "corporal"])
        self.assertEqual(room.metadata_["voice_relay_face_shape"], "tall")
        self.assertIs(room.metadata_["voice_relay_face_plate"], False)
        self.assertEqual(result["primary_agent_id"], "majik")
        self.assertEqual(result["max_spoken_chars"], 0)
        frame = livekit.send_data.await_args.args[1]
        self.assertEqual(frame["max_spoken_chars"], 0)

    async def test_nobody_clears_the_cohost(self) -> None:
        _result, room, _livekit = await self._call(
            RoomVoiceSettingsBody(activation="name", primary_agent_id="nobody")
        )
        self.assertEqual(room.metadata_["voice_primary_agent_id"], "nobody")

    async def test_a_channel_without_a_source_is_still_a_409(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await self._call(
                RoomVoiceSettingsBody(activation="name"),
                metadata={"brigade_agent_id": "majik"},
                room_type=RoomType.CHANNEL,
            )
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_a_hub_without_a_source_defaults_to_the_human_owner(self) -> None:
        room_id_holder = {}

        async def _run():
            db = AsyncMock()
            room = SimpleNamespace(
                id=_uuid(),
                livekit_room_name="stable-hub",
                metadata_={},
                room_type=RoomType.AGENT_HUB,
            )
            room_id_holder["room"] = room
            db.execute = AsyncMock(
                side_effect=[
                    _row(room),
                    _row(SimpleNamespace(role=MemberRole.OWNER)),
                    _row("aaron"),
                ]
            )
            db.commit = AsyncMock()
            livekit = AsyncMock()
            result = await update_voice_settings(
                room_id=room.id,
                body=RoomVoiceSettingsBody(activation="always", primary_agent_id="majik"),
                user={"participant_id": _uuid()},
                db=db,
                livekit=livekit,
            )
            return result

        result = await _run()
        room = room_id_holder["room"]
        self.assertEqual(result["activation"], "always")
        self.assertEqual(room.metadata_["voice_relay_source"], "aaron")
        self.assertEqual(room.metadata_["voice_primary_agent_id"], "majik")
        # Hub default spoken length is unlimited.
        self.assertEqual(room.metadata_["voice_relay_max_spoken_chars"], 0)

    async def test_sync_fills_a_channel_cap_when_the_key_is_absent(self) -> None:
        from app.api.webhooks import _sync_voice_metadata

        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(return_value={})
        room = SimpleNamespace(
            id=_uuid(),
            livekit_room_name="stable-chan",
            metadata_={"voice_relay_source": "agent-claude-code"},
            room_type=RoomType.CHANNEL,
        )
        await _sync_voice_metadata(lk, room)
        merged = json.loads(lk.update_room_metadata.await_args.args[1])
        self.assertEqual(merged["voice_relay_max_spoken_chars"], "900")

    async def test_sync_fills_unlimited_for_a_hub(self) -> None:
        from app.api.webhooks import _sync_voice_metadata

        lk = AsyncMock()
        lk.get_room_metadata = AsyncMock(return_value={})
        room = SimpleNamespace(
            id=_uuid(),
            livekit_room_name="stable-hub",
            metadata_={"voice_primary_agent_id": "majik"},
            room_type=RoomType.AGENT_HUB,
        )
        await _sync_voice_metadata(lk, room)
        merged = json.loads(lk.update_room_metadata.await_args.args[1])
        self.assertEqual(merged["voice_relay_max_spoken_chars"], "0")
        self.assertEqual(merged["voice_primary_agent_id"], "majik")
