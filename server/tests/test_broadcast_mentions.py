"""Broadcast mentions (@here / @channel) resolve to the RIGHT recipients.

The bug this file pins down: the push and email fan-outs tokenized
``@here`` / ``@channel`` into the handles ``here`` / ``channel`` and compared
them against ``Participant.username`` — a field where those keywords can
never match — so broadcast mentions notified nobody. Recipient resolution now
lives in ``app.services.mentions`` and is shared by all three surfaces
(badge/inbox, web-push, email).

Semantics under test (composer cheatsheet is the user-facing contract):
- @channel — everyone in the room except the sender: badge + inbox row for
  every member, push + email for human members not actively online.
- @here — online members only: badge + inbox row still lands (durable
  catch-up surface), but @here contributes NO offline push/email targets.
"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from sqlalchemy.dialects import postgresql

from app.models.activity import ActivityEvent, ActivityEventType
from app.models.room import RoomType
from app.services.mentions import (
    mentions_participant,
    offline_notify_targets,
    parse_mentions,
)


def _sql(query) -> str:
    return str(query.compile(dialect=postgresql.dialect())).replace("\n", " ")


def _participant(username: str, display_name: str, *, sub: str | None = None):
    return SimpleNamespace(
        id=uuid.uuid4(),
        username=username,
        display_name=display_name,
        keycloak_sub=sub or f"sub-{username}",
    )


class _Result:
    """Minimal stand-in for a SQLAlchemy Result."""

    def __init__(self, *, scalar=None, scalars=None, rows=None, row=None):
        self._scalar = scalar
        self._scalars = scalars or []
        self._rows = rows or []
        self._row = row

    def scalar_one_or_none(self):
        return self._scalar

    def scalars(self):
        return SimpleNamespace(all=lambda: list(self._scalars))

    def all(self):
        return list(self._rows)

    def one_or_none(self):
        return self._row


def _fake_db(results):
    """AsyncSession double: returns canned results in order, records queries."""
    db = MagicMock()
    db.queries = []
    db.added = []
    seq = list(results)

    async def _execute(query, *args, **kwargs):
        db.queries.append(query)
        result = seq.pop(0)
        if callable(result):
            result = result(query)
        return result

    db.execute = AsyncMock(side_effect=_execute)
    db.add = MagicMock(side_effect=db.added.append)
    db.flush = AsyncMock()
    db.commit = AsyncMock()
    db.refresh = AsyncMock()
    return db


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


class ParseMentionsTests(TestCase):
    def test_channel_and_here_are_broadcasts_not_handles(self) -> None:
        pm = parse_mentions("heads up @channel and @here")
        self.assertTrue(pm.channel)
        self.assertTrue(pm.here)
        self.assertTrue(pm.broadcast)
        self.assertEqual(pm.handles, frozenset())

    def test_case_insensitive(self) -> None:
        self.assertTrue(parse_mentions("@Here").here)
        self.assertTrue(parse_mentions("@CHANNEL").channel)

    def test_trailing_punctuation_still_broadcasts(self) -> None:
        self.assertTrue(parse_mentions("@here.").here)
        self.assertTrue(parse_mentions("ping @channel, thanks").channel)
        self.assertTrue(parse_mentions("@here...").here)

    def test_word_boundary_no_false_broadcasts(self) -> None:
        pm = parse_mentions("@hereabouts @channels @channel-team")
        self.assertFalse(pm.here)
        self.assertFalse(pm.channel)
        self.assertEqual(
            pm.handles, frozenset({"hereabouts", "channels", "channel-team"})
        )

    def test_mixed_broadcast_and_personal(self) -> None:
        pm = parse_mentions("@here please, and @bob check @channel later")
        self.assertTrue(pm.here)
        self.assertTrue(pm.channel)
        self.assertEqual(pm.handles, frozenset({"bob"}))

    def test_personal_handles_casefolded_and_punct_alias(self) -> None:
        pm = parse_mentions("thanks @Bob.")
        self.assertIn("bob", pm.handles)
        self.assertIn("bob.", pm.handles)  # raw kept: usernames may end in ._-

    def test_empty_and_none_content(self) -> None:
        for content in ("", None, "no mentions here at all"):
            pm = parse_mentions(content)
            self.assertFalse(pm.broadcast)
            self.assertEqual(pm.handles, frozenset())

    def test_broad_kind_channel_wins_over_here(self) -> None:
        self.assertEqual(parse_mentions("@here @channel").broad_kind, "channel")
        self.assertEqual(parse_mentions("@here").broad_kind, "here")
        self.assertIsNone(parse_mentions("@bob").broad_kind)


# ---------------------------------------------------------------------------
# Recipient resolution — the RIGHT field
# ---------------------------------------------------------------------------


class OfflineNotifyTargetsTests(TestCase):
    def setUp(self) -> None:
        self.alice = _participant("astransky", "Aaron")
        self.bob = _participant("bob", "Here Person")
        self.candidates = [self.alice, self.bob]

    def test_channel_expands_to_every_candidate(self) -> None:
        pm = parse_mentions("@channel standup in 5")
        self.assertEqual(
            offline_notify_targets(pm, self.candidates), self.candidates
        )

    def test_here_alone_adds_no_offline_targets(self) -> None:
        pm = parse_mentions("@here quick sync?")
        self.assertEqual(offline_notify_targets(pm, self.candidates), [])

    def test_handles_match_username_never_display_name(self) -> None:
        # display_name "Aaron" must NOT be reachable via @aaron — the login
        # username is the only field a typed handle matches. This is the
        # wrong-field regression class.
        pm = parse_mentions("@aaron take a look")
        self.assertEqual(offline_notify_targets(pm, self.candidates), [])
        pm = parse_mentions("@astransky take a look")
        self.assertEqual(offline_notify_targets(pm, self.candidates), [self.alice])

    def test_broadcast_keyword_is_never_a_username_lookup(self) -> None:
        # bob's display_name is "Here Person"; @here must not resolve through
        # any name field, and must not match a user literally at all.
        pm = parse_mentions("@here")
        self.assertEqual(offline_notify_targets(pm, self.candidates), [])

    def test_mixed_here_plus_personal_keeps_only_personal(self) -> None:
        pm = parse_mentions("@here also @bob specifically")
        self.assertEqual(offline_notify_targets(pm, self.candidates), [self.bob])

    def test_mentions_participant_broadcast_and_personal(self) -> None:
        self.assertTrue(
            mentions_participant(parse_mentions("@channel"), self.alice)
        )
        self.assertTrue(
            mentions_participant(parse_mentions("@here"), self.alice)
        )
        self.assertTrue(
            mentions_participant(parse_mentions("@astransky"), self.alice)
        )
        self.assertFalse(
            mentions_participant(parse_mentions("@aaron"), self.alice)
        )


# ---------------------------------------------------------------------------
# Web-push fan-out
# ---------------------------------------------------------------------------


def _push_settings():
    return SimpleNamespace(
        vapid_private_key="priv",
        vapid_public_key="pub",
        vapid_subject="mailto:ops@stable.test",
        public_base_url="https://stable.test",
    )


def _sub_for(p):
    return SimpleNamespace(
        endpoint=f"https://push.example/{p.username}",
        p256dh="p",
        auth="a",
        participant_id=p.id,
    )


class DispatchMessagePushesTests(IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.room = SimpleNamespace(
            id=uuid.uuid4(),
            room_type=RoomType.CHANNEL,
            display_name="General",
            name="general",
        )
        self.carol = _participant("carol", "Carol")
        self.dave = _participant("dave", "Dave")

    async def _run(self, *, content, offline_members, room=None):
        from app.services import push_service

        room = room or self.room
        subs = [_sub_for(p) for p in offline_members]

        def _subs_result(query):
            # Honor the SQL `participant_id IN (…)` filter the code issues —
            # the fan-out narrows targets BEFORE this query, and the test must
            # only hand back subscriptions the query actually asked for. The
            # IN renders as one expanding bind param holding the id list.
            wanted: set[str] = set()
            for value in query.compile(dialect=postgresql.dialect()).params.values():
                if isinstance(value, (list, tuple, set)):
                    wanted.update(str(v) for v in value)
                else:
                    wanted.add(str(value))
            return _Result(
                scalars=[s for s in subs if str(s.participant_id) in wanted]
            )

        db = _fake_db(
            [
                _Result(scalar=room),
                _Result(scalars=offline_members),
                _subs_result,
            ]
        )
        sent = []

        async def _fake_send(sub, payload, settings):
            sent.append((sub, payload))
            return True

        with patch.object(push_service, "send_web_push", _fake_send):
            await push_service.dispatch_message_pushes(
                db=db,
                content=content,
                room_id=room.id,
                sender_id=uuid.uuid4(),
                sender_name="Aaron",
                settings=_push_settings(),
            )
        return db, sent

    async def test_channel_broadcast_pushes_every_offline_member(self) -> None:
        db, sent = await self._run(
            content="@channel deploy is done",
            offline_members=[self.carol, self.dave],
        )
        self.assertEqual(len(sent), 2)
        endpoints = {sub.endpoint for sub, _ in sent}
        self.assertEqual(
            endpoints,
            {"https://push.example/carol", "https://push.example/dave"},
        )
        # The subscription query targeted exactly the resolved participants.
        subs_sql = _sql(db.queries[2])
        self.assertIn("push_subscriptions", subs_sql)

    async def test_push_payload_shape(self) -> None:
        _, sent = await self._run(
            content="@channel deploy is done", offline_members=[self.carol]
        )
        _, payload = sent[0]
        self.assertEqual(payload["title"], "Aaron in General")
        self.assertEqual(payload["body"], "@channel deploy is done")
        self.assertEqual(payload["tag"], str(self.room.id))
        self.assertIn(str(self.room.id), payload["url"])

    async def test_here_pushes_nobody_offline(self) -> None:
        _, sent = await self._run(
            content="@here quick sync?", offline_members=[self.carol, self.dave]
        )
        self.assertEqual(sent, [])

    async def test_mixed_here_and_personal_pushes_only_personal(self) -> None:
        db, sent = await self._run(
            content="@here — @dave can you drive?",
            offline_members=[self.carol, self.dave],
        )
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0].endpoint, "https://push.example/dave")

    async def test_member_query_excludes_sender_and_scopes_room(self) -> None:
        db, _ = await self._run(
            content="@channel hi", offline_members=[self.carol]
        )
        members_sql = _sql(db.queries[1])
        self.assertIn("JOIN room_members", members_sql)
        self.assertIn("room_members.room_id =", members_sql)
        self.assertIn("participants.id !=", members_sql)
        self.assertIn("participants.status !=", members_sql)

    async def test_dm_rooms_still_push_without_mentions(self) -> None:
        dm = SimpleNamespace(
            id=uuid.uuid4(),
            room_type=RoomType.DM,
            display_name=None,
            name="dm-room",
        )
        _, sent = await self._run(
            content="plain message, no mentions",
            offline_members=[self.carol],
            room=dm,
        )
        self.assertEqual(len(sent), 1)


# ---------------------------------------------------------------------------
# Email fan-out
# ---------------------------------------------------------------------------


def _email_settings():
    return SimpleNamespace(
        ms_graph_tenant_id="tenant",
        ms_graph_client_id="client",
        ms_graph_client_secret="secret",
        ms_graph_from_address="stable@magicunicorn.tech",
        public_base_url="https://stable.test",
    )


class MentionEmailDispatchTests(IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.room = SimpleNamespace(
            id=uuid.uuid4(), display_name="General", name="general"
        )
        self.carol = _participant("carol", "Carol")
        self.dave = _participant("dave", "Dave")
        self.emails = {
            self.carol.keycloak_sub: "carol@x.test",
            self.dave.keycloak_sub: "dave@x.test",
        }

    async def _run(self, *, content, offline_members):
        from app.api.messages import _maybe_dispatch_mention_emails

        db = _fake_db(
            [_Result(scalar=self.room), _Result(scalars=offline_members)]
        )
        sent = []

        async def _fake_send(self_sender, **kwargs):
            sent.append(kwargs)
            return True

        async def _fake_email_for_sub(sub):
            return self.emails.get(sub)

        with (
            patch("app.config.get_settings", return_value=_email_settings()),
            patch(
                "app.api.users._load_keycloak_email_for_sub",
                _fake_email_for_sub,
            ),
            patch(
                "app.services.email_sender.GraphEmailSender.send", _fake_send
            ),
        ):
            await _maybe_dispatch_mention_emails(
                db=db,
                content=content,
                room_id=self.room.id,
                sender_participant_id=uuid.uuid4(),
                sender_name="Aaron",
                sender_email="aaron@magicunicorn.tech",
            )
            # Sends are fire-and-forget tasks; drain them before asserting.
            pending = [
                t
                for t in asyncio.all_tasks()
                if t is not asyncio.current_task()
            ]
            if pending:
                await asyncio.gather(*pending)
        return db, sent

    async def test_channel_broadcast_emails_every_offline_member(self) -> None:
        db, sent = await self._run(
            content="@channel release notes are up",
            offline_members=[self.carol, self.dave],
        )
        self.assertEqual(
            sorted(kw["to"] for kw in sent), ["carol@x.test", "dave@x.test"]
        )
        for kw in sent:
            self.assertEqual(
                kw["subject"], "Aaron mentioned @channel in General"
            )
            self.assertIn("release notes are up", kw["html_body"])
            self.assertEqual(kw["reply_to"], "aaron@magicunicorn.tech")

    async def test_personally_mentioned_recipient_reads_mentioned_you(
        self,
    ) -> None:
        _, sent = await self._run(
            content="@channel — @dave owns the rollback",
            offline_members=[self.carol, self.dave],
        )
        by_to = {kw["to"]: kw for kw in sent}
        self.assertEqual(
            by_to["dave@x.test"]["subject"], "Aaron mentioned you in General"
        )
        self.assertEqual(
            by_to["carol@x.test"]["subject"],
            "Aaron mentioned @channel in General",
        )

    async def test_here_sends_no_email(self) -> None:
        _, sent = await self._run(
            content="@here anyone around?",
            offline_members=[self.carol, self.dave],
        )
        self.assertEqual(sent, [])

    async def test_member_query_scopes_room_and_excludes_sender(self) -> None:
        db, _ = await self._run(
            content="@channel hi", offline_members=[self.carol]
        )
        members_sql = _sql(db.queries[1])
        self.assertIn("JOIN room_members", members_sql)
        self.assertIn("room_members.room_id =", members_sql)
        self.assertIn("participants.id !=", members_sql)
        self.assertIn("participants.status !=", members_sql)

    async def test_no_mentions_no_queries(self) -> None:
        db, sent = await self._run(
            content="plain text, nothing to see", offline_members=[]
        )
        self.assertEqual(sent, [])
        self.assertEqual(db.queries, [])


# ---------------------------------------------------------------------------
# Badge + Activity inbox rows (message_service)
# ---------------------------------------------------------------------------


def _member_row(participant):
    member = SimpleNamespace(
        participant_id=participant.id,
        mention_count=0,
        has_unread_mention=False,
    )
    return member, participant


class BroadcastInboxRowTests(IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.sender = _participant("aaron", "Aaron")
        self.carol = _participant("carol", "Carol")
        self.dave = _participant("dave", "Dave")

    async def _send(self, content):
        from app.services.message_service import MessageService

        sender_row = _member_row(self.sender)
        carol_row = _member_row(self.carol)
        dave_row = _member_row(self.dave)
        db = _fake_db(
            [
                _Result(scalar=SimpleNamespace(is_muted=False)),  # membership
                _Result(rows=[sender_row, carol_row, dave_row]),  # members
                _Result(scalar=self.sender),  # sender lookup
                _Result(row=None),  # livekit room row → skip broadcast
            ]
        )
        svc = MessageService(db=db, livekit=AsyncMock())
        await svc.send_message(
            room_id=uuid.uuid4(),
            sender_id=self.sender.id,
            content=content,
        )
        events = [e for e in db.added if isinstance(e, ActivityEvent)]
        return db, {"sender": sender_row[0], "carol": carol_row[0], "dave": dave_row[0]}, events

    async def test_channel_broadcast_writes_inbox_row_per_recipient(self) -> None:
        _, members, events = await self._send("@channel all hands now")
        mention_events = [
            e for e in events if e.event_type == ActivityEventType.MENTION
        ]
        self.assertEqual(
            {e.participant_id for e in mention_events},
            {self.carol.id, self.dave.id},
        )
        self.assertEqual(members["carol"].mention_count, 1)
        self.assertEqual(members["dave"].mention_count, 1)
        self.assertTrue(members["carol"].has_unread_mention)

    async def test_sender_is_excluded_from_own_broadcast(self) -> None:
        _, members, events = await self._send("@channel all hands now")
        self.assertEqual(members["sender"].mention_count, 0)
        self.assertFalse(members["sender"].has_unread_mention)
        self.assertNotIn(
            self.sender.id, {e.participant_id for e in events}
        )

    async def test_here_also_badges_members_durable_inbox(self) -> None:
        _, members, events = await self._send("@here quick huddle")
        self.assertEqual(members["carol"].mention_count, 1)
        self.assertEqual(
            {e.participant_id for e in events},
            {self.carol.id, self.dave.id},
        )

    async def test_hereabouts_is_not_a_broadcast(self) -> None:
        _, members, events = await self._send("meet me @hereabouts later")
        self.assertEqual(events, [])
        self.assertEqual(members["carol"].mention_count, 0)

    async def test_personal_display_name_mention_still_badges(self) -> None:
        # Composer inserts display-name mentions; the badge path matches them
        # by substring. Guard that the shared-parser swap kept this working.
        _, members, events = await self._send("ping @Carol about the deploy")
        self.assertEqual(members["carol"].mention_count, 1)
        self.assertEqual(members["dave"].mention_count, 0)
        self.assertEqual(
            {e.participant_id for e in events}, {self.carol.id}
        )
