"""Artifact (canvas) business logic — framework-agnostic.

Every public function takes an ``AsyncSession`` + domain objects and returns
ORM rows, so the SAME logic backs both the REST API
(``app/api/artifacts.py``) and the Brigade tool callbacks (an agent-side tool
that POSTs to an internal route, authenticated with the LiveKit shared secret,
exactly like ``/internal/agent-messages``).

Design (research-validated, Vercel ai-chatbot / Claude-Artifacts):

  * Versions are FULL SNAPSHOTS, not diffs (``artifact_versions.content`` is
    the complete document). Simpler, race-free, trivially restorable.
  * Three write verbs:
      - ``create_artifact``  -> seq 1.
      - ``rewrite_artifact`` -> replace whole content (default for weaker /
        local models; the model returns the entire new document).
      - ``edit_artifact``    -> deterministic server-side SEARCH/REPLACE
        (the aider / Claude-Code pattern) with a fallback match ladder.
  * ``edit_artifact`` NEVER silently no-ops. If a search block does not match
    exactly once, it raises ``ArtifactEditError`` carrying per-block detail so
    the caller (REST -> 422, or the agent tool -> structured tool error) can
    tell the model precisely what to fix.

Capability gate (enforced by the CALLER, not here): route a frontier model to
``edit_artifact`` (search/replace) and a local/weaker model to
``rewrite_artifact`` (whole-document). This module just executes whichever it
is handed.
"""

from __future__ import annotations

import difflib
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import (
    Artifact,
    ArtifactAuthorKind,
    ArtifactKind,
    ArtifactVersion,
)

logger = structlog.get_logger(__name__)

# Fuzzy ratio below which we refuse to guess (difflib SequenceMatcher.ratio()).
_FUZZY_THRESHOLD = 0.90


# ---------------------------------------------------------------------------
# Structured errors
# ---------------------------------------------------------------------------


class ArtifactError(Exception):
    """Base for artifact domain errors. ``code`` is a stable machine string."""

    code = "artifact_error"

    def __init__(self, message: str, **detail: Any) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail

    def to_dict(self) -> dict[str, Any]:
        return {"error": self.code, "message": self.message, **self.detail}


class ArtifactNotFound(ArtifactError):
    code = "artifact_not_found"


class ArtifactValidationError(ArtifactError):
    code = "artifact_validation_error"


@dataclass
class EditBlockResult:
    """Outcome of trying to apply one search/replace block."""

    index: int
    matched: bool
    strategy: str | None = None  # "exact" | "whitespace" | "fuzzy" | None
    reason: str | None = None
    match_count: int = 0
    # Fuzzy near-miss preview, to help the model self-correct.
    closest_snippet: str | None = None


class ArtifactEditError(ArtifactError):
    """A search/replace edit could not be applied deterministically.

    Carries one ``EditBlockResult`` per requested block so the caller can hand
    the model an actionable, per-block explanation instead of a vague failure.
    """

    code = "artifact_edit_failed"

    def __init__(self, message: str, results: list[EditBlockResult]) -> None:
        super().__init__(
            message,
            blocks=[
                {
                    "index": r.index,
                    "matched": r.matched,
                    "strategy": r.strategy,
                    "reason": r.reason,
                    "match_count": r.match_count,
                    "closest_snippet": r.closest_snippet,
                }
                for r in results
            ],
        )
        self.results = results


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_kind(kind: str | ArtifactKind) -> ArtifactKind:
    if isinstance(kind, ArtifactKind):
        return kind
    try:
        return ArtifactKind(str(kind).lower())
    except ValueError as exc:
        valid = ", ".join(k.value for k in ArtifactKind)
        raise ArtifactValidationError(
            f"Unknown artifact kind {kind!r}. Valid kinds: {valid}.",
            given=str(kind),
        ) from exc


def _ws_normalize(s: str) -> str:
    """Collapse runs of whitespace to a single space and strip line ends.

    Used by ladder rung 2 so indentation / trailing-space drift between what
    the model "remembers" and the stored content does not block a match.
    """
    return re.sub(r"\s+", " ", s).strip()


async def _next_seq(db: AsyncSession, artifact_id: uuid.UUID) -> int:
    current_max = (
        await db.execute(
            select(func.max(ArtifactVersion.seq)).where(
                ArtifactVersion.artifact_id == artifact_id
            )
        )
    ).scalar_one_or_none()
    return int(current_max or 0) + 1


def _coerce_uuid(value: Any) -> uuid.UUID | None:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


async def _append_version(
    db: AsyncSession,
    *,
    artifact: Artifact,
    content: str,
    author_kind: ArtifactAuthorKind,
    author_id: uuid.UUID | None,
    edit_op: dict[str, Any] | None,
    parent_version_id: uuid.UUID | None,
) -> ArtifactVersion:
    """Create the next full-snapshot version and point the artifact head at it.

    Flushes (not commits) so callers compose this into their own transaction;
    the REST/internal handlers own the final ``commit()``.
    """
    seq = await _next_seq(db, artifact.id)
    version = ArtifactVersion(
        artifact_id=artifact.id,
        seq=seq,
        content=content,
        parent_version_id=parent_version_id,
        author_kind=author_kind,
        author_id=author_id,
        edit_op=edit_op or {},
    )
    db.add(version)
    await db.flush()  # assign version.id without ending the txn
    artifact.current_version_id = version.id
    await db.flush()
    return version


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


async def get_artifact(db: AsyncSession, artifact_id: uuid.UUID) -> Artifact:
    artifact = (
        await db.execute(select(Artifact).where(Artifact.id == artifact_id))
    ).scalar_one_or_none()
    if artifact is None:
        raise ArtifactNotFound("Artifact not found.", artifact_id=str(artifact_id))
    return artifact


async def list_room_artifacts(
    db: AsyncSession, room_id: uuid.UUID
) -> list[Artifact]:
    rows = (
        await db.execute(
            select(Artifact)
            .where(Artifact.room_id == room_id)
            .order_by(Artifact.updated_at.desc())
        )
    ).scalars().all()
    return list(rows)


async def get_versions(
    db: AsyncSession, artifact_id: uuid.UUID
) -> list[ArtifactVersion]:
    rows = (
        await db.execute(
            select(ArtifactVersion)
            .where(ArtifactVersion.artifact_id == artifact_id)
            .order_by(ArtifactVersion.seq.asc())
        )
    ).scalars().all()
    return list(rows)


async def get_current_content(db: AsyncSession, artifact: Artifact) -> str:
    """Return the head version's content ("" if the artifact has no versions)."""
    if artifact.current_version_id is None:
        return ""
    version = (
        await db.execute(
            select(ArtifactVersion).where(
                ArtifactVersion.id == artifact.current_version_id
            )
        )
    ).scalar_one_or_none()
    return version.content if version else ""


# ---------------------------------------------------------------------------
# Write — create / rewrite / edit / restore
# ---------------------------------------------------------------------------


async def create_artifact(
    db: AsyncSession,
    *,
    room_id: uuid.UUID,
    title: str,
    kind: str | ArtifactKind = ArtifactKind.MARKDOWN,
    content: str = "",
    language: str | None = None,
    author_kind: ArtifactAuthorKind = ArtifactAuthorKind.HUMAN,
    author_id: uuid.UUID | None = None,
    org_id: uuid.UUID | None = None,
) -> Artifact:
    """Create an artifact + its seq-1 version snapshot.

    Caller is responsible for room-membership authz and the final commit.
    """
    title = (title or "").strip()
    if not title:
        raise ArtifactValidationError("Artifact title is required.")
    art_kind = _normalize_kind(kind)

    artifact = Artifact(
        room_id=room_id,
        org_id=org_id,
        title=title[:255],
        kind=art_kind,
        language=(language or None),
        created_by=author_id,
    )
    db.add(artifact)
    await db.flush()  # assign artifact.id

    await _append_version(
        db,
        artifact=artifact,
        content=content or "",
        author_kind=author_kind,
        author_id=author_id,
        edit_op={"op": "create"},
        parent_version_id=None,
    )
    logger.info(
        "artifact_created",
        artifact_id=str(artifact.id),
        room_id=str(room_id),
        kind=art_kind.value,
    )
    return artifact


async def rewrite_artifact(
    db: AsyncSession,
    *,
    artifact: Artifact,
    content: str,
    author_kind: ArtifactAuthorKind = ArtifactAuthorKind.HUMAN,
    author_id: uuid.UUID | None = None,
    summary: str | None = None,
) -> ArtifactVersion:
    """Whole-document replacement -> a new full version.

    Default path for weaker/local models, which return the ENTIRE new document
    rather than a surgical patch. Always succeeds (no matching to fail).
    """
    if content is None:
        raise ArtifactValidationError("rewrite requires content.")
    parent_id = _coerce_uuid(artifact.current_version_id)
    return await _append_version(
        db,
        artifact=artifact,
        content=content,
        author_kind=author_kind,
        author_id=author_id,
        edit_op={"op": "rewrite", **({"summary": summary} if summary else {})},
        parent_version_id=parent_id,
    )


def _find_exact(haystack: str, needle: str) -> tuple[int, int]:
    """Return (count, start_index) for exact occurrences of needle."""
    if needle == "":
        return (0, -1)
    count = haystack.count(needle)
    idx = haystack.find(needle) if count else -1
    return (count, idx)


def _splice_window(content: str, start: int, end: int, replace: str) -> str:
    """Replace content[start:end] with ``replace``, preserving the window's
    trailing newline when the matched span ended a line but the replacement
    does not. Keeps line boundaries intact for the whitespace/fuzzy rungs
    (the exact rung splices a literal substring and never calls this).
    """
    matched = content[start:end]
    if matched.endswith("\n") and not replace.endswith("\n"):
        replace = replace + "\n"
    return content[:start] + replace + content[end:]


def _apply_one_edit(content: str, search: str, replace: str, replace_all: bool) -> tuple[str | None, EditBlockResult, int]:
    """Apply a single search/replace block with the fallback ladder.

    Ladder: (1) exact, (2) whitespace-normalized line window, (3) difflib fuzzy.
    Returns (new_content_or_None, result, index_hint). ``new_content`` is None
    when the block could not be applied unambiguously.
    """
    # --- Rung 1: exact ---
    count, idx = _find_exact(content, search)
    if count == 1:
        new_content = (
            content.replace(search, replace)
            if replace_all
            else content[:idx] + replace + content[idx + len(search):]
        )
        return new_content, EditBlockResult(index=0, matched=True, strategy="exact", match_count=1), idx
    if count > 1:
        if replace_all:
            return content.replace(search, replace), EditBlockResult(
                index=0, matched=True, strategy="exact", match_count=count
            ), idx
        return None, EditBlockResult(
            index=0,
            matched=False,
            strategy="exact",
            match_count=count,
            reason=(
                f"search block matched {count} times; pass replace_all=true or "
                "add surrounding context to make it unique."
            ),
        ), idx

    # --- Rung 2: whitespace-normalized sliding window over lines ---
    lines = content.splitlines(keepends=True)
    search_norm = _ws_normalize(search)
    search_line_count = max(1, len(search.splitlines()))
    ws_matches: list[tuple[int, int]] = []  # (start_char, end_char)
    char_offsets: list[int] = []
    running = 0
    for ln in lines:
        char_offsets.append(running)
        running += len(ln)
    char_offsets.append(running)
    for start in range(0, max(1, len(lines) - search_line_count + 1)):
        window = "".join(lines[start:start + search_line_count])
        if _ws_normalize(window) == search_norm:
            ws_matches.append((char_offsets[start], char_offsets[start + search_line_count]))
    if len(ws_matches) == 1:
        s, e = ws_matches[0]
        return _splice_window(content, s, e, replace), EditBlockResult(
            index=0, matched=True, strategy="whitespace", match_count=1
        ), s
    if len(ws_matches) > 1 and not replace_all:
        return None, EditBlockResult(
            index=0,
            matched=False,
            strategy="whitespace",
            match_count=len(ws_matches),
            reason="whitespace-normalized search matched multiple windows; add context.",
        ), -1

    # --- Rung 3: difflib fuzzy (best single window) ---
    best_ratio = 0.0
    best_span: tuple[int, int] | None = None
    best_preview: str | None = None
    for start in range(0, max(1, len(lines) - search_line_count + 1)):
        window = "".join(lines[start:start + search_line_count])
        ratio = difflib.SequenceMatcher(None, search, window).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_span = (char_offsets[start], char_offsets[start + search_line_count])
            best_preview = window
    if best_span is not None and best_ratio >= _FUZZY_THRESHOLD:
        s, e = best_span
        return _splice_window(content, s, e, replace), EditBlockResult(
            index=0, matched=True, strategy="fuzzy", match_count=1
        ), s
    return None, EditBlockResult(
        index=0,
        matched=False,
        strategy=None,
        match_count=0,
        reason=(
            "no exact, whitespace, or fuzzy match found"
            + (f" (closest similarity {best_ratio:.2f})" if best_span is not None else "")
        ),
        closest_snippet=(best_preview[:200] if best_preview else None),
    ), -1


def apply_edits(content: str, edits: list[dict[str, Any]]) -> str:
    """Pure function: apply an ordered list of search/replace edits to a string.

    Each edit = ``{"search": str, "replace": str, "replace_all"?: bool}``.
    Edits are applied sequentially (each sees the result of the previous).
    Raises ``ArtifactEditError`` (with per-block results) on the FIRST block
    that cannot be applied unambiguously — no partial application is persisted
    because callers run this before creating a version.
    """
    if not edits:
        raise ArtifactValidationError("edit requires a non-empty 'edits' list.")
    results: list[EditBlockResult] = []
    working = content
    failed = False
    for i, edit in enumerate(edits):
        if not isinstance(edit, dict) or "search" not in edit or "replace" not in edit:
            res = EditBlockResult(
                index=i, matched=False, reason="each edit needs 'search' and 'replace' string fields."
            )
            results.append(res)
            failed = True
            break
        search = str(edit.get("search", ""))
        replace = str(edit.get("replace", ""))
        replace_all = bool(edit.get("replace_all", False))
        if search == "":
            results.append(EditBlockResult(index=i, matched=False, reason="empty search block."))
            failed = True
            break
        new_content, res, _ = _apply_one_edit(working, search, replace, replace_all)
        res.index = i
        results.append(res)
        if new_content is None:
            failed = True
            break
        working = new_content
    if failed:
        raise ArtifactEditError(
            "One or more edit blocks could not be applied. No changes were saved.",
            results,
        )
    return working


async def edit_artifact(
    db: AsyncSession,
    *,
    artifact: Artifact,
    edits: list[dict[str, Any]],
    author_kind: ArtifactAuthorKind = ArtifactAuthorKind.AGENT,
    author_id: uuid.UUID | None = None,
    summary: str | None = None,
) -> ArtifactVersion:
    """Apply deterministic server-side SEARCH/REPLACE edits -> a new version.

    Raises ``ArtifactEditError`` (structured, per-block) if any block fails to
    match exactly once. On success records a new full snapshot with the edit
    operations preserved in ``edit_op`` for audit/replay.
    """
    base_content = await get_current_content(db, artifact)
    new_content = apply_edits(base_content, edits)  # may raise ArtifactEditError
    parent_id = _coerce_uuid(artifact.current_version_id)
    return await _append_version(
        db,
        artifact=artifact,
        content=new_content,
        author_kind=author_kind,
        author_id=author_id,
        edit_op={
            "op": "edit",
            "edits": [
                {
                    "search": str(e.get("search", "")),
                    "replace": str(e.get("replace", "")),
                    "replace_all": bool(e.get("replace_all", False)),
                }
                for e in edits
            ],
            **({"summary": summary} if summary else {}),
        },
        parent_version_id=parent_id,
    )


async def restore_version(
    db: AsyncSession,
    *,
    artifact: Artifact,
    target_version_id: uuid.UUID,
    author_kind: ArtifactAuthorKind = ArtifactAuthorKind.HUMAN,
    author_id: uuid.UUID | None = None,
) -> ArtifactVersion:
    """Restore by appending a NEW version whose content == the target's.

    History is append-only: restoring never deletes intervening versions, it
    creates a fresh head that copies an older snapshot (parent = the target).
    """
    target = (
        await db.execute(
            select(ArtifactVersion).where(
                ArtifactVersion.id == target_version_id,
                ArtifactVersion.artifact_id == artifact.id,
            )
        )
    ).scalar_one_or_none()
    if target is None:
        raise ArtifactNotFound(
            "Target version not found for this artifact.",
            artifact_id=str(artifact.id),
            version_id=str(target_version_id),
        )
    return await _append_version(
        db,
        artifact=artifact,
        content=target.content,
        author_kind=author_kind,
        author_id=author_id,
        edit_op={"op": "restore", "from_version_id": str(target_version_id), "from_seq": target.seq},
        parent_version_id=target.id,
    )


__all__ = [
    "ArtifactError",
    "ArtifactNotFound",
    "ArtifactValidationError",
    "ArtifactEditError",
    "EditBlockResult",
    "get_artifact",
    "list_room_artifacts",
    "get_versions",
    "get_current_content",
    "create_artifact",
    "rewrite_artifact",
    "apply_edits",
    "edit_artifact",
    "restore_version",
]
