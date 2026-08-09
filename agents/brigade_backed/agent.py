"""BrigadeBackedAgent — Stable agent powered by any Brigade agent.

Reads `brigade_agent_id` from room metadata and acts as that Brigade
agent. All persona, memory, delegation, and tool intelligence comes
from Brigade; LiveKit handles voice, room presence, and (eventually)
video tracks.

Migrated to livekit-agents 1.5+ Agent + AgentSession API.
Voice path active when STT/TTS plugins are configured. Otherwise
text-only via the data-channel ChatHandler.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx
import structlog


def asyncio_now() -> float:
    """Monotonic seconds — for chunk-flush throttling."""
    return time.monotonic()


_ = asyncio  # keep import (used via httpx)
from livekit.agents import Agent, AgentSession, JobContext

from agent_runtime.base import StableAgent
from agent_runtime.transcript_publisher import (
    TranscriptPublisher,
    VoiceHistoryPersister,
    _agent_display_name,
)
from agent_runtime.brigade_llm import build_brigade_llm
from agent_runtime.config import AgentSettings, api_path, get_agent_settings
from agent_runtime.voice_transcripts import VoiceTranscriptResponder

logger = structlog.get_logger(__name__)


class _CaptioningAgent(Agent):
    """Agent that tees its streaming reply text into the live caption publisher.

    ``transcription_node`` is the pipeline node livekit-agents 1.6 feeds the
    agent's reply text through as it is produced/spoken -- the LLM token stream,
    or TTS-aligned word timings when the TTS advertises aligned transcripts (see
    livekit/agents/voice/agent_activity.py). The default node is a pure
    passthrough; we override it to ADDITIONALLY publish a growing interim caption
    line ("as it reads"), while still yielding every delta through UNCHANGED so
    the built-in transcription forwarding and TTS pacing are unaffected.

    Purely additive and never raises into the voice loop: the tee is guarded and
    only ``push`` is wrapped; cancellation/interruption propagate normally
    through the untouched ``async for`` / ``yield``.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._caption_publisher: TranscriptPublisher | None = None

    def set_caption_publisher(
        self, publisher: TranscriptPublisher | None
    ) -> None:
        self._caption_publisher = publisher

    async def transcription_node(self, text, model_settings):  # type: ignore[override]
        pub = self._caption_publisher
        if pub is None:
            async for delta in text:
                yield delta
            return
        try:
            interim = pub.begin_agent_interim()
        except Exception:
            logger.debug("caption_interim_begin_failed", exc_info=True)
            interim = None
        async for delta in text:
            if interim is not None:
                # push() is fully guarded and never raises.
                interim.push(delta)
            yield delta


class BrigadeBackedAgent(StableAgent):
    """Generic agent whose personality + tools + memory come from Brigade."""

    agent_type: str = "brigade"

    def __init__(self, settings: AgentSettings | None = None) -> None:
        super().__init__(settings)
        self._brigade_agent_id: str = "the-general"
        self._tts_provider: str = "kokoro"
        self._stt_provider: str = "whisper"
        self._session: AgentSession | None = None
        self._lk_agent: Agent | None = None
        self._transcript: TranscriptPublisher | None = None
        self._voice_history: VoiceHistoryPersister | None = None
        self._voice_responder: VoiceTranscriptResponder | None = None

    async def on_message(self, message: dict[str, Any]) -> None:
        """Reply to a chat by streaming from Brigade and posting incrementally.

        Lifecycle:
            1. Emit "agent_typing: true" (UI shows "X is thinking…").
            2. POST an empty placeholder message to backend → get message_id.
            3. Stream Brigade's chat/completions, accumulating text.
            4. PATCH the placeholder ~every 200ms so the chat updates live.
            5. On completion, finalize PATCH and clear typing.
        """
        content = (message.get("content") or "").strip()
        if not content:
            return

        cfg = self._settings
        url = (cfg.brigade_base_url or "").rstrip("/") + "/chat/completions"
        if not cfg.brigade_base_url or not cfg.brigade_api_key:
            logger.warning("on_message_brigade_unconfigured")
            return

        user_id = self._human_user_id or self.identity

        # 1. Typing on
        await self._post_typing(True)

        # 2. Empty placeholder message (so we have an id to PATCH).
        msg_id = await self._post_chat_message("…")
        if not msg_id:
            await self._post_typing(False)
            return

        # 3 & 4. Stream chunks
        accumulated = ""
        last_flush = 0.0
        FLUSH_EVERY = 0.18  # seconds

        try:
            payload = {
                "model": self._brigade_agent_id,
                "messages": [{"role": "user", "content": content}],
                "user": user_id,
                "stream": True,
            }
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(120.0, connect=10.0)
            ) as http:
                async with http.stream(
                    "POST",
                    url,
                    headers={
                        "Authorization": f"Bearer {cfg.brigade_api_key}",
                        "Content-Type": "application/json",
                        "Accept": "text/event-stream",
                    },
                    json=payload,
                ) as resp:
                    if resp.status_code >= 300:
                        text_err = (await resp.aread()).decode("utf-8", "replace")
                        logger.warning(
                            "brigade_stream_http_error",
                            status=resp.status_code,
                            body=text_err[:300],
                        )
                        accumulated = (
                            f"_(Brigade returned {resp.status_code}; "
                            "check backend logs.)_"
                        )
                    else:
                        async for line in resp.aiter_lines():
                            if not line or not line.startswith("data:"):
                                continue
                            data = line[5:].strip()
                            if data == "[DONE]":
                                break
                            try:
                                obj = json.loads(data)
                                delta = (
                                    obj.get("choices", [{}])[0]
                                    .get("delta", {})
                                    .get("content", "")
                                )
                            except Exception:
                                continue
                            if not delta:
                                continue
                            accumulated += delta
                            now = asyncio_now()
                            if now - last_flush >= FLUSH_EVERY:
                                await self._patch_chat_message(
                                    msg_id, accumulated, finalize=False
                                )
                                last_flush = now
        except Exception as exc:
            logger.error("brigade_stream_failed", error=str(exc), exc_info=True)
            if not accumulated:
                accumulated = (
                    f"_(I had trouble reaching Brigade: {exc.__class__.__name__})_"
                )

        # 5. Final flush + typing off
        if not accumulated.strip():
            accumulated = "_(empty reply)_"
        await self._patch_chat_message(msg_id, accumulated, finalize=True)
        await self._post_typing(False)
        logger.info(
            "brigade_reply",
            agent_id=self._brigade_agent_id,
            chars=len(accumulated),
        )

    async def on_transcript(self, message: dict[str, Any]) -> None:
        """Feed browser-STT caption payloads to the fallback responder.

        The responder classifies (interim/agent/dup) and groups; only grouped
        HUMAN finals can become replies, and only when the session's own STT
        is silent. No responder (voice-only wiring failed, or replies disabled
        via VOICE_TRANSCRIPT_REPLIES_ENABLED) → captions stay display-only.
        """
        responder = self._voice_responder
        if responder is None:
            return
        await responder.on_transcript(message)

    async def _shutdown_steps(self) -> None:
        responder = self._voice_responder
        self._voice_responder = None
        if responder is not None:
            try:
                await responder.aclose()
            except Exception:
                logger.debug("voice_responder_close_failed", exc_info=True)
        await super()._shutdown_steps()

    async def _post_chat_message(self, content: str) -> str | None:
        """Persist a reply via the internal agent-messages endpoint.

        Returns the new message's id so callers can stream updates via
        _patch_chat_message.
        """
        secret = self._settings.internal_agent_secret or self._settings.livekit_api_secret
        if not secret:
            logger.warning("post_chat_no_secret")
            return None
        try:
            async with httpx.AsyncClient(
                base_url=self._settings.stable_backend_url,
                timeout=httpx.Timeout(30.0, connect=5.0),
            ) as http:
                resp = await http.post(
                    api_path("internal/agent-messages"),
                    headers={"Authorization": f"Bearer {secret}"},
                    json={
                        "livekit_room_name": self._room_name,
                        "brigade_agent_id": self._brigade_agent_id,
                        "content": content,
                    },
                )
                if resp.status_code >= 300:
                    logger.warning(
                        "post_chat_http_error",
                        status=resp.status_code,
                        body=resp.text[:300],
                    )
                    return None
                return (resp.json() or {}).get("id")
        except Exception:
            logger.error("post_chat_failed", exc_info=True)
            return None

    async def _patch_chat_message(
        self, message_id: str, content: str, finalize: bool
    ) -> None:
        """Stream-update an existing agent message in place."""
        secret = self._settings.internal_agent_secret or self._settings.livekit_api_secret
        if not secret:
            return
        try:
            async with httpx.AsyncClient(
                base_url=self._settings.stable_backend_url,
                timeout=httpx.Timeout(15.0, connect=5.0),
            ) as http:
                resp = await http.patch(
                    api_path(f"internal/agent-messages/{message_id}"),
                    headers={"Authorization": f"Bearer {secret}"},
                    json={"content": content, "finalize": finalize},
                )
                if resp.status_code >= 300:
                    logger.debug(
                        "patch_chat_http_error",
                        status=resp.status_code,
                        body=resp.text[:200],
                    )
        except Exception:
            logger.debug("patch_chat_failed", exc_info=True)

    async def _post_typing(self, typing: bool) -> None:
        """Broadcast a typing/working indicator over LiveKit data."""
        secret = self._settings.internal_agent_secret or self._settings.livekit_api_secret
        if not secret:
            return
        try:
            async with httpx.AsyncClient(
                base_url=self._settings.stable_backend_url,
                timeout=httpx.Timeout(10.0, connect=5.0),
            ) as http:
                await http.post(
                    api_path("internal/agent-typing"),
                    headers={"Authorization": f"Bearer {secret}"},
                    json={
                        "livekit_room_name": self._room_name,
                        "brigade_agent_id": self._brigade_agent_id,
                        "typing": typing,
                    },
                )
        except Exception:
            logger.debug("typing_post_failed", exc_info=True)

    async def build_pipeline(self, ctx: JobContext) -> Any:
        """Build the LiveKit Agent + AgentSession.

        Voice plugins (STT/TTS) come in only when configured. Otherwise the
        Agent is built LLM-only and chat is text-only via ChatHandler.

        Returns the AgentSession (which has .start(...)) so the base class can
        treat it the same way it treated VoicePipelineAgent before — we shim
        a .start(room) interface.
        """
        cfg = self._settings

        brigade_agent_id = self._resolve_brigade_agent_id(ctx)
        self._brigade_agent_id = brigade_agent_id
        user_id = self._human_user_id or self.identity
        model_override = self._resolve_model_override(ctx)

        llm_plugin = build_brigade_llm(
            cfg,
            brigade_agent_id=brigade_agent_id,
            user_id=user_id,
            model_override=model_override,
        )

        # Optional voice plugins
        stt_plugin = None
        tts_plugin = None
        try:
            from plugins.stt import get_stt_plugin
            stt_plugin = get_stt_plugin(self._stt_provider, settings=cfg)
        except Exception as e:
            logger.info("brigade_backed_no_stt", reason=str(e))
        try:
            from plugins.tts import get_tts_plugin
            tts_plugin = get_tts_plugin(self._tts_provider, personality=brigade_agent_id, settings=cfg)
        except Exception as e:
            logger.info("brigade_backed_no_tts", reason=str(e))

        agent_kwargs: dict[str, Any] = {
            "instructions": (
                f"You are acting as {brigade_agent_id} — a Unicorn Brigade agent. "
                "All persona, retrieved memory, and any tool decisions are returned "
                "by the upstream Brigade backend; you only need to relay its responses."
            ),
            "llm": llm_plugin,
        }
        if stt_plugin is not None:
            agent_kwargs["stt"] = stt_plugin
            # Whisper-compat STT plugins don't stream; livekit-agents requires a
            # VAD to slice audio into utterances before hitting STT.
            try:
                from livekit.plugins import silero
                agent_kwargs["vad"] = silero.VAD.load()
            except Exception as e:
                logger.info("brigade_backed_no_vad", reason=str(e))
        if tts_plugin is not None:
            agent_kwargs["tts"] = tts_plugin

        # Cross-modal memory: seed the voice agent with recent room history so a
        # voice call picks up where the (text) conversation left off. Fully
        # fail-safe: any error leaves the context unseeded -> identical to prior
        # behavior (LiveKit still accumulates the live call's own turns). Uses
        # the same ChatContext mechanism LiveKit already feeds the LLM, so seeded
        # turns are consumed exactly like in-call turns.
        try:
            from livekit.agents import ChatContext as _ChatContext

            _rid = getattr(self, "_room_id", "") or ""
            _http = getattr(self.tools, "http", None)
            if _rid and _http is not None:
                _resp = await _http.get(
                    api_path(f"rooms/{_rid}/messages"),
                    params={"limit": "20"},
                )
                _resp.raise_for_status()
                # MessageListResponse: {"messages": [...], ...}, newest first.
                _body = _resp.json() or {}
                _rows = _body.get("messages", []) if isinstance(_body, dict) else []
                if isinstance(_rows, list) and _rows:
                    _seed = _ChatContext()
                    _n = 0
                    for _m in reversed(_rows):  # API is newest-first -> oldest-first
                        _text = (_m.get("content") or "").strip()
                        if not _text or _text == "\u2026":
                            continue
                        # The wire value is "agent_action" ("action" is only
                        # the request-side alias the backend normalizes).
                        if _m.get("content_type") in ("action", "agent_action"):
                            continue
                        _role = (
                            "assistant"
                            if _m.get("sender_type") == "agent"
                            else "user"
                        )
                        _seed.add_message(role=_role, content=_text)
                        _n += 1
                    if _n:
                        agent_kwargs["chat_ctx"] = _seed
                        logger.info(
                            "voice_ctx_seeded", room_id=_rid, messages=_n
                        )
        except Exception:
            logger.info("voice_ctx_seed_skipped", exc_info=True)

        # Use the captioning subclass so the agent's spoken reply streams into
        # the live caption panel as it is produced (see _CaptioningAgent). The
        # publisher is attached below once it exists.
        self._lk_agent = _CaptioningAgent(**agent_kwargs)

        session = AgentSession()
        self._session = session

        def linked_participant():
            """The one human whose audio this AgentSession actually consumes."""
            room_io = getattr(session, "room_io", None)
            return getattr(room_io, "linked_participant", None)

        # --- Live transcript publishing (additive, fire-and-forget) ---
        # Republish the human STT (interim + final) and Majik’s spoken
        # replies as `transcript` data messages on the "stable" topic so the
        # frontend TranscriptPanel shows captions in near-real-time. This is
        # read-only w.r.t. the voice path and must never raise into it.
        try:
            # Use the room’s actual local-participant identity (the in-room
            # "agent-<type>" set at job-accept) so the caption’s speaker
            # correlates with the agent’s tile/roster; fall back to
            # self.identity if the room handle isn’t populated yet.
            agent_identity = (
                getattr(
                    getattr(ctx.room, "local_participant", None),
                    "identity",
                    "",
                )
                or self.identity
                or f"agent-{brigade_agent_id}"
            )
            self._transcript = TranscriptPublisher(
                room=ctx.room,
                agent_identity=agent_identity,
                agent_name=_agent_display_name(brigade_agent_id),
                linked_participant_getter=linked_participant,
            )
            # Tee the agent's streamed reply text (via transcription_node) into
            # the publisher so the caption builds up live "as it reads"; the
            # turn-end conversation_item_added final then supersedes the interim.
            try:
                if isinstance(self._lk_agent, _CaptioningAgent):
                    self._lk_agent.set_caption_publisher(self._transcript)
            except Exception:
                logger.debug("caption_publisher_attach_failed", exc_info=True)
            # livekit-agents 1.6 AgentSession events (verified in-container):
            #   user_input_transcribed -> UserInputTranscribedEvent
            #       (.transcript, .is_final, .speaker_id) = human STT.
            #   conversation_item_added -> ConversationItemAddedEvent
            #       (.item: ChatMessage with .role/.text_content) = replies.
            session.on(
                "user_input_transcribed", self._transcript.on_user_transcript
            )
            session.on(
                "conversation_item_added", self._transcript.on_conversation_item
            )
            logger.info(
                "transcript_publisher_wired",
                agent_identity=agent_identity,
                topic="stable",
            )
        except Exception:
            # Captioning is best-effort; a wiring failure must not break
            # the voice session.
            logger.warning("transcript_publisher_wire_failed", exc_info=True)

        # --- Voice history persistence (additive, fire-and-forget) ---
        # Captions above are ephemeral; this writes the SAME final turns to the
        # room's chat history so a spoken conversation is reviewable later.
        # Separate from captioning so a persistence hiccup never touches the
        # live caption path, and vice-versa. Same never-raise contract.
        try:
            self._voice_history = VoiceHistoryPersister(
                room=ctx.room,
                livekit_room_name=ctx.room.name,
                brigade_agent_id=brigade_agent_id,
                linked_participant_getter=linked_participant,
            )
            session.on(
                "user_input_transcribed", self._voice_history.on_user_transcript
            )
            session.on(
                "conversation_item_added", self._voice_history.on_conversation_item
            )
            logger.info(
                "voice_history_persister_wired",
                livekit_room_name=ctx.room.name,
                brigade_agent_id=brigade_agent_id,
            )
        except Exception:
            logger.warning("voice_history_persister_wire_failed", exc_info=True)

        # --- Browser-STT fallback ears (fix for the mute-agent call) ---
        # The web publishes each human's local-mic captions as `transcript`
        # data messages. When our own STT plugin is silent (unloaded, or its
        # endpoint is down), those finals are the ONLY record of what the human
        # said — group them and answer through the SAME session pipeline
        # (generate_reply → Brigade LLM → TTS → captions → history). Fail-safe:
        # a wiring error leaves voice exactly as it was before this feature.
        try:
            if cfg.voice_transcript_replies_enabled:
                responder_identity = (
                    getattr(
                        getattr(ctx.room, "local_participant", None),
                        "identity",
                        "",
                    )
                    or self.identity
                    or f"agent-{brigade_agent_id}"
                )
                history = self._voice_history
                self._voice_responder = VoiceTranscriptResponder(
                    session=session,
                    room=ctx.room,
                    agent_identity=responder_identity,
                    brigade_agent_id=brigade_agent_id,
                    agent_type=self.agent_type,
                    stt_configured=stt_plugin is not None,
                    group_window=cfg.voice_transcript_group_window_seconds,
                    stt_grace=cfg.voice_transcript_stt_grace_seconds,
                    stt_alive_window=cfg.voice_transcript_stt_alive_seconds,
                    persist_user_utterance=(
                        history.persist_user_utterance if history else None
                    ),
                    acquire_rate_slot=self._msg_limiter.acquire,
                )
                # Any session STT activity (interim or final) stands the
                # fallback down — the session is hearing and will reply itself.
                session.on(
                    "user_input_transcribed",
                    self._voice_responder.note_agent_stt_activity,
                )
                logger.info(
                    "voice_transcript_responder_wired",
                    agent_identity=responder_identity,
                    stt_configured=stt_plugin is not None,
                )
        except Exception:
            logger.warning("voice_transcript_responder_wire_failed", exc_info=True)

        # Shim: provide start(room) the way the old VoicePipelineAgent did, so
        # base.py's existing `self._pipeline.start(ctx.room)` call works.
        async def _start(room):
            await session.start(agent=self._lk_agent, room=room)

        # Bind the shim onto the session object
        session.start_room = _start  # type: ignore[attr-defined]

        logger.info(
            "brigade_backed_session_built",
            brigade_agent_id=brigade_agent_id,
            user_id=user_id,
            model_override=model_override,
            has_stt=stt_plugin is not None,
            has_tts=tts_plugin is not None,
        )
        return session

    def _resolve_brigade_agent_id(self, ctx: JobContext) -> str:
        # Prefer the DISPATCH (job) metadata — it reliably carries
        # brigade_agent_id; room metadata can be empty/stale when the room is
        # freshly created (same lesson as the registry agent_type resolution).
        candidates = [
            getattr(getattr(ctx, "job", None), "metadata", "") or "",
            getattr(ctx.room, "metadata", "") or "",
        ]
        for meta_raw in candidates:
            if not meta_raw:
                continue
            try:
                meta = json.loads(meta_raw)
            except (ValueError, TypeError):
                continue
            if isinstance(meta, dict) and meta.get("brigade_agent_id"):
                return str(meta["brigade_agent_id"])
        return "the-general"

    def _resolve_model_override(self, ctx: JobContext) -> str | None:
        # Per-conversation LLM override (model switcher), carried on the same
        # dispatch/room metadata as brigade_agent_id. None → persona default.
        candidates = [
            getattr(getattr(ctx, "job", None), "metadata", "") or "",
            getattr(ctx.room, "metadata", "") or "",
        ]
        for meta_raw in candidates:
            if not meta_raw:
                continue
            try:
                meta = json.loads(meta_raw)
            except (ValueError, TypeError):
                continue
            if isinstance(meta, dict) and meta.get("model_override"):
                return str(meta["model_override"])
        return None
