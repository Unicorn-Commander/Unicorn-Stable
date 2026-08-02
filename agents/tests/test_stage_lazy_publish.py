"""The stage track must not claim to be a camera it has nothing to put on.

Regression cover for the black-rectangle bug: `StageTrack` published a
camera-source video track at join and kept it up for the whole call, showing
`_render_blank()` — a flat #0f1117 fill. The Stable web client renders a
camera-source track as the participant's FACE, so every agent in every call was
a black rectangle and the avatar underneath was unreachable.

These tests exercise publish/unpublish bookkeeping with fakes; they deliberately
do not import livekit (`_ensure_published` imports `livekit.rtc` lazily), so the
track-construction call is stubbed out and what is asserted is WHEN we publish,
which is the part that was wrong.
"""

import asyncio

from agent_runtime.stage import StageTrack


class FakeLocalParticipant:
    def __init__(self) -> None:
        self.published: list[object] = []
        self.unpublished: list[str] = []

    async def publish_track(self, track, options):  # noqa: ANN001
        self.published.append(track)

    async def unpublish_track(self, sid):  # noqa: ANN001
        self.unpublished.append(sid)


class FakeRoom:
    name = "room-test"

    def __init__(self) -> None:
        self.local_participant = FakeLocalParticipant()
        # Matches rtc.ConnectionState.CONN_CONNECTED closely enough for the
        # guard in _unpublish; the sentinel below is compared against it.
        self.connection_state = "connected"


class FakeTrack:
    sid = "TR_stage"


def _install_fake_publisher(stage: StageTrack, room: FakeRoom) -> list[str]:
    """Replace the livekit-touching half of _ensure_published/_unpublish."""
    events: list[str] = []

    async def ensure() -> None:
        if stage._track is not None or stage._room is None or not stage._running:
            return
        stage._video_source = object()
        stage._track = FakeTrack()
        await room.local_participant.publish_track(stage._track, None)
        events.append("publish")

    async def unpublish() -> None:
        if stage._track is None:
            stage._video_source = None
            return
        await room.local_participant.unpublish_track(stage._track.sid)
        stage._video_source = None
        stage._track = None
        events.append("unpublish")

    stage._ensure_published = ensure  # type: ignore[method-assign]
    stage._unpublish = unpublish  # type: ignore[method-assign]
    return events


def test_start_publishes_nothing() -> None:
    """THE BUG. Joining a room must not put a camera track on the wire."""

    async def run() -> None:
        stage = StageTrack()
        room = FakeRoom()
        _install_fake_publisher(stage, room)
        await stage.start(room)
        assert room.local_participant.published == []
        assert stage._track is None

    asyncio.run(run())


def test_first_content_publishes_once() -> None:
    async def run() -> None:
        stage = StageTrack()
        room = FakeRoom()
        events = _install_fake_publisher(stage, room)
        await stage.start(room)

        await stage.show_text("hello")
        assert events == ["publish"]

        # Subsequent content reuses the same track — no republish churn.
        await stage.show_text("still hello")
        await stage.show_code("print(1)", "python")
        assert events == ["publish"]
        assert len(room.local_participant.published) == 1

    asyncio.run(run())


def test_clear_takes_the_track_down() -> None:
    """Clearing means "nothing to show", and nothing to show means no track.

    Painting a blank frame instead is exactly the original bug: from the
    client's side an agent showing a blank frame is an agent whose camera is on.
    """

    async def run() -> None:
        stage = StageTrack()
        room = FakeRoom()
        events = _install_fake_publisher(stage, room)
        await stage.start(room)

        await stage.show_text("hello")
        await stage.clear()
        assert events == ["publish", "unpublish"]
        assert stage._track is None

        # ...and it comes back if there is something to show again.
        await stage.show_text("hello again")
        assert events == ["publish", "unpublish", "publish"]

    asyncio.run(run())


def test_stop_is_safe_when_nothing_was_ever_published() -> None:
    """The common case now: an agent joins, talks, and never shows anything."""

    async def run() -> None:
        stage = StageTrack()
        room = FakeRoom()
        _install_fake_publisher(stage, room)
        await stage.start(room)
        await stage.stop()
        assert room.local_participant.unpublished == []
        assert stage._room is None

    asyncio.run(run())
