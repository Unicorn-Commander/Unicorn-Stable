"""Document text extraction + chunking for RAG.

Pure, dependency-light helpers used by ``rag_service`` to turn an uploaded
attachment on disk into a list of embeddable text chunks. Everything here is
synchronous and best-effort: on any failure (corrupt file, missing optional
dependency, unknown type) we return an empty string / empty list rather than
raise, so the RAG pipeline stays fail-safe end to end.

Supported in v1:
  * PDF   → pypdf (per-page text)
  * docx  → python-docx (paragraph + table text)
  * text/*, application/json → utf-8 decode (errors ignored)
Unknown / unsupported (xlsx, pptx, scanned PDFs needing OCR, …) → "" so the
caller skips them gracefully. These are noted as future work.
"""

from __future__ import annotations

import json
import re

import structlog

logger = structlog.get_logger(__name__)


def _extract_pdf(path: str) -> str:
    try:
        from pypdf import PdfReader
    except Exception:
        logger.warning("doc_extract_pypdf_missing")
        return ""
    try:
        reader = PdfReader(path)
        parts: list[str] = []
        for page in reader.pages:
            try:
                txt = page.extract_text() or ""
            except Exception:
                txt = ""
            if txt:
                parts.append(txt)
        return "\n\n".join(parts)
    except Exception:
        logger.warning("doc_extract_pdf_failed", path=path, exc_info=True)
        return ""


def _extract_docx(path: str) -> str:
    try:
        import docx  # python-docx
    except Exception:
        logger.warning("doc_extract_python_docx_missing")
        return ""
    try:
        document = docx.Document(path)
        parts: list[str] = [p.text for p in document.paragraphs if p.text and p.text.strip()]
        # Pull text out of tables too — contracts/specs often live in tables.
        for table in getattr(document, "tables", []):
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text and c.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))
        return "\n".join(parts)
    except Exception:
        logger.warning("doc_extract_docx_failed", path=path, exc_info=True)
        return ""


def _extract_text(path: str) -> str:
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
        return raw.decode("utf-8", errors="ignore")
    except Exception:
        logger.warning("doc_extract_text_failed", path=path, exc_info=True)
        return ""


def _extract_json(path: str) -> str:
    """Decode JSON to a readable string. Falls back to raw utf-8 on parse error
    so even malformed JSON still yields searchable text."""
    raw = _extract_text(path)
    if not raw:
        return ""
    try:
        obj = json.loads(raw)
        return json.dumps(obj, indent=2, ensure_ascii=False, default=str)
    except Exception:
        return raw


def extract_text(path: str, content_type: str, filename: str) -> str:
    """Extract plain text from a file on disk.

    Dispatch is by content_type first, then by filename extension as a
    fallback (browsers sometimes send ``application/octet-stream`` for known
    types). Returns "" for anything we can't handle — never raises.
    """
    ct = (content_type or "").lower()
    name = (filename or "").lower()

    is_pdf = ct == "application/pdf" or name.endswith(".pdf")
    is_docx = (
        ct == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        or name.endswith(".docx")
    )
    is_json = ct == "application/json" or name.endswith(".json")
    is_text = ct.startswith("text/") or name.endswith(
        (".txt", ".md", ".csv", ".log", ".rst", ".text")
    )

    try:
        if is_pdf:
            return _extract_pdf(path)
        if is_docx:
            return _extract_docx(path)
        if is_json:
            return _extract_json(path)
        if is_text:
            return _extract_text(path)
    except Exception:
        logger.warning(
            "doc_extract_failed", content_type=ct, filename=filename, exc_info=True
        )
        return ""

    # Unknown / unsupported (xlsx, pptx, images, scanned PDFs → OCR): future work.
    logger.info("doc_extract_unsupported_type", content_type=ct, filename=filename)
    return ""


# Split on paragraph breaks first, then sentence-ish boundaries, so chunks land
# on natural edges instead of mid-word.
_PARA_RE = re.compile(r"\n\s*\n")
_SENT_RE = re.compile(r"(?<=[.!?])\s+")


def _split_units(text: str) -> list[str]:
    units: list[str] = []
    for para in _PARA_RE.split(text):
        para = para.strip()
        if not para:
            continue
        units.append(para)
    return units


def chunk_text(text: str, target_chars: int = 1200, overlap: int = 200) -> list[str]:
    """Char-based chunking on paragraph/sentence boundaries.

    Greedily packs paragraphs up to ``target_chars``; paragraphs longer than
    the target are split on sentence boundaries (and hard-split if a single
    sentence still overflows). Consecutive chunks share ``overlap`` trailing
    characters so context isn't lost at the seams. Simple but solid for v1.
    """
    text = (text or "").strip()
    if not text:
        return []
    target_chars = max(200, int(target_chars))
    overlap = max(0, min(int(overlap), target_chars // 2))

    # First, normalise into pieces no larger than target_chars.
    pieces: list[str] = []
    for unit in _split_units(text):
        if len(unit) <= target_chars:
            pieces.append(unit)
            continue
        # Paragraph too big — break on sentences.
        current = ""
        for sent in _SENT_RE.split(unit):
            sent = sent.strip()
            if not sent:
                continue
            if len(sent) > target_chars:
                # A single monster sentence — flush, then hard-slice it.
                if current:
                    pieces.append(current)
                    current = ""
                for i in range(0, len(sent), target_chars):
                    pieces.append(sent[i : i + target_chars])
                continue
            if current and len(current) + 1 + len(sent) > target_chars:
                pieces.append(current)
                current = sent
            else:
                current = f"{current} {sent}".strip() if current else sent
        if current:
            pieces.append(current)

    # Greedily pack pieces into chunks, adding overlap between them.
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        if current and len(current) + 2 + len(piece) > target_chars:
            chunks.append(current)
            tail = current[-overlap:] if overlap else ""
            current = f"{tail}\n\n{piece}".strip() if tail else piece
        else:
            current = f"{current}\n\n{piece}".strip() if current else piece
    if current:
        chunks.append(current)

    return [c for c in (c.strip() for c in chunks) if c]
