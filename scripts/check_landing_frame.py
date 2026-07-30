#!/usr/bin/env python3
"""Verify the public first-visit landing can render in Stable's own iframe."""

from __future__ import annotations

import sys
import urllib.request
from urllib.parse import urljoin


def fetch(url: str) -> tuple[dict[str, str], bytes]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "unicorn-stable-release-check/1.0"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return {key.lower(): value for key, value in response.headers.items()}, response.read()


def main() -> int:
    base_url = sys.argv[1] if len(sys.argv) > 1 else "https://stable.magicunicorn.dev/"
    root_headers, _ = fetch(base_url)
    landing_headers, landing = fetch(urljoin(base_url, "/stable-landing.html"))

    failures: list[str] = []
    for label, headers in (("root", root_headers), ("landing", landing_headers)):
        x_frame_options = headers.get("x-frame-options", "").upper()
        if x_frame_options != "SAMEORIGIN":
            failures.append(f"{label}: X-Frame-Options is {x_frame_options or 'missing'}")
        csp = headers.get("content-security-policy", "")
        if "frame-ancestors 'self'" not in csp:
            failures.append(f"{label}: CSP does not allow same-origin frame ancestors")
        if "frame-ancestors 'none'" in csp:
            failures.append(f"{label}: CSP still blocks every frame ancestor")
        if "https://analytics.unicorncommander.ai" not in csp:
            failures.append(f"{label}: CSP blocks the landing analytics script")

    if b"stable:enter" not in landing or b"Enter Stable" not in landing:
        failures.append("landing: expected entry contract is missing")

    if failures:
        for failure in failures:
            print(f"landing frame check failed: {failure}", file=sys.stderr)
        return 1

    print("  ✓ landing frame: same-origin allowed, cross-origin blocked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
