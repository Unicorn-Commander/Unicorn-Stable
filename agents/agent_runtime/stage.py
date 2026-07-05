"""StageTrack — renders visual content and publishes it as a video track in LiveKit."""

from __future__ import annotations

import asyncio
import io
import textwrap
from enum import StrEnum
from typing import Any

import structlog
from PIL import Image, ImageDraw, ImageFont

logger = structlog.get_logger(__name__)

# Default canvas dimensions (720p landscape)
_WIDTH: int = 1280
_HEIGHT: int = 720
_BG_COLOR: str = "#0f1117"
_TEXT_COLOR: str = "#e2e8f0"
_CODE_BG_COLOR: str = "#1a1b26"
_CODE_COLOR: str = "#7aa2f7"
_ACCENT_COLOR: str = "#6366f1"
_FONT_SIZE: int = 28
_CODE_FONT_SIZE: int = 22
_PADDING: int = 48
_LINE_SPACING: int = 8


class ContentKind(StrEnum):
    TEXT = "text"
    CODE = "code"
    IMAGE = "image"
    URL = "url"
    CLEAR = "clear"


def _load_font(size: int, monospace: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Load a font, falling back to the default bitmap font."""
    font_names: list[str] = (
        ["DejaVuSansMono.ttf", "LiberationMono-Regular.ttf", "courier.ttf"]
        if monospace
        else ["DejaVuSans.ttf", "LiberationSans-Regular.ttf", "arial.ttf"]
    )
    for name in font_names:
        try:
            return ImageFont.truetype(name, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def _render_blank() -> Image.Image:
    img = Image.new("RGB", (_WIDTH, _HEIGHT), color=_BG_COLOR)
    return img


def _render_text(content: str) -> Image.Image:
    img = Image.new("RGB", (_WIDTH, _HEIGHT), color=_BG_COLOR)
    draw = ImageDraw.Draw(img)
    font = _load_font(_FONT_SIZE)

    max_chars = (_WIDTH - 2 * _PADDING) // (_FONT_SIZE // 2 + 2)
    wrapped = textwrap.fill(content, width=max(max_chars, 40))
    lines = wrapped.splitlines()

    y = _PADDING
    line_height = _FONT_SIZE + _LINE_SPACING

    # Draw accent bar at top
    draw.rectangle([0, 0, _WIDTH, 4], fill=_ACCENT_COLOR)

    for line in lines:
        if y + line_height > _HEIGHT - _PADDING:
            draw.text((_PADDING, y), "...", fill=_TEXT_COLOR, font=font)
            break
        draw.text((_PADDING, y), line, fill=_TEXT_COLOR, font=font)
        y += line_height

    return img


def _render_code(code: str, language: str) -> Image.Image:
    img = Image.new("RGB", (_WIDTH, _HEIGHT), color=_CODE_BG_COLOR)
    draw = ImageDraw.Draw(img)
    font = _load_font(_CODE_FONT_SIZE, monospace=True)

    # Header bar with language label
    draw.rectangle([0, 0, _WIDTH, 40], fill=_ACCENT_COLOR)
    header_font = _load_font(18)
    draw.text((16, 10), language.upper(), fill="#ffffff", font=header_font)

    lines = code.splitlines()
    y = 56
    line_height = _CODE_FONT_SIZE + _LINE_SPACING
    gutter_width = 60

    for i, line in enumerate(lines, start=1):
        if y + line_height > _HEIGHT - _PADDING:
            draw.text((_PADDING, y), "  ...", fill="#565f89", font=font)
            break
        # Line number
        draw.text((_PADDING, y), f"{i:>3}", fill="#565f89", font=font)
        # Code text
        draw.text((gutter_width + _PADDING, y), line, fill=_CODE_COLOR, font=font)
        y += line_height

    return img


def _image_to_rgba_bytes(img: Image.Image) -> bytes:
    """Convert a PIL Image to raw RGBA bytes for an RTCVideoFrame."""
    rgba = img.convert("RGBA")
    return rgba.tobytes()


class StageTrack:
    """Manages an agent's stage video track in a LiveKit room.

    Renders content (text, code, images) to PIL images, converts to ARGB32 frames,
    and publishes them through a LiveKit VideoSource.
    """

    def __init__(self) -> None:
        self._current_image: Image.Image = _render_blank()
        self._video_source: Any | None = None
        self._room: Any | None = None
        self._track: Any | None = None
        self._publish_task: asyncio.Task[None] | None = None
        self._dirty: asyncio.Event = asyncio.Event()
        self._running: bool = False

    async def start(self, room: Any) -> None:
        """Attach to a LiveKit room and begin publishing a video track."""
        from livekit import rtc

        self._room = room
        self._video_source = rtc.VideoSource(width=_WIDTH, height=_HEIGHT)
        self._track = rtc.LocalVideoTrack.create_video_track(
            "stage",
            self._video_source,
        )
        options = rtc.TrackPublishOptions(
            source=rtc.TrackSource.SOURCE_CAMERA,
        )
        await room.local_participant.publish_track(self._track, options)
        self._running = True
        self._publish_task = asyncio.create_task(self._publish_loop())
        logger.info("stage_track_started", room=getattr(room, "name", "unknown"))

    async def stop(self) -> None:
        """Unpublish and clean up."""
        self._running = False
        self._dirty.set()
        if self._publish_task is not None:
            self._publish_task.cancel()
            try:
                await self._publish_task
            except asyncio.CancelledError:
                pass
            self._publish_task = None

        if self._room is not None and self._track is not None:
            from livekit import rtc

            try:
                # livekit-agents disconnects the room BEFORE running job
                # shutdown callbacks (ipc/job_proc_lazy_main.py), so an
                # unpublish on the dead signal client never resolves and the
                # job process eats the framework's 10s shutdown_process_timeout
                # and dies by SIGUSR1 (exit -10). Skip when disconnected and
                # cap the await either way.
                if self._room.connection_state == rtc.ConnectionState.CONN_CONNECTED:
                    await asyncio.wait_for(
                        self._room.local_participant.unpublish_track(self._track.sid),
                        timeout=3.0,
                    )
            except Exception:
                logger.warning("stage_track_unpublish_failed", exc_info=True)

        self._video_source = None
        self._track = None
        self._room = None
        logger.info("stage_track_stopped")

    # -- public content methods --

    async def show_text(self, content: str) -> None:
        """Render text content onto the stage."""
        self._current_image = _render_text(content)
        self._dirty.set()
        logger.debug("stage_show_text", length=len(content))

    async def show_code(self, code: str, language: str = "python") -> None:
        """Render syntax-highlighted code onto the stage."""
        self._current_image = _render_code(code, language)
        self._dirty.set()
        logger.debug("stage_show_code", language=language, lines=code.count("\n") + 1)

    async def show_image(self, url: str) -> None:
        """Download an image from a URL and display it on the stage."""
        import httpx as _httpx

        try:
            async with _httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                raw_image = Image.open(io.BytesIO(resp.content))
                raw_image.thumbnail((_WIDTH, _HEIGHT), Image.Resampling.LANCZOS)
                canvas = Image.new("RGB", (_WIDTH, _HEIGHT), color=_BG_COLOR)
                x_offset = (_WIDTH - raw_image.width) // 2
                y_offset = (_HEIGHT - raw_image.height) // 2
                canvas.paste(raw_image, (x_offset, y_offset))
                self._current_image = canvas
                self._dirty.set()
                logger.debug("stage_show_image", url=url)
        except Exception:
            logger.error("stage_show_image_failed", url=url, exc_info=True)
            await self.show_text(f"[Failed to load image: {url}]")

    async def show_url(self, url: str) -> None:
        """Display a URL on the stage.

        Full Playwright-based rendering is planned. For now, renders the URL as
        a styled text card so participants can see what's being referenced.
        """
        img = Image.new("RGB", (_WIDTH, _HEIGHT), color=_BG_COLOR)
        draw = ImageDraw.Draw(img)
        font = _load_font(_FONT_SIZE)
        small_font = _load_font(20)

        draw.rectangle([0, 0, _WIDTH, 4], fill=_ACCENT_COLOR)
        draw.text((_PADDING, _PADDING), "Shared Link", fill=_ACCENT_COLOR, font=font)
        draw.text((_PADDING, _PADDING + 48), url, fill=_TEXT_COLOR, font=small_font)

        self._current_image = img
        self._dirty.set()
        logger.debug("stage_show_url", url=url)

    async def clear(self) -> None:
        """Clear the stage back to a blank frame."""
        self._current_image = _render_blank()
        self._dirty.set()
        logger.debug("stage_cleared")

    # -- internal --

    async def _publish_loop(self) -> None:
        """Wait for dirty flag, then push the current image as a video frame."""
        from livekit import rtc

        while self._running:
            try:
                await asyncio.wait_for(self._dirty.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                # Publish a keepalive frame every 5s so the track stays alive
                pass

            self._dirty.clear()

            if self._video_source is None:
                break

            try:
                rgba_data = _image_to_rgba_bytes(self._current_image)
                frame = rtc.VideoFrame(
                    width=_WIDTH,
                    height=_HEIGHT,
                    type=rtc.VideoBufferType.RGBA,
                    data=rgba_data,
                )
                self._video_source.capture_frame(frame)
            except Exception:
                logger.error("stage_frame_publish_failed", exc_info=True)
