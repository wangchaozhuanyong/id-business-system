"""Pure response-contract tests; no app initialization, database or network."""
from contextlib import ExitStack
import copy
import hashlib
import json
from pathlib import Path
import socket
import sqlite3
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import flow_evidence as flow


class Response:
    def __init__(self, body, *, status=200, url="https://auth.openai.com/api/accounts/user/register", invalid=False):
        self.body, self.status_code, self.url, self.invalid = body, status, url, invalid
        self.headers = {"content-type": "application/json", "x-request-id": "fixture-private-request-id"}
        self.history = []

    def json(self):
        if self.invalid:
            raise ValueError("fixture-private-response")
        return self.body


class FlowContractUnitTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(sqlite3, "connect", side_effect=AssertionError("database disabled")))
        for name in ("connect", "connect_ex"):
            self.stack.enter_context(patch.object(socket.socket, name, side_effect=AssertionError("network disabled")))
        for name in ("create_connection", "getaddrinfo"):
            self.stack.enter_context(patch.object(socket, name, side_effect=AssertionError("network disabled")))
        self.addCleanup(self.stack.close)

    def sentinel(self, body=None, **kwargs):
        value = {"token": "fixture-private-token", "proofofwork": {"required": False},
                 "turnstile": {"required": False}} if body is None else body
        return flow.observation(Response(value, url=kwargs.pop("url", "https://sentinel.openai.com/backend-api/sentinel/req"),
                                         **kwargs), "sentinel")

    def test_current_sentinel_accepts_explicit_false_and_legacy_missing_requirements(self):
        for body in (None, {"token": "fixture-private-token"},
                     {"token": "fixture-private-token", "proofofwork": {}, "turnstile": {}}):
            with self.subTest(body=body):
                evidence = self.sentinel(body)
                self.assertEqual((evidence["decision"], evidence["reason"]), ("accepted", None))
                self.assertTrue(evidence["sentinelDetails"]["tokenPresent"])
                self.assertEqual(evidence["pageKind"], "not_checked")
                flow.validate_flow_evidence({"version": 3, "sentinel": evidence})

    def test_required_challenges_are_never_accepted_even_with_token(self):
        for key in ("proofofwork", "turnstile"):
            evidence = self.sentinel({"token": "fixture-private-token", key: {"required": True}})
            self.assertEqual((evidence["decision"], evidence["reason"]), ("rejected", "challenge_required"))

    def test_malformed_challenge_requirements_fail_closed(self):
        for key in ("proofofwork", "turnstile"):
            for malformed in (None, [], True, "fixture-private-value", {"required": 1},
                              {"required": "false"}, {"required": None}, {"required": []}):
                with self.subTest(key=key, malformed=malformed):
                    evidence = self.sentinel({"token": "fixture-private-token", key: malformed})
                    self.assertEqual(evidence["reason"], "challenge_invalid")

    def test_missing_blank_wrong_type_or_oversized_tokens_are_rejected(self):
        for token in (None, "", " \n", True, [], {}, "x" * 16385):
            evidence = self.sentinel({"token": token})
            self.assertFalse(evidence["sentinelDetails"]["tokenPresent"])
            self.assertEqual(evidence["reason"], "missing_token")
        self.assertEqual(self.sentinel({})["reason"], "missing_token")

    def test_sentinel_status_origin_and_json_gates_precede_challenge(self):
        for kwargs, reason in (({"status": 403}, "http_status"),
                               ({"status": 500}, "http_status"),
                               ({"url": "https://auth.openai.com/"}, "untrusted_origin"),
                               ({"url": "http://sentinel.openai.com/"}, "untrusted_origin"),
                               ({"url": "https://sentinel.openai.com.evil.invalid/"}, "untrusted_origin"),
                               ({"url": "https://user:private@sentinel.openai.com/"}, "untrusted_origin"),
                               ({"invalid": True}, "invalid_json")):
            with self.subTest(kwargs=kwargs):
                self.assertEqual(self.sentinel(**kwargs)["reason"], reason)
        for body in ([], "fixture-private-value", 0):
            evidence = self.sentinel(body)
            self.assertEqual(evidence["reason"], "invalid_json")
            self.assertNotIn("sentinelDetails", evidence)

    def test_password_200_requires_trusted_json_object_without_explicit_error(self):
        for body in ({}, {"page": {"type": "future_page"}}, {"continue_url": "fixture-private-link"},
                     {"error": None}, {"errors": []}):
            evidence = flow.observation(Response(body), "password")
            self.assertEqual((evidence["decision"], evidence["reason"]), ("accepted", None))
        for body in ({"error": {"code": "account_creation_failed"}}, {"errors": ["fixture-private-value"]},
                     {"error": "fixture-private-value"}):
            evidence = flow.observation(Response(body), "password")
            self.assertEqual((evidence["decision"], evidence["reason"]), ("rejected", "upstream_error"))
        for kwargs, reason in (({"status": 400}, "http_status"), ({"url": "https://other.invalid/"}, "untrusted_origin"),
                               ({"invalid": True}, "invalid_json")):
            self.assertEqual(flow.observation(Response({}, **kwargs), "password")["reason"], reason)
        for body in ([], "fixture-private-value", None, True):
            self.assertEqual(flow.observation(Response(body), "password")["reason"], "invalid_json")

    def test_unknown_page_only_keeps_bounded_identifier_digest(self):
        for raw in ("future_page", "abc123"):
            evidence = flow.observation(Response({"page": {"type": raw}}), "signup")
            self.assertEqual(evidence["reason"], "unexpected_page")
            self.assertEqual(evidence["responseDetails"]["pageTypeSha256"], hashlib.sha256(raw.encode()).hexdigest())
            self.assertNotIn(raw, json.dumps(evidence))
        for raw in ("", "A", "private@example.invalid", "https://other.invalid/private", "x" * 129, "含私密信息"):
            evidence = flow.observation(Response({"page": {"type": raw}}), "signup")
            self.assertIsNone(evidence["responseDetails"]["pageTypeSha256"])
        known = flow.observation(Response({"page": {"type": "password"}}), "signup")
        self.assertIsNone(known["responseDetails"]["pageTypeSha256"])

    def test_v1_and_v2_projection_preserves_historical_schema_without_changing_live_gate(self):
        password = flow.observation(Response({"error": {"code": "account_creation_failed"}}), "password")
        self.assertEqual(password["decision"], "rejected")
        for version in (1, 2):
            projected = flow.observation_for_version("password", password, version)
            self.assertEqual(set(projected), flow.FIELDS)
            self.assertEqual((projected["decision"], projected["jsonKind"], projected["pageKind"]),
                             ("observed", "not_checked", "not_checked"))
            flow.validate_flow_evidence({"version": version, "password": projected})
            self.assertIsNone(flow.observation_for_version("sentinel", self.sentinel(), version))
        self.assertEqual(password["decision"], "rejected")
        signup = flow.observation(Response({"page": {"type": "password"}, "error": "fixture-private-value"}), "signup")
        v1 = flow.observation_for_version("signup", signup, 1)
        v2 = flow.observation_for_version("signup", signup, 2)
        self.assertEqual(v1["reason"], "unexpected_page")
        self.assertEqual(v2["reason"], "upstream_error")
        self.assertNotIn("pageTypeSha256", v2["responseDetails"])
        for version, evidence in ((1, v1), (2, v2), (3, signup)):
            flow.validate_flow_evidence({"version": version, "signup": evidence})

    def test_v3_closed_schema_rejects_extra_raw_or_inconsistent_evidence(self):
        sentinel = self.sentinel()
        password = flow.observation(Response({}), "password")
        mutations = (("sentinel", sentinel, lambda x: x["sentinelDetails"].update(token="fixture-private-token")),
                     ("sentinel", sentinel, lambda x: x["sentinelDetails"].update(tokenPresent=1)),
                     ("sentinel", sentinel, lambda x: x["sentinelDetails"].update(proofOfWorkRequired=True)),
                     ("sentinel", sentinel, lambda x: x["sentinelDetails"].update(turnstileRequired="required")),
                     ("sentinel", sentinel, lambda x: x.update(pageKind="missing")),
                     ("password", password, lambda x: x["responseDetails"].update(rawType="fixture-private-value")),
                     ("password", password, lambda x: x["responseDetails"].update(pageTypeSha256="raw-private-value")),
                     ("password", password, lambda x: x["responseDetails"].update(pageTypeSha256="a" * 64)),
                     ("password", password, lambda x: x.update(decision="observed")))
        for slot, evidence, mutate in mutations:
            bad = copy.deepcopy(evidence)
            mutate(bad)
            with self.subTest(slot=slot, evidence=bad), self.assertRaises(ValueError):
                flow.validate_flow_evidence({"version": 3, slot: bad})
        for version in (1, 2, True, 4):
            with self.subTest(version=version), self.assertRaises(ValueError):
                flow.validate_flow_evidence({"version": version, "sentinel": sentinel})

    def test_sensitive_payload_and_challenge_content_never_leave_evidence(self):
        marker = "fixture-private-value"
        sentinel = self.sentinel({"token": marker, "proofofwork": {"required": True, "seed": marker},
                                  "turnstile": {"required": True, "dx": marker}, "cookie": marker})
        password = flow.observation(Response({"page": {"type": marker}, "password": marker,
                                              "access_token": marker, "continue_url": marker}), "password")
        for evidence in (sentinel, password):
            text = json.dumps(evidence)
            self.assertNotIn(marker, text)
            self.assertNotIn("fixture-private-request-id", text)
            self.assertNotIn("fixture-private-token", text)

    def test_safety_reader_accepts_v3_sentinel_failure_and_rejects_secret_extras(self):
        # Import the stdlib-only reader while database/network guards are active.
        import release_safety as safety
        evidence = self.sentinel({"token": "fixture-private-token", "turnstile": {"required": True}})
        value = {"email": "fixture@example.invalid", "aliasId": "fixture-alias", "resultKind": "failed",
                 "stage": "sentinel", "flowEvidence": {"version": 3, "sentinel": evidence},
                 "firstFailure": {"stage": "sentinel", "errorKind": "unknown", "httpStatus": 200,
                                  "elapsedMs": 9, "observedAt": evidence["observedAt"]}}
        task = "82b25c6d-404f-47e9-a624-e106bd1a22cb"
        original = copy.deepcopy(value)
        safety.validate_task(task, value)
        self.assertEqual(value, original)
        for mutate in (lambda x: x.update(cookie="fixture-private-value"),
                       lambda x: x["firstFailure"].update(token="fixture-private-value"),
                       lambda x: x["flowEvidence"]["sentinel"]["sentinelDetails"].update(token="fixture-private-value")):
            bad = copy.deepcopy(value)
            mutate(bad)
            with self.subTest(value=bad), self.assertRaises(safety.SafetyError):
                safety.validate_task(task, bad)


if __name__ == "__main__":
    unittest.main()
