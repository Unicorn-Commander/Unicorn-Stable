"""Keep deployment-specific hosts out of the public code and config surface."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
LOCKFILE_NAMES = frozenset(
    {
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "poetry.lock",
        "uv.lock",
    }
)
EXCLUDED_DIRECTORY_NAMES = frozenset({"docs", "tests", "node_modules", ".venv"})
INTERNAL_HOST_PATTERN = re.compile(
    r"magicunicorn|unicorncommander|majiks|192\.168\.|"
    r"100\.[0-9]+\.[0-9]+\.[0-9]+|\.ts\.net|bigboy|rackboy|midboy|"
    r"(?:\bcommander\.(?:[a-z0-9-]+\.)*(?:magicunicorn\.dev|"
    r"unicorncommander\.ai|ts\.net)\b|\bssh\s+commander\b)",
)


def _is_excluded_path(relative_path: str) -> bool:
    path = Path(relative_path)
    return (
        path.name == "docker-compose.yml"
        or path.name in LOCKFILE_NAMES
        or any(part in EXCLUDED_DIRECTORY_NAMES for part in path.parts)
        or "test" in relative_path.lower()
    )


def _find_internal_host_offenders(repo_root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=repo_root,
        check=False,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr.decode(errors="replace")

    offenders = []
    tracked_paths = sorted(
        path.decode("utf-8", errors="surrogateescape")
        for path in result.stdout.split(b"\0")
        if path
    )
    for relative_path in tracked_paths:
        if _is_excluded_path(relative_path):
            continue

        path = repo_root / relative_path
        if not path.is_file():
            continue
        contents = path.read_bytes()
        if b"\0" in contents:
            continue

        text = contents.decode("utf-8", errors="replace")
        for line_number, line in enumerate(text.splitlines(), start=1):
            if INTERNAL_HOST_PATTERN.search(line):
                offenders.append(f"{relative_path}:{line_number}:{line}")
    return offenders


def test_no_internal_hosts_outside_deployment_compose() -> None:
    """The public surface may not acquire a private host or address default."""

    offenders = _find_internal_host_offenders(REPO_ROOT)
    assert not offenders, (
        "internal host/address found outside the deployment compose allowlist:\n"
        + "\n".join(offenders)
    )


def test_commander_package_fixture_is_not_a_host() -> None:
    package_lock_line = '    "node_modules/commander": {'

    assert re.search(r"commander\b", package_lock_line)
    assert INTERNAL_HOST_PATTERN.search(package_lock_line) is None


def test_commander_matches_only_internal_host_forms() -> None:
    assert INTERNAL_HOST_PATTERN.search("https://commander.magicunicorn.dev")
    assert INTERNAL_HOST_PATTERN.search("commander.my-tailnet.ts.net")
    assert INTERNAL_HOST_PATTERN.search("ssh commander")
    assert INTERNAL_HOST_PATTERN.search("commander") is None
    assert INTERNAL_HOST_PATTERN.search("commander.example.com") is None


def test_tracked_walk_excludes_non_public_files_and_binary_content(tmp_path: Path) -> None:
    fixtures = {
        "public.txt": "https://commander.magicunicorn.dev\n",
        "docs/reference.txt": "https://stable.magicunicorn.dev\n",
        "tests/fixture.txt": "https://stable.magicunicorn.dev\n",
        "web/package-lock.json": '"node_modules/commander": {\n',
        "docker-compose.yml": "https://stable.magicunicorn.dev\n",
        "node_modules/dependency.txt": "https://stable.magicunicorn.dev\n",
        ".venv/config.txt": "https://stable.magicunicorn.dev\n",
        "src/example.test.ts": "https://stable.magicunicorn.dev\n",
    }
    for relative_path, contents in fixtures.items():
        path = tmp_path / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
    binary_path = tmp_path / "assets" / "image.bin"
    binary_path.parent.mkdir()
    binary_path.write_bytes(b"https://stable.magicunicorn.dev\0")

    subprocess.run(["git", "init", "--quiet"], cwd=tmp_path, check=True)
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)

    assert _find_internal_host_offenders(tmp_path) == [
        "public.txt:1:https://commander.magicunicorn.dev"
    ]
