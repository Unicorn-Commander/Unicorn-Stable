from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from jose.exceptions import ExpiredSignatureError, JWTError

from app.api.agent_events import sanitize_event_data
from app.api.health import _database_state, router as health_router
from app.auth import keycloak
from app.config import Settings
from app.deps import get_db, get_livekit, get_redis, get_settings_dep
from app.ws.handler import _jwt_failure_reason


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class EnterpriseTrustTests(unittest.IsolatedAsyncioTestCase):
    async def test_database_readiness_requires_current_schema(self):
        db = AsyncMock()
        db.execute.side_effect = [
            _Rows([(1,)]),
            _Rows([("008_agent_event_audit",)]),
        ]
        with patch(
            "app.api.health._expected_schema_heads",
            return_value=frozenset({"008_agent_event_audit"}),
        ):
            states, ready = await _database_state(db, 1.0)
        self.assertTrue(ready)
        self.assertEqual(states, {"database": "ready", "schema": "current"})

    async def test_database_readiness_rejects_outdated_schema(self):
        db = AsyncMock()
        db.execute.side_effect = [_Rows([(1,)]), _Rows([("006",)])]
        with patch(
            "app.api.health._expected_schema_heads",
            return_value=frozenset({"008_agent_event_audit"}),
        ):
            states, ready = await _database_state(db, 1.0)
        self.assertFalse(ready)
        self.assertEqual(states["schema"], "outdated")

    async def test_database_timeout_is_not_ready(self):
        async def slow(*_args, **_kwargs):
            await asyncio.sleep(0.05)

        db = AsyncMock()
        db.execute.side_effect = slow
        states, ready = await _database_state(db, 0.001)
        self.assertFalse(ready)
        self.assertEqual(states["database"], "unavailable")

    async def test_jwks_refresher_recovers_after_bootstrap_failure(self):
        fetch = AsyncMock(
            side_effect=[
                RuntimeError("identity temporarily unavailable"),
                {"keys": [{"kid": "recovered"}]},
                asyncio.CancelledError(),
            ]
        )
        with (
            patch("app.auth.keycloak.fetch_jwks", fetch),
            patch.object(keycloak, "JWKS_RETRY_INTERVAL", 0),
            patch.object(keycloak, "JWKS_REFRESH_INTERVAL", 0),
        ):
            task = await keycloak.start_jwks_refresh_task(
                "https://identity.example", "enterprise", refresh_immediately=True
            )
            await task
        self.assertEqual(fetch.await_count, 3)

    def test_agent_event_payload_redacts_secrets_recursively(self):
        clean = sanitize_event_data(
            {
                "tool": "deploy",
                "Authorization": "Bearer should-not-survive",
                "nested": {
                    "api_key": "should-not-survive",
                    "result": "ok",
                },
            }
        )
        self.assertEqual(clean["Authorization"], "[redacted]")
        self.assertEqual(clean["nested"]["api_key"], "[redacted]")
        self.assertEqual(clean["nested"]["result"], "ok")

    def test_websocket_auth_failure_is_bounded(self):
        self.assertEqual(
            _jwt_failure_reason(ExpiredSignatureError("Signature has expired.")),
            "expired",
        )
        self.assertEqual(_jwt_failure_reason(JWTError("arbitrary raw value")), "invalid")

    def test_public_v1_health_alias_is_mounted_and_truthful(self):
        class FakeDB:
            async def execute(self, statement):
                if "alembic_version" in str(statement):
                    return _Rows([("008_agent_event_audit",)])
                return _Rows([(1,)])

        class FakeRedis:
            async def ping(self):
                return True

        class FakeLiveKit:
            async def list_rooms(self):
                return []

        async def db_override():
            yield FakeDB()

        probe = FastAPI()
        probe.include_router(health_router)
        probe.state.jwks_loaded = True
        probe.state.observability_enabled = False
        probe.dependency_overrides[get_db] = db_override
        probe.dependency_overrides[get_redis] = lambda: FakeRedis()
        probe.dependency_overrides[get_livekit] = lambda: FakeLiveKit()
        probe.dependency_overrides[get_settings_dep] = lambda: Settings(
            environment="development"
        )

        with patch(
            "app.api.health._expected_schema_heads",
            return_value=frozenset({"008_agent_event_audit"}),
        ):
            response = TestClient(probe).get("/api/v1/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")


if __name__ == "__main__":
    unittest.main()
