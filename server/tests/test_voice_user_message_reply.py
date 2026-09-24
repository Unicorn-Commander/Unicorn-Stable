"""A voice line routed to another agent must get a text reply (N4, 2026-09-24)."""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.api import messages as M
from app.models.participant import ParticipantType


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _DB:
    """Answers the endpoint's three lookups: room, speaker, membership."""

    def __init__(self, answers):
        self._answers = list(answers)

    async def execute(self, stmt):
        return _Result(self._answers.pop(0))


def _body(**overrides):
    base = dict(livekit_room_name="stable-x", speaker_identity="aaron_" + str(uuid.uuid4()), content="@zen zen, go")
    base.update(overrides)
    return M.VoiceUserMessageBody(**base)


@pytest.mark.asyncio
@pytest.mark.parametrize("reply, expects_request", [(False, False), (True, True)])
async def test_reply_to_mention_schedules_the_text_responder(reply, expects_request):
    room = SimpleNamespace(id=uuid.uuid4(), livekit_room_name="stable-x")
    participant = SimpleNamespace(
        id=uuid.uuid4(), keycloak_sub="k", username="aaron", display_name="Aaron", participant_type=ParticipantType.HUMAN
    )
    body = _body(speaker_identity=f"aaron_{participant.id}", reply_to_mention=reply)
    request = object()
    send = AsyncMock(return_value="msg")
    with patch.object(M, "verify_internal_bearer", lambda _r: None), patch.object(M, "send_message", send):
        out = await M.post_voice_user_message(
            body, request, _DB([room, participant, uuid.uuid4()]), livekit=SimpleNamespace()
        )
    assert out == "msg"
    kwargs = send.await_args.kwargs
    assert kwargs["room_id"] == room.id
    assert kwargs["body"].content == "@zen zen, go"
    assert kwargs["body"].metadata == {"via": "voice"}
    assert (kwargs["request"] is request) is expects_request
    if not expects_request:
        assert kwargs["request"] is None


def test_reply_to_mention_defaults_off():
    assert _body().reply_to_mention is False
