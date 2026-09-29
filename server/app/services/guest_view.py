"""What a GUEST may see of a message (Nav v3, REVIEW-4 P2-2).

A guest is an outsider let into one room. The roster already hides who owns
each seat and which agents have shell hands; the message feed told the same
story through metadata: every gateway line carries ``gateway: true`` and
``agent_id``, and a JWT-path seat's line carries ``on_behalf_of`` — a
Keycloak subject.

These helpers shape what LEAVES the server for a guest: the list route and
the WebSocket echo. They never change what is stored, and members keep
everything.
"""

from __future__ import annotations

from typing import Any

#: Message-metadata keys a guest never receives.
GUEST_HIDDEN_METADATA_KEYS: frozenset[str] = frozenset({"gateway", "on_behalf_of", "agent_id"})


def guest_view_of_metadata(metadata: Any) -> Any:
    """``metadata`` without the hidden keys. A copy when something was
    removed; the same object otherwise (non-dicts pass through)."""
    if not isinstance(metadata, dict) or not (GUEST_HIDDEN_METADATA_KEYS & set(metadata)):
        return metadata
    return {k: v for k, v in metadata.items() if k not in GUEST_HIDDEN_METADATA_KEYS}


def guest_view_of_message(message: Any) -> Any:
    """A message response (pydantic model or dict) as a guest gets it. The
    input is never mutated: the same response object may be on its way to a
    member too."""
    if isinstance(message, dict):
        metadata = message.get("metadata")
        cleaned = guest_view_of_metadata(metadata)
        return message if cleaned is metadata else {**message, "metadata": cleaned}
    metadata = getattr(message, "metadata", None)
    cleaned = guest_view_of_metadata(metadata)
    if cleaned is metadata:
        return message
    return message.model_copy(update={"metadata": cleaned})


def guest_view_of_envelope(envelope: Any) -> Any:
    """A WebSocket envelope as a guest's socket gets it: any
    ``payload.message`` loses the hidden metadata keys. Everything else
    passes through untouched; the input is never mutated (the same decoded
    frame is not shared, but the rule costs nothing to keep)."""
    if not isinstance(envelope, dict):
        return envelope
    payload = envelope.get("payload")
    if not isinstance(payload, dict) or not isinstance(payload.get("message"), dict):
        return envelope
    cleaned = guest_view_of_message(payload["message"])
    if cleaned is payload["message"]:
        return envelope
    return {**envelope, "payload": {**payload, "message": cleaned}}


__all__ = [
    "GUEST_HIDDEN_METADATA_KEYS",
    "guest_view_of_envelope",
    "guest_view_of_message",
    "guest_view_of_metadata",
]
