"""Call-entry preferences: voice calls never ask; the only stored choice is
whether VIDEO calls get the pre-join device check, and it must read safely
from untrusted participant metadata (server-side so it follows the user)."""

from app.api.users import CallPrefs, UserPreferences, UserPreferencesUpdate, _call_prefs


def test_call_prefs_default_is_straight_in() -> None:
    assert _call_prefs({}) == CallPrefs(check_devices_before_video=False)
    assert UserPreferences().call_prefs.check_devices_before_video is False


def test_call_prefs_reads_only_an_explicit_true() -> None:
    assert _call_prefs({"call_prefs": {"check_devices_before_video": True}}).check_devices_before_video is True
    for junk in ("true", 1, None, [], {}):
        assert _call_prefs({"call_prefs": {"check_devices_before_video": junk}}).check_devices_before_video is False
    assert _call_prefs({"call_prefs": "garbage"}).check_devices_before_video is False
    assert _call_prefs({"call_prefs": ["x"]}).check_devices_before_video is False


def test_update_is_partial_and_optional() -> None:
    body = UserPreferencesUpdate.model_validate({"call_prefs": {"check_devices_before_video": True}})
    assert body.call_prefs is not None and body.call_prefs.check_devices_before_video is True
    assert UserPreferencesUpdate.model_validate({}).call_prefs is None
    # A missing flag inside call_prefs means "off" — the safe default.
    assert UserPreferencesUpdate.model_validate({"call_prefs": {}}).call_prefs.check_devices_before_video is False
