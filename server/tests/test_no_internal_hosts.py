"""Keep deployment-specific hosts out of the public code and config surface."""

from __future__ import annotations

import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
INTERNAL_HOST_PATTERN = (
    r"magicunicorn|unicorncommander|majiks|192\.168\.|"
    r"100\.[0-9]+\.[0-9]+\.[0-9]+|\.ts\.net|bigboy|rackboy|midboy|commander\b"
)


def test_no_internal_hosts_outside_deployment_compose() -> None:
    """The public surface may not acquire a private host or address default."""

    result = subprocess.run(
        [
            "git",
            "grep",
            "-nE",
            INTERNAL_HOST_PATTERN,
            "--",
            ":!docs",
            ":!*test*",
        ],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode in (0, 1), result.stderr

    offenders = []
    for line in result.stdout.splitlines():
        path = line.split(":", 1)[0]
        if path == "docker-compose.yml" or path.endswith("/docker-compose.yml"):
            continue
        offenders.append(line)

    assert not offenders, (
        "internal host/address found outside the deployment compose allowlist:\n"
        + "\n".join(offenders)
    )
