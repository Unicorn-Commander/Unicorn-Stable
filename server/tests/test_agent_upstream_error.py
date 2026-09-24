from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import uuid
import pytest

@pytest.mark.asyncio
@pytest.mark.parametrize('stream',[False,True])
async def test_http_failure_is_raised_not_returned_as_agent_text(stream):
    from app.services import agent_chat_responder as responder
    import httpx
    transport=httpx.MockTransport(lambda request:httpx.Response(404,text='upstream private diagnostics'))
    client=httpx.AsyncClient(transport=transport)
    settings=SimpleNamespace(brigade_api_base_url='http://test',brigade_api_key='fixture')
    room=SimpleNamespace(id=uuid.uuid4(),livekit_room_name='fixture',metadata_={})
    with patch.object(responder.httpx,'AsyncClient',return_value=client):
        with pytest.raises(RuntimeError,match='Agent upstream request failed'):
            await responder._call_brigade(settings=settings,brigade_agent_id='seat',user_id='fixture',messages=[{'role':'user','content':'hello'}],room=room,on_progress=AsyncMock() if stream else None)


@pytest.mark.asyncio
async def test_brigade_404_is_discarded_and_only_agent_error_is_emitted():
    from app.services import agent_chat_responder as responder
    import httpx

    transport = httpx.MockTransport(
        lambda request: httpx.Response(404, text='upstream private diagnostics')
    )
    client = httpx.AsyncClient(transport=transport)
    settings = SimpleNamespace(brigade_api_base_url='http://test', brigade_api_key='fixture')
    room = SimpleNamespace(id=uuid.uuid4(), livekit_room_name='fixture', metadata_={})
    placeholder = SimpleNamespace(id=uuid.uuid4(), is_deleted=False, content='…')
    with patch.object(responder.httpx, 'AsyncClient', return_value=client):
        with pytest.raises(RuntimeError, match='Agent upstream request failed'):
            await responder._call_brigade(
                settings=settings,
                brigade_agent_id='seat',
                user_id='fixture',
                messages=[{'role': 'user', 'content': 'hello'}],
                room=room,
            )
    with patch.object(responder, '_ws_deliver_to_room', new=AsyncMock()) as emit:
        await responder._discard_failed_reply(
            db=AsyncMock(), placeholder=placeholder, room_id=room.id
        )
    assert placeholder.is_deleted is True
    assert placeholder.content == ''
    assert [call.kwargs['envelope']['type'] for call in emit.await_args_list] == [
        'message_delete', 'agent_error'
    ]
    assert all('content' not in call.kwargs['envelope']['payload'] for call in emit.await_args_list)
