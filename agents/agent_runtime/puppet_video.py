"""PuppetVideo — an agent's FACE as a real LiveKit camera track.

WHY. Every avatar an agent has had so far was painted by the BROWSER: the
talking puppet, the portrait ladder, the WebGL face all live in the web
client, keyed off a participant that publishes only audio. That is fine for a
person looking at the call grid and useless for everything downstream of it —
an OBS browser source on ``/broadcast/{room}/{identity}`` subscribes to the
participant's CAMERA track and there is none, so the tile that looks alive in
the app is a black rectangle on the stream. The fix is to make the face a
track: render the puppet server-side, push it through ``rtc.VideoSource``, and
publish it as ``SOURCE_CAMERA`` so every consumer — grid, broadcast page,
egress — treats the agent exactly like a human on a webcam.

WHAT IT DRAWS. 640x360, ~12 fps: the agent's art centered on a flat ground, a
border in the agent's colour, a name plate bottom-left, a glow that follows
the outgoing speech level, a mouth cavity for art whose mouth line is known
(the same rig table the web puppet uses), and a slow idle bob so the tile is
visibly live when the agent is silent. Art comes from a manifest
(``PUPPET_MANIFEST``, schema ``{agent_id: {file, kind, frame, display_name}}``)
or the shipped ``agent-puppets`` set; an agent with no art gets a coloured
initial-letter tile rather than nothing.

THE GATE THAT IS NOT HERE. livekit-agents' RoomIO audio output waits for a
visible subscriber before its first frame (see ``_unblock_audio_output`` in
voice_relay/agent.py). ``rtc.VideoSource.capture_frame`` has no such wait: it
is synchronous, hands the frame to the FFI and returns, subscribers or not.
``test_puppet_video.py`` pushes frames into a real ``VideoSource`` with no
room attached and asserts a bound on the time it takes, so the class of stall
that silenced E03 cannot come back through this door unnoticed.
"""

from __future__ import annotations

import asyncio
import colorsys
import hashlib
import json
import math
import os
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import structlog
from PIL import Image, ImageDraw

from PIL import ImageFont

logger = structlog.get_logger(__name__)

WIDTH = 640
HEIGHT = 360
FPS = 12
BG_COLOR = (15, 17, 23, 255)
TEXT_COLOR = (226, 232, 240, 255)
BORDER_PX = 6
#: The art's box on the canvas (square, vertically centred, room for the plate).
ART_SIZE = 288
ART_TOP = 24

#: Speech-level → mouth mapping. Kokoro lines sit around -20 dBFS RMS with
#: consonant gaps near -40; this window turns that into a full 0..1 swing.
SILENT_DBFS = -45.0
LOUD_DBFS = -15.0
#: The mouth closes faster than it opens looks wrong; it opens instantly and
#: relaxes over this many seconds.
RELEASE_S = 0.12
#: Kokoro speech sits above the LOUD line almost continuously, so a mouth
#: driven by the absolute level hangs open for whole sentences, and a fixed
#: syllable-rate carrier flutters (Aaron, 2026-09-10: "stays open too long"
#: then "a little on the fast side"). Measured on a real af_heart line: the
#: envelope has ~3.5 syllable peaks a second; gating the mouth on the level
#: RELATIVE to its recent peak, with hysteresis and minimum dwell times,
#: follows those syllables at ~2.3 open-close cycles a second with no
#: one-frame flickers at 12 fps.
MOUTH_PEAK_WINDOW_S = 0.30
MOUTH_OPEN_REL = 0.65
MOUTH_CLOSE_REL = 0.45
MOUTH_MIN_OPEN_S = 0.12
MOUTH_MIN_CLOSED_S = 0.14
#: A flat, unbroken level (a held vowel, or a synthetic tone) never dips, so
#: the mouth takes a breath on its own after this long open.
MOUTH_MAX_OPEN_S = 0.35
#: Idle motion.
BOB_PERIOD_S = 3.2
BOB_PX = 4.0
BLINK_EVERY_S = 4.3
BLINK_LEN_S = 0.13

_MANIFEST_ENV = "PUPPET_MANIFEST"
_DIR_ENV = "PUPPET_DIR"
_DEFAULT_MANIFEST = Path.home() / "Projects" / "rook-bin" / "puppet" / "manifest.json"
#: Where the shipped art may be, in the order tried. ``/app/puppets`` is the
#: compose mount of ``web/public/agent-puppets``; the repo-relative path covers
#: a developer running the worker from a checkout.
_ART_DIRS = (
    Path("/app/puppets"),
    Path(__file__).resolve().parents[2] / "web" / "public" / "agent-puppets",
)


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """A scalable font. The container has no DejaVu unless the Dockerfile
    installs it, and Pillow's bitmap default cannot be sized, so fall back to
    Pillow's bundled scalable default (10.1+) before the bitmap one."""
    for name in ("DejaVuSans-Bold.ttf", "DejaVuSans.ttf", "Arial Bold.ttf", "Arial.ttf", "Helvetica.ttc"):
        try:
            return ImageFont.truetype(name, size)
        except (OSError, IOError):
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


# ---------------------------------------------------------------------------
# Rig table — where the mouth and eyes are, normalised top-down 0..1, ported
# from web/src/lib/puppetRig.ts so the server-side mouth lands where the
# client's does. Only art in this table gets a mouth cavity; anything else
# gets the glow, which is correct on any picture.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Ellipse:
    cx: float
    cy: float
    rx: float
    ry: float


@dataclass(frozen=True)
class Rig:
    mouth: Ellipse
    open_depth: float
    eye_l: Ellipse
    eye_r: Ellipse


DEFAULT_RIG = Rig(
    mouth=Ellipse(0.500, 0.612, 0.055, 0.017),
    open_depth=0.048,
    eye_l=Ellipse(0.432, 0.430, 0.035, 0.038),
    eye_r=Ellipse(0.578, 0.430, 0.035, 0.038),
)

_RIGS: dict[str, Rig] = {
    "majik": Rig(
        Ellipse(0.503, 0.611, 0.050, 0.017), 0.046,
        Ellipse(0.437, 0.432, 0.036, 0.038), Ellipse(0.575, 0.432, 0.036, 0.038),
    ),
    "sidekick": Rig(
        Ellipse(0.548, 0.590, 0.050, 0.017), 0.045,
        Ellipse(0.424, 0.407, 0.038, 0.042), Ellipse(0.586, 0.407, 0.038, 0.042),
    ),
    "gunny": Rig(
        Ellipse(0.505, 0.638, 0.048, 0.017), 0.042,
        Ellipse(0.428, 0.452, 0.034, 0.036), Ellipse(0.578, 0.452, 0.034, 0.036),
    ),
    "the-general": Rig(
        Ellipse(0.500, 0.625, 0.048, 0.016), 0.045,
        Ellipse(0.432, 0.446, 0.034, 0.035), Ellipse(0.575, 0.446, 0.034, 0.035),
    ),
    "rook": Rig(
        Ellipse(0.500, 0.660, 0.055, 0.017), 0.034,
        Ellipse(0.414, 0.445, 0.030, 0.028), Ellipse(0.585, 0.445, 0.030, 0.028),
    ),
}
for _id in (
    "corporal-qwen", "cpl-colophon", "perry", "prudence", "accounting-ops-cfo",
    "center-deep-lead", "contact-ops-lead", "customer-ops-lead",
    "meeting-ops-lead", "claude-code", "claude", "cmo", "code-reviewer",
    "col-finance", "harmony", "maj-recon", "meeting-ops-dev", "scout",
    "shox", "corporal-forge", "sprint", "gm-watchdog", "research-monitor",
    # Build In Public crew (2026-09-02 puppet set): drawn puppets get a mouth.
    "zen", "producer", "shafen-claude-code",
    # Full roster 2026-09-03: control room, chat companion, Shafen's antelopes.
    "control-room", "chat-companion", "dikdik", "eland", "gerenuk", "kudu", "okapi", "oryx",
    # Persephone — Aaron's main assistant seat (2026-09-03).
    "persephone",
):
    _RIGS.setdefault(_id, DEFAULT_RIG)
# Persephone v5 Grok idle: landmarks on the 512px framed tile.
_RIGS["persephone"] = Rig(
    mouth=Ellipse(0.536, 0.564, 0.028, 0.009),
    open_depth=0.028,
    eye_l=Ellipse(0.444, 0.429, 0.027, 0.027),
    eye_r=Ellipse(0.573, 0.429, 0.027, 0.027),
)
# External seats (codex, grok, chatgpt, gemini, deepseek, qwen) are VENDOR LOGO
# tiles, not faces: no rig on purpose — a mouth cavity on a logo is wrong. They
# still get the glow ring, which is correct on any picture.

#: Usernames that name a persona whose art is filed under another slug.
_ALIASES = {
    "claude-code": "rook",
    "agent-claude-code": "rook",
    # The crew seats whose Stable username is the model, not the character.
    "qwen-35b": "corporal-forge",
    "deepseek-flash": "sprint",
    "flow": "shafen-claude-code",
    # Shafen's seats are <animal>-<model>; the character is the animal.
    "dikdik-haiku": "dikdik",
    "eland-qwen": "eland",
    "gerenuk-codex": "gerenuk",
    "kudu-sonnet": "kudu",
    "okapi-grok": "okapi",
    "oryx-gpt": "oryx",
    "reddit-scout": "scout",
}


def rig_for(agent_id: str) -> Rig | None:
    return _RIGS.get(agent_id)


# ---------------------------------------------------------------------------
# Spec + manifest
# ---------------------------------------------------------------------------


@dataclass
class PuppetSpec:
    """Everything the renderer needs to know about one agent."""

    agent_id: str
    display_name: str
    frame: tuple[int, int, int]
    image: Image.Image | None = None
    rig: Rig | None = None
    kind: str = "internal"
    frames: dict[str, Image.Image] = field(default_factory=dict)


def slug_of(identity: str) -> str:
    slug = (identity or "").strip().lower()
    slug = slug[6:] if slug.startswith("agent-") else slug
    return _ALIASES.get(slug, slug) or "agent"


def hex_to_rgb(value: Any, fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6:
        return fallback
    try:
        return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))
    except ValueError:
        return fallback


def identity_color(identity: str) -> tuple[int, int, int]:
    """A stable, saturated colour per identity, so two fallback tiles differ."""
    digest = hashlib.sha1(slug_of(identity).encode()).digest()
    hue = digest[0] / 255.0
    r, g, b = colorsys.hsv_to_rgb(hue, 0.62, 0.92)
    return (int(r * 255), int(g * 255), int(b * 255))


def default_display_name(identity: str) -> str:
    bare = slug_of(identity)
    return bare.replace("-", " ").replace("_", " ").title() or "Agent"


def load_manifest(path: str | os.PathLike[str] | None = None) -> dict[str, dict[str, Any]]:
    """The puppet manifest, or ``{}``. Never raises: art is optional."""
    candidate = Path(path) if path else Path(os.getenv(_MANIFEST_ENV) or _DEFAULT_MANIFEST)
    try:
        if not candidate.is_file():
            return {}
        data = json.loads(candidate.read_text("utf-8"))
    except Exception:
        logger.warning("puppet_manifest_unreadable", path=str(candidate), exc_info=True)
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, dict):
            entry = dict(value)
            raw_file = entry.get("file")
            if isinstance(raw_file, str) and raw_file and not os.path.isabs(raw_file):
                entry["file"] = str(candidate.parent / raw_file)
            frames = entry.get("frames", {})
            if isinstance(frames, dict):
                entry["frames"] = {state: str(candidate.parent / value) if not os.path.isabs(value) else value
                                   for state, value in frames.items() if isinstance(value, str)}
            out[key.strip().lower()] = entry
    return out


def _art_dirs() -> list[Path]:
    dirs: list[Path] = []
    override = os.getenv(_DIR_ENV)
    if override:
        dirs.append(Path(override))
    dirs.extend(_ART_DIRS)
    return dirs


def find_art(slug: str, manifest: dict[str, dict[str, Any]] | None = None) -> Path | None:
    """The art file for a slug: manifest first, then the shipped set."""
    entry = (manifest or {}).get(slug)
    if entry:
        file = entry.get("file")
        if isinstance(file, str) and Path(file).is_file():
            return Path(file)
    for directory in _art_dirs():
        for ext in ("webp", "png", "jpg"):
            path = directory / f"{slug}.{ext}"
            if path.is_file():
                return path
    return None


def build_spec(
    identity: str,
    display_name: str | None = None,
    manifest: dict[str, dict[str, Any]] | None = None,
) -> PuppetSpec:
    """A renderable spec for an identity. Art is optional; a name is not."""
    slug = slug_of(identity)
    entry = (manifest or {}).get(slug) or {}
    colour = hex_to_rgb(entry.get("frame"), identity_color(identity))
    name = (
        (display_name or "").strip()
        or str(entry.get("display_name") or "").strip()
        or default_display_name(identity)
    )
    image: Image.Image | None = None
    path = find_art(slug, manifest)
    if path is not None:
        try:
            with Image.open(path) as raw:
                image = raw.convert("RGBA")
                image.load()
        except Exception:
            logger.warning("puppet_art_unreadable", path=str(path), exc_info=True)
            image = None
    frames = {}
    for state, filename in (entry.get("frames") or {}).items():
        if state not in ("idle", "talk", "talk2", "blink", "smile"):
            continue
        try:
            with Image.open(filename) as raw:
                if image is not None and raw.size == image.size:
                    frames[state] = raw.convert("RGBA")
        except (OSError, ValueError, TypeError):
            logger.warning("puppet_frame_unreadable", state=state)
    rig = rig_for(slug)
    raw_rig = entry.get("rig")
    if isinstance(raw_rig, dict):
        try:
            rig = Rig(mouth=Ellipse(**raw_rig["mouth"]), open_depth=float(raw_rig["open_depth"]),
                      eye_l=Ellipse(**raw_rig["eye_l"]), eye_r=Ellipse(**raw_rig["eye_r"]))
        except (TypeError, ValueError, KeyError):
            pass
    return PuppetSpec(
        agent_id=slug,
        display_name=name,
        frame=colour,
        image=image,
        frames=frames,
        rig=rig if image is not None else None,
        kind=str(entry.get("kind") or "internal"),
    )


# ---------------------------------------------------------------------------
# Speech level → mouth
# ---------------------------------------------------------------------------


def frame_dbfs(data: bytes | bytearray | memoryview) -> float:
    """RMS level of int16 PCM in dBFS. Silence (or no data) is -96."""
    view = memoryview(data).cast("B")
    n = len(view) // 2
    if n == 0:
        return -96.0
    try:
        import numpy as np

        samples = np.frombuffer(view, dtype="<i2", count=n).astype("float32")
        rms = float(np.sqrt(np.mean(samples * samples)))
    except Exception:
        pcm = memoryview(bytes(view[: n * 2])).cast("h")
        acc = 0.0
        for s in pcm:
            acc += float(s) * float(s)
        rms = math.sqrt(acc / n)
    if rms < 1.0:
        return -96.0
    return 20.0 * math.log10(rms / 32768.0)


def openness_from_dbfs(dbfs: float) -> float:
    """Linear 0..1 across the SILENT..LOUD window, clamped."""
    if dbfs <= SILENT_DBFS:
        return 0.0
    if dbfs >= LOUD_DBFS:
        return 1.0
    return (dbfs - SILENT_DBFS) / (LOUD_DBFS - SILENT_DBFS)


class LevelTimeline:
    """Mouth level scheduled against PLAYOUT time, not push time.

    Audio is pushed into a source faster than it plays (the source queues up
    to a few hundred ms), so reacting to a frame the moment it is pushed would
    move the mouth ahead of the voice. Each pushed frame is stamped with when
    it will actually play — the end of the previous one, or now if the queue
    ran dry — and the renderer asks for the level at the current instant.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._segments: deque[tuple[float, float, float]] = deque()
        self._play_end = 0.0
        self._last_level = 0.0
        self._last_at = 0.0

    def push(self, level: float, duration_s: float, now: float | None = None) -> None:
        now = self._clock() if now is None else now
        start = max(now, self._play_end)
        end = start + max(duration_s, 0.0)
        self._segments.append((start, end, max(0.0, min(1.0, level))))
        self._play_end = end
        # Keep a bounded history; nothing older than a second matters.
        while self._segments and self._segments[0][1] < now - 1.0:
            self._segments.popleft()

    def reset(self) -> None:
        self._segments.clear()
        self._play_end = 0.0

    def level_at(self, now: float | None = None) -> float:
        now = self._clock() if now is None else now
        current = 0.0
        for start, end, level in self._segments:
            if start <= now < end:
                current = level
                break
        # Instant attack, timed release.
        if current >= self._last_level:
            self._last_level, self._last_at = current, now
            return current
        elapsed = max(0.0, now - self._last_at)
        decayed = self._last_level * max(0.0, 1.0 - elapsed / RELEASE_S)
        value = max(current, decayed)
        if value <= current:
            self._last_level, self._last_at = current, now
        return value

    @property
    def busy_until(self) -> float:
        return self._play_end


# ---------------------------------------------------------------------------
# Renderer (pure: time + level in, RGBA frame out)
# ---------------------------------------------------------------------------


class PuppetRenderer:
    """Draws one agent. No LiveKit here — this is what the tests exercise."""

    def __init__(self, spec: PuppetSpec, *, width: int = WIDTH, height: int = HEIGHT) -> None:
        self.spec = spec
        self.width = width
        self.height = height
        self._art_box = (
            (width - ART_SIZE) // 2,
            ART_TOP,
        )
        self._art = self._prepare_art()
        self._frames = {state: self._prepare_art(art) for state, art in spec.frames.items()}
        self._last_speech = -float("inf")
        self._recent: deque[tuple[float, float]] = deque()  # (t, level) for the peak window
        self._mouth_open = False
        self._mouth_since = -float("inf")
        self._mouth_openness = 0.0
        self._base = self._render_base()
        self._font = _load_font(22)
        self._letter_font = _load_font(150)

    # -- one-time layers --

    def _prepare_art(self, image: Image.Image | None = None) -> Image.Image | None:
        image = image if image is not None else self.spec.image
        if image is None:
            return None
        art = image.copy()
        art.thumbnail((ART_SIZE, ART_SIZE), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (ART_SIZE, ART_SIZE), (0, 0, 0, 0))
        canvas.paste(art, ((ART_SIZE - art.width) // 2, (ART_SIZE - art.height) // 2), art)
        return canvas

    def _render_base(self) -> Image.Image:
        img = Image.new("RGBA", (self.width, self.height), BG_COLOR)
        draw = ImageDraw.Draw(img)
        r, g, b = self.spec.frame
        for i in range(BORDER_PX):
            draw.rectangle(
                [i, i, self.width - 1 - i, self.height - 1 - i],
                outline=(r, g, b, 255),
            )
        return img

    # -- per-frame --

    def render(self, t: float, level: float, expression: str | None = None) -> Image.Image:
        """The frame at time ``t`` (seconds) with mouth ``level`` (0..1)."""
        level = max(0.0, min(1.0, level))
        if level > 0.03: self._last_speech = t
        img = self._base.copy()
        draw = ImageDraw.Draw(img)
        bob = int(round(BOB_PX * math.sin(2 * math.pi * t / BOB_PERIOD_S)))
        x0, y0 = self._art_box
        y0 += bob
        r, g, b = self.spec.frame

        # Glow ring: the speaking signal every picture supports.
        if level > 0.02:
            pad = int(6 + 14 * level)
            alpha = int(60 + 160 * level)
            glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
            gd = ImageDraw.Draw(glow)
            gd.rounded_rectangle(
                [x0 - pad, y0 - pad, x0 + ART_SIZE + pad, y0 + ART_SIZE + pad],
                radius=24,
                outline=(r, g, b, alpha),
                width=max(2, pad // 2),
            )
            img.alpha_composite(glow)

        if self._art is not None:
            state = self.frame_state(t, level, expression)
            art = self._frames.get(state)
            img.alpha_composite(art if art is not None else self._art, (x0, y0))
            if art is None:
                self._draw_rig(draw, x0, y0, t, level)
        else:
            self._draw_letter(draw, x0, y0, level)

        self._draw_plate(draw, level)
        return img

    def mouth_gate(self, t: float, level: float) -> float:
        """Advance the mouth state to time ``t`` and return its openness 0..1.

        Open when the level rises above MOUTH_OPEN_REL of its recent peak,
        close when it falls under MOUTH_CLOSE_REL, each state held at least
        its minimum dwell so 12 fps never shows a one-frame flicker; a long
        unbroken open takes a breath at MOUTH_MAX_OPEN_S. Silence closes it
        at once. Idempotent for a repeated ``t``.
        """
        level = max(0.0, min(1.0, level))
        while self._recent and self._recent[0][0] < t - MOUTH_PEAK_WINDOW_S:
            self._recent.popleft()
        if not self._recent or self._recent[-1][0] < t:
            self._recent.append((t, level))
        peak = max(l for _, l in self._recent)
        rel = level / peak if peak > 0.0 else 0.0
        held = t - self._mouth_since
        if level <= 0.03:
            if self._mouth_open:
                self._mouth_open, self._mouth_since = False, t
            self._mouth_openness = 0.0
            return 0.0
        if self._mouth_open:
            if (rel < MOUTH_CLOSE_REL and held >= MOUTH_MIN_OPEN_S) or held >= MOUTH_MAX_OPEN_S:
                self._mouth_open, self._mouth_since = False, t
        elif rel > MOUTH_OPEN_REL and held >= MOUTH_MIN_CLOSED_S:
            self._mouth_open, self._mouth_since = True, t
        self._mouth_openness = level * rel if self._mouth_open else 0.0
        return self._mouth_openness

    def frame_state(self, t: float, level: float, expression: str | None = None) -> str:
        """Which expression frame to show at ``t`` for speech ``level``.

        Priority: an explicit expression → a blink → the gated mouth (``talk``
        wide, ``talk2`` part-open, ``idle`` closed between syllables) → a
        short smile after the last line → idle. Frames the art does not have
        fall through to the next rung, so a face with only ``idle`` never
        picks a missing state.
        """
        openness = self.mouth_gate(t, level)
        if expression in self._frames:
            return expression
        if t % BLINK_EVERY_S < BLINK_LEN_S and "blink" in self._frames:
            return "blink"
        if openness > 0.5 and "talk" in self._frames:
            return "talk"
        if openness > 0.0 and "talk2" in self._frames:
            return "talk2"
        if level > 0.03:
            return "idle"  # closed between syllables, mid-line
        if 0 <= t - self._last_speech < 0.7 and "smile" in self._frames:
            return "smile"
        return "idle"

    def _draw_rig(self, draw: ImageDraw.ImageDraw, x0: int, y0: int, t: float, level: float) -> None:
        rig = self.spec.rig
        if rig is None:
            return
        # Mouth cavity grows DOWNWARD from the closed line, like the web shader.
        openness = self._mouth_openness
        if openness > 0.03:
            m = rig.mouth
            cx = x0 + m.cx * ART_SIZE
            top = y0 + m.cy * ART_SIZE
            rx = m.rx * ART_SIZE
            depth = rig.open_depth * ART_SIZE * openness
            draw.ellipse(
                [cx - rx, top - m.ry * ART_SIZE * 0.5, cx + rx, top + depth],
                fill=(14, 10, 16, 235),
            )
        # Blink: a short lid over each eye every few seconds.
        phase = t % BLINK_EVERY_S
        if phase < BLINK_LEN_S:
            for eye in (rig.eye_l, rig.eye_r):
                cx = x0 + eye.cx * ART_SIZE
                cy = y0 + eye.cy * ART_SIZE
                rx = eye.rx * ART_SIZE * 1.15
                ry = eye.ry * ART_SIZE * 1.15
                draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(246, 246, 250, 255))
                draw.line([cx - rx, cy, cx + rx, cy], fill=(20, 20, 24, 255), width=3)

    def _draw_letter(self, draw: ImageDraw.ImageDraw, x0: int, y0: int, level: float) -> None:
        r, g, b = self.spec.frame
        draw.rounded_rectangle(
            [x0, y0, x0 + ART_SIZE, y0 + ART_SIZE],
            radius=32,
            fill=(max(0, r // 3), max(0, g // 3), max(0, b // 3), 255),
            outline=(r, g, b, 255),
            width=4,
        )
        letter = (self.spec.display_name[:1] or "?").upper()
        try:
            bbox = draw.textbbox((0, 0), letter, font=self._letter_font)
            w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
            draw.text(
                (x0 + (ART_SIZE - w) / 2 - bbox[0], y0 + (ART_SIZE - h) / 2 - bbox[1]),
                letter,
                fill=TEXT_COLOR,
                font=self._letter_font,
            )
        except Exception:
            draw.text((x0 + ART_SIZE // 3, y0 + ART_SIZE // 3), letter, fill=TEXT_COLOR)
        # A mouth bar under the letter, so the fallback still visibly talks.
        bar_w = int(40 + 120 * level)
        cx = x0 + ART_SIZE // 2
        draw.rounded_rectangle(
            [cx - bar_w // 2, y0 + ART_SIZE - 44, cx + bar_w // 2, y0 + ART_SIZE - 30],
            radius=7,
            fill=(r, g, b, 255) if level > 0.03 else (r // 2, g // 2, b // 2, 255),
        )

    def _draw_plate(self, draw: ImageDraw.ImageDraw, level: float) -> None:
        name = self.spec.display_name
        try:
            bbox = draw.textbbox((0, 0), name, font=self._font)
            tw = bbox[2] - bbox[0]
        except Exception:
            tw = 8 * len(name)
        px, py = 18, self.height - 48
        draw.rounded_rectangle(
            [px, py, px + tw + 44, py + 32],
            radius=8,
            fill=(0, 0, 0, 150),
        )
        r, g, b = self.spec.frame
        dot = (r, g, b, 255) if level > 0.03 else (90, 96, 110, 255)
        draw.ellipse([px + 12, py + 11, px + 22, py + 21], fill=dot)
        draw.text((px + 32, py + 4), name, fill=TEXT_COLOR, font=self._font)

    @staticmethod
    def to_rgba_bytes(img: Image.Image) -> bytes:
        return img.tobytes()


# ---------------------------------------------------------------------------
# The track
# ---------------------------------------------------------------------------


@dataclass
class PuppetVideoStats:
    frames: int = 0
    last_level: float = 0.0
    started_at: float = 0.0
    errors: int = 0
    log: list[str] = field(default_factory=list)


class PuppetVideo:
    """Renders a puppet and publishes it as this participant's camera.

    ``start(room)`` publishes immediately — unlike the stage track, this one is
    never blank, so there is no "camera pointed at a wall" to hide. ``feed``
    takes every outgoing audio frame and schedules the mouth against playout.
    """

    def __init__(
        self,
        spec: PuppetSpec,
        *,
        fps: int = FPS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.spec = spec
        self.renderer = PuppetRenderer(spec)
        self.levels = LevelTimeline(clock)
        self.stats = PuppetVideoStats()
        self._fps = max(1, fps)
        self._clock = clock
        self._room: Any = None
        self._source: Any = None
        self._track: Any = None
        self._publication: Any = None
        self._task: asyncio.Task[None] | None = None
        self._running = False

    # -- audio in --

    def feed(self, frame: Any) -> None:
        """Account for one outgoing ``rtc.AudioFrame``. Sync; never raises."""
        try:
            data = getattr(frame, "data", None)
            if data is None:
                return
            rate = int(getattr(frame, "sample_rate", 0) or 0)
            per_channel = int(getattr(frame, "samples_per_channel", 0) or 0)
            duration = (per_channel / rate) if rate and per_channel else 0.02
            level = openness_from_dbfs(frame_dbfs(data))
            self.levels.push(level, duration)
            self.stats.last_level = level
        except Exception:
            self.stats.errors += 1

    # -- lifecycle --

    async def start(self, room: Any) -> None:
        if self._running:
            return
        from livekit import rtc

        self._room = room
        self._source = rtc.VideoSource(self.renderer.width, self.renderer.height)
        self._track = rtc.LocalVideoTrack.create_video_track(
            "puppet", self._source
        )
        options = rtc.TrackPublishOptions(
            source=rtc.TrackSource.SOURCE_CAMERA,
            simulcast=False,
        )
        self._publication = await room.local_participant.publish_track(self._track, options)
        self._running = True
        self.stats.started_at = self._clock()
        self._task = asyncio.create_task(
            self._loop(), name=f"puppet-video:{self.spec.agent_id}"
        )
        logger.info(
            "puppet_video_published",
            agent=self.spec.agent_id,
            art=self.spec.image is not None,
            rig=self.spec.rig is not None,
            size=f"{self.renderer.width}x{self.renderer.height}@{self._fps}",
        )

    def unmute(self) -> bool:
        """Compatibility with the moderator unmute path: a video track that got
        server-muted comes back the same way the mic does."""
        track = self._track
        try:
            if track is not None and getattr(track, "muted", False):
                track.unmute()
                return True
        except Exception:
            logger.debug("puppet_video_unmute_failed", exc_info=True)
        return False

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        room, track = self._room, self._track
        if room is not None and track is not None:
            try:
                from livekit import rtc

                if getattr(room, "connection_state", None) == rtc.ConnectionState.CONN_CONNECTED:
                    await asyncio.wait_for(
                        room.local_participant.unpublish_track(track.sid), timeout=3.0
                    )
            except Exception:
                logger.debug("puppet_video_unpublish_failed", exc_info=True)
        self._track = None
        self._source = None
        self._room = None

    # -- the frame loop --

    def push_frame(self, t: float | None = None) -> bool:
        """Render and hand ONE frame to the source. Sync; True on success.

        Split out of the loop so a test can drive it without an event loop and
        time exactly what a frame costs.
        """
        if self._source is None:
            return False
        from livekit import rtc

        now = self._clock()
        t = (now - self.stats.started_at) if t is None else t
        level = self.levels.level_at(now)
        try:
            img = self.renderer.render(t, level)
            frame = rtc.VideoFrame(
                self.renderer.width,
                self.renderer.height,
                rtc.VideoBufferType.RGBA,
                self.renderer.to_rgba_bytes(img),
            )
            self._source.capture_frame(frame)
            self.stats.frames += 1
            self.stats.last_level = level
            return True
        except Exception:
            self.stats.errors += 1
            if self.stats.errors <= 3:
                logger.warning("puppet_video_frame_failed", exc_info=True)
            return False

    async def _loop(self) -> None:
        period = 1.0 / self._fps
        next_at = self._clock()
        while self._running:
            self.push_frame()
            next_at += period
            delay = next_at - self._clock()
            if delay <= 0:
                # Fell behind (a slow render); resync rather than spin.
                next_at = self._clock()
                delay = 0.0
            await asyncio.sleep(delay)


def tap_audio_output(session: Any, sink: Callable[[Any], None]) -> bool:
    """Wire ``sink`` to every frame the session's audio output sends.

    Walks the same output chain ``_unblock_audio_output`` does and wraps the
    HEAD's ``capture_frame`` — every ``say()`` (session TTS or supplied audio)
    passes through it. Returns False, leaving the session untouched, when the
    chain is not shaped as expected.
    """
    out = getattr(getattr(session, "output", None), "audio", None)
    if out is None:
        return False
    original = getattr(out, "capture_frame", None)
    if not callable(original):
        return False
    if getattr(out, "_puppet_tapped", False):
        return True

    async def tapped(frame: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            sink(frame)
        except Exception:
            pass
        return await original(frame, *args, **kwargs)

    try:
        out.capture_frame = tapped  # instance attribute shadows the method
        out._puppet_tapped = True
    except Exception:
        return False
    return True
