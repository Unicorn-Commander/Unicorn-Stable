"""PATCH /rooms/{id}/voice-settings driven by a gateway CONTROL KEY (2026-09-02).

The Talk Controls desk app holds a gateway key, not a user JWT, so the
voice-settings write admits a key bearer through ``deps.get_room_controller``
under three conditions: active key, ``talk-controls-app`` identity OR the
explicit ``can_manage_voice_settings`` grant, and the room in the key's
allowed_rooms. Every other bearer takes the old ``get_current_user`` path,
and an ordinary agent key is refused — posting messages is not
reconfiguring the room.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.api.rooms import RoomVoiceSettingsBody, update_voice_settings
from app.auth.gateway_auth import (
    TALK_CONTROLS_AGENT_ID,
    GatewayPrincipal,
    hash_key,
    room_in_key_scope,
)
from app.deps import (
    control_key_user_dict,
    get_room_controller,
    is_control_key,
    room_control_actor,
)
from app.models.room import MemberRole

TOKEN = "sbk-unit-test-control-key-not-a-real-secret"
ROOM_LK = "stable-build-in-public-live"
ROOM_NAME = "build-in-public-live"


def _row(value):
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _room(metadata: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        livekit_room_name=ROOM_LK,
        name=ROOM_NAME,
        metadata_=metadata if metadata is not None else {"voice_relay_source": "agent-claude-code"},
    )


def _key_row(
    *,
    agent_id: str = TALK_CONTROLS_AGENT_ID,
    allowed_rooms: list | None = None,
    can_manage: bool = False,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        key_hash=hash_key(TOKEN),
        agent_id=agent_id,
        allowed_rooms=allowed_rooms if allowed_rooms is not None else [ROOM_NAME, ROOM_LK],
        rate_limit_rpm=30,
        can_manage_voice_settings=can_manage,
        revoked_at=None,
    )


def _request(bearer: str | None = TOKEN) -> SimpleNamespace:
    headers = {"Authorization": f"Bearer {bearer}"} if bearer is not None else {}
    return SimpleNamespace(headers=headers)


async def _controller(room, key_row, *, room_found: bool = True):
    """Run the dependency: the key lookup, then the room lookup."""
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[_row(key_row), _row(room if room_found else None)])
    return await get_room_controller(
        room_id=room.id, request=_request(), settings=SimpleNamespace(), db=db
    )


class RoomScopeRuleTests(TestCase):
    def test_either_name_form_or_star_is_in_scope(self) -> None:
        room = _room()
        self.assertTrue(room_in_key_scope([ROOM_NAME], room))
        self.assertTrue(room_in_key_scope([ROOM_LK], room))
        self.assertTrue(room_in_key_scope(["*"], room))
        self.assertFalse(room_in_key_scope(["some-other-room"], room))
        self.assertFalse(room_in_key_scope([], room))
        # None is the JWT path, which is never a key scope.
        self.assertFalse(room_in_key_scope(None, room))

    def test_only_a_key_of_the_desk_app_or_a_promoted_key_may_manage(self) -> None:
        def principal(agent_id: str, can_manage: bool = False, kind: str = "key"):
            return GatewayPrincipal(
                auth_kind=kind,
                agent_id=agent_id,
                allowed_rooms=["*"],
                rate_key="x",
                rate_limit_rpm=30,
                human_sub=None,
                key_id="k",
                can_manage_voice_settings=can_manage,
            )

        self.assertTrue(principal(TALK_CONTROLS_AGENT_ID).may_manage_voice_settings())
        self.assertTrue(principal("grok", can_manage=True).may_manage_voice_settings())
        self.assertFalse(principal("grok").may_manage_voice_settings())
        # A gateway JWT is never a controller, whatever it claims.
        self.assertFalse(
            principal(TALK_CONTROLS_AGENT_ID, can_manage=True, kind="jwt").may_manage_voice_settings()
        )

    def test_actor_label_never_carries_the_whole_key_id(self) -> None:
        key_id = str(uuid.uuid4())
        user = {"is_control_key": True, "control_key_id": key_id}
        self.assertEqual(room_control_actor(user), f"control_key:{key_id[:8]}")
        pid = uuid.uuid4()
        self.assertEqual(room_control_actor({"participant_id": pid}), f"user:{pid}")


class GetRoomControllerTests(IsolatedAsyncioTestCase):
    async def test_a_jwt_bearer_takes_the_ordinary_user_path_unchanged(self) -> None:
        human = {"participant_id": uuid.uuid4(), "sub": "kc-sub"}
        db = AsyncMock()
        with patch("app.deps.get_current_user", new=AsyncMock(return_value=human)) as gcu:
            user = await get_room_controller(
                room_id=uuid.uuid4(),
                request=_request("eyJhbGciOiJSUzI1NiJ9.not-a-key"),
                settings=SimpleNamespace(),
                db=db,
            )
        self.assertIs(user, human)
        gcu.assert_awaited_once()
        self.assertFalse(is_control_key(user))
        db.execute.assert_not_called()

    async def test_no_bearer_at_all_is_the_ordinary_401(self) -> None:
        with patch(
            "app.deps.get_current_user",
            new=AsyncMock(side_effect=HTTPException(status_code=401, detail="Missing")),
        ):
            with self.assertRaises(HTTPException) as ctx:
                await get_room_controller(
                    room_id=uuid.uuid4(), request=_request(None), settings=SimpleNamespace(), db=AsyncMock()
                )
        self.assertEqual(ctx.exception.status_code, 401)

    async def test_talk_controls_key_with_room_in_scope_is_a_control_principal(self) -> None:
        room = _room()
        key = _key_row(allowed_rooms=[ROOM_NAME])
        user = await _controller(room, key)
        self.assertTrue(is_control_key(user))
        self.assertEqual(user["control_key_id"], str(key.id))
        self.assertEqual(user["control_key_agent_id"], TALK_CONTROLS_AGENT_ID)
        self.assertEqual(user["control_room_id"], str(room.id))
        self.assertIsNone(user["participant_id"])
        self.assertEqual(room_control_actor(user), f"control_key:{str(key.id)[:8]}")

    async def test_the_livekit_name_form_counts_too(self) -> None:
        room = _room()
        user = await _controller(room, _key_row(allowed_rooms=[ROOM_LK]))
        self.assertTrue(is_control_key(user))

    async def test_room_out_of_the_keys_scope_is_403(self) -> None:
        room = _room()
        with self.assertRaises(HTTPException) as ctx:
            await _controller(room, _key_row(allowed_rooms=["stable-some-other-room"]))
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_a_revoked_or_unknown_key_is_401(self) -> None:
        # verify_gateway_key filters revoked_at IS NULL, so a revoked key
        # resolves to no row — the gateway's own 401.
        room = _room()
        with self.assertRaises(HTTPException) as ctx:
            await _controller(room, None)
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertEqual(ctx.exception.headers.get("WWW-Authenticate"), "Bearer")

    async def test_an_ordinary_agent_key_is_403_even_in_scope(self) -> None:
        room = _room()
        with self.assertRaises(HTTPException) as ctx:
            await _controller(room, _key_row(agent_id="grok", allowed_rooms=["*"]))
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("may not manage", ctx.exception.detail)

    async def test_the_explicit_grant_promotes_a_non_desk_app_key(self) -> None:
        room = _room()
        key = _key_row(agent_id="grok", allowed_rooms=[ROOM_NAME], can_manage=True)
        user = await _controller(room, key)
        self.assertTrue(is_control_key(user))
        self.assertEqual(user["control_key_agent_id"], "grok")

    async def test_the_grant_does_not_widen_room_scope(self) -> None:
        room = _room()
        with self.assertRaises(HTTPException) as ctx:
            await _controller(room, _key_row(agent_id="grok", allowed_rooms=["elsewhere"], can_manage=True))
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_an_unknown_room_is_404_after_the_key_checks(self) -> None:
        room = _room()
        with self.assertRaises(HTTPException) as ctx:
            await _controller(room, _key_row(), room_found=False)
        self.assertEqual(ctx.exception.status_code, 404)


class UpdateVoiceSettingsWithControlKeyTests(IsolatedAsyncioTestCase):
    """The handler with the synthetic principal: no membership ladder, the
    audit actor is the key prefix, and the live frame says who did it."""

    def _principal(self, room, key=None):
        key = key or _key_row()
        principal = GatewayPrincipal(
            auth_kind="key",
            agent_id=key.agent_id,
            allowed_rooms=list(key.allowed_rooms),
            rate_key=f"gwkey:{key.id}",
            rate_limit_rpm=30,
            human_sub=None,
            key_id=str(key.id),
            can_manage_voice_settings=key.can_manage_voice_settings,
        )
        return control_key_user_dict(principal, room), key

    async def test_control_key_write_is_200_shaped_and_audited(self) -> None:
        room = _room()
        user, key = self._principal(room)
        db = AsyncMock()
        # Only the room lookup — no membership query for a control key.
        db.execute = AsyncMock(side_effect=[_row(room)])
        db.commit = AsyncMock()
        livekit = AsyncMock()
        with patch("app.api.rooms.logger") as log:
            result = await update_voice_settings(
                room_id=room.id,
                body=RoomVoiceSettingsBody(activation="ptt"),
                user=user,
                db=db,
                livekit=livekit,
            )
        self.assertEqual(result, {"activation": "ptt", "live": True})
        self.assertEqual(room.metadata_["voice_relay_activation"], "ptt")
        db.commit.assert_awaited()
        self.assertEqual(db.execute.await_count, 1)
        frame = livekit.send_data.await_args.args[1]
        self.assertEqual(frame["by"], f"control_key:{str(key.id)[:8]}")
        updated = [c for c in log.info.call_args_list if c.args and c.args[0] == "voice_settings_updated"]
        self.assertEqual(len(updated), 1)
        self.assertEqual(
            updated[0].kwargs["voice_settings_updated_by"], f"control_key:{str(key.id)[:8]}"
        )

    async def test_user_path_audit_names_the_participant(self) -> None:
        room = _room()
        pid = uuid.uuid4()
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_row(room), _row(SimpleNamespace(role=MemberRole.OWNER))])
        db.commit = AsyncMock()
        livekit = AsyncMock()
        with patch("app.api.rooms.logger") as log:
            result = await update_voice_settings(
                room_id=room.id,
                body=RoomVoiceSettingsBody(activation="name"),
                user={"participant_id": pid},
                db=db,
                livekit=livekit,
            )
        self.assertEqual(result["activation"], "name")
        self.assertEqual(livekit.send_data.await_args.args[1]["by"], str(pid))
        updated = [c for c in log.info.call_args_list if c.args and c.args[0] == "voice_settings_updated"]
        self.assertEqual(updated[0].kwargs["voice_settings_updated_by"], f"user:{pid}")

    async def test_a_control_principal_for_another_room_is_refused_by_the_handler(self) -> None:
        room = _room()
        user, _ = self._principal(_room())  # resolved against a DIFFERENT room
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_row(room)])
        with self.assertRaises(HTTPException) as ctx:
            await update_voice_settings(
                room_id=room.id,
                body=RoomVoiceSettingsBody(activation="ptt"),
                user=user,
                db=db,
                livekit=AsyncMock(),
            )
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_a_room_with_no_voice_agent_is_still_a_409_for_a_key(self) -> None:
        room = _room(metadata={"brigade_agent_id": "majik"})
        user, _ = self._principal(room)
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[_row(room)])
        with self.assertRaises(HTTPException) as ctx:
            await update_voice_settings(
                room_id=room.id,
                body=RoomVoiceSettingsBody(activation="ptt"),
                user=user,
                db=db,
                livekit=AsyncMock(),
            )
        self.assertEqual(ctx.exception.status_code, 409)
