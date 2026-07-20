#!/usr/bin/env python3
"""Assert the federation server rail survived a deploy.

WHY THIS EXISTS
---------------
The web image BAKES an empty ``instances.json`` (``[]``) — the correct default
for a single-instance deploy. A federated deploy's real list reaches nginx as a
bind mount declared in ``docker-compose.yml`` (host path from
``$STABLE_INSTANCES_FILE``).

If that mount is ever lost — a deploy that drops an out-of-tree ``-f`` override,
a missing env var, a per-org compose re-rendered without the line — nginx does
not error. It serves the baked ``[]``, the ServerRail renders empty, and the
deploy reports success. That silent fallback is exactly what this guard makes
loud.

It compares two INDEPENDENT sources rather than re-deriving one from the other:

  * EXPECTED — the host file that ``docker compose config`` says is mounted at
    ``/usr/share/nginx/html/instances.json``. Asking compose (instead of
    re-reading .env ourselves) means the answer reflects every ``-f`` file, env
    var and default that actually applied.
  * SERVED   — what the public URL actually returns, through Traefik and nginx.

Exit 0 when they agree, 1 when the served rail lost entries the host file has.
An expected-empty list is fine — that IS the single-instance default — so this
only fails when a non-empty list silently became empty or shorter.

Usage: check_server_rail.py <compose-project> <external-url>
"""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.request

CONTAINER_PATH = "/usr/share/nginx/html/instances.json"


def _entries(blob, what):
    """Parse a rail list, tolerating anything that isn't a JSON array."""
    try:
        data = json.loads(blob)
    except Exception as e:
        print(f"  ✋ {what} is not valid JSON: {e}")
        return None
    if not isinstance(data, list):
        print(f"  ✋ {what} is not a JSON array (got {type(data).__name__})")
        return None
    return [e.get("id", "?") if isinstance(e, dict) else "?" for e in data]


def main() -> int:
    project, external_url = sys.argv[1], sys.argv[2]

    # --- EXPECTED: what compose actually resolved -------------------------
    try:
        raw = subprocess.run(
            ["docker", "compose", "-p", project, "config", "--format", "json"],
            capture_output=True, text=True, check=True,
        ).stdout
        web = json.loads(raw).get("services", {}).get("web", {})
    except Exception as e:
        print(f"  ⚠ server rail: could not read compose config ({e}) — skipping check")
        return 0

    mounts = [
        v for v in (web.get("volumes") or [])
        if isinstance(v, dict) and v.get("target") == CONTAINER_PATH
    ]
    if not mounts:
        print(
            "❌ server rail: docker-compose.yml declares NO mount for\n"
            f"   {CONTAINER_PATH} — the web image's baked empty list will be\n"
            "   served and the ServerRail will silently go dark.\n"
            "   Fix: restore the instances.json volume on the `web` service.",
            file=sys.stderr,
        )
        return 1

    host_path = mounts[0].get("source")
    try:
        with open(host_path) as f:
            expected = _entries(f.read(), f"host file {host_path}")
    except FileNotFoundError:
        print(
            f"❌ server rail: mounted host path does not exist: {host_path}\n"
            "   Docker would create a DIRECTORY there and nginx would 404 the\n"
            "   rail. Create the file (use `[]` for a single-instance deploy).",
            file=sys.stderr,
        )
        return 1
    if expected is None:
        return 1

    # --- SERVED: what the site actually returns ---------------------------
    url = external_url.rstrip("/") + "/instances.json"
    # An explicit User-Agent is REQUIRED: the edge WAF 403s the default
    # "Python-urllib/x.y" agent, which would fail every deploy on a healthy rail.
    req = urllib.request.Request(url, headers={"User-Agent": "unicorn-stable-deploy-check/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            served = _entries(r.read().decode(), f"served {url}")
    except Exception as e:
        print(f"❌ server rail: could not fetch {url}: {e}", file=sys.stderr)
        return 1
    if served is None:
        return 1

    # --- compare -----------------------------------------------------------
    if not expected:
        print(f"  ✓ server rail: single-instance default ({host_path} is empty)")
        return 0
    if len(served) < len(expected):
        print(
            f"❌ server rail REGRESSED — the mount was lost or overridden.\n"
            f"   host file {host_path}: {len(expected)} entries {expected}\n"
            f"   served    {url}: {len(served)} entries {served}\n"
            "   nginx is serving the image's baked list, not the mounted one.\n"
            "   Check that `web` still declares the instances.json volume and\n"
            "   that STABLE_INSTANCES_FILE points at the intended list.",
            file=sys.stderr,
        )
        return 1
    print(f"  ✓ server rail: {len(served)} instances served {served}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
