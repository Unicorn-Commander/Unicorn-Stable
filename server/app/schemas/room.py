from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.message import MessageResponse

Visibility = Literal["public", "private"]
AgentMode = Literal["answers_all", "when_named", "listening", "muted"]
RecordingPolicy = Literal["off", "on_request", "always"]
RecordingKind = Literal["audio", "composite", "track"]


class RoomCounterpart(BaseModel):
    """The other side of a 1:1 room (dm → the other human, agent_hub → the
    agent) so the sidebar never has to guess whose face to draw."""

    participant_id: uuid.UUID
    kind: str  # human | agent | guest
    display_name: str
    username: str | None = None
    avatar_url: str | None = None
    avatar_emoji: str | None = None
    agent_id: str | None = None


class RoomAgentInfo(BaseModel):
    """An agent member of a room with its per-room mode."""

    participant_id: uuid.UUID
    agent_id: str | None = None
    display_name: str
    avatar_url: str | None = None
    agent_mode: AgentMode | None = None


class RoomCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9._-]*$")

    @field_validator("name")
    @classmethod
    def _name_not_livekit_prefixed(cls, value: str) -> str:
        # LiveKit room names are ``stable-<name>``; a room NAMED ``stable-x``
        # would collide with #x's LiveKit name in every by-name lookup and
        # gateway key scope (MultipleResultsFound, a 500). Reserved.
        if value.startswith("stable-"):
            raise ValueError("room names may not start with 'stable-'")
        return value
    display_name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    # DEPRECATED for agent chats (the web's ``createAgentDm``: ``dm`` + an
    # agent bind): still works, but "Talk to <agent>" is ``POST
    # /agents/{agent_id}/hub`` and new conversations are THREADS under the hub
    # (``POST /rooms/{hub_id}/threads``). Design §3.
    room_type: str = Field(
        "channel",
        pattern=r"^(channel|group_dm|dm)$",
        description=(
            "channel | group_dm | dm. Minting a `dm` per agent conversation is "
            "deprecated: use POST /agents/{agent_id}/hub and start threads under it."
        ),
    )
    max_participants: int = Field(50, ge=2, le=500)


class EnsureHumanDmBody(BaseModel):
    """Body for ``POST /api/v1/dms/ensure`` — idempotent 1:1 human DM."""

    participant_id: uuid.UUID


class RoomUpdate(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    is_archived: bool | None = None
    # Client-writable room metadata. MERGED into the room's existing metadata
    # server-side, and restricted to an allowlist of benign keys
    # (room_service.CLIENT_MUTABLE_METADATA_KEYS — currently `auto_titled`);
    # anything else (brigade_agent_id, conference, …) is silently dropped.
    metadata: dict[str, object] | None = None
    # --- conversation / recording contracts (owner or admin only) ---
    # Channels only; a DM / group / hub 422s. Design §3.
    visibility: Visibility | None = None
    # Project-Ops binding (e.g. "P-00115"); empty string clears it.
    project_number: str | None = Field(None, max_length=64)
    # off | on_request | always. Design §8.
    recording_policy: RecordingPolicy | None = None
    recording_kind: RecordingKind | None = None


class RoomMemberResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    participant_id: uuid.UUID
    username: str | None = None
    display_name: str | None = None
    participant_type: str | None = None
    role: str
    joined_at: datetime
    last_read_at: datetime | None = None
    is_muted: bool
    is_self: bool = False
    # Redis-derived live presence. The canonical boolean the web roster reads;
    # `status` carries the same fact as a string for status-shaped consumers.
    is_online: bool = False
    status: str | None = None
    # The participant's picture (mirror/override hybrid, same value messages
    # carry as sender_avatar) + emoji tier. Absent for years, which made every
    # members-driven surface — roster strip, "seen by", the DM hero — render
    # initials for humans AND agents no matter how much art existed.
    avatar_url: str | None = None
    avatar_emoji: str | None = None
    # AGENTS ONLY (null for humans) — a deliberately separate fact from
    # `is_online`. Presence means "a client is connected"; availability means
    # "this agent can be invoked right now" (Brigade has it enabled, or a
    # bridge session is actively polling the gateway). One of "available",
    # "unavailable", "unknown"; `availability_reason` is a short tag the UI
    # renders as a tooltip so an un-lit agent can explain itself.
    availability: str | None = None
    availability_reason: str | None = None
    # AGENTS ONLY (null for humans): how this agent behaves in this room.
    agent_mode: AgentMode | None = None
    context_depth: int | None = None


class RoomResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    name: str
    display_name: str
    description: str | None = None
    room_type: str
    livekit_room_name: str
    livekit_sid: str | None = None
    max_participants: int
    metadata_: dict | None = Field(None, alias="metadata_")
    is_archived: bool
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    member_count: int = 0
    online_count: int = 0
    # Conversation-list extras (populated by list_rooms_for_user): the latest
    # non-deleted message in the room, and the caller's unread count since their
    # last_read_at. Both let the sidebar + home feed show previews and badges
    # on cold load. Default to empty so other RoomResponse callers are unaffected.
    unread_count: int = 0
    mention_count: int = 0
    has_unread_mention: bool = False
    last_message: MessageResponse | None = None
    # --- conversation model (design §3, migration 021) ---
    parent_room_id: uuid.UUID | None = None
    visibility: Visibility = "public"
    project_number: str | None = None
    # Number of non-archived threads (child rooms) under this room.
    thread_count: int = 0
    # GET /rooms nests a parent's live threads here (newest activity first,
    # capped at room_service.NESTED_THREADS_PER_PARENT); ``latest_thread_id``
    # is the first of them — what a hub opens on. Threads themselves never
    # appear at the top level. Empty/None on every other RoomResponse path.
    latest_thread_id: uuid.UUID | None = None
    threads: list["RoomResponse"] = Field(default_factory=list)
    # False only for a nested thread the caller has not joined yet (someone
    # else's thread in a room they share): opening it joins them.
    is_member: bool = True
    # dm → the other human; agent_hub → the agent. None elsewhere.
    counterpart: RoomCounterpart | None = None
    # Agent members with their per-room mode (empty for rooms with none).
    agents: list[RoomAgentInfo] = Field(default_factory=list)
    # --- recording policy (design §8, migration 023) ---
    recording_policy: RecordingPolicy = "off"
    recording_kind: RecordingKind = "audio"


class EnsureHumanDmResponse(RoomResponse):
    """Room payload for ensure-DM; ``created`` is True when this call inserted it."""

    created: bool = False


class AgentHubResponse(RoomResponse):
    """Room payload for ``POST /agents/{agent_id}/hub``; ``created`` is True
    when this call inserted the hub."""

    created: bool = False


class ThreadCreate(BaseModel):
    """Body for ``POST /rooms/{room_id}/threads``."""

    title: str | None = Field(None, min_length=1, max_length=255)
    # Optional: the message the thread branches from. It is quoted as the
    # thread's first (system-styled) entry with metadata.seed_message_id
    # linking back; the original is not moved. With no title, the thread is
    # titled from the seed's first 60 characters.
    seed_message_id: uuid.UUID | None = None


class ProjectChannelBody(BaseModel):
    """Body for ``POST /rooms/for-project`` — ensure the private channel
    bound to a Project-Ops project. ``P-00115``, ``p-115`` and ``P00115``
    all normalise to ``P-00115``."""

    project_number: str = Field(..., min_length=2, max_length=32)


class ProjectChannelResponse(RoomResponse):
    """``created`` is True when this call made the channel."""

    created: bool = False


class ProjectTask(BaseModel):
    """One open task of the bound project (Project-Ops, via the server proxy)."""

    id: str
    task_number: str | None = None
    title: str
    status: str | None = None
    priority: str | None = None
    due_date: str | None = None
    assignee: str | None = None
    url: str


class ProjectTasksResponse(BaseModel):
    """``GET /rooms/{room_id}/tasks`` — open tasks for the room's project,
    cached 60 s per project on the server."""

    room_id: uuid.UUID
    project_number: str
    tasks: list[ProjectTask] = Field(default_factory=list)
    cached: bool = False
    fetched_at: str | None = None


class ConvertToChannelBody(BaseModel):
    """Body for ``POST /rooms/{room_id}/convert-to-channel`` (group → channel).
    Everything optional: the slug derives from the label, the label stays,
    and the channel is private unless told otherwise."""

    name: str | None = Field(None, min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    display_name: str | None = Field(None, min_length=1, max_length=255)
    visibility: Visibility = "private"


class MemberSettingsBody(BaseModel):
    """Body for ``PATCH /rooms/{room_id}/members/{participant_id}``."""

    agent_mode: AgentMode | None = None
    # 0 clears the override (NULL); 1..500 messages otherwise.
    context_depth: int | None = Field(None, ge=0, le=500)


class RoomInviteCreate(BaseModel):
    """Body for ``POST /rooms/{room_id}/invites``."""

    expires_hours: int | None = Field(None, ge=1, le=24 * 30)
    max_uses: int | None = Field(None, ge=1, le=1000)
    role: Literal["member", "admin"] = "member"


class RoomInviteResponse(BaseModel):
    id: uuid.UUID
    room_id: uuid.UUID
    token_prefix: str
    role: str
    expires_at: datetime
    max_uses: int | None = None
    use_count: int = 0
    revoked_at: datetime | None = None
    created_at: datetime
    created_by: uuid.UUID | None = None
    # Present ONLY on the mint response; never stored, never listed.
    token: str | None = None
    url_path: str | None = None


class InvitePreviewResponse(BaseModel):
    """What a signed-in user sees before accepting an invite link."""

    room_id: uuid.UUID
    display_name: str
    room_type: str
    visibility: Visibility
    member_count: int
    role: str
    expires_at: datetime
    inviter_display_name: str | None = None
    already_member: bool = False


class ContextSender(BaseModel):
    id: uuid.UUID | None = None
    name: str
    kind: str  # human | agent | guest | system


class ContextEntry(BaseModel):
    """One line of the room stream as the context builder hands it to an
    agent: messages, replies, voice lines and (later) system events."""

    id: uuid.UUID | None = None
    ts: datetime
    sender: ContextSender
    # message | reply | voice | system
    kind: str
    text: str
    parent_id: uuid.UUID | None = None


class ContextResponse(BaseModel):
    """``GET /rooms/{room_id}/context`` — design §4.

    ``entries`` are oldest-first and fit within ``budget_tokens`` (chars/4).
    ``watermark`` is the newest message id included, for delta requests.
    ``summary`` is the rolling room summary when one exists (L4 fills it).
    """

    room_id: uuid.UUID
    budget_tokens: int
    used_tokens: int
    truncated: bool
    watermark: uuid.UUID | None = None
    summary: str | None = None
    entries: list[ContextEntry] = Field(default_factory=list)


class RecordingResponse(BaseModel):
    """One recording of a call (a ``call_egresses`` row) — design §8."""

    model_config = {"from_attributes": True}

    id: uuid.UUID
    room_id: uuid.UUID | None = None
    kind: str = "audio"
    status: str
    started_by: uuid.UUID | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    duration_seconds: float | None = None
    storage_url: str | None = None
    mo_session_id: str | None = None
    retention_until: datetime | None = None
    legal_hold: bool = False
    # --- filled by the recording lane (L8s); additive, all optional ---
    # LiveKit's own egress id (EG_…), accepted as an alias on the item routes.
    egress_id: str | None = None
    started_by_name: str | None = None
    # Meeting-Ops session page for playback (the transcript export's link).
    mo_session_url: str | None = None
    # none | pending | delivering | delivered | failed | no_session | blocked
    handoff_status: str | None = None
    file_size_bytes: int | None = None
    # What THIS caller may do (owner/admin or whoever started it).
    can_delete: bool = False
    can_download: bool = False


class RoomListResponse(BaseModel):
    rooms: list[RoomResponse]
    total: int
    cursor: str | None = None


class RoomPresenceResponse(BaseModel):
    """Snapshot of who is currently online in a room.

    ``online`` is a list of Participant IDs (Participant.id) — the same identity
    the web roster matches its online dot on and the WS presence event carries.
    """

    online: list[str]
