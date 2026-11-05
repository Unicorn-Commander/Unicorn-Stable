"""Session plumbing for the agents test suite.

livekit-rtc's Rust FFI keeps a tokio runtime alive for the life of the process. When
CPython finalizes after the session, a worker thread can hit "panic in a function that
cannot unwind" and abort the interpreter: exit 134 AFTER every test passed. Measured in
CI on 2026-11-05 (tasks 6486 and 6498: "405 passed" then "Aborted (core dumped)"), on
either event for the same tree, so the `ci / agents` status was a coin toss with no test
at fault. pytest has reported by the time it unconfigures, so leave with its own exit
status and skip the finalization that races the runtime.
"""
from __future__ import annotations

import os
import sys

import pytest

_session_exit_status: int | None = None


def pytest_sessionfinish(session, exitstatus) -> None:  # noqa: ANN001
    global _session_exit_status
    _session_exit_status = int(exitstatus)


@pytest.hookimpl(trylast=True)
def pytest_unconfigure(config) -> None:  # noqa: ANN001
    if _session_exit_status is None:  # --collect-only style early exits: normal shutdown
        return
    capture = config.pluginmanager.getplugin("capturemanager")
    if capture is not None:
        capture.stop_global_capturing()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(_session_exit_status)
