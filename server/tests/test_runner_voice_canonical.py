"""Runner voice calls redirect to the provisioned canonical room."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

import pytest
from fastapi import HTTPException

from app.api import brigade, calls
from app.models.room import RoomType


def _scalar(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


def _rows(values):
    result = MagicMock()
    result.scalars.return_value.all.return_value = list(values)
    return result


def _room(*, room_id, name="runner-thread", display_name="Runner thread", room_type=RoomType.AGENT_HUB):
    return SimpleNamespace(
        id=room_id,
        name=name,
        display_name=display_name,
        livekit_room_name=f"stable-{name}",
        room_type=room_type,
        metadata_={"brigade_agent_id": "persephone"},
    )


def _detail(canonical, seat="persephone"):
    return {
        "code": "runner_voice_canonical_only",
        "detail": "Open this runner's canonical chat; new runner rooms require provisioning",
        "canonical_room_id": str(canonical.id),
        "canonical_room_name": canonical.display_name,
        "seat": seat,
    }


@pytest.mark.asyncio
async def test_invite_runner_in_noncanonical_room_returns_structured_409():
    current = _room(room_id=uuid.uuid4())
    canonical = _room(
        room_id=uuid.uuid4(),
        name="persephone-desk",
        display_name="Persephone · Desk",
        room_type=RoomType.GROUP_DM,
    )
    participant = SimpleNamespace(
        keycloak_sub="brigade:persephone",
        metadata_={"backend": "runner", "canonical_dm_room": canonical.name},
    )
    user = {"participant_id": uuid.uuid4()}
    db = AsyncMock()
    db.execute.side_effect = [_scalar(current), _scalar(SimpleNamespace())]

    with (
        patch.object(brigade, "find_agent_participant", new=AsyncMock(return_value=participant)),
        patch.object(brigade, "find_canonical_room", new=AsyncMock(return_value=canonical)),
    ):
        with pytest.raises(HTTPException) as caught:
            await brigade.invite_brigade_agent(
                room_name=str(current.id),
                body=brigade.InviteAgentRequest(brigade_agent_id="persephone"),
                user=user,
                db=db,
                livekit=AsyncMock(),
                _rl=None,
            )

    assert caught.value.status_code == 409
    assert caught.value.detail == _detail(canonical)


@pytest.mark.asyncio
async def test_ring_runner_in_noncanonical_room_returns_structured_409():
    current = _room(room_id=uuid.uuid4())
    canonical = _room(
        room_id=uuid.uuid4(),
        name="persephone-desk",
        display_name="Persephone · Desk",
        room_type=RoomType.GROUP_DM,
    )
    caller = SimpleNamespace(id=uuid.uuid4(), display_name="Aaron", username="aaron")
    runner = SimpleNamespace(
        id=uuid.uuid4(),
        keycloak_sub="brigade:persephone",
        metadata_={"backend": "runner", "canonical_dm_room": canonical.name},
        participant_type="agent",
    )
    db = AsyncMock()
    db.execute.side_effect = [
        _scalar(current),
        _scalar(caller),
        _rows([]),
        _rows([runner]),
    ]

    with patch.object(calls, "find_canonical_room", new=AsyncMock(return_value=canonical)):
        with pytest.raises(HTTPException) as caught:
            await calls.ring_room(
                room_id=current.id,
                user={"participant_id": caller.id, "display_name": "Aaron", "username": "aaron"},
                db=db,
                redis=AsyncMock(),
                livekit=AsyncMock(),
                _rl=None,
            )

    assert caught.value.status_code == 409
    assert caught.value.detail == _detail(canonical)


@pytest.mark.asyncio
async def test_invite_runner_in_canonical_room_is_a_noop_not_a_brigade_dispatch():
    canonical = _room(
        room_id=uuid.uuid4(),
        name="persephone-desk",
        display_name="Persephone · Desk",
        room_type=RoomType.GROUP_DM,
    )
    participant = SimpleNamespace(
        keycloak_sub="brigade:persephone",
        metadata_={"backend": "runner", "canonical_dm_room": canonical.name},
    )
    user = {"participant_id": uuid.uuid4()}
    db = AsyncMock()
    db.execute.side_effect = [_scalar(canonical), _scalar(SimpleNamespace())]
    livekit = AsyncMock()

    with (
        patch.object(brigade, "find_agent_participant", new=AsyncMock(return_value=participant)),
        patch.object(brigade, "find_canonical_room", new=AsyncMock(return_value=canonical)),
    ):
        response = await brigade.invite_brigade_agent(
            room_name=str(canonical.id),
            body=brigade.InviteAgentRequest(brigade_agent_id="persephone"),
            user=user,
            db=db,
            livekit=livekit,
            _rl=None,
        )

    assert response.dispatched is False
    assert response.reason == "runner_canonical_room"
    assert not livekit.dispatch_agent.await_count
