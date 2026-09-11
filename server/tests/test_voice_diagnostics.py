import uuid
from unittest.mock import Mock
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app.api import rooms
from app.deps import require_room_member

ROOM = str(uuid.uuid4())
USER = str(uuid.uuid4())
BODY = dict(reason="publish", track_muted=True, track_enabled=True, ready_state="live", device_id="fixture", sample_rate=48000, audio_context_state="suspended", permission="granted", participant_sid="PA_fixture", track_sid="TR_fixture")

@pytest.fixture
def client(monkeypatch):
 app = FastAPI(); app.include_router(rooms.router, prefix="/api/v1")
 app.dependency_overrides[require_room_member] = lambda: {"participant_id": USER}
 app.dependency_overrides[rooms.voice_diagnostic_rate_limit] = lambda: None
 logger = Mock(); monkeypatch.setattr(rooms, "logger", logger)
 return TestClient(app), app, logger

def test_actual_route_logs_authenticated_identity_and_capture_facts(client):
 c, _, logger = client
 assert c.post(f"/api/v1/rooms/{ROOM}/voice-diagnostics", json=BODY).status_code == 204
 args = logger.info.call_args.kwargs
 assert args["authenticated_participant_id"] == USER
 assert args["track_muted"] is True and args["device_id"] == "fixture"
 assert args["room_id"] == ROOM

def test_membership_denial_prevents_logging(client):
 c, app, logger = client
 def denied(): raise HTTPException(403, "Not a member")
 app.dependency_overrides[require_room_member] = denied
 assert c.post(f"/api/v1/rooms/{ROOM}/voice-diagnostics", json=BODY).status_code == 403
 logger.info.assert_not_called()

@pytest.mark.parametrize("extra", [{"authenticated_participant_id":"spoof"}, {"device_id":"x"*257}, {"sample_rate":-1}, {"reason":"arbitrary log injection"}])
def test_invalid_diagnostics_rejected(client, extra):
 c, _, logger = client
 assert c.post(f"/api/v1/rooms/{ROOM}/voice-diagnostics", json={**BODY,**extra}).status_code == 422
 logger.info.assert_not_called()
