"""Recording policy matrix (design §8) — every cell, as pure decisions.

    policy      entitled  pref   manual start   auto-start                 manual stop
    off         any       any    403            no                         403
    on_request  no        any    403            no                         403
    on_request  yes       off    start          no                         stop
    on_request  yes       on     start          start iff joiner started   stop
    always      no        any    403            start (started_by NULL)    403
    always      yes       any    start          start (started_by NULL)    owner/admin only
"""

from __future__ import annotations

import unittest
from types import SimpleNamespace

from app.services.recording_policy import (
    RECORD_MY_CALLS_KEY,
    RECORDER_ENTITLED_KEY,
    RECORDER_ROLE,
    decide_auto_start,
    decide_delete,
    decide_manual_start,
    decide_manual_stop,
    may_view_file,
    normalize_policy,
    participant_is_entitled,
    participant_wants_own_calls_recorded,
    user_is_entitled,
)

POLICIES = ("off", "on_request", "always")


class ManualStartMatrix(unittest.TestCase):
    def test_every_cell(self) -> None:
        expected = {
            # (policy, entitled) -> status (200 = allowed)
            ("off", False): 403,
            ("off", True): 403,
            ("on_request", False): 403,
            ("on_request", True): 200,
            ("always", False): 403,
            ("always", True): 200,
        }
        for (policy, entitled), want in expected.items():
            for pref in (False, True):  # the preference never changes a manual start
                with self.subTest(policy=policy, entitled=entitled, pref=pref):
                    d = decide_manual_start(
                        policy=policy,
                        entitled=entitled,
                        master_enabled=True,
                        already_active=False,
                    )
                    self.assertEqual(d.status if not d.allowed else 200, want)

    def test_policy_off_beats_entitlement_in_the_answer(self) -> None:
        d = decide_manual_start(policy="off", entitled=True, master_enabled=True, already_active=False)
        self.assertEqual(d.status, 403)
        self.assertIn("off for this room", d.reason)

    def test_master_switch_off_is_503_for_entitled_callers_only(self) -> None:
        d = decide_manual_start(policy="always", entitled=True, master_enabled=False, already_active=False)
        self.assertEqual(d.status, 503)
        # Not entitled → still the entitlement refusal (never leak instance config).
        d = decide_manual_start(policy="always", entitled=False, master_enabled=False, already_active=False)
        self.assertEqual(d.status, 403)

    def test_already_active_is_409(self) -> None:
        d = decide_manual_start(policy="on_request", entitled=True, master_enabled=True, already_active=True)
        self.assertEqual(d.status, 409)

    def test_unknown_kind_is_400(self) -> None:
        d = decide_manual_start(
            policy="on_request", entitled=True, master_enabled=True, already_active=False, kind="track"
        )
        self.assertEqual(d.status, 400)
        for kind in ("audio", "composite"):
            self.assertTrue(
                decide_manual_start(
                    policy="on_request", entitled=True, master_enabled=True, already_active=False, kind=kind
                ).allowed
            )


class AutoStartMatrix(unittest.TestCase):
    def _auto(self, policy, entitled, pref, started_call=True, master=True):
        return decide_auto_start(
            policy=policy,
            master_enabled=master,
            joiner_entitled=entitled,
            joiner_pref=pref,
            joiner_started_call=started_call,
        )

    def test_every_cell(self) -> None:
        # (policy, entitled, pref) -> (start, attribute_to_joiner)
        expected = {
            ("off", False, False): (False, False),
            ("off", False, True): (False, False),
            ("off", True, False): (False, False),
            ("off", True, True): (False, False),
            ("on_request", False, False): (False, False),
            ("on_request", False, True): (False, False),  # pref cannot outrank the role
            ("on_request", True, False): (False, False),
            ("on_request", True, True): (True, True),
            ("always", False, False): (True, False),
            ("always", False, True): (True, False),
            ("always", True, False): (True, False),
            ("always", True, True): (True, False),  # always is policy-driven: started_by NULL
        }
        for (policy, entitled, pref), (start, attributed) in expected.items():
            with self.subTest(policy=policy, entitled=entitled, pref=pref):
                d = self._auto(policy, entitled, pref)
                self.assertEqual((d.start, d.attribute_to_joiner), (start, attributed), d.reason)

    def test_pref_only_fires_when_the_joiner_started_the_call(self) -> None:
        self.assertTrue(self._auto("on_request", True, True, started_call=True).start)
        self.assertFalse(self._auto("on_request", True, True, started_call=False).start)

    def test_master_switch_off_stops_even_always_rooms(self) -> None:
        d = self._auto("always", True, True, master=False)
        self.assertFalse(d.start)
        self.assertIn("master", d.reason)


class ManualStopMatrix(unittest.TestCase):
    def _stop(self, policy, entitled, admin=False, active=True):
        return decide_manual_stop(
            policy=policy, entitled=entitled, active=active, is_owner_or_admin=admin
        )

    def test_every_cell(self) -> None:
        # (policy, entitled, owner_or_admin) -> status
        expected = {
            ("off", False, False): 403,
            ("off", True, True): 403,
            ("on_request", False, False): 403,
            ("on_request", False, True): 403,
            ("on_request", True, False): 200,
            ("on_request", True, True): 200,
            ("always", False, False): 403,
            ("always", False, True): 403,
            ("always", True, False): 403,  # an always room is the owner's policy
            ("always", True, True): 200,
        }
        for (policy, entitled, admin), want in expected.items():
            with self.subTest(policy=policy, entitled=entitled, admin=admin):
                d = self._stop(policy, entitled, admin)
                self.assertEqual(d.status if not d.allowed else 200, want, d.reason)

    def test_nothing_active_is_409(self) -> None:
        self.assertEqual(self._stop("on_request", True, active=False).status, 409)


class DeleteAndViewRules(unittest.TestCase):
    def test_owner_admin_or_starter_may_delete(self) -> None:
        self.assertTrue(decide_delete(is_owner_or_admin=True, is_starter=False, legal_hold=False).allowed)
        self.assertTrue(decide_delete(is_owner_or_admin=False, is_starter=True, legal_hold=False).allowed)
        self.assertEqual(
            decide_delete(is_owner_or_admin=False, is_starter=False, legal_hold=False).status, 403
        )

    def test_legal_hold_blocks_everyone(self) -> None:
        d = decide_delete(is_owner_or_admin=True, is_starter=True, legal_hold=True)
        self.assertEqual(d.status, 423)

    def test_file_access_matches_delete_scope(self) -> None:
        self.assertTrue(may_view_file(is_owner_or_admin=True, is_starter=False))
        self.assertTrue(may_view_file(is_owner_or_admin=False, is_starter=True))
        self.assertFalse(may_view_file(is_owner_or_admin=False, is_starter=False))


class CallerFacts(unittest.TestCase):
    def test_jwt_roles_decide_entitlement_deny_by_default(self) -> None:
        self.assertTrue(user_is_entitled({"roles": [RECORDER_ROLE, "user"]}))
        self.assertFalse(user_is_entitled({"roles": []}))
        self.assertFalse(user_is_entitled({}))
        self.assertFalse(user_is_entitled(None))
        self.assertFalse(user_is_entitled({"roles": 42}))

    def test_participant_mirror_and_preference(self) -> None:
        p = SimpleNamespace(metadata_={RECORDER_ENTITLED_KEY: True, RECORD_MY_CALLS_KEY: "true"})
        self.assertTrue(participant_is_entitled(p))
        self.assertTrue(participant_wants_own_calls_recorded(p))
        self.assertFalse(participant_is_entitled(SimpleNamespace(metadata_=None)))
        self.assertFalse(participant_is_entitled(None))
        self.assertFalse(participant_wants_own_calls_recorded(SimpleNamespace(metadata_={})))

    def test_policy_normalisation_reads_odd_values_as_off(self) -> None:
        self.assertEqual(normalize_policy("ALWAYS"), "always")
        self.assertEqual(normalize_policy(None), "off")
        self.assertEqual(normalize_policy("sometimes"), "off")


class RoleMirrorOnSignIn(unittest.TestCase):
    """participant_identity._sync_mutable_fields stamps the role onto the row
    so the webhook path (no JWT) can answer the on_request + pref cell."""

    def _p(self, meta=None):
        # The mirror reads/reassigns ``metadata_`` only; a plain namespace is
        # the honest double (a real Participant needs a mapper session).
        return SimpleNamespace(display_name="Aaron", keycloak_avatar_url=None, metadata_=meta)

    def test_role_present_is_stamped_once(self) -> None:
        from app.services.participant_identity import _mirror_recorder_entitlement

        p = self._p({})
        self.assertTrue(_mirror_recorder_entitlement(p, {"roles": [RECORDER_ROLE]}))
        self.assertTrue(p.metadata_[RECORDER_ENTITLED_KEY])
        # Steady state: no write.
        self.assertFalse(_mirror_recorder_entitlement(p, {"roles": [RECORDER_ROLE]}))

    def test_role_removed_is_cleared(self) -> None:
        from app.services.participant_identity import _mirror_recorder_entitlement

        p = self._p({RECORDER_ENTITLED_KEY: True, "email": "a@b"})
        self.assertTrue(_mirror_recorder_entitlement(p, {"roles": ["user"]}))
        self.assertNotIn(RECORDER_ENTITLED_KEY, p.metadata_)
        self.assertEqual(p.metadata_["email"], "a@b")  # other keys untouched

    def test_no_role_and_no_key_is_a_read(self) -> None:
        from app.services.participant_identity import _mirror_recorder_entitlement

        p = self._p(None)
        self.assertFalse(_mirror_recorder_entitlement(p, {"roles": []}))
        self.assertIsNone(p.metadata_)


if __name__ == "__main__":
    unittest.main()
