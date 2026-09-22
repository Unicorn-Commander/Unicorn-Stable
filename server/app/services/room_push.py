"""New-room push (design §3, L2 item 7): every room created FOR a member is
pushed to that member's open sockets, so a phone that was asleep or looking
elsewhere never needs a restart to see it (Aaron's 09-09 bug).

One event name — ``room_invited`` — because that is the one the web client
already handles (``useGlobalNotifications``: sound cue, a toast only when
``inviter_name`` is present, and a rooms refetch always). ``kind`` lets a
client style hub / thread / group / invite / project channel differently and
``parent_room_id`` lets it nest a thread without a refetch.

The creator's OWN sockets are pushed without ``inviter_name`` so they get the
refetch (their phone learns about the room they just made on the desktop)
but not a "you were invited" toast.

Published to Redis ``user:{participant_id}`` through
:func:`app.api.messages._ws_send_participant` (cross-worker). Best-effort:
never raises, never delays the request that created the room.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

import structlog

logger = structlog.get_logger(__name__)

#: The event name the web client already subscribes to.
ROOM_INVITED = "room_invited"

#: ``payload.kind`` values.
PUSH_KINDS: tuple[str, ...] = (
    "hub",
    "thread",
    "group",
    "invite",
    "project_channel",
)


def room_push_payload(
    *,
    room_id: Any,
    kind: str,
    inviter_name: str | None = None,
    parent_room_id: Any = None,
    display_name: str | None = None,
    room_type: str | None = None,
) -> dict[str, Any]:
    """The ``room_invited`` payload. ``inviter_name`` is omitted (not null)
    when absent so the web's ``event.inviter_name ? toast : refetch-only``
    branch keeps working unchanged."""
    if kind not in PUSH_KINDS:
        raise ValueError(f"unknown push kind: {kind}")
    payload: dict[str, Any] = {"room_id": str(room_id), "kind": kind}
    if inviter_name:
        payload["inviter_name"] = inviter_name
    if parent_room_id is not None:
        payload["parent_room_id"] = str(parent_room_id)
    if display_name:
        payload["display_name"] = display_name
    if room_type:
        payload["room_type"] = room_type
    return payload


async def push_room_to_participants(
    participant_ids: Iterable[Any],
    *,
    room_id: Any,
    kind: str,
    inviter_name: str | None = None,
    self_id: Any = None,
    parent_room_id: Any = None,
    display_name: str | None = None,
    room_type: str | None = None,
) -> int:
    """Push ``room_invited`` to every id in ``participant_ids`` (deduplicated).

    ``self_id`` is the actor: they are pushed WITHOUT ``inviter_name`` (refetch,
    no toast). Returns the number of pushes attempted; a failed publish is
    logged and counted as attempted — the caller has nothing useful to do
    about it and must not fail the request.
    """
    seen: set[str] = set()
    sent = 0
    for pid in participant_ids:
        if pid is None:
            continue
        key = str(pid)
        if key in seen:
            continue
        seen.add(key)
        is_self = self_id is not None and key == str(self_id)
        payload = room_push_payload(
            room_id=room_id,
            kind=kind,
            inviter_name=None if is_self else inviter_name,
            parent_room_id=parent_room_id,
            display_name=display_name,
            room_type=room_type,
        )
        try:
            from app.api.messages import _ws_send_participant

            await _ws_send_participant(key, {"type": ROOM_INVITED, "payload": payload})
        except Exception:
            logger.warning("room_push_failed", participant_id=key, kind=kind, exc_info=True)
        sent += 1
    return sent


__all__ = [
    "ROOM_INVITED",
    "PUSH_KINDS",
    "room_push_payload",
    "push_room_to_participants",
]
