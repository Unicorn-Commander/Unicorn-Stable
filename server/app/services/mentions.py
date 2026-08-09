"""Mention parsing shared by every notification fan-out surface.

One parser, one truth. Three surfaces react to an @-mention — the durable
badge/inbox path (services/message_service), the offline web-push path
(services/push_service) and the offline email path (api/messages) — and they
must agree on what a message mentions. They did not: push and email tokenized
``@here`` / ``@channel`` into the handles ``here`` / ``channel`` and compared
them against ``Participant.username``, a field where those keywords can never
match, so broadcast mentions resolved to ZERO push/email recipients. This
module owns the token grammar, the broadcast classification, and the one
field explicit handles are matched against (the login ``username``).

Broadcast semantics (the user-facing contract is the composer cheatsheet,
web/src/components/Layout/CheatsheetModal.tsx):

- ``@channel`` — "Notify everyone in this channel". Every room member except
  the sender gets the durable mention badge + Activity-inbox row, and every
  human member not actively online also gets the offline channels (web-push
  + email) — the same offline predicate personal @user mentions use.
- ``@here`` — "Notify online members only". Members present right now are
  reached over the realtime plane, and the durable badge/inbox row still
  lands for every member (the inbox is a catch-up surface, and DB presence
  for chat-only humans is written only by the LiveKit voice webhooks, so it
  is too unreliable to gate a durable record on). ``@here`` deliberately
  contributes NOTHING to the offline channels: web-push and email exist to
  reach people who are away, which is exactly who ``@here`` promises not to
  disturb. Explicit @user handles in the same message still get theirs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Sequence, TypeVar

# The historical token grammar from push_service/api.messages, kept verbatim
# so personal-handle matching is byte-for-byte unchanged.
MENTION_TOKEN_RE = re.compile(r"@([A-Za-z0-9_.\-]{2,64})")

# Trailing characters the token class over-eats ("@here." captures "here.").
# Stripped for classification AND for handle matching so "@bob." finds bob.
_TRAILING_PUNCT = "._-"


@dataclass(frozen=True)
class ParsedMentions:
    """What one message's content @-mentions."""

    handles: frozenset[str]  # explicit @user handles, casefolded, broadcasts excluded
    here: bool
    channel: bool

    @property
    def broadcast(self) -> bool:
        """True when the message addresses the whole room (either token)."""
        return self.here or self.channel

    @property
    def broad_kind(self) -> str | None:
        """Wire label for the realtime broadcast: channel wins over here."""
        if self.channel:
            return "channel"
        if self.here:
            return "here"
        return None


def parse_mentions(content: str | None) -> ParsedMentions:
    """Tokenize ``content`` into explicit handles + broadcast flags.

    Word-boundary correct where the old substring checks were not:
    "@hereabouts" is a personal handle, not a broadcast; "@Here" and
    "@CHANNEL," are broadcasts.
    """
    handles: set[str] = set()
    here = False
    channel = False
    for token in MENTION_TOKEN_RE.findall(content or ""):
        raw = token.casefold()
        norm = raw.rstrip(_TRAILING_PUNCT)
        if norm == "here":
            here = True
        elif norm == "channel":
            channel = True
        else:
            # Keep the raw token (usernames MAY legally end in ._-) and add
            # the trimmed form so "@bob." still finds bob. Set-membership
            # matching means the extra alias can only add a hit, never lose
            # one.
            handles.add(raw)
            if norm and norm != raw:
                handles.add(norm)
    return ParsedMentions(handles=frozenset(handles), here=here, channel=channel)


_P = TypeVar("_P")


def _username_of(participant: object) -> str:
    return ((getattr(participant, "username", None) or "")).casefold()


def mentions_participant(pm: ParsedMentions, participant: object) -> bool:
    """Does this content mention ``participant`` (personally or broadcast)?

    Explicit handles match the login USERNAME — the only stable identifier a
    typed @token can promise to be. Never the display name, never an email.
    """
    return pm.broadcast or _username_of(participant) in pm.handles


def offline_notify_targets(
    pm: ParsedMentions, candidates: Sequence[_P] | Iterable[_P]
) -> list[_P]:
    """Subset of ``candidates`` owed an OFFLINE-channel notification
    (web-push / email) for this content.

    ``@channel`` expands to every candidate; ``@here`` deliberately expands
    to none (see module docstring); explicit handles match the USERNAME
    field. Callers pass candidates already scoped to: room members, humans,
    not the sender, not actively online.
    """
    pool = list(candidates)
    if pm.channel:
        return pool
    if not pm.handles:
        return []
    return [p for p in pool if _username_of(p) in pm.handles]


__all__ = [
    "MENTION_TOKEN_RE",
    "ParsedMentions",
    "mentions_participant",
    "offline_notify_targets",
    "parse_mentions",
]
