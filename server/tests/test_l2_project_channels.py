"""L2 — project channels (item 5).

* number normalisation, ``p-<number>-<slug>`` / ``P-00115 · <title>``;
* ``POST /rooms/for-project`` ensures ONE private channel bound through
  ``rooms.project_number`` (creator OWNER; a later caller joins);
* ``GET /rooms/{id}/tasks`` proxies open tasks, cached 60 s per project;
* promote-to-task pre-fills the bound project;
* the webhook receiver routes task events to the bound channel when one
  exists, else today's assignee map.

Project-Ops is mocked at the ``call_projectops_tool`` seam; no JWT appears
anywhere in these tests.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import unittest
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql

from app.models.room import RoomType
from app.services import project_channels as PC

NOW = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)
TITLE = "Unicorn Stable — mesh chat/voice/video-with-agents plane"


def _res(*, scalar=None, rows=None, scalars=None, scalar_value=None):
    res = MagicMock()
    res.scalar_one_or_none.return_value = scalar
    res.all.return_value = list(rows or [])
    res.scalars.return_value.all.return_value = list(scalars or [])
    res.scalars.return_value.first.return_value = (scalars or [None])[0]
    res.scalar.return_value = scalar_value
    return res


def _sql(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect())).replace("\n", " ")


class PureHelpers(unittest.TestCase):
    def test_project_number_normalises(self) -> None:
        for raw in ("P-00115", "p-115", "P115", " p-0115 ", "P - 115"):
            self.assertEqual(PC.normalize_project_number(raw), "P-00115", raw)
        for raw in ("", "115", "PX-1", "P-", None, 115, "P-00115-extra"):
            self.assertIsNone(PC.normalize_project_number(raw), raw)

    def test_slug_and_display(self) -> None:
        slug = PC.project_channel_slug("P-00115", TITLE)
        self.assertTrue(slug.startswith("p-00115-unicorn-stable-mesh-chat"))
        self.assertRegex(slug, r"^[a-z0-9][a-z0-9._-]*$")
        self.assertLessEqual(len(slug), 100)
        self.assertEqual(PC.project_channel_slug("P-00115", ""), "p-00115")
        self.assertEqual(PC.project_channel_display_name("P-00115", f"  {TITLE}  "), f"P-00115 · {TITLE}")
        self.assertEqual(PC.project_channel_display_name("P-00115", None), "P-00115")

    def test_extract_project_number_from_webhook_shapes(self) -> None:
        self.assertEqual(PC.extract_project_number({"projectNumber": "p-115"}), "P-00115")
        self.assertEqual(PC.extract_project_number({"project": {"projectNumber": "P-00115"}}), "P-00115")
        self.assertEqual(PC.extract_project_number({"task": {"projectNumber": "P-00115"}}), "P-00115")
        self.assertEqual(PC.extract_project_number({"task": {"project": {"projectNumber": "P-00115"}}}), "P-00115")
        self.assertIsNone(PC.extract_project_number({"assignedToId": "u1"}))
        self.assertIsNone(PC.extract_project_number(None))

    def test_open_task_filter_and_normalisation(self) -> None:
        self.assertTrue(PC.is_open_task({"status": "IN_PROGRESS"}))
        self.assertTrue(PC.is_open_task({"status": "pending"}))
        self.assertFalse(PC.is_open_task({"status": "COMPLETED"}))
        self.assertFalse(PC.is_open_task({"status": "CANCELLED"}))
        self.assertFalse(PC.is_open_task({"status": "PENDING", "completedAt": "2026-09-01"}))
        self.assertFalse(PC.is_open_task("junk"))
        task = PC.normalize_task(
            {"id": "t1", "taskNumber": "T-7", "title": "Ship it", "status": "PENDING", "priority": "HIGH",
             "dueDate": "2026-09-30", "assignedTo": {"firstName": "Aaron", "lastName": "Stransky"}},
            dashboard_url="https://po.example", project_id="proj-1",
        )
        self.assertEqual(task["assignee"], "Aaron Stransky")
        self.assertEqual(task["url"], "https://po.example/dashboard/projects/proj-1")
        self.assertEqual(task["task_number"], "T-7")
        self.assertIsNone(PC.normalize_task({"title": "no id"}, dashboard_url="x", project_id=None))

    def test_normalize_project_unwraps_and_requires_number_and_title(self) -> None:
        p = PC.normalize_project({"project": {"id": "abc", "projectNumber": "p-115", "title": " T ", "status": "IN_PROGRESS"}})
        self.assertEqual(p, {"id": "abc", "projectNumber": "P-00115", "title": "T", "status": "IN_PROGRESS", "priority": None, "dueDate": None})
        self.assertIsNone(PC.normalize_project({"id": "abc", "title": "no number"}))


class ProjectOpsSeam(IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        PC.clear_tasks_cache()

    async def test_open_tasks_are_filtered_and_cached_60s_per_project(self) -> None:
        raw = {
            "project": {"id": "proj-1", "projectNumber": "P-00115", "title": TITLE},
            "tasks": [
                {"id": "t1", "title": "Open", "status": "PENDING"},
                {"id": "t2", "title": "Done", "status": "COMPLETED"},
            ],
        }
        with patch.object(PC, "call_projectops_tool", AsyncMock(return_value=raw)) as call:
            first = await PC.fetch_open_tasks("P-00115", dashboard_url="https://po.example")
            second = await PC.fetch_open_tasks("P-00115", dashboard_url="https://po.example")
            other = await PC.fetch_open_tasks("P-00116", dashboard_url="https://po.example")
        self.assertEqual([t["id"] for t in first["tasks"]], ["t1"])
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(second["tasks"], first["tasks"])
        self.assertEqual(call.await_count, 2)  # P-00115 once, P-00116 once
        self.assertEqual(call.await_args_list[0].args, ("list_project_tasks", {"projectNumber": "P-00115", "limit": 100}))
        self.assertFalse(other["cached"])
        self.assertEqual(PC.TASKS_CACHE_TTL_SECONDS, 60.0)

    async def test_fetch_project_maps_not_found_and_unreachable(self) -> None:
        with patch.object(PC, "call_projectops_tool", AsyncMock(return_value={"id": "p", "projectNumber": "P-00115", "title": TITLE})):
            project = await PC.fetch_project("P-00115")
        self.assertEqual(project["title"], TITLE)
        with patch.object(PC, "call_projectops_tool", AsyncMock(side_effect=HTTPException(status_code=502, detail="Project not found"))):
            with self.assertRaises(HTTPException) as ctx:
                await PC.fetch_project("P-00999")
        self.assertEqual(ctx.exception.status_code, 404)
        with patch.object(PC, "call_projectops_tool", AsyncMock(side_effect=HTTPException(status_code=502, detail="connect timeout"))):
            with self.assertRaises(HTTPException) as ctx:
                await PC.fetch_project("P-00115")
        self.assertEqual(ctx.exception.status_code, 502)
        # A different project than asked for is not "found".
        with patch.object(PC, "call_projectops_tool", AsyncMock(return_value={"id": "p", "projectNumber": "P-00116", "title": "x"})):
            with self.assertRaises(HTTPException) as ctx:
                await PC.fetch_project("P-00115")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_seam_delegates_to_the_service_jwt_client_without_exposing_it(self) -> None:
        import inspect

        src = inspect.getsource(PC)
        self.assertNotIn("projectops_service_jwt", src)
        self.assertIn("_call_projectops_tool", inspect.getsource(PC.call_projectops_tool))


class EnsureProjectChannelService(IsolatedAsyncioTestCase):
    def _svc(self, existing=None):
        from app.services.room_service import RoomService

        db = AsyncMock()
        db.add = MagicMock()
        svc = RoomService(db=db, livekit=AsyncMock(), presence=AsyncMock())
        return svc, db

    async def test_creates_a_private_bound_channel_with_the_creator_as_owner(self) -> None:
        svc, db = self._svc()
        db.execute = AsyncMock(side_effect=[_res(scalars=[])])
        made = SimpleNamespace(id=uuid.uuid4(), name="p-00115-x", visibility="public", project_number=None)
        svc.create_room = AsyncMock(return_value=made)
        room, created = await svc.ensure_project_channel(
            creator_id=uuid.uuid4(), project_number="P-00115",
            project={"id": "proj-1", "title": TITLE, "status": "IN_PROGRESS"}, org_id=None,
        )
        self.assertTrue(created)
        self.assertEqual(room.visibility, "private")
        self.assertEqual(room.project_number, "P-00115")
        kwargs = svc.create_room.call_args.kwargs
        self.assertEqual(kwargs["room_type"], "channel")  # create_room makes the creator OWNER
        self.assertTrue(kwargs["name"].startswith("p-00115-"))
        self.assertEqual(kwargs["display_name"], f"P-00115 · {TITLE}")
        self.assertEqual(kwargs["metadata"]["project"]["number"], "P-00115")
        lookup_sql = _sql(db.execute.call_args_list[0].args[0])
        self.assertIn("rooms.project_number = ", lookup_sql)
        self.assertIn("rooms.parent_room_id IS NULL", lookup_sql)
        self.assertIn("rooms.is_archived = false", lookup_sql)

    async def test_existing_channel_is_reused_and_a_newcomer_joins(self) -> None:
        svc, db = self._svc()
        existing = SimpleNamespace(id=uuid.uuid4(), name="p-00115-x", visibility="private", project_number="P-00115")
        db.execute = AsyncMock(side_effect=[_res(scalars=[existing]), _res(scalar=None)])
        svc.create_room = AsyncMock()
        # Any spelling finds the ONE channel: the service normalises too.
        room, created = await svc.ensure_project_channel(
            creator_id=uuid.uuid4(), project_number="p-115", project={"title": TITLE}, org_id=None,
        )
        self.assertFalse(created)
        self.assertIs(room, existing)
        lookup = db.execute.call_args_list[0].args[0]
        self.assertIn("P-00115", lookup.compile(dialect=postgresql.dialect()).params.values())
        svc.create_room.assert_not_awaited()
        db.add.assert_called_once()
        self.assertEqual(db.add.call_args.args[0].role.value, "member")

    async def test_junk_number_is_422_before_any_query(self) -> None:
        svc, db = self._svc()
        with self.assertRaises(HTTPException) as ctx:
            await svc.ensure_project_channel(creator_id=uuid.uuid4(), project_number="stable", project={}, org_id=None)
        self.assertEqual(ctx.exception.status_code, 422)
        db.execute.assert_not_awaited()

    async def test_slug_collision_falls_back_to_a_suffixed_slug(self) -> None:
        svc, db = self._svc()
        db.execute = AsyncMock(side_effect=[_res(scalars=[])])
        made = SimpleNamespace(id=uuid.uuid4(), name="p-00115-x-abc", visibility="public", project_number=None)
        svc.create_room = AsyncMock(side_effect=[HTTPException(status_code=409, detail="taken"), made])
        room, created = await svc.ensure_project_channel(
            creator_id=uuid.uuid4(), project_number="P-00115", project={"title": TITLE}, org_id=None,
        )
        self.assertTrue(created)
        first, second = [c.kwargs["name"] for c in svc.create_room.call_args_list]
        self.assertNotEqual(first, second)
        self.assertTrue(second.startswith(first[:20]))


class ForProjectAndTasksRoutes(IsolatedAsyncioTestCase):
    def _room(self, project_number):
        return SimpleNamespace(
            id=uuid.uuid4(), name="p-00115-x", display_name=f"P-00115 · {TITLE}", description=None,
            room_type=RoomType.CHANNEL, livekit_room_name="stable-p-00115-x", livekit_sid=None,
            max_participants=50, metadata_={}, is_archived=False, created_by=None, created_at=NOW,
            updated_at=NOW, parent_room_id=None, visibility="private", project_number=project_number,
            recording_policy="off", recording_kind="audio",
        )

    async def test_for_project_normalises_fetches_title_and_pushes_on_create(self) -> None:
        import app.api.conversation as C

        room = self._room("P-00115")
        svc = SimpleNamespace(
            ensure_project_channel=AsyncMock(return_value=(room, True)),
            get_room=AsyncMock(return_value={"room": room, "member_count": 1, "online_count": 1}),
            room_extras=AsyncMock(return_value={}),
        )
        me = uuid.uuid4()
        with patch.object(C, "_build_room_service", return_value=svc), patch.object(
            C, "fetch_project", AsyncMock(return_value={"id": "proj-1", "projectNumber": "P-00115", "title": TITLE})
        ) as fetch, patch.object(C, "push_room_to_participants", AsyncMock()) as push:
            out = await C.ensure_project_channel(
                SimpleNamespace(project_number="p-115"), {"participant_id": me},
                SimpleNamespace(instance_org_id=None), AsyncMock(), AsyncMock(), AsyncMock(), None,
            )
        self.assertTrue(out.created)
        self.assertEqual(out.project_number, "P-00115")
        self.assertEqual(out.visibility, "private")
        fetch.assert_awaited_once_with("P-00115")
        self.assertEqual(svc.ensure_project_channel.await_args.kwargs["project_number"], "P-00115")
        self.assertEqual(push.await_args.kwargs["kind"], "project_channel")

    async def test_for_project_rejects_a_non_number(self) -> None:
        import app.api.conversation as C

        with self.assertRaises(HTTPException) as ctx:
            await C.ensure_project_channel(
                SimpleNamespace(project_number="stable"), {"participant_id": uuid.uuid4()},
                SimpleNamespace(instance_org_id=None), AsyncMock(), AsyncMock(), AsyncMock(), None,
            )
        self.assertEqual(ctx.exception.status_code, 422)

    async def test_tasks_route_proxies_the_bound_project_and_404s_an_unbound_room(self) -> None:
        import app.api.conversation as C

        room = self._room("P-00115")
        db = AsyncMock()
        db.execute = AsyncMock(return_value=_res(scalar=room))
        payload = {"project_number": "P-00115", "tasks": [{"id": "t1", "title": "Open", "url": "https://po/x"}], "cached": False, "fetched_at": "2026-09-21T00:00:00Z"}
        with patch.object(C, "fetch_open_tasks", AsyncMock(return_value=payload)) as fetch:
            out = await C.list_project_tasks(room.id, {"participant_id": uuid.uuid4()}, SimpleNamespace(projectops_dashboard_url="https://po"), db)
        self.assertEqual(out.project_number, "P-00115")
        self.assertEqual(out.tasks[0].id, "t1")
        self.assertEqual(fetch.await_args.args[0], "P-00115")

        unbound = self._room(None)
        db.execute = AsyncMock(return_value=_res(scalar=unbound))
        with self.assertRaises(HTTPException) as ctx:
            await C.list_project_tasks(unbound.id, {"participant_id": uuid.uuid4()}, SimpleNamespace(projectops_dashboard_url="https://po"), db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_tasks_route_is_member_only(self) -> None:
        import typing

        import app.api.conversation as C

        hints = typing.get_type_hints(C.list_project_tasks, include_extras=True, globalns=vars(C))
        names = [getattr(m.dependency, "__name__", "") for ann in hints.values() for m in getattr(ann, "__metadata__", ()) if hasattr(m, "dependency")]
        self.assertIn("require_room_member", names)


class PromoteToTaskPrefill(IsolatedAsyncioTestCase):
    def test_body_no_longer_requires_a_project_and_binding_resolves(self) -> None:
        from app.api.messages import PromoteToProjectOpsBody, resolve_bound_project_number

        self.assertIsNone(PromoteToProjectOpsBody().project_number)
        self.assertEqual(resolve_bound_project_number(SimpleNamespace(project_number="p-115")), "P-00115")
        self.assertIsNone(resolve_bound_project_number(SimpleNamespace(project_number=None)))
        self.assertIsNone(resolve_bound_project_number(SimpleNamespace()))

    async def _promote(self, room_project, body_project):
        import app.api.messages as M

        msg = SimpleNamespace(id=uuid.uuid4(), sender=None, sender_id=uuid.uuid4(), content="do the thing", created_at=NOW, metadata_={})
        room = SimpleNamespace(id=uuid.uuid4(), display_name="P-00115 · x", name="p-00115-x", project_number=room_project)
        db = AsyncMock()
        body = M.PromoteToProjectOpsBody(project_number=body_project)
        with patch.object(M, "_load_visible_message", AsyncMock(return_value=(msg, room))), patch.object(
            M, "_call_projectops_tool", AsyncMock(return_value={"id": "t1", "projectNumber": "P-00115", "projectId": "proj-1"})
        ) as call:
            out = await M.promote_message_to_projectops_task(msg.id, body, {"participant_id": uuid.uuid4()}, db)
        return out, call, msg

    async def test_bound_room_prefills_the_project(self) -> None:
        out, call, msg = await self._promote(room_project="P-00115", body_project=None)
        self.assertEqual(call.await_args.args[0], "create_task")
        self.assertEqual(call.await_args.args[1]["projectNumber"], "P-00115")
        self.assertEqual(out.project_number, "P-00115")
        self.assertEqual(msg.metadata_["projectops_task"]["project_number"], "P-00115")

    async def test_explicit_project_still_wins(self) -> None:
        _out, call, _msg = await self._promote(room_project="P-00115", body_project="P-00120")
        self.assertEqual(call.await_args.args[1]["projectNumber"], "P-00120")

    async def test_unbound_room_without_a_project_is_422(self) -> None:
        import app.api.messages as M

        msg = SimpleNamespace(id=uuid.uuid4(), sender=None, sender_id=uuid.uuid4(), content="x", created_at=NOW, metadata_={})
        room = SimpleNamespace(id=uuid.uuid4(), display_name="general", name="general", project_number=None)
        with patch.object(M, "_load_visible_message", AsyncMock(return_value=(msg, room))), patch.object(
            M, "_call_projectops_tool", AsyncMock()
        ) as call:
            with self.assertRaises(HTTPException) as ctx:
                await M.promote_message_to_projectops_task(msg.id, M.PromoteToProjectOpsBody(), {"participant_id": uuid.uuid4()}, AsyncMock())
        self.assertEqual(ctx.exception.status_code, 422)
        call.assert_not_awaited()


# ---------------------------------------------------------------------------
# Webhook routing: bound project channel first, assignee map second
# ---------------------------------------------------------------------------

SECRET = "whsec_" + "ab" * 32


def _sign(body: dict) -> tuple[bytes, str]:
    raw = json.dumps(body).encode("utf-8")
    return raw, "sha256=" + hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()


class WebhookRoutesToProjectChannel(unittest.TestCase):
    def setUp(self) -> None:
        from app.main import app

        self.app = app

    def tearDown(self) -> None:
        self.app.dependency_overrides.clear()

    def _client(self, monkeypatch_targets: dict, mapping: dict | None = None):
        import app.api.project_ops as route
        from app.config import Settings
        from app.deps import get_db, get_livekit, get_redis, get_settings_dep

        settings = Settings(
            projectops_webhook_secret=SECRET, projectops_workspace_id="ws1",
            projectops_room_mapping=mapping or {}, rate_limit_enabled=False,
        )
        client = TestClient(self.app)
        db = AsyncMock()
        db.get.return_value = None
        by_name_room = SimpleNamespace(id="assignee-room-id", name="astra")
        db.execute.return_value = _res(scalar=by_name_room)
        client.app.dependency_overrides[get_settings_dep] = lambda: settings
        client.app.dependency_overrides[get_db] = lambda: db
        client.app.dependency_overrides[get_livekit] = lambda: AsyncMock()
        client.app.dependency_overrides[get_redis] = lambda: None
        patches = [patch.object(route, name, value) for name, value in monkeypatch_targets.items()]
        return client, patches, db

    def _post(self, client, data):
        raw, sig = _sign({"event": "task.assigned", "workspaceId": "ws1", "data": data, "timestamp": datetime.now(timezone.utc).isoformat()})
        return client.post("/api/v1/webhooks/project-ops", content=raw, headers={"X-ProjectOps-Signature": sig, "X-ProjectOps-Delivery": "d1"})

    def test_bound_channel_wins_over_the_assignee_map(self) -> None:
        channel = SimpleNamespace(id=uuid.uuid4(), name="p-00115-stable")
        send = AsyncMock(return_value=SimpleNamespace(id="m1"))
        sender = AsyncMock(return_value=SimpleNamespace(id="sender-id"))
        client, patches, _db = self._client(
            {"_find_project_channel": AsyncMock(return_value=channel), "_get_or_create_sender": sender,
             "_ensure_membership": AsyncMock()},
            mapping={"u1": "astra"},
        )
        import app.api.project_ops as route

        with patches[0], patches[1], patches[2], patch.object(route.MessageService, "send_message", send):
            resp = self._post(client, {"assignedToId": "u1", "taskId": "t1", "projectNumber": "P-00115"})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["status"], "ok")
        self.assertEqual(send.await_args.kwargs["room_id"], channel.id)
        sender.assert_awaited_once_with(unittest.mock.ANY, "p-00115-stable")

    def test_no_channel_falls_back_to_todays_assignee_map(self) -> None:
        send = AsyncMock(return_value=SimpleNamespace(id="m1"))
        client, patches, _db = self._client(
            {"_find_project_channel": AsyncMock(return_value=None),
             "_get_or_create_sender": AsyncMock(return_value=SimpleNamespace(id="sender-id")),
             "_ensure_membership": AsyncMock()},
            mapping={"u1": "astra"},
        )
        import app.api.project_ops as route

        with patches[0], patches[1], patches[2], patch.object(route.MessageService, "send_message", send):
            resp = self._post(client, {"assignedToId": "u1", "taskId": "t1", "projectNumber": "P-00115"})
        self.assertEqual(resp.json()["status"], "ok")
        self.assertEqual(send.await_args.kwargs["room_id"], "assignee-room-id")

    def test_no_channel_and_unmapped_assignee_is_ignored(self) -> None:
        client, patches, _db = self._client({"_find_project_channel": AsyncMock(return_value=None)})
        with patches[0]:
            resp = self._post(client, {"assignedToId": "nobody", "taskId": "t1", "projectNumber": "P-00115"})
        self.assertEqual(resp.json(), {"status": "ignored", "reason": "unmapped_assignee"})

    def test_channel_lookup_sql_is_live_top_level_channels_only(self) -> None:
        from app.api.project_ops import _find_project_channel

        async def run():
            db = AsyncMock()
            db.execute = AsyncMock(return_value=_res(scalars=[]))
            await _find_project_channel(db, "P-00115")
            return _sql(db.execute.call_args.args[0])

        import asyncio

        sql = asyncio.run(run())
        self.assertIn("rooms.project_number = ", sql)
        self.assertIn("rooms.room_type = ", sql)
        self.assertIn("rooms.parent_room_id IS NULL", sql)
        self.assertIn("rooms.is_archived = false", sql)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
