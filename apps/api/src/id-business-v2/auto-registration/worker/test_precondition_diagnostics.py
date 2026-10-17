"""Pure fake-transport tests of the exact frozen initialization methods."""
import hashlib
import json
from pathlib import Path
import socket
import sqlite3
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import precondition_diagnostics as diagnostic


class Response:
    def __init__(self, status=200, *, url="https://auth.openai.com/log-in", cookie="fixture-device-secret",
                 body=None, headers=None, text="", redirects=0):
        self.status_code, self.url, self.cookie = status, url, cookie
        self.body, self.text, self.redirect_count, self.history = body, text, redirects, []
        self.headers = headers or {"content-type": "application/json" if body is not None else "text/html"}

    def json(self):
        if self.body is None:
            raise ValueError("not json")
        return self.body


def transport(responses):
    calls, sessions = [], []

    class Curl:
        def perform(self):
            return None

    class Session:
        def __init__(self, **options):
            self.options, self.cookies, self.closed = options, {}, False
            sessions.append(self)

        def request(self, method, url, *args, **kwargs):
            Curl().perform()
            calls.append((self, method, url, kwargs))
            item = responses.pop(0)
            if isinstance(item, BaseException):
                raise item
            if item.cookie:
                self.cookies["oai-did"] = item.cookie
            return item

        def get(self, url, *args, **kwargs):
            return self.request("GET", url, *args, **kwargs)

        def post(self, url, *args, **kwargs):
            return self.request("POST", url, *args, **kwargs)

        def close(self):
            self.closed = True

    class RequestsError(Exception):
        pass

    return SimpleNamespace(Curl=Curl, requests=SimpleNamespace(Session=Session, RequestsError=RequestsError)), calls, sessions


def trace(country="JP"):
    return Response(url=diagnostic.TRACE_URL, cookie=None, text="ip=203.0.113.10\nloc=" + country + "\n")


class PreconditionTests(unittest.TestCase):
    def config(self):
        return {"permitNetwork": True,
                "sourceHashes": {n: hashlib.sha256((diagnostic.BASE / n).read_bytes()).hexdigest()
                                 for n in diagnostic.SOURCE_NAMES},
                "settings": {"clientId": "app_EMoamEEZ73f0CkXaXp7hrann", "authUrl": "https://auth.openai.com/oauth/authorize",
                             "tokenUrl": "https://auth.openai.com/oauth/token",
                             "redirectUri": "http://localhost:1455/auth/callback", "scope": "openid email profile offline_access"},
                "proxyUrl": None, "proxySource": "default"}

    def run_fake(self, responses, config=None):
        curl, calls, sessions = transport(responses)
        original_request, original_perform = curl.requests.Session.request, curl.Curl.perform
        with patch.object(sqlite3, "connect", side_effect=AssertionError("database forbidden")), \
                patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden")):
            result = diagnostic.run_precondition(config or self.config(), curl=curl)
        self.assertIs(curl.requests.Session.request, original_request)
        self.assertIs(curl.Curl.perform, original_perform)
        self.assertTrue(all(s.closed for s in sessions))
        self.assertEqual(result["businessRequestCounts"], dict.fromkeys(diagnostic.BUSINESS_STEPS, 0))
        self.assertEqual(result["databaseConnections"], 0)
        self.assertEqual(result["registrationStarts"], 0)
        return result, calls, sessions

    def test_real_constructor_trace_native_redirect_authorize_and_sentinel_same_session(self):
        result, calls, sessions = self.run_fake([
            trace(), Response(redirects=2),
            Response(url="https://sentinel.openai.com/backend-api/sentinel/req", body={"token": "fixture-token-secret"})])
        self.assertEqual(result["status"], "PRECONDITION_ACCEPTED", result)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].options, {"proxies": None, "impersonate": "chrome", "verify": True, "timeout": 30})
        self.assertEqual([v[1] for v in calls], ["GET", "GET", "POST"])
        self.assertEqual(calls[0][2], diagnostic.TRACE_URL)
        self.assertTrue(calls[1][2].startswith("https://auth.openai.com/oauth/authorize?"))
        self.assertTrue(calls[1][3]["allow_redirects"])
        self.assertEqual(calls[1][3]["max_redirects"], 5)
        self.assertEqual(calls[1][3]["timeout"], 20)
        self.assertNotIn("headers", calls[1][3])
        self.assertEqual(result["nativeRedirectCounts"]["authorize"], 2)
        self.assertFalse(result["fullTransportEquivalenceClaimed"])

    def test_forbidden_html_stops_first_response_even_with_device_cookie(self):
        result, calls, _ = self.run_fake([trace(), Response(403, headers={"content-type": "text/html", "cf-mitigated": "challenge"})])
        self.assertEqual(result["status"], "BLOCKED", result)
        self.assertEqual(result["reason"], "authorize_http_status")
        self.assertEqual(len(calls), 2)
        self.assertEqual(result["attempts"][0]["observation"]["httpStatus"], 403)
        self.assertEqual(result["attempts"][0]["deviceCookieAfter"], "present")
        self.assertEqual(result["requestCounts"]["sentinel"], 0)

    def test_required_sentinel_stops_without_signup(self):
        result, calls, _ = self.run_fake([trace(), Response(), Response(url="https://sentinel.openai.com/backend-api/sentinel/req",
            body={"token": "fixture-token-secret", "turnstile": {"required": True}})])
        self.assertEqual(result["status"], "BLOCKED", result)
        self.assertEqual(result["reason"], "sentinel_challenge_required")
        self.assertEqual(len(calls), 3)

    def test_sentinel_token_with_explicit_error_is_not_accepted(self):
        result, calls, _ = self.run_fake([trace(), Response(), Response(url="https://sentinel.openai.com/backend-api/sentinel/req",
            body={"token": "fixture-token-secret", "error": {"code": "fixture-private-code"}})])
        self.assertEqual(result["status"], "BLOCKED", result)
        self.assertEqual(result["reason"], "sentinel_upstream_error")
        self.assertEqual(result["attempts"][-1]["responseClass"], "structured_rejection")
        self.assertEqual(len(calls), 3)

    def test_success_status_with_explicit_challenge_never_reaches_sentinel(self):
        result, calls, _ = self.run_fake([trace(), Response(headers={"content-type": "text/html", "cf-mitigated": "challenge"})])
        self.assertEqual(result["status"], "BLOCKED", result)
        self.assertEqual(result["reason"], "authorize_challenge_required")
        self.assertEqual(len(calls), 2)

    def test_first_network_exception_has_no_stale_response_and_no_retry(self):
        result, calls, _ = self.run_fake([trace(), RuntimeError("fixture-secret-response")])
        self.assertEqual(result["status"], "INCOMPLETE", result)
        self.assertEqual(len(calls), 2)
        self.assertEqual(result["attempts"][0]["outcome"], "network_error")
        self.assertIsNone(result["attempts"][0]["observation"])

    def test_no_cookie_stops_before_upstream_retry(self):
        result, calls, _ = self.run_fake([trace(), Response(cookie=None)])
        self.assertEqual(result["reason"], "device_cookie_missing", result)
        self.assertEqual(len(calls), 2)

    def test_untrusted_final_origin_never_reaches_sentinel(self):
        result, calls, _ = self.run_fake([trace(), Response(url="https://fixture.invalid/private")])
        self.assertEqual(result["reason"], "authorize_untrusted_origin", result)
        self.assertEqual(len(calls), 2)

    def test_trace_refusal_never_reaches_authorize(self):
        result, calls, _ = self.run_fake([Response(403, url=diagnostic.TRACE_URL, cookie=None)])
        self.assertEqual(result["reason"], "ip_precheck_rejected", result)
        self.assertEqual(len(calls), 1)

    def test_trace_without_valid_country_is_incomplete_before_authorization(self):
        for text in ("<html>fixture</html>", "loc=fixture-secret\n", "ip=203.0.113.10\n"):
            result, calls, _ = self.run_fake([Response(url=diagnostic.TRACE_URL, cookie=None, text=text)])
            self.assertEqual(result["status"], "INCOMPLETE")
            self.assertEqual(result["reason"], "ip_location_unavailable")
            self.assertEqual(len(calls), 1)
            self.assertEqual(result["requestCounts"]["authorize"], 0)

    def test_budget_exhaustion_is_incomplete_not_registration_failure(self):
        result, calls, _ = self.run_fake([trace(), Response(redirects=6)])
        self.assertEqual(result["status"], "INCOMPLETE", result)
        self.assertEqual(result["reason"], "redirect_budget")
        self.assertEqual(len(calls), 2)

    def test_corrupt_source_or_unknown_configuration_cannot_make_request(self):
        for change in (lambda c: c["sourceHashes"].update({"upstream/src/core/register.py": "0" * 64}),
                       lambda c: c.update({"runRegistration": True})):
            config = self.config()
            change(config)
            result, calls, _ = self.run_fake([], config)
            self.assertEqual(result["status"], "INCOMPLETE")
            self.assertEqual(calls, [])

    def test_internal_transport_retry_cannot_exceed_single_native_perform(self):
        curl, calls, _ = transport([trace()])
        original_request = curl.requests.Session.request
        native_calls = []
        curl.Curl.perform = lambda self: native_calls.append(True)

        def retrying_request(session, method, url, *args, **kwargs):
            response = original_request(session, method, url, *args, **kwargs)
            curl.Curl().perform()
            return response

        curl.requests.Session.request = retrying_request
        result = diagnostic.run_precondition(self.config(), curl=curl)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(result["reason"], "transport_bypass_boundary")
        self.assertEqual(len(native_calls), 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["requestCounts"], {"ipCheck": 1, "authorize": 0, "sentinel": 0})

    def test_only_initialization_methods_exist_and_output_contains_no_secrets(self):
        curl, _, _ = transport([])
        namespace, _ = diagnostic.load_sources(diagnostic.BASE, curl, self.config()["settings"])
        engine = namespace["RegistrationEngine"]
        for name in ("run", "_create_email", "_register_password", "_get_verification_code", "_handle_oauth_callback"):
            self.assertFalse(hasattr(engine, name))
        result, _, _ = self.run_fake([trace(), Response(), Response(url="https://sentinel.openai.com/backend-api/sentinel/req",
            body={"token": "fixture-token-secret", "error": {"code": "fixture-private-code", "message": "fixture-secret-response"}})])
        output = json.dumps(result)
        for secret in ("fixture-device-secret", "fixture-token-secret", "fixture-private-code", "fixture-secret-response", "203.0.113.10", "auth/callback"):
            self.assertNotIn(secret, output)
        self.assertFalse(result["accountCreationTested"])


if __name__ == "__main__":
    unittest.main()
