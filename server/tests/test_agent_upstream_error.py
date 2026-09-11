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
