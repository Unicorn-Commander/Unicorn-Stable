"""Names of the room-scoped WebSocket events introduced by the conversation /
recording / voice-turn contracts (design §9).

One place to spell them so the server, the web client and the tests agree.
Emitters publish ``{"type": <name>, "payload": {...}}`` through
``app.api.messages._ws_broadcast_room`` (Redis ``room:{id}``), exactly like
``members_changed``.
"""

from __future__ import annotations

#: A thread (child room) was created under ``payload.parent_room_id``.
THREAD_CREATED = "thread_created"
#: A channel's ``visibility`` changed (``payload.visibility``).
ROOM_VISIBILITY = "room_visibility"
#: An invite link was minted (``payload.token_prefix`` only — never the raw token).
INVITE_CREATED = "invite_created"
#: An agent member's ``agent_mode`` / ``context_depth`` changed.
MEMBER_MODE = "member_mode"
#: Recording started/stopped (``payload.active``, ``kind``, ``started_by``).
#: Emitted by the recording lane (L8s); registered here so the client can
#: subscribe before it exists.
RECORDING_STATE = "recording_state"
#: A voice dispatch decision (``payload.winner``, ``rule``). Emitted by the
#: voice-turn lane (L5) for the floor pill / raise-hand UI.
VOICE_DISPATCH = "voice_dispatch"

CONTRACT_EVENTS: tuple[str, ...] = (
    THREAD_CREATED,
    ROOM_VISIBILITY,
    INVITE_CREATED,
    MEMBER_MODE,
    RECORDING_STATE,
    VOICE_DISPATCH,
)

# --- L2 additions (conversation server lane). Additive: not part of the
# frozen CONTRACT_EVENTS tuple the L0 test pins. ---

#: A thread was archived (idle 14 d, or by its owner) or unarchived (a new
#: message). ``payload.is_archived`` says which; sent to the thread AND its
#: parent room. See services/room_archive.py.
THREAD_ARCHIVED = "thread_archived"
#: A group DM was converted to a channel in place (``payload.room_type``,
#: ``visibility``, ``name``, ``display_name``). Room-scoped.
ROOM_CONVERTED = "room_converted"
#: Per-USER (not room) event: a room was created for / opened to this
#: participant — hub, thread, group, invite accept, project channel.
#: ``payload.kind`` says which; ``inviter_name`` is present only when it
#: was someone else's doing. See services/room_push.py.
ROOM_INVITED = "room_invited"

__all__ = [
    "THREAD_CREATED",
    "ROOM_VISIBILITY",
    "INVITE_CREATED",
    "MEMBER_MODE",
    "RECORDING_STATE",
    "VOICE_DISPATCH",
    "CONTRACT_EVENTS",
    "THREAD_ARCHIVED",
    "ROOM_CONVERTED",
    "ROOM_INVITED",
]
