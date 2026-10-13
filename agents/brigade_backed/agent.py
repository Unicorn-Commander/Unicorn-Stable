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
from typing import Any, Callable

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
from agent_runtime.resilient_stt import NeverFatalSTT
from agent_runtime import voice_dispatch
from agent_runtime.voice_transcripts import (
    VoiceTranscriptResponder,
    any_shared_mic,
    call_roster,
    elected_user_captioner,
    mention_needles,
    participant_shared_mic,
    primary_agent_id,
)

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
        self._reply_gate: Any = None

    def set_reply_gate(self, gate: Any) -> None:
        """Install the voice-dispatch gate over the session's OWN turn loop.

        This is the enforcement point that was missing. Voice dispatch v1
        gated only the browser-caption FALLBACK path — but with a healthy STT
        the AgentSession's native loop replies to every final utterance of its
        linked participant, no dispatcher consulted. Which is why, in the live
        rehearsal, Majik answered a line addressed to Rook: the rules existed
        and nothing routed this lane through them.
        """
        self._reply_gate = gate

    async def on_user_turn_completed(self, turn_ctx: Any, new_message: Any) -> None:
        gate = self._reply_gate
        if gate is not None:
            try:
                allowed = bool(gate(new_message))
            except Exception:
                # Fail OPEN: a bug in the gate must degrade to the old
                # behaviour (chatty), never to a co-host that silently cannot
                # speak at all. VOICE_DISPATCH_ENABLED=0 remains the explicit
                # way to turn the gate off on purpose.
                logger.warning("session_reply_gate_failed", exc_info=True)
                allowed = True
            if not allowed:
                from livekit.agents.llm import StopResponse

                raise StopResponse()
        return await super().on_user_turn_completed(turn_ctx, new_message)

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
        self._tts_plugin: Any | None = None
        self._restart_lock: asyncio.Lock = asyncio.Lock()

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
        # A failing STT endpoint must never take the SESSION down with it.
        # Incident 2026-08-10: the whisper base_url answered 404, each VAD
        # segment emitted an unrecoverable stt_error, and after
        # max_unrecoverable_errors (3) the AgentSession CLOSED itself
        # (CloseReason.ERROR) — killing TTS and the whole reply pipeline ~20s
        # into the call. NeverFatalSTT converts recognize failures into empty
        # finals (the agent is deaf, loudly logged, and the browser-transcript
        # fallback still hears), instead of poisoning the session.
        if stt_plugin is not None:
            try:
                if not stt_plugin.capabilities.streaming:
                    stt_plugin = NeverFatalSTT(stt_plugin)
            except Exception:
                logger.warning("stt_resilience_wrap_failed", exc_info=True)
        try:
            from plugins.tts import get_tts_plugin
            tts_plugin = get_tts_plugin(self._tts_provider, personality=brigade_agent_id, settings=cfg)
        except Exception as e:
            logger.info("brigade_backed_no_tts", reason=str(e))
        # Kept for the emergency direct-reply path (Brigade text + TTS publish
        # when the session is dead and could not be restarted).
        self._tts_plugin = tts_plugin

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
            room_io = getattr(self._session, "room_io", None)
            return getattr(room_io, "linked_participant", None)

        # Route the session's own turn loop through voice dispatch. The floor
        # and stickiness state are the same per-room objects the fallback path
        # uses, so the two lanes cannot disagree about who holds the floor.
        self._dispatch_me = brigade_agent_id or self.agent_type
        self._dispatch_floor = voice_dispatch.floor_for(ctx.room.name)
        self._ctx_room = ctx.room
        self._join_identity = str(
            getattr(getattr(ctx.room, "local_participant", None), "identity", "")
            or ""
        )
        my_needles = set(mention_needles(brigade_agent_id, self.agent_type))
        self._dispatch_needles = my_needles
        from agent_runtime.barge_in import (
            BargeIn,
            install_chunked_say,
            transcript_duration_seconds,
        )
        from voice_relay.agent import barge_in_mode_from_metadata

        barge_mode = barge_in_mode_from_metadata(
            getattr(getattr(ctx, "job", None), "metadata", ""),
            getattr(ctx.room, "metadata", ""),
        )
        self._barge = BargeIn(enabled=barge_mode == "auto")

        def _spoken_limit() -> int:
            from voice_relay.agent import max_spoken_chars_from_metadata

            room = getattr(self, "_ctx_room", None)
            return max_spoken_chars_from_metadata(
                getattr(room, "metadata", "") if room is not None else ""
            )

        try:
            install_chunked_say(session, self._barge, limit_of=_spoken_limit)
        except Exception:
            logger.debug("brigade_chunked_say_failed", exc_info=True)

        def _persist_user_line(speaker: str, text: str) -> None:
            """The user's spoken line becomes chat ONLY when it earns a reply.

            The unconditional user_input_transcribed persister wrote EVERY
            final utterance of the linked human into the room — the same
            chat-flood the relay was cured of, still alive on the Brigade
            lane. With the gate deciding replies, the gate is also the one
            place that knows whether the line deserves to be in the log.
            """
            history = self._voice_history
            if history is None or not text:
                return
            try:
                history.persist_user_utterance(speaker, text)
            except Exception:
                logger.debug("gated_history_persist_failed", exc_info=True)

        def _reply_gate(new_message: Any) -> bool:
            text = (getattr(new_message, "text_content", "") or "").strip()
            linked = linked_participant()
            speaker = str(getattr(linked, "identity", "") or "") or "unknown-human"
            if not voice_dispatch.dispatch_enabled():
                # Kill switch: the old behaviour exactly — reply to everything,
                # and keep the full voice conversation in chat.
                _persist_user_line(speaker, text)
                return True
            others, humans = call_roster(ctx.room, self._identity)
            shared = any_shared_mic(ctx.room)
            decision = voice_dispatch.decide(
                state=self._dispatch_floor,
                me=self._dispatch_me,
                my_names=my_needles,
                speaker=speaker,
                speaker_is_agent=False,
                text=text,
                other_agent_names=others,
                human_count=humans,
                primary_agent=primary_agent_id(ctx.room),
                shared_mic=shared,
                room=getattr(ctx.room, "name", "") or "",
                agent_identity=self._join_identity or self._identity,
            )
            logger.info(
                "voice_dispatch_decision",
                source="session",
                me=self._dispatch_me,
                speaker=speaker,
                respond=decision.respond,
                rule=decision.rule,
                addressed=decision.addressed,
                humans=humans,
                other_agents=sorted(others),
                preview=text[:80],
            )
            if decision.respond:
                _persist_user_line(speaker, text)
            return decision.respond

        self._lk_agent.set_reply_gate(_reply_gate)
        self._reply_gate_fn = _reply_gate

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
            # Listener attachment happens once for the whole session in
            # _wire_session_events below (shared with the emergency restart
            # path, so a fresh session hears/captions/persists identically).
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
                    # Session-death recovery (incident 2026-08-10): one
                    # restart attempt, then the bounded direct path.
                    restart_session=self.restart_voice_session,
                    direct_reply=self._direct_voice_reply,
                    linked_participant_getter=linked_participant,
                    on_human_final=self._barge_on_human_final,
                )
                logger.info(
                    "voice_transcript_responder_wired",
                    agent_identity=responder_identity,
                    stt_configured=stt_plugin is not None,
                )
        except Exception:
            logger.warning("voice_transcript_responder_wire_failed", exc_info=True)

        # ALL session listeners in one place — shared with restart_voice_session
        # so a fresh session is wired identically (captions, history, the
        # responder's STT-alive signal, and the LOUD error/close reporters that
        # the 2026-08-10 incident lacked).
        self._wire_session_events(session)
        self._attach_multi_track(linked_participant)

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

    # ------------------------------------------------------------------ #
    # Session lifecycle visibility + recovery (incident 2026-08-10)
    # ------------------------------------------------------------------ #

    def _wire_session_events(self, session: AgentSession) -> None:
        """Attach every listener a voice session needs.

        One place, used at build AND at emergency restart, so a fresh session
        captions, persists, feeds the responder's STT-alive signal, and —
        crucially — REPORTS its own death. The 2026-08-10 session close was
        invisible: no close/error listener existed and the structlog chain
        swallowed tracebacks, so the only symptom was generate_reply throwing
        "AgentSession isn't running" 22 seconds later.
        """
        if self._transcript is not None:
            def _user_caption(ev: Any) -> None:
                """USER captions go through the one-captioner election.

                Every agent session transcribes the human it is linked to;
                unelected publishers made a three-agent call render every
                sentence three times. Our OWN replies caption unconditionally
                below — nobody else speaks in our voice.
                """
                try:
                    room = getattr(self, "_ctx_room", None)
                    me = getattr(self, "_join_identity", "") or self._identity
                    if room is None or elected_user_captioner(room, me):
                        self._transcript.on_user_transcript(ev)
                except Exception:
                    logger.debug("user_caption_election_failed", exc_info=True)

            session.on("user_input_transcribed", _user_caption)
            session.on(
                "conversation_item_added", self._transcript.on_conversation_item
            )
        # Release the dispatch floor when this agent's reply finishes, so the
        # next agent can be addressed without waiting out the 120s lease. The
        # lease stays as the backstop for a worker that dies mid-turn.
        def _release_floor(ev: Any = None) -> None:
            try:
                floor = getattr(self, "_dispatch_floor", None)
                me = getattr(self, "_dispatch_me", None)
                state = str(getattr(ev, "new_state", "") or "")
                barge = getattr(self, "_barge", None)
                if barge is not None:
                    barge.note_state(state)
                if floor is not None and me and state in ("listening", "idle"):
                    voice_dispatch.observe_reply_finished(floor, me)
            except Exception:
                logger.debug("floor_release_failed", exc_info=True)

        try:
            session.on("agent_state_changed", _release_floor)
        except Exception:
            logger.debug("floor_release_wire_failed", exc_info=True)

        def _barge_final(ev: Any) -> None:
            try:
                if not bool(getattr(ev, "is_final", False)):
                    return
                text = (getattr(ev, "transcript", "") or "").strip()
                self._barge_on_human_final(
                    text,
                    duration_s=transcript_duration_seconds(ev),
                )
            except Exception:
                logger.debug("brigade_barge_listener_failed", exc_info=True)

        try:
            session.on("user_input_transcribed", _barge_final)
        except Exception:
            logger.debug("brigade_barge_wire_failed", exc_info=True)

        # The user-line persister moves INTO the reply gate when one exists:
        # only a line that earns a reply lands in chat. Without a gate (none
        # installed, e.g. a build path that never wired one), keep the old
        # unconditional listener so voice history does not silently vanish.
        if self._voice_history is not None and getattr(self, "_reply_gate_fn", None) is None:
            session.on(
                "user_input_transcribed", self._voice_history.on_user_transcript
            )
            session.on(
                "conversation_item_added",
                self._voice_history.on_conversation_item,
            )
        if self._voice_responder is not None:
            session.on(
                "user_input_transcribed",
                self._voice_responder.note_agent_stt_activity,
            )
        session.on("error", self._on_session_error)
        session.on("close", self._on_session_close)

    def _barge_on_human_final(
        self, text: str, *, duration_s: float | None = None
    ) -> None:
        """Stop the in-flight say and release the floor. Empty text does nothing."""
        barge = getattr(self, "_barge", None)
        if barge is None or not barge.on_human_final(text, duration_s=duration_s):
            return
        floor = getattr(self, "_dispatch_floor", None)
        me = getattr(self, "_dispatch_me", None)
        if floor is not None and me:
            voice_dispatch.observe_reply_finished(floor, me)
        logger.info("brigade_barge_in", chars=len(text or ""), me=me)

    def _attach_multi_track(self, linked_participant: Any) -> None:
        """Elected captioner: one STT session per human mic, attributed by track."""
        room = getattr(self, "_ctx_room", None)
        if room is None:
            return
        try:
            from agent_runtime.diarization import speaker_hint
            from agent_runtime.multi_track_stt import attach_multi_track_stt

            def _linked_identity() -> str:
                try:
                    linked = linked_participant() if callable(linked_participant) else None
                except Exception:
                    return ""
                return str(getattr(linked, "identity", "") or "")

            def _on_final(track: Any, text: str) -> None:
                content = (text or "").strip()
                if not content:
                    return
                self._barge_on_human_final(content)
                hint = None
                try:
                    remotes = getattr(room, "remote_participants", {}) or {}
                    participant = None
                    for candidate in remotes.values():
                        if str(getattr(candidate, "identity", "") or "") == track.participant_identity:
                            participant = candidate
                            break
                    if participant is not None and participant_shared_mic(participant):
                        hint = speaker_hint(
                            track.participant_name,
                            participant_identity=track.participant_identity,
                            text=content,
                        )
                except Exception:
                    logger.debug("captioner_speaker_hint_failed", exc_info=True)
                publisher = getattr(self, "_transcript", None)
                if publisher is not None:
                    publisher.publish_user_line(
                        participant_id=track.participant_identity,
                        name=track.participant_name,
                        text=content,
                        source="captioner",
                        speaker_hint=hint,
                    )
                # The session's own turn loop already decides for the human it
                # is linked to. This path is the humans that loop cannot hear.
                if track.participant_identity == _linked_identity():
                    return
                allowed = self._consider_spoken(track.participant_identity, content)
                if not allowed:
                    return
                history = getattr(self, "_voice_history", None)
                if history is not None:
                    try:
                        history.persist_user_utterance(track.participant_identity, content)
                    except Exception:
                        logger.debug("captioner_persist_failed", exc_info=True)
                session = getattr(self, "_session", None)
                if session is None:
                    return

                async def _speak() -> None:
                    try:
                        result = session.generate_reply(user_input=content)
                        if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future):
                            await result
                    except Exception:
                        logger.error("captioner_reply_failed", exc_info=True)
                        floor = getattr(self, "_dispatch_floor", None)
                        me = getattr(self, "_dispatch_me", None)
                        if floor is not None and me:
                            voice_dispatch.observe_reply_finished(floor, me)

                try:
                    asyncio.get_running_loop().create_task(
                        _speak(), name=f"captioner-reply:{track.track_sid}"
                    )
                except RuntimeError:
                    logger.debug("captioner_reply_no_loop")

            attach_multi_track_stt(
                room,
                getattr(self, "_join_identity", "") or self._identity,
                _on_final,
            )
        except Exception:
            logger.warning("brigade_multi_track_failed", exc_info=True)

    def _consider_spoken(self, speaker: str, text: str) -> bool:
        """decide() for a line this worker heard outside its linked STT."""
        if not (text or "").strip():
            return False
        if not voice_dispatch.dispatch_enabled():
            return True
        room = getattr(self, "_ctx_room", None)
        try:
            others, humans = call_roster(room, getattr(self, "_join_identity", "") or self._identity)
            shared = any_shared_mic(room)
            decision = voice_dispatch.decide(
                state=getattr(self, "_dispatch_floor", None),
                me=getattr(self, "_dispatch_me", "") or "",
                my_names=getattr(self, "_dispatch_needles", set()) or set(),
                speaker=speaker,
                speaker_is_agent=False,
                text=text,
                other_agent_names=others,
                human_count=humans,
                primary_agent=primary_agent_id(room),
                shared_mic=shared,
                room=getattr(room, "name", "") or "",
                agent_identity=getattr(self, "_join_identity", "") or self._identity,
            )
        except Exception:
            logger.warning("captioner_decide_failed", exc_info=True)
            return False
        logger.info(
            "voice_dispatch_decision",
            source="captioner",
            me=getattr(self, "_dispatch_me", ""),
            speaker=speaker,
            respond=decision.respond,
            rule=decision.rule,
            addressed=decision.addressed,
            humans=humans,
            preview=text[:80],
        )
        return bool(decision.respond)

    def _on_session_error(self, ev: Any) -> None:
        """LOUD ErrorEvent reporter (sync listener; must never raise)."""
        try:
            err = getattr(ev, "error", None)
            logger.error(
                "voice_session_error",
                recoverable=getattr(err, "recoverable", None),
                error_type=getattr(err, "type", None),
                error=repr(getattr(err, "error", err)),
                source=type(getattr(ev, "source", None)).__name__,
                room=self._room_name,
            )
        except Exception:  # pragma: no cover
            logger.error("voice_session_error_report_failed", exc_info=True)

    def _on_session_close(self, ev: Any) -> None:
        """LOUD CloseEvent reporter — reason + error, the missing black box."""
        try:
            reason = getattr(ev, "reason", None)
            logger.error(
                "voice_session_closed",
                reason=str(getattr(reason, "value", reason)),
                error=repr(getattr(ev, "error", None)),
                room=self._room_name,
            )
        except Exception:  # pragma: no cover
            logger.error("voice_session_close_report_failed", exc_info=True)

    async def restart_voice_session(self) -> AgentSession | None:
        """ONE fresh AgentSession after the current one died. None on failure.

        Builds a NEW Agent from the dead one's own components (same Brigade
        LLM, TTS, resilient STT, VAD — and its chat_ctx, so the conversation
        memory survives the restart) rather than re-binding the old Agent
        object, and wires the identical listener set. Serialized by a lock so
        overlapping utterances can't spawn competing sessions.
        """
        ctx = self._job_ctx
        old_agent = self._lk_agent
        if ctx is None or old_agent is None:
            logger.warning("voice_session_restart_unavailable")
            return None
        async with self._restart_lock:
            old_session = self._session
            try:
                agent_kwargs: dict[str, Any] = {
                    "instructions": old_agent.instructions,
                    "llm": old_agent.llm,
                }
                for component in ("stt", "tts", "vad"):
                    value = getattr(old_agent, component, None)
                    if value is not None:
                        agent_kwargs[component] = value
                try:
                    chat_ctx = old_agent.chat_ctx
                    if chat_ctx is not None:
                        agent_kwargs["chat_ctx"] = chat_ctx.copy()
                except Exception:
                    logger.debug("restart_chat_ctx_copy_failed", exc_info=True)

                fresh_agent = _CaptioningAgent(**agent_kwargs)
                if self._transcript is not None:
                    fresh_agent.set_caption_publisher(self._transcript)
                # The dispatch gate too — a restarted session that skipped it
                # would reply to everything again, silently, which is the exact
                # failure this gate exists to close.
                gate = getattr(self, "_reply_gate_fn", None)
                if gate is not None:
                    fresh_agent.set_reply_gate(gate)

                session = AgentSession()
                self._wire_session_events(session)
                await session.start(agent=fresh_agent, room=ctx.room)
            except Exception:
                logger.error("voice_session_restart_failed", exc_info=True)
                return None

            self._lk_agent = fresh_agent
            self._session = session
            self._pipeline = session
            logger.warning(
                "voice_session_restarted",
                room=self._room_name,
                brigade_agent_id=self._brigade_agent_id,
            )
            # Put the old session out of its misery quietly, AFTER the swap.
            if old_session is not None and old_session is not session:
                closer = getattr(old_session, "aclose", None)
                if callable(closer):
                    try:
                        await closer()
                    except Exception:
                        logger.debug("old_session_close_failed", exc_info=True)
            return session

    async def _direct_voice_reply(
        self, text: str, on_commit: Callable[[], None]
    ) -> bool:
        """LAST-RESORT reply when the session is dead and restart failed.

        A deliberate, bounded fork of the pipeline — logged loudly by the
        caller as ``voice_reply_via_direct_path`` — so the agent is never
        visibly present and mute: Brigade text (non-streaming) → commit the
        user turn → persist the reply text → caption it → best-effort spoken
        audio on a directly-published track. Text delivery is the guarantee;
        audio is attempted on top.
        """
        cfg = self._settings
        if not cfg.brigade_base_url or not cfg.brigade_api_key:
            logger.warning("direct_reply_brigade_unconfigured")
            return False
        url = (cfg.brigade_base_url or "").rstrip("/") + "/chat/completions"
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(120.0, connect=10.0)
            ) as http:
                resp = await http.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {cfg.brigade_api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": self._brigade_agent_id,
                        "messages": [{"role": "user", "content": text}],
                        "user": self._human_user_id or self.identity,
                        "stream": False,
                    },
                )
                resp.raise_for_status()
                data = resp.json() or {}
                reply = (
                    (data.get("choices") or [{}])[0]
                    .get("message", {})
                    .get("content")
                    or ""
                ).strip()
        except Exception:
            logger.error("direct_reply_brigade_failed", exc_info=True)
            return False
        if not reply:
            logger.warning("direct_reply_empty")
            return False

        # A reply exists: commit the user turn first so history keeps order.
        on_commit()
        await self._post_chat_message(reply)
        if self._transcript is not None:
            try:
                self._transcript.publish_agent_final(reply)
            except Exception:
                logger.debug("direct_reply_caption_failed", exc_info=True)
        await self._speak_text_direct(reply)
        return True

    async def _speak_text_direct(self, text: str) -> None:
        """Best-effort TTS → a directly-published audio track. Never raises."""
        tts = self._tts_plugin
        ctx = self._job_ctx
        if tts is None or ctx is None:
            logger.warning("direct_reply_no_tts", has_tts=tts is not None)
            return
        try:
            from livekit import rtc

            source: Any | None = None
            publication: Any | None = None
            try:
                async for chunk in tts.synthesize(text):
                    frame = getattr(chunk, "frame", None)
                    if frame is None:
                        continue
                    if source is None:
                        source = rtc.AudioSource(
                            frame.sample_rate, frame.num_channels
                        )
                        track = rtc.LocalAudioTrack.create_audio_track(
                            "voice-direct-reply", source
                        )
                        options = rtc.TrackPublishOptions(
                            source=rtc.TrackSource.SOURCE_MICROPHONE
                        )
                        publication = await ctx.room.local_participant.publish_track(
                            track, options
                        )
                    await source.capture_frame(frame)
                if source is not None:
                    await source.wait_for_playout()
            finally:
                if publication is not None:
                    try:
                        await ctx.room.local_participant.unpublish_track(
                            publication.sid
                        )
                    except Exception:
                        logger.debug("direct_reply_unpublish_failed", exc_info=True)
                if source is not None:
                    try:
                        await source.aclose()
                    except Exception:
                        pass
            logger.info("direct_reply_spoken", chars=len(text))
        except Exception:
            logger.error("direct_reply_tts_failed", exc_info=True)

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
