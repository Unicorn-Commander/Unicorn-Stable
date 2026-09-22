"""Recording policy engine — design §8, the decision half.

Every "may this recording start / stop / be deleted" question is answered
HERE, as a pure function of facts the caller already holds, so the API route
and the LiveKit webhook path cannot drift apart and the whole matrix is unit
testable without a database, a JWT or a LiveKit.

Inputs (three axes, all deny-by-default):

* ``rooms.recording_policy`` — ``off`` | ``on_request`` | ``always``
  (owner/admin set it via ``PATCH /rooms/{id}``).
* Entitlement — the Keycloak realm role ``stable-recorder`` on the caller's
  JWT (granted in Ops-Center). The webhook path has no JWT, so the role is
  mirrored onto ``participants.metadata->>'stable_recorder'`` at sign-in
  (services/participant_identity.py) and read from there.
* Personal preference — ``participants.metadata->>'record_my_calls'``: a
  call *you start* in an ``on_request`` room auto-starts recording, with you
  as ``started_by``. The preference never grants what the role does not.

The matrix (``M`` = manual start via POST, ``A`` = auto-start on the first
``participant_joined`` of a call, ``S`` = manual stop):

    policy      entitled  pref   M(start)             A(auto)                    S(stop)
    ----------  --------  -----  -------------------  -------------------------  ---------------------------
    off         any       any    403 policy           no                         403 policy
    on_request  no        any    403 entitlement      no                         403 entitlement
    on_request  yes       off    start (started_by)   no                         stop
    on_request  yes       on     start (started_by)   start if joiner STARTED    stop
                                                      the call (started_by=them)
    always      no        any    403 entitlement      start (started_by NULL)    403 entitlement
    always      yes       any    start (started_by)   start (started_by NULL)    owner/admin only (403 else)

Plus, orthogonal to the matrix:

* ``CALL_RECORDING_ENABLED`` stays as the instance-wide master kill-switch —
  off means nothing records, whatever the room says (503 on the API).
* An already-active recording answers 409 to a start; nothing active answers
  409 to a stop.
* Delete: room owner/admin or whoever started it; ``legal_hold`` blocks it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: Keycloak realm role that entitles a user to start/stop server-side recording.
RECORDER_ROLE = "stable-recorder"
#: Mirror of the role on ``participants.metadata`` (webhook path has no JWT).
RECORDER_ENTITLED_KEY = "stable_recorder"
#: Personal preference on ``participants.metadata``.
RECORD_MY_CALLS_KEY = "record_my_calls"

POLICY_OFF = "off"
POLICY_ON_REQUEST = "on_request"
POLICY_ALWAYS = "always"
POLICIES = (POLICY_OFF, POLICY_ON_REQUEST, POLICY_ALWAYS)

KIND_AUDIO = "audio"
KIND_COMPOSITE = "composite"
#: Kinds this lane can actually capture. ``track`` (ISO) is a later lane.
STARTABLE_KINDS = (KIND_AUDIO, KIND_COMPOSITE)


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def normalize_policy(value: Any) -> str:
    """The room's policy as one of ``POLICIES``; anything odd reads as off."""
    text = str(value or "").strip().lower()
    return text if text in POLICIES else POLICY_OFF


# ---------------------------------------------------------------------------
# Facts about the caller
# ---------------------------------------------------------------------------


def user_is_entitled(user: dict[str, Any] | None) -> bool:
    """Entitlement from a validated JWT (``deps.get_current_user`` dict)."""
    if not user:
        return False
    roles = user.get("roles") or []
    try:
        return RECORDER_ROLE in set(roles)
    except TypeError:
        return False


def participant_is_entitled(participant: Any) -> bool:
    """Entitlement from the participant row's mirrored role (webhook path)."""
    meta = getattr(participant, "metadata_", None)
    if not isinstance(meta, dict):
        return False
    return _truthy(meta.get(RECORDER_ENTITLED_KEY))


def participant_wants_own_calls_recorded(participant: Any) -> bool:
    meta = getattr(participant, "metadata_", None)
    if not isinstance(meta, dict):
        return False
    return _truthy(meta.get(RECORD_MY_CALLS_KEY))


# ---------------------------------------------------------------------------
# Decisions
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Decision:
    """Outcome of a policy question.

    ``allowed`` False carries the HTTP ``status`` the API should answer with
    and a plain-language ``reason`` fit for the response body.
    """

    allowed: bool
    reason: str = ""
    status: int = 200

    @classmethod
    def ok(cls, reason: str = "") -> "Decision":
        return cls(True, reason, 200)

    @classmethod
    def deny(cls, status: int, reason: str) -> "Decision":
        return cls(False, reason, status)


def decide_manual_start(
    *,
    policy: str,
    entitled: bool,
    master_enabled: bool,
    already_active: bool,
    kind: str = KIND_AUDIO,
) -> Decision:
    """POST /rooms/{id}/recording/start."""
    policy = normalize_policy(policy)
    # Policy first — a room whose owner said "off" must answer the same to an
    # entitled and an unentitled member (matches the L0 contract test).
    if policy == POLICY_OFF:
        return Decision.deny(403, "Recording is off for this room")
    if not entitled:
        return Decision.deny(
            403, "You are not entitled to record; ask an admin for the recorder role"
        )
    if not master_enabled:
        return Decision.deny(503, "Recording is disabled on this instance")
    if kind not in STARTABLE_KINDS:
        return Decision.deny(400, f"Recording kind '{kind}' is not available")
    if already_active:
        return Decision.deny(409, "This room is already being recorded")
    return Decision.ok("start")


def decide_manual_stop(
    *,
    policy: str,
    entitled: bool,
    active: bool,
    is_owner_or_admin: bool,
) -> Decision:
    """POST /rooms/{id}/recording/stop."""
    policy = normalize_policy(policy)
    if policy == POLICY_OFF:
        return Decision.deny(403, "Recording is off for this room")
    if not entitled:
        return Decision.deny(
            403, "You are not entitled to record; ask an admin for the recorder role"
        )
    if policy == POLICY_ALWAYS and not is_owner_or_admin:
        return Decision.deny(
            403,
            "This room always records; only the room owner or an admin can stop "
            "it (or change the room's recording policy)",
        )
    if not active:
        return Decision.deny(409, "This room is not being recorded")
    return Decision.ok("stop")


@dataclass(frozen=True)
class AutoStart:
    """What the ``participant_joined`` path should do."""

    start: bool
    #: True when the joiner is the recorder of record (``started_by``);
    #: False for a policy-driven start (``started_by`` NULL).
    attribute_to_joiner: bool = False
    reason: str = ""


def decide_auto_start(
    *,
    policy: str,
    master_enabled: bool,
    joiner_entitled: bool,
    joiner_pref: bool,
    joiner_started_call: bool,
) -> AutoStart:
    """First ``participant_joined`` of a call (the DB lease makes it once)."""
    if not master_enabled:
        return AutoStart(False, reason="master switch off")
    policy = normalize_policy(policy)
    if policy == POLICY_OFF:
        return AutoStart(False, reason="policy off")
    if policy == POLICY_ALWAYS:
        return AutoStart(True, attribute_to_joiner=False, reason="policy always")
    # on_request: only the personal preference of an ENTITLED caller who is
    # starting this call may auto-start, and it is attributed to them.
    if joiner_entitled and joiner_pref and joiner_started_call:
        return AutoStart(True, attribute_to_joiner=True, reason="record_my_calls")
    if joiner_pref and not joiner_entitled:
        return AutoStart(False, reason="record_my_calls set but not entitled")
    return AutoStart(False, reason="on_request; nobody asked")


def decide_delete(
    *,
    is_owner_or_admin: bool,
    is_starter: bool,
    legal_hold: bool,
) -> Decision:
    """DELETE /rooms/{id}/recordings/{egress_id}."""
    if not (is_owner_or_admin or is_starter):
        return Decision.deny(
            403, "Only the room owner, an admin, or whoever started the recording may delete it"
        )
    if legal_hold:
        return Decision.deny(423, "This recording is under legal hold and cannot be deleted")
    return Decision.ok("delete")


def may_view_file(*, is_owner_or_admin: bool, is_starter: bool) -> bool:
    """Who may fetch the FILE (download link). Every member may see the fact."""
    return bool(is_owner_or_admin or is_starter)


__all__ = [
    "RECORDER_ROLE",
    "RECORDER_ENTITLED_KEY",
    "RECORD_MY_CALLS_KEY",
    "POLICY_OFF",
    "POLICY_ON_REQUEST",
    "POLICY_ALWAYS",
    "POLICIES",
    "KIND_AUDIO",
    "KIND_COMPOSITE",
    "STARTABLE_KINDS",
    "Decision",
    "AutoStart",
    "normalize_policy",
    "user_is_entitled",
    "participant_is_entitled",
    "participant_wants_own_calls_recorded",
    "decide_manual_start",
    "decide_manual_stop",
    "decide_auto_start",
    "decide_delete",
    "may_view_file",
]
