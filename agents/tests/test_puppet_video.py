"""PuppetVideo — the agent's face as a real camera track.

What these prove, in the order the feature can fail:

  * the frame is the size and format the SFU is told it is (640x360 RGBA);
  * speech level maps to a mouth monotonically and inside 0..1, and the
    picture visibly CHANGES with it — a face that never moves is the black
    rectangle again, only prettier;
  * the mouth follows PLAYOUT time, not push time;
  * a subscriber-less ``rtc.VideoSource`` does not stall — the audio gate that
    silenced E03 has no twin here (measured against the real library, not a
    fake);
  * an agent with no art still gets a tile, and the manifest is consumed when
    it exists and ignored when it is junk.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase

import numpy as np
from PIL import Image

from agent_runtime.puppet_video import (
    FPS,
    HEIGHT,
    LOUD_DBFS,
    SILENT_DBFS,
    WIDTH,
    LevelTimeline,
    PuppetRenderer,
    PuppetSpec,
    PuppetVideo,
    build_spec,
    frame_dbfs,
    identity_color,
    load_manifest,
    openness_from_dbfs,
    slug_of,
    tap_audio_output,
)


def _art(colour=(240, 240, 240, 255)) -> Image.Image:
    img = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    from PIL import ImageDraw

    ImageDraw.Draw(img).ellipse([60, 60, 452, 452], fill=colour)
    return img


def _spec(with_art: bool = True, rig: bool = True) -> PuppetSpec:
    from agent_runtime.puppet_video import DEFAULT_RIG

    return PuppetSpec(
        agent_id="grok",
        display_name="Grok",
        frame=(89, 234, 191),
        image=_art() if with_art else None,
        rig=DEFAULT_RIG if (with_art and rig) else None,
    )


def _pcm(dbfs: float, samples: int = 480) -> bytes:
    amp = 32767.0 * (10 ** (dbfs / 20.0)) if dbfs > -96 else 0.0
    t = np.arange(samples) / 24000.0
    # RMS of a sine is amp/sqrt(2); scale so the RMS lands on `dbfs`.
    wave = np.sqrt(2.0) * amp * np.sin(2 * np.pi * 440.0 * t)
    return np.clip(wave, -32768, 32767).astype("<i2").tobytes()


class FrameShapeTests(TestCase):
    def test_frame_is_640x360_rgba(self) -> None:
        img = PuppetRenderer(_spec()).render(0.0, 0.0)
        self.assertEqual(img.size, (WIDTH, HEIGHT))
        self.assertEqual(img.mode, "RGBA")
        self.assertEqual(len(PuppetRenderer.to_rgba_bytes(img)), WIDTH * HEIGHT * 4)

    def test_frame_has_a_picture_by_the_web_clients_own_test(self) -> None:
        """The web tile parks a video whose luma spread < 4 and mean < 40 as
        'blank' (web/src/lib/videoFrame.ts). A puppet frame must clear that
        or the browser hides it behind the old client-side face."""
        img = PuppetRenderer(_spec()).render(0.0, 0.0).convert("L")
        arr = np.asarray(img, dtype="float32")
        self.assertGreater(float(arr.std()), 4.0)

    def test_render_is_cheap_enough_for_the_frame_rate(self) -> None:
        r = PuppetRenderer(_spec())
        t0 = time.perf_counter()
        for i in range(24):
            r.render(i / FPS, (i % 5) / 4)
        per_frame = (time.perf_counter() - t0) / 24
        # 12 fps is 83 ms a frame; a render must be a small fraction of that.
        self.assertLess(per_frame, 0.03, f"{per_frame*1000:.1f} ms/frame")


class MouthMappingTests(TestCase):
    def test_openness_is_monotonic_and_clamped(self) -> None:
        self.assertEqual(openness_from_dbfs(-96.0), 0.0)
        self.assertEqual(openness_from_dbfs(SILENT_DBFS), 0.0)
        self.assertEqual(openness_from_dbfs(LOUD_DBFS), 1.0)
        self.assertEqual(openness_from_dbfs(0.0), 1.0)
        last = -1.0
        for dbfs in range(-60, 0, 3):
            value = openness_from_dbfs(float(dbfs))
            self.assertGreaterEqual(value, last)
            self.assertTrue(0.0 <= value <= 1.0)
            last = value
        self.assertAlmostEqual(openness_from_dbfs((SILENT_DBFS + LOUD_DBFS) / 2), 0.5)

    def test_frame_dbfs_measures_real_pcm(self) -> None:
        self.assertEqual(frame_dbfs(b""), -96.0)
        self.assertEqual(frame_dbfs(bytes(960)), -96.0)
        self.assertAlmostEqual(frame_dbfs(_pcm(-20.0)), -20.0, delta=0.6)
        self.assertAlmostEqual(frame_dbfs(_pcm(-40.0)), -40.0, delta=0.6)

    def test_the_picture_changes_with_the_mouth(self) -> None:
        r = PuppetRenderer(_spec())
        closed = np.asarray(r.render(0.0, 0.0).convert("L"), dtype="int16")
        open_ = np.asarray(r.render(0.0, 1.0).convert("L"), dtype="int16")
        changed = int((np.abs(open_ - closed) > 8).sum())
        # Mouth cavity + glow ring: thousands of pixels, not a rounding error.
        self.assertGreater(changed, 2000)

    def test_the_letter_tile_also_talks(self) -> None:
        r = PuppetRenderer(_spec(with_art=False))
        closed = np.asarray(r.render(0.0, 0.0).convert("L"), dtype="int16")
        open_ = np.asarray(r.render(0.0, 1.0).convert("L"), dtype="int16")
        self.assertGreater(int((np.abs(open_ - closed) > 8).sum()), 1000)

    def test_idle_motion_moves_the_picture(self) -> None:
        r = PuppetRenderer(_spec())
        a = np.asarray(r.render(0.0, 0.0).convert("L"), dtype="int16")
        b = np.asarray(r.render(0.8, 0.0).convert("L"), dtype="int16")
        self.assertGreater(int((np.abs(a - b) > 8).sum()), 200)


class LevelTimelineTests(TestCase):
    def test_level_is_scheduled_at_playout_not_push(self) -> None:
        now = [100.0]
        tl = LevelTimeline(clock=lambda: now[0])
        # Ten 20 ms frames pushed in one burst: they play back to back.
        for i in range(10):
            tl.push(1.0 if i >= 5 else 0.0, 0.02)
        self.assertEqual(tl.level_at(100.0), 0.0)
        self.assertEqual(tl.level_at(100.05), 0.0)
        self.assertEqual(tl.level_at(100.11), 1.0)
        self.assertAlmostEqual(tl.busy_until, 100.2)

    def test_release_decays_after_the_last_voiced_frame(self) -> None:
        now = [0.0]
        tl = LevelTimeline(clock=lambda: now[0])
        tl.push(1.0, 0.02)
        self.assertEqual(tl.level_at(0.01), 1.0)
        mid = tl.level_at(0.02 + 0.06)
        self.assertTrue(0.0 < mid < 1.0, mid)
        self.assertEqual(tl.level_at(0.02 + 0.5), 0.0)


class NoSubscriberTests(TestCase):
    """The stall class that silenced E03, checked against the REAL rtc source.

    RoomIO's audio output awaits a visible subscriber before frame one. The
    puppet pushes into ``rtc.VideoSource`` directly, whose ``capture_frame``
    is synchronous. This test creates a VideoSource with no room, no track
    and no subscriber and pushes 3 seconds' worth of frames through the
    puppet's own frame path; if any of them blocked, the bound fails.
    """

    def test_frames_push_without_a_room_or_subscriber(self) -> None:
        try:
            from livekit import rtc
        except Exception as exc:  # pragma: no cover - environment
            self.skipTest(f"livekit.rtc unavailable: {exc}")
        pv = PuppetVideo(_spec())
        pv._source = rtc.VideoSource(WIDTH, HEIGHT)
        pv.stats.started_at = time.monotonic()
        n = FPS * 3
        t0 = time.perf_counter()
        ok = [pv.push_frame() for _ in range(n)]
        elapsed = time.perf_counter() - t0
        self.assertTrue(all(ok))
        self.assertEqual(pv.stats.frames, n)
        self.assertEqual(pv.stats.errors, 0)
        # 3 s of video pushed in far less than 3 s: nothing waited on anyone.
        self.assertLess(elapsed, 1.5, f"{elapsed:.2f}s for {n} frames")

    def test_feed_never_raises_on_garbage(self) -> None:
        pv = PuppetVideo(_spec())
        pv.feed(None)
        pv.feed(SimpleNamespace(data=b"\x01"))
        pv.feed(SimpleNamespace(data=_pcm(-20.0), sample_rate=24000, samples_per_channel=480))
        self.assertGreater(pv.stats.last_level, 0.5)


class AudioTapTests(TestCase):
    def test_tap_sees_every_frame_and_forwards_it(self) -> None:
        import asyncio

        seen: list[object] = []
        forwarded: list[object] = []

        class Out:
            async def capture_frame(self, frame):
                forwarded.append(frame)

        session = SimpleNamespace(output=SimpleNamespace(audio=Out()))
        self.assertTrue(tap_audio_output(session, seen.append))
        self.assertTrue(tap_audio_output(session, seen.append))  # idempotent
        asyncio.run(session.output.audio.capture_frame("f1"))
        self.assertEqual(seen, ["f1"])
        self.assertEqual(forwarded, ["f1"])

    def test_tap_declines_an_unexpected_chain(self) -> None:
        self.assertFalse(tap_audio_output(SimpleNamespace(output=None), lambda f: None))
        self.assertFalse(tap_audio_output(object(), lambda f: None))


class SpecAndManifestTests(TestCase):
    def test_slug_strips_the_prefix_and_aliases_rook(self) -> None:
        self.assertEqual(slug_of("agent-grok"), "grok")
        self.assertEqual(slug_of("agent-claude-code"), "rook")
        self.assertEqual(slug_of(""), "agent")

    def test_model_named_seats_resolve_to_their_characters(self) -> None:
        """The crew seats whose Stable username is the MODEL wear the
        character's art (same table as web/src/lib/puppetRig.ts ALIASES)."""
        self.assertEqual(slug_of("agent-qwen-35b"), "corporal-forge")
        self.assertEqual(slug_of("agent-deepseek-flash"), "sprint")
        self.assertEqual(slug_of("agent-flow"), "shafen-claude-code")
        self.assertEqual(slug_of("agent-shafen-claude-code"), "shafen-claude-code")

    def test_no_art_still_yields_a_named_coloured_tile(self) -> None:
        # Zen has shipped art since the 2026-09-02 crew set; a made-up seat is
        # the honest "no art" case now.
        spec = build_spec("agent-nobody-yet", None, manifest={})
        self.assertIsNone(spec.image)
        self.assertEqual(spec.display_name, "Nobody Yet")
        self.assertEqual(spec.frame, identity_color("agent-nobody-yet"))
        self.assertNotEqual(identity_color("agent-nobody-yet"), identity_color("agent-grok"))
        img = PuppetRenderer(spec).render(0.0, 0.5)
        self.assertEqual(img.size, (WIDTH, HEIGHT))

    def test_manifest_supplies_art_name_and_frame(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            art = Path(tmp) / "newbie.png"
            _art((10, 200, 10, 255)).save(art)
            manifest = Path(tmp) / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "newbie": {
                            "file": "newbie.png",
                            "kind": "external",
                            "frame": "#ff8800",
                            "display_name": "Newbie (xAI)",
                        }
                    }
                )
            )
            loaded = load_manifest(manifest)
            self.assertEqual(loaded["newbie"]["file"], str(art))
            spec = build_spec("agent-newbie", None, loaded)
            self.assertIsNotNone(spec.image)
            self.assertEqual(spec.display_name, "Newbie (xAI)")
            self.assertEqual(spec.frame, (255, 136, 0))
            self.assertEqual(spec.kind, "external")
            self.assertIsNone(spec.rig)  # unknown art gets no mouth cavity

    def test_junk_manifest_is_empty_not_fatal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "manifest.json"
            bad.write_text("{not json")
            self.assertEqual(load_manifest(bad), {})
            self.assertEqual(load_manifest(Path(tmp) / "missing.json"), {})

    def test_shipped_art_is_found_when_the_checkout_has_it(self) -> None:
        """The repo's web/public/agent-puppets set is the default art source
        (mounted at /app/puppets in the container)."""
        shipped = Path(__file__).resolve().parents[2] / "web" / "public" / "agent-puppets" / "majik.webp"
        if not shipped.is_file():
            self.skipTest("no shipped art in this checkout")
        old = os.environ.pop("PUPPET_DIR", None)
        try:
            spec = build_spec("agent-majik", None, {})
        finally:
            if old is not None:
                os.environ["PUPPET_DIR"] = old
        self.assertIsNotNone(spec.image)
        self.assertIsNotNone(spec.rig)

    def test_shipped_crew_manifest_covers_every_show_seat(self) -> None:
        """web/public/agent-puppets/manifest.json (mounted at /app/puppets,
        PUPPET_MANIFEST in compose) is the 2026-09-02 crew set: every seat in
        the show room gets art, the manifest's name and frame, and a mouth only
        when the art is a drawn face."""
        puppets = Path(__file__).resolve().parents[2] / "web" / "public" / "agent-puppets"
        manifest_path = puppets / "manifest.json"
        if not manifest_path.is_file():
            self.skipTest("no shipped manifest in this checkout")
        manifest = load_manifest(manifest_path)
        old = os.environ.pop("PUPPET_DIR", None)
        try:
            crew = {
                "agent-claude-code": ("Rook", True),
                "agent-majik": ("Majik Mane", True),
                "agent-qwen-35b": ("Corporal Forge", True),
                "agent-deepseek-flash": ("Sprint", True),
                "agent-zen": ("Zen", True),
                "agent-producer": ("Producer", True),
                "agent-shox": ("ShOX", True),
                "agent-shafen-claude-code": ("Flow", True),
                "agent-codex": ("Codex", False),
                "agent-grok": ("Grok", False),
                "agent-chatgpt": ("ChatGPT", False),
                "agent-control-room": ("Control Room", True),
                "agent-chat-companion": ("Chat Companion", True),
                "agent-dikdik-haiku": ("Dikdik", True),
                "agent-eland-qwen": ("Eland", True),
                "agent-gerenuk-codex": ("Gerenuk", True),
                "agent-kudu-sonnet": ("Kudu", True),
                "agent-okapi-grok": ("Okapi", True),
                "agent-oryx-gpt": ("Oryx", True),
            }
            amber, grey = (245, 166, 35), (138, 143, 152)
            for identity, (name, drawn) in crew.items():
                spec = build_spec(identity, None, manifest)
                self.assertIsNotNone(spec.image, identity)
                self.assertEqual(spec.display_name, name, identity)
                self.assertEqual(spec.kind, "internal" if drawn else "external", identity)
                self.assertEqual(spec.frame, amber if drawn else grey, identity)
                if drawn:
                    self.assertIsNotNone(spec.rig, f"{identity} is a face and needs a mouth")
                else:
                    self.assertIsNone(spec.rig, f"{identity} is a logo tile: no mouth")
        finally:
            if old is not None:
                os.environ["PUPPET_DIR"] = old
