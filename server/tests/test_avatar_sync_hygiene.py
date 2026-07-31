"""Regression tests for avatar-mirror hygiene in participant_identity.

The stale-gravatar bug: the OLD identity spine minted gravatar.com URLs
keyed by email MD5 (d=404, so they only ever rendered broken images and
leaked an email hash to a third party on every render). The newer spine
mints no fallback at all, but rows whose mirror already held a gravatar URL
kept it forever — `_sync_mutable_fields` only ever wrote when a NEW avatar
was present, never cleared.

The fix: when a token arrives with NO `picture` claim and the current mirror
is a gravatar URL, clear the mirror. Guarded to the gravatar class on
purpose — a real Ops-Center picture (unicorncommander.ai) is never blanked
by a transiently-absent claim, and a Stable-local override is untouched by
design.

Run inside the backend image with this worktree's `server/` mounted:

    docker run --rm --network stable-flagship-network \
      -v /tmp/wt-avatar-sync/server:/home/stable/server -w /home/stable/server \
      unicorn-stable-backend:e9db82f18be0 python tests/test_avatar_sync_hygiene.py

No pytest dependency — the backend image does not ship one.
"""

from __future__ import annotations

import sys
from typing import Any

sys.path.insert(0, "/home/stable/server")

from app.models.participant import Participant  # noqa: E402
from app.services.participant_identity import (  # noqa: E402
    _is_gravatar_url,
    _sync_mutable_fields,
)

FAILURES: list[str] = []


def check(name: str, got: Any, want: Any) -> None:
    if got == want:
        print(f"  ok  {name}")
    else:
        print(f"  FAIL {name}: got {got!r}, want {want!r}")
        FAILURES.append(name)


def make_participant(**kw: Any) -> Participant:
    base = dict(
        keycloak_sub="sub-test",
        username="testuser",
        display_name="Test User",
    )
    base.update(kw)
    return Participant(**base)


def test_is_gravatar_url() -> None:
    print("_is_gravatar_url")
    check("www host", _is_gravatar_url("https://www.gravatar.com/avatar/a1b2.png"), True)
    check("bare host", _is_gravatar_url("http://gravatar.com/avatar/x"), True)
    check("subdomain", _is_gravatar_url("https://secure.gravatar.com/avatar/x"), True)
    check("path spoof", _is_gravatar_url("https://example.com/gravatar.com/x.png"), False)
    check("host suffix spoof", _is_gravatar_url("https://gravatar.com.evil.example/x.png"), False)
    check("userinfo spoof", _is_gravatar_url("https://evil@gravatar.com/x.png"), True)
    check("our host", _is_gravatar_url("https://unicorncommander.ai/avatars/a.png"), False)
    check("relative", _is_gravatar_url("/avatars/a.png"), False)
    check("none", _is_gravatar_url(None), False)
    check("empty", _is_gravatar_url(""), False)


def test_gravatar_mirror_cleared_on_absent_claim() -> None:
    print("stale gravatar mirror cleared when token has no picture")
    p = make_participant(
        keycloak_avatar_url="https://www.gravatar.com/avatar/abc123def456.png"
    )
    changed = _sync_mutable_fields(p, {"display_name": "Test User", "avatar_url": None}, None)
    check("changed flagged", changed, True)
    check("mirror cleared", p.keycloak_avatar_url, None)
    check("override untouched", p.avatar_override_url, None)


def test_ops_center_picture_survives_absent_claim() -> None:
    print("Ops-Center picture NOT blanked by a transiently-absent claim")
    url = "https://unicorncommander.ai/avatars/aaron_c41dbe8a353e.png"
    p = make_participant(keycloak_avatar_url=url)
    changed = _sync_mutable_fields(p, {"display_name": "Test User", "avatar_url": None}, None)
    check("not changed", changed, False)
    check("mirror kept", p.keycloak_avatar_url, url)


def test_local_override_untouched_by_clear() -> None:
    print("local override survives the gravatar clear")
    p = make_participant(
        keycloak_avatar_url="https://www.gravatar.com/avatar/abc.png",
        metadata_={"avatar_override_url": "/api/v1/avatars/secret123.png"},
    )
    changed = _sync_mutable_fields(p, {"display_name": "Test User", "avatar_url": None}, None)
    check("changed flagged", changed, True)
    check("mirror cleared", p.keycloak_avatar_url, None)
    check("override kept", p.avatar_override_url, "/api/v1/avatars/secret123.png")
    check("effective still override", p.avatar_url, "/api/v1/avatars/secret123.png")


def test_new_picture_still_mirrors() -> None:
    print("a new picture claim still mirrors as before")
    url = "https://unicorncommander.ai/avatars/new.png"
    p = make_participant(keycloak_avatar_url="https://www.gravatar.com/avatar/old.png")
    changed = _sync_mutable_fields(p, {"display_name": "Test User", "avatar_url": url}, None)
    check("changed flagged", changed, True)
    check("new picture mirrored", p.keycloak_avatar_url, url)


if __name__ == "__main__":
    test_is_gravatar_url()
    test_gravatar_mirror_cleared_on_absent_claim()
    test_ops_center_picture_survives_absent_claim()
    test_local_override_untouched_by_clear()
    test_new_picture_still_mirrors()
    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURE(S): {FAILURES}")
        sys.exit(1)
    print("\nall avatar-sync hygiene tests passed")
