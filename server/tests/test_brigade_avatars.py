"""Brigade avatar resolution stays canonical, portable, and privacy-safe."""

from types import SimpleNamespace

from app.api import brigade


def settings():
    return SimpleNamespace(
        brigade_base_url="https://brigade.magicunicorn.dev/api/v1/openai/v1"
    )


def test_relative_registered_avatar_is_anchored_to_brigade(monkeypatch) -> None:
    monkeypatch.setattr(brigade, "get_settings", settings)
    monkeypatch.setenv(
        "BRIGADE_AVATAR_BASE_URL",
        "https://brigade.magicunicorn.dev/avatars",
    )
    url, emoji = brigade._resolve_agent_avatar(
        {
            "id": "the-general",
            "avatarUrl": "/avatars/the-general.webp",
            "avatar": "🎖️",
        }
    )
    assert url == "https://brigade.magicunicorn.dev/avatars/the-general.webp"
    assert emoji == "🎖️"


def test_convention_then_emoji_fallback(monkeypatch) -> None:
    monkeypatch.setattr(brigade, "get_settings", settings)
    monkeypatch.setenv(
        "BRIGADE_AVATAR_BASE_URL",
        "https://brigade.magicunicorn.dev/avatars",
    )
    url, emoji = brigade._resolve_agent_avatar(
        {"id": "gunny", "avatarUrl": None, "avatar": "🎯"}
    )
    assert url == "https://brigade.magicunicorn.dev/avatars/gunny.webp"
    assert emoji == "🎯"


def test_untrusted_registered_avatar_drops_to_emoji(monkeypatch) -> None:
    monkeypatch.setattr(brigade, "get_settings", settings)
    monkeypatch.delenv("BRIGADE_AVATAR_BASE_URL", raising=False)
    url, emoji = brigade._resolve_agent_avatar(
        {
            "id": "gunny",
            "avatarUrl": "https://tracker.example/gunny.png",
            "avatar": "🎯",
        }
    )
    assert url is None
    assert emoji == "🎯"


def test_brand_ops_relative_path_uses_brigade_alias_not_stable(monkeypatch) -> None:
    monkeypatch.setattr(brigade, "get_settings", settings)
    monkeypatch.setenv(
        "BRIGADE_AVATAR_BASE_URL",
        "https://brigade.magicunicorn.dev/avatars",
    )
    url, emoji = brigade._resolve_agent_avatar(
        {
            "id": "cpl.-colophon",
            "avatarUrl": (
                "/api/brands/magic-unicorn/agents/cpl-colophon/avatar"
            ),
            "avatar": "🦄",
        }
    )
    assert url == "https://brigade.magicunicorn.dev/avatars/cpl.-colophon.webp"
    assert emoji == "🦄"


def test_convention_is_not_synthesized_for_unmapped_runtime_agent(
    monkeypatch,
) -> None:
    monkeypatch.setattr(brigade, "get_settings", settings)
    monkeypatch.setenv(
        "BRIGADE_AVATAR_BASE_URL",
        "https://brigade.magicunicorn.dev/avatars",
    )
    url, emoji = brigade._resolve_agent_avatar(
        {"id": "corporal-qwen", "avatarUrl": None, "avatar": "🦄"}
    )
    assert url is None
    assert emoji == "🦄"
