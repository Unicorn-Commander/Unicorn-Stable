"""Tests for the search operator filters (from:/in:/has:/before:/after:).

The web client parses chips out of the search box and sends them as query
params; the server must actually filter (the chips used to render as applied
while the params were silently ignored). Everything validates leniently — an
unusable value drops that one filter, it never 422s/500s the search.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock

from sqlalchemy.dialects import postgresql

from app.services.message_service import (
    MessageService,
    build_search_operator_filters,
    parse_operator_date,
)


def _sql(clause) -> str:
    """Compile a clause to Postgres SQL (parameterized) for assertions."""
    compiled = clause.compile(dialect=postgresql.dialect())
    return str(compiled).replace("\n", " ")


def _params(clause) -> dict:
    return dict(clause.compile(dialect=postgresql.dialect()).params)


class ParseOperatorDateTests(TestCase):
    def test_bare_date_is_midnight_utc(self) -> None:
        dt = parse_operator_date("2026-08-01")
        self.assertEqual(dt, datetime(2026, 8, 1, tzinfo=timezone.utc))

    def test_full_timestamp_with_zulu(self) -> None:
        dt = parse_operator_date("2026-08-01T12:30:00Z")
        self.assertEqual(
            dt, datetime(2026, 8, 1, 12, 30, tzinfo=timezone.utc)
        )

    def test_offset_is_preserved(self) -> None:
        dt = parse_operator_date("2026-08-01T00:00:00-04:00")
        assert dt is not None
        self.assertEqual(dt.utcoffset().total_seconds(), -4 * 3600)

    def test_garbage_and_empty_return_none(self) -> None:
        self.assertIsNone(parse_operator_date("yesterday"))
        self.assertIsNone(parse_operator_date("2026-13-45"))
        self.assertIsNone(parse_operator_date(""))
        self.assertIsNone(parse_operator_date("   "))
        self.assertIsNone(parse_operator_date(None))


class BuildSearchOperatorFiltersTests(TestCase):
    def test_no_operators_no_filters(self) -> None:
        self.assertEqual(build_search_operator_filters(), [])

    def test_from_matches_display_name_or_username_case_insensitive(self) -> None:
        conds = build_search_operator_filters(from_sender="@Alice")
        self.assertEqual(len(conds), 1)
        sql = _sql(conds[0])
        self.assertIn("sender_id IN", sql)
        self.assertIn("display_name ILIKE", sql)
        self.assertIn("username ILIKE", sql)
        # Leading @ is stripped; substring semantics.
        self.assertIn("%Alice%", _params(conds[0]).values())

    def test_from_blank_or_bare_at_is_dropped(self) -> None:
        self.assertEqual(build_search_operator_filters(from_sender="   "), [])
        self.assertEqual(build_search_operator_filters(from_sender="@"), [])

    def test_in_matches_room_name_with_hash_stripped(self) -> None:
        conds = build_search_operator_filters(in_room="#general")
        self.assertEqual(len(conds), 1)
        sql = _sql(conds[0])
        self.assertIn("room_id IN", sql)
        self.assertIn("rooms.name ILIKE", sql)
        self.assertIn("rooms.display_name ILIKE", sql)
        self.assertIn("%general%", _params(conds[0]).values())

    def test_has_file_and_attachment_filter_on_metadata_attachments(self) -> None:
        for value in ("file", "attachment", "FILE", " Files "):
            conds = build_search_operator_filters(has=value)
            self.assertEqual(len(conds), 2, f"has={value!r}")
            joined = " AND ".join(_sql(c) for c in conds)
            self.assertIn("jsonb_typeof", joined)
            self.assertIn("metadata", joined)
            # Arrow operator, never PG14+ subscripting or jsonb_array_length
            # (which raises on non-arrays; AND order is not guaranteed).
            self.assertIn("->", joined)
            self.assertNotIn("jsonb_array_length", joined)

    def test_has_unknown_value_is_dropped_not_erred(self) -> None:
        self.assertEqual(build_search_operator_filters(has="link"), [])
        self.assertEqual(build_search_operator_filters(has="image"), [])
        self.assertEqual(build_search_operator_filters(has="🦄"), [])

    def test_before_after_bound_created_at(self) -> None:
        conds = build_search_operator_filters(
            before="2026-08-01", after="2026-07-01"
        )
        self.assertEqual(len(conds), 2)
        sqls = [_sql(c) for c in conds]
        self.assertTrue(any("created_at <" in s for s in sqls))
        self.assertTrue(any("created_at >" in s for s in sqls))

    def test_invalid_dates_are_dropped(self) -> None:
        self.assertEqual(
            build_search_operator_filters(before="soon", after="not-a-date"),
            [],
        )

    def test_mixed_valid_and_invalid_keeps_only_valid(self) -> None:
        conds = build_search_operator_filters(
            from_sender="alice", has="nope", before="garbage", after="2026-01-01"
        )
        joined = " AND ".join(_sql(c) for c in conds)
        self.assertEqual(len(conds), 2)
        self.assertIn("sender_id IN", joined)
        self.assertIn("created_at >", joined)


class SearchServiceOperatorWiringTests(IsolatedAsyncioTestCase):
    """The service methods weave the operator filters into their queries."""

    def _service(self) -> tuple[MessageService, AsyncMock]:
        db = AsyncMock()
        result = MagicMock()
        result.scalars.return_value.all.return_value = []
        db.execute.return_value = result
        svc = MessageService(db=db, livekit=AsyncMock())
        return svc, db

    async def test_per_room_search_applies_operators(self) -> None:
        svc, db = self._service()
        await svc.search_messages(
            room_id=uuid.uuid4(),
            query_text="rollout",
            from_sender="alice",
            has="file",
            before="2026-08-01",
            after="2026-07-01",
        )
        query = db.execute.call_args_list[0].args[0]
        sql = _sql(query)
        self.assertIn("content ILIKE", sql)
        self.assertIn("sender_id IN", sql)
        self.assertIn("jsonb_typeof", sql)
        self.assertIn("created_at <", sql)
        self.assertIn("created_at >", sql)

    async def test_per_room_search_without_operators_is_unchanged(self) -> None:
        svc, db = self._service()
        await svc.search_messages(room_id=uuid.uuid4(), query_text="rollout")
        sql = _sql(db.execute.call_args_list[0].args[0])
        self.assertIn("content ILIKE", sql)
        self.assertNotIn("sender_id IN", sql)
        self.assertNotIn("jsonb_typeof", sql)

    async def test_global_search_applies_in_room_within_membership(self) -> None:
        svc, db = self._service()
        await svc.search_all_messages(
            participant_id=uuid.uuid4(),
            query_text="rollout",
            in_room="#general",
        )
        sql = _sql(db.execute.call_args_list[0].args[0])
        # Membership scope AND the in: filter are both room_id IN (...) —
        # the operator narrows within the caller's rooms, never widens.
        self.assertEqual(sql.count("room_id IN"), 2)
        self.assertIn("room_members", sql)
        self.assertIn("rooms.name ILIKE", sql)

    async def test_global_search_bad_operator_values_still_run_base_query(self) -> None:
        svc, db = self._service()
        out = await svc.search_all_messages(
            participant_id=uuid.uuid4(),
            query_text="rollout",
            from_sender="@",
            in_room="#",
            has="link",
            before="nope",
            after="also-nope",
        )
        self.assertEqual(out, [])
        sql = _sql(db.execute.call_args_list[0].args[0])
        self.assertIn("content ILIKE", sql)
        self.assertNotIn("sender_id IN", sql)
        self.assertNotIn("jsonb_typeof", sql)
        self.assertNotIn("created_at <", sql)
