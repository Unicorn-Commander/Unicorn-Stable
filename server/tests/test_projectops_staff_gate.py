"""Project-Ops Stable-side authorization and credential selection tests."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.config import Settings
from app.deps import (
    get_current_user,
    get_db,
    get_livekit,
    get_presence,
    get_redis,
    get_settings_dep,
)
from app.main import app
from app.schemas.room import RoomResponse


NOW = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def clear_dependency_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


def _settings() -> Settings:
    return Settings(
        rate_limit_enabled=False,
        projectops_service_pat="pat-test-placeholder",
        projectops_service_jwt="jwt-test-placeholder",
    )


def _client(user) -> TestClient:
    client = TestClient(app)
    client.app.dependency_overrides[get_current_user] = lambda: user
    client.app.dependency_overrides[get_settings_dep] = _settings
    client.app.dependency_overrides[get_db] = lambda: AsyncMock()
    client.app.dependency_overrides[get_livekit] = lambda: AsyncMock()
    client.app.dependency_overrides[get_presence] = lambda: AsyncMock()
    client.app.dependency_overrides[get_redis] = lambda: None
    return client


def _request(client: TestClient, method: str, path: str, payload: dict | None = None):
    if method == "GET":
        return client.get(path)
    return client.post(path, json=payload)


ROUTE_CASES = (
    ("GET", "/api/v1/po/projects", None),
    (
        "POST",
        f"/api/v1/messages/{uuid.uuid4()}/promote-to-po-task",
        {"project_number": "P-00115"},
    ),
    ("POST", "/api/v1/rooms/for-project", {"project_number": "P-00115"}),
)


@pytest.mark.parametrize("method,path,payload", ROUTE_CASES)
def test_non_staff_members_get_403_on_all_projectops_routes(method, path, payload):
    client = _client(
        {
            "participant_id": uuid.uuid4(),
            "email": "member@example.com",
            "roles": [],
        }
    )

    response = _request(client, method, path, payload)

    assert response.status_code == 403
    assert response.json()["detail"] == "Project Ops staff access required"


def _guest_authentication():
    raise HTTPException(
        status_code=401,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )


@pytest.mark.parametrize("method,path,payload", ROUTE_CASES)
def test_guest_credentials_get_401_on_all_projectops_routes(method, path, payload):
    client = _client(_guest_authentication)
    client.app.dependency_overrides[get_current_user] = _guest_authentication

    response = _request(client, method, path, payload)

    assert response.status_code == 401


def _staff_user() -> dict:
    return {
        "participant_id": uuid.uuid4(),
        "email": "staff@example.com",
        "roles": ["stable-admin"],
    }


def test_staff_can_list_projectops_projects_without_network():
    client = _client(_staff_user())
    import app.api.messages as messages

    with patch.object(
        messages,
        "_list_projectops_projects_cached",
        AsyncMock(return_value=[]),
    ) as projects:
        response = client.get("/api/v1/po/projects")

    assert response.status_code == 200
    assert response.json() == []
    projects.assert_awaited_once_with()


def test_staff_can_promote_and_task_description_carries_caller_email():
    client = _client(_staff_user())
    user = _staff_user()
    client.app.dependency_overrides[get_current_user] = lambda: user
    import app.api.messages as messages

    message = SimpleNamespace(
        id=uuid.uuid4(),
        sender=None,
        sender_id=uuid.uuid4(),
        content="Please investigate this",
        created_at=NOW,
        metadata_={},
    )
    room = SimpleNamespace(
        id=uuid.uuid4(),
        name="p-00115-project",
        display_name="P-00115 · Project",
        project_number="P-00115",
    )
    with patch.object(
        messages,
        "_load_visible_message",
        AsyncMock(return_value=(message, room)),
    ), patch.object(
        messages,
        "_call_projectops_tool",
        AsyncMock(
            return_value={
                "id": "task-1",
                "projectNumber": "P-00115",
                "projectId": "project-1",
            }
        ),
    ) as call:
        response = client.post(
            f"/api/v1/messages/{message.id}/promote-to-po-task",
            json={"project_number": "P-00115"},
        )

    assert response.status_code == 200, response.text
    description = call.await_args.args[1]["description"]
    assert description.startswith("Promoted from Stable by staff@example.com\n\n")


def test_staff_can_ensure_project_channel_and_join_is_explicitly_authorized():
    client = _client(_staff_user())
    user = _staff_user()
    client.app.dependency_overrides[get_current_user] = lambda: user
    import app.api.conversation as conversation

    room = SimpleNamespace(
        id=uuid.uuid4(),
        display_name="P-00115 · Project",
        room_type=SimpleNamespace(value="channel"),
    )
    service = SimpleNamespace(
        ensure_project_channel=AsyncMock(return_value=(room, True)),
    )
    response_model = RoomResponse(
        id=room.id,
        name="p-00115-project",
        display_name=room.display_name,
        room_type="channel",
        livekit_room_name="stable-p-00115-project",
        max_participants=50,
        is_archived=False,
        created_at=NOW,
        updated_at=NOW,
        visibility="private",
        project_number="P-00115",
    )
    with patch.object(
        conversation,
        "fetch_project",
        AsyncMock(
            return_value={
                "id": "project-1",
                "projectNumber": "P-00115",
                "title": "Project",
            }
        ),
    ) as fetch, patch.object(
        conversation,
        "_build_room_service",
        return_value=service,
    ), patch.object(
        conversation,
        "_room_response",
        AsyncMock(return_value=response_model),
    ), patch.object(
        conversation,
        "push_room_to_participants",
        AsyncMock(),
    ):
        response = client.post(
            "/api/v1/rooms/for-project",
            json={"project_number": "P-00115"},
        )

    assert response.status_code == 200, response.text
    fetch.assert_awaited_once_with("P-00115")
    assert service.ensure_project_channel.await_args.kwargs["allow_existing_join"] is True


@pytest.mark.asyncio
async def test_projectops_client_prefers_pat_and_falls_back_to_jwt():
    import app.api.messages as messages

    captured: list[dict] = []

    class Response:
        status_code = 200
        text = '{"result": {"structuredContent": []}}'

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, *, headers, json):
            captured.append({"headers": headers, "json": json})
            return Response()

    settings = SimpleNamespace(
        projectops_service_pat="pat-test-placeholder",
        projectops_service_jwt="jwt-test-placeholder",
        projectops_mcp_url="https://projectops.invalid/mcp",
    )
    with patch.object(messages, "get_settings", return_value=settings), patch.object(
        messages.httpx,
        "AsyncClient",
        lambda **_kwargs: Client(),
    ):
        await messages._call_projectops_tool("list_my_projects", {})
        settings.projectops_service_pat = ""
        await messages._call_projectops_tool("list_my_projects", {})

    assert captured[0]["headers"]["Authorization"] == "Bearer pat-test-placeholder"
    assert captured[1]["headers"]["Authorization"] == "Bearer jwt-test-placeholder"
