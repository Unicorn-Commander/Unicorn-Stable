"""Composite-egress capacity — the Redis semaphore (design §8: cap at 2)."""

from __future__ import annotations

from unittest import IsolatedAsyncioTestCase

from app.services import recording_capacity as cap
from recording_fakes import FakeRedis


class SemaphoreTests(IsolatedAsyncioTestCase):
    async def test_two_admitted_third_refused(self) -> None:
        r = FakeRedis()
        self.assertTrue(await cap.acquire_composite_slot(r, member="a", limit=2, ttl_seconds=60, now=1.0))
        self.assertTrue(await cap.acquire_composite_slot(r, member="b", limit=2, ttl_seconds=60, now=2.0))
        self.assertFalse(await cap.acquire_composite_slot(r, member="c", limit=2, ttl_seconds=60, now=3.0))
        # The refused claimant leaves no residue.
        self.assertEqual(await cap.active_composite_slots(r, ttl_seconds=60, now=4.0), 2)
        self.assertNotIn("c", r.zsets[cap.SLOTS_KEY])

    async def test_release_frees_a_slot(self) -> None:
        r = FakeRedis()
        await cap.acquire_composite_slot(r, member="a", limit=2, ttl_seconds=60, now=1.0)
        await cap.acquire_composite_slot(r, member="b", limit=2, ttl_seconds=60, now=2.0)
        await cap.release_composite_slot(r, "a")
        self.assertTrue(await cap.acquire_composite_slot(r, member="c", limit=2, ttl_seconds=60, now=3.0))

    async def test_stale_slots_expire_with_the_max_egress_duration(self) -> None:
        r = FakeRedis()
        await cap.acquire_composite_slot(r, member="a", limit=1, ttl_seconds=100, now=0.0)
        self.assertFalse(await cap.acquire_composite_slot(r, member="b", limit=1, ttl_seconds=100, now=50.0))
        # 101s later the leaked slot is gone and a new claimant gets in.
        self.assertTrue(await cap.acquire_composite_slot(r, member="b", limit=1, ttl_seconds=100, now=101.0))

    async def test_limit_zero_admits_nobody(self) -> None:
        r = FakeRedis()
        self.assertFalse(await cap.acquire_composite_slot(r, member="a", limit=0, ttl_seconds=60))

    async def test_redis_failure_is_surfaced_not_swallowed(self) -> None:
        r = FakeRedis()
        r.fail = True
        with self.assertRaises(cap.CapacityUnavailable):
            await cap.acquire_composite_slot(r, member="a", limit=2, ttl_seconds=60)
        # release is fail-open (called from cleanup paths)
        await cap.release_composite_slot(r, "a")

    async def test_reconcile_drops_slots_whose_rows_finished(self) -> None:
        r = FakeRedis()
        for m in ("live", "dead1", "dead2"):
            await cap.acquire_composite_slot(r, member=m, limit=5, ttl_seconds=60, now=1.0)
        removed = await cap.reconcile_composite_slots(r, {"live"})
        self.assertEqual(removed, 2)
        self.assertEqual(set(r.zsets[cap.SLOTS_KEY]), {"live"})
