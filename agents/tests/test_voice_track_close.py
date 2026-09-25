"""The per-track controller's shutdown and retry bookkeeping stay bounded.

- aclose() must not leave a session running past its timeout: a session left
  behind would post its line after the relay's HTTP client is closed and lose
  it silently.
- The reopen budget forgets sids whose last reopen is outside the window, so a
  long show with tracks coming and going does not grow that map forever.
"""

from __future__ import annotations

import asyncio
import unittest

from agent_runtime.multi_track_stt import (
    REOPEN_WINDOW_S,
    HumanAudioTrack,
    MultiTrackController,
)


class _StuckSession:
    """Looks running to the controller; its task never finishes by itself."""

    def __init__(self) -> None:
        self.closed = False
        self._task = asyncio.get_running_loop().create_task(asyncio.sleep(3600))

    def close(self) -> None:
        self.closed = True  # a close that does not stop the task, like a hung flush


class ControllerCloseTests(unittest.TestCase):
    def test_aclose_cancels_a_session_that_outlives_the_timeout(self) -> None:
        opened: list[_StuckSession] = []

        def opener(_track: HumanAudioTrack) -> _StuckSession:
            session = _StuckSession()
            opened.append(session)
            return session

        async def go() -> None:
            controller = MultiTrackController(on_final=lambda *_: None, opener=opener)
            controller.reconcile([HumanAudioTrack("aaron_1", "Aaron", "TR_1")])
            self.assertEqual(len(opened), 1)
            await controller.aclose(timeout=0.05)
            # One scheduler turn lets the cancellation land.
            await asyncio.sleep(0)
            self.assertTrue(opened[0]._task.cancelled())
            self.assertEqual(controller.active_sids, set())

        asyncio.run(go())


class ReopenBudgetTests(unittest.TestCase):
    def test_sids_outside_the_window_are_forgotten(self) -> None:
        now = [1000.0]
        controller = MultiTrackController(
            on_final=lambda *_: None, opener=lambda _t: None, clock=lambda: now[0]
        )
        for sid in ("TR_1", "TR_2", "TR_3"):
            self.assertTrue(controller._reopen_allowed(sid))
        self.assertEqual(set(controller._reopens), {"TR_1", "TR_2", "TR_3"})

        now[0] += REOPEN_WINDOW_S + 1.0
        self.assertTrue(controller._reopen_allowed("TR_4"))
        self.assertEqual(set(controller._reopens), {"TR_4"})

    def test_the_budget_still_holds_inside_the_window(self) -> None:
        now = [0.0]
        controller = MultiTrackController(
            on_final=lambda *_: None, opener=lambda _t: None, clock=lambda: now[0]
        )
        allowed = [controller._reopen_allowed("TR_1") for _ in range(5)]
        self.assertEqual(allowed, [True, True, True, False, False])


if __name__ == "__main__":
    unittest.main()
