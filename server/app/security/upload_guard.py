"""Upload MIME guarding + safe-download hardening (B4: stored-XSS defense).

The attack this closes: a user uploads ``evil.html`` (or an SVG with an inline
``<script>``, or an HTML file mislabeled as ``image/png``). If the server later
serves that file inline with a renderable ``Content-Type`` at the app's own
origin, opening it executes attacker JavaScript in a first-party context — and
because the SPA silently re-authenticates via Keycloak ``check-sso``, that JS
can lift a fresh suite-wide session. Cross-suite account takeover from a file
upload.

Three independent layers defeat it, any one of which is sufficient:

1. **Reject dangerous declared types** at upload — html / xhtml / svg / xml /
   javascript can all execute in a browser rendering context.
2. **Sniff the actual bytes** so a dangerous payload can't sneak in under a
   benign ``Content-Type`` (the client controls that header).
3. **Neutralize on the way out** — never serve a dangerous type with a
   renderable media type; force ``Content-Disposition: attachment`` +
   ``X-Content-Type-Options: nosniff`` for anything not on a tiny inline-safe
   allowlist, and slap ``Content-Security-Policy: default-src 'none'; sandbox``
   on every attachment response so even a served payload can't do anything.
"""

from __future__ import annotations

# Content types that a browser can execute script from when rendered inline.
# Matched case-insensitively as a prefix OR by the ``+xml`` suffix family.
_DANGEROUS_EXACT = frozenset(
    {
        "text/html",
        "application/xhtml+xml",
        "image/svg+xml",
        "application/xml",
        "text/xml",
        "application/javascript",
        "text/javascript",
        "application/ecmascript",
        "text/ecmascript",
        "application/x-javascript",
        "text/vbscript",
        "application/mathml+xml",
    }
)

# File suffixes that must never survive onto disk with their original extension
# (a stored ``.html`` would make ``mimetypes.guess_type`` re-derive text/html on
# download). We strip these to no-suffix so the served type falls back to
# octet-stream regardless.
_DANGEROUS_SUFFIXES = frozenset(
    {
        ".html", ".htm", ".xhtml", ".shtml", ".xml", ".svg", ".svgz",
        ".js", ".mjs", ".cjs", ".vbs", ".xht", ".xsl", ".xslt", ".mathml",
    }
)

# The ONLY types we ever serve inline. Everything else downloads as an
# attachment. SVG is deliberately absent (it can carry script); it downloads.
_INLINE_SAFE = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/x-icon",
        "image/avif",
        "application/pdf",
    }
)


def is_dangerous_content_type(content_type: str | None) -> bool:
    """True if a browser could execute script when rendering this type."""
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    if not ct:
        return False
    if ct in _DANGEROUS_EXACT:
        return True
    # Any structured ``+xml`` type (e.g. image/svg+xml, application/*+xml) can
    # carry XML/HTML that a browser may render.
    return ct.endswith("+xml")


def dangerous_suffix(suffix: str | None) -> bool:
    """True if this file suffix is one we must not persist verbatim."""
    return (suffix or "").lower() in _DANGEROUS_SUFFIXES


def sniff_is_markup(head: bytes) -> bool:
    """Heuristic byte sniff: does the payload look like HTML/SVG/XML/script?

    Catches a dangerous payload smuggled under a benign declared type. We only
    need the leading bytes; whitespace and a UTF-8/UTF-16 BOM are skipped. This
    is intentionally aggressive (false positives merely reject an upload) but
    only fires on markup signatures, so a real PNG/PDF/plain-text doc passes.
    """
    if not head:
        return False
    # Strip common BOMs.
    for bom in (b"\xef\xbb\xbf", b"\xff\xfe", b"\xfe\xff"):
        if head.startswith(bom):
            head = head[len(bom):]
            break
    # Look only at the leading window, lowercased.
    window = head[:1024].lstrip().lower()
    if not window:
        return False
    signatures = (
        b"<!doctype html",
        b"<html",
        b"<head",
        b"<body",
        b"<svg",
        b"<script",
        b"<?xml",
        b"<!entity",
        b"<xsl:",
    )
    return any(window.startswith(sig) or sig in window[:512] for sig in signatures)


def safe_download_headers(
    guessed_media_type: str | None,
    filename: str,
) -> tuple[str, dict[str, str]]:
    """Return ``(media_type, headers)`` for serving an attachment safely.

    - Dangerous types are downgraded to ``application/octet-stream``.
    - Only ``_INLINE_SAFE`` types render inline; everything else is forced to
      ``attachment`` so the browser downloads rather than renders it.
    - ``X-Content-Type-Options: nosniff`` stops MIME-sniffing a text file into
      HTML; a locked-down CSP neutralizes anything that is served.
    """
    ct = (guessed_media_type or "application/octet-stream").split(";", 1)[0].strip().lower()
    if is_dangerous_content_type(ct):
        ct = "application/octet-stream"

    inline = ct in _INLINE_SAFE
    disposition = "inline" if inline else "attachment"
    # Quote the filename defensively (strip control chars / quotes).
    safe_name = "".join(c for c in (filename or "download") if c.isprintable() and c not in '"\\')[:200] or "download"

    headers = {
        "Content-Disposition": f'{disposition}; filename="{safe_name}"',
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
        "Cache-Control": "private, max-age=3600",
    }
    return ct, headers
