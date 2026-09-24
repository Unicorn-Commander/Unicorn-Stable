from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
import uuid
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from app.api.brigade import router
from app.deps import get_current_user, get_db, get_livekit, get_presence, get_settings_dep
from app.services.agent_routing import participant_backend


def result(value):
    r = MagicMock()
    r.scalar_one_or_none.return_value = value
    r.scalars.return_value.all.return_value = value
    return r


def test_backend_is_participant_owned():
    assert participant_backend(SimpleNamespace(metadata_={'backend': 'runner'})) == 'runner'
    assert participant_backend(SimpleNamespace(metadata_={'backend': 'brigade'})) == 'brigade'
    assert participant_backend(SimpleNamespace(metadata_={})) == 'brigade'
    assert participant_backend(SimpleNamespace(metadata_={'backend': 'typo'})) == 'unknown'


@pytest.mark.asyncio
async def test_runner_route_ensures_canonical_hub_and_never_calls_brigade():
    room = SimpleNamespace(id=uuid.uuid4())
    participant = SimpleNamespace(metadata_={'backend':'runner'})
    db = AsyncMock()
    service = SimpleNamespace(
        ensure_agent_hub=AsyncMock(return_value=(room, True)),
    )
    app = FastAPI()
    app.include_router(router, prefix='/api/v1')
    human_id = uuid.uuid4()
    app.dependency_overrides[get_current_user] = lambda: {'participant_id':human_id}
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_settings_dep] = lambda: SimpleNamespace(instance_org_id=None)
    app.dependency_overrides[get_livekit] = lambda: AsyncMock()
    app.dependency_overrides[get_presence] = lambda: AsyncMock()
    db.execute.side_effect = [result(participant)]
    with patch('app.api.brigade.ensure_agent_access', new=AsyncMock()), \
         patch('app.api.brigade._build_room_service', return_value=service) as build, \
         patch('app.api.brigade._fetch_invitable_agents', new=AsyncMock()) as brigade:
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            response = await client.get('/api/v1/brigade/agents/seat/chat-route')
        assert response.status_code == 200, response.text
        assert response.json()=={'backend':'runner','room_id':str(room.id)}
        build.assert_called_once()
        service.ensure_agent_hub.assert_awaited_once_with(
            human_id=human_id, agent_id='seat', org_id=None
        )
        brigade.assert_not_awaited()


@pytest.mark.asyncio
async def test_brigade_route_keeps_current_backend():
    db=AsyncMock()
    db.execute.return_value=result(SimpleNamespace(metadata_={'backend':'brigade'}))
    app=FastAPI(); app.include_router(router,prefix='/api/v1')
    app.dependency_overrides[get_current_user]=lambda:{'participant_id':uuid.uuid4()}
    app.dependency_overrides[get_db]=lambda:db
    app.dependency_overrides[get_settings_dep]=lambda:SimpleNamespace(instance_org_id=None)
    app.dependency_overrides[get_livekit]=lambda:AsyncMock()
    app.dependency_overrides[get_presence]=lambda:AsyncMock()
    with patch('app.api.brigade.ensure_agent_access',new=AsyncMock()):
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
            response=await client.get('/api/v1/brigade/agents/majik/chat-route')
    assert response.json()=={'backend':'brigade','room_id':None}


@pytest.mark.asyncio
async def test_runner_in_fresh_dm_never_invokes_brigade():
    from app.services import agent_chat_responder as responder
    from app.models.room import RoomType
    db = AsyncMock()
    room=SimpleNamespace(id=uuid.uuid4(),is_archived=False,room_type=RoomType.DM,metadata_={'brigade_agent_id':'seat'})
    message=SimpleNamespace(is_deleted=False,metadata_={},content='hello')
    participant=SimpleNamespace(metadata_={'backend':'runner'})
    db.execute.side_effect=[result(message),result(room)]
    factory=MagicMock();factory.return_value.__aenter__.return_value=db
    with patch.object(responder,'_resolve_agent',new=AsyncMock(return_value=('seat',participant))), patch.object(responder,'_call_brigade',new=AsyncMock()) as brigade:
        await responder._respond(room_id=room.id,message_id=uuid.uuid4(),sender_id=None,settings=SimpleNamespace(),session_factory=factory,livekit=AsyncMock())
        brigade.assert_not_awaited()
        db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_failed_placeholder_is_removed_and_error_is_not_authored():
    from app.services import agent_chat_responder as responder
    db=AsyncMock();placeholder=SimpleNamespace(id=uuid.uuid4(),is_deleted=False,content='partial')
    with patch.object(responder,'_ws_deliver_to_room',new=AsyncMock()) as emit:
        await responder._discard_failed_reply(db=db,placeholder=placeholder,room_id=uuid.uuid4())
    assert placeholder.is_deleted and placeholder.content==''
    assert [call.kwargs['envelope']['type'] for call in emit.await_args_list]==['message_delete','agent_error']
    assert 'content' not in emit.await_args_list[-1].kwargs['envelope']['payload']



@pytest.mark.asyncio
async def test_registered_seat_without_participant_fails_closed():
    from app.services.agent_routing import find_agent_participant
    db=AsyncMock();db.execute.side_effect=[result(None),result(uuid.uuid4())]
    participant=await find_agent_participant(db,'new-seat')
    assert participant_backend(participant)=='runner'
    assert 'canonical_dm_room' not in participant.metadata_


@pytest.mark.asyncio
async def test_direct_runner_invite_never_fetches_brigade_or_dispatches():
    from app.api import brigade
    from fastapi import HTTPException
    db=AsyncMock();db.execute.return_value=result(SimpleNamespace(metadata_={'backend':'runner'}))
    livekit=AsyncMock()
    with patch.object(brigade,'_fetch_invitable_agents',new=AsyncMock()) as roster:
        with pytest.raises(HTTPException) as exc:
            await brigade.invite_brigade_agent(room_name='new-dm',body=brigade.InviteAgentRequest(brigade_agent_id='seat'),user={'participant_id':uuid.uuid4()},db=db,livekit=livekit)
    assert exc.value.status_code==409
    roster.assert_not_awaited();db.commit.assert_not_awaited();assert not livekit.mock_calls


@pytest.mark.asyncio
async def test_group_conversion_cannot_copy_runner_into_unprovisioned_room():
    from app.services.room_service import RoomService
    from app.models.room import RoomType
    from app.models.participant import ParticipantType
    from fastapi import HTTPException
    caller=SimpleNamespace(id=uuid.uuid4(),participant_type=ParticipantType.HUMAN)
    runner=SimpleNamespace(id=uuid.uuid4(),participant_type=ParticipantType.AGENT,metadata_={'backend':'runner'})
    source=SimpleNamespace(id=uuid.uuid4(),room_type=RoomType.DM)
    rows=MagicMock();rows.all.return_value=[(None,caller),(None,runner)]
    db=AsyncMock();db.execute.side_effect=[result(source),rows]
    svc=RoomService(db,AsyncMock(),AsyncMock())
    with pytest.raises(HTTPException) as exc:
        await svc.start_group_from_dm(source_room_id=source.id,caller_id=caller.id,extra_participant_ids=[],new_agent_ids=[],agent_names={})
    assert exc.value.status_code==409
    db.commit.assert_not_awaited()
