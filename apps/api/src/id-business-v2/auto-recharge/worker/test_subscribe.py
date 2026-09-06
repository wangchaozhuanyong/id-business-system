"""合成凭据单测；不访问真实账户。旧直连 POST 用例由浏览器请求门禁用例替代。"""
import asyncio
import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

import checkout_core as c
from attempt_ledger import AttemptLedger, existing_checkout, rejected_retry_allowed
from browser_checkout import NetworkGuard, money, quote_from_text, check_session
import subscribe


def fixture(*, expired=False, user_id="synthetic-user", expiry_offset=0):
    def part(data):
        return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")
    token = ".".join((part({"alg": "RS256"}), part({
        "exp": int(time.time()) + (-10 if expired else 3600) + expiry_offset,
        "https://api.openai.com/auth": {"chatgpt_account_id": "synthetic-account"},
        "https://api.openai.com/profile": {"email": "test@example.invalid"},
    }), "c3ludGhldGljX3NpZ25hdHVyZQ"))
    return json.dumps({"accessToken": token, "sessionToken": "SESSION_NOT_TO_PERSIST",
                       "password": "PASSWORD_NOT_TO_SEND", "account": {"id": "synthetic-account"},
                       "user": {"id": user_id, "email": "test@example.invalid"}}).encode()


def account(plan="free"):
    return {"accounts": {"synthetic-account": {"account": {"plan_type": plan}}}}


def rejected():
    return {"status": "blocked", "created_at": 1, "plan": "chatgptplusplan", "requested_country": "PH",
            "requested_currency": "PHP", "payment_status": "not_attempted", "reason": "http_error",
            "http_status": 400, "response_format": "json", "challenge_observed": False,
            "server_message": "Our systems have detected unusual activity. Please try again later.",
            "checkout_outcome": "not_confirmed"}


class CoreTests(unittest.TestCase):
    def test_observed_chinese_checkout_quote_and_estimated_tax(self):
        quote = quote_from_text("ChatGPT Plus\nMYR\u00a092.50\n预估税费\nMYR\u00a00.00\n今日应付金额\nMYR\u00a092.50\n"
                                "将按 每月 自动续订，直至取消。将按 MYR\u00a092.50/月 收费。", "MYR")
        self.assertEqual(quote["today"], {"currency": "MYR", "amount": "92.50", "amount_minor": 9250})
        self.assertEqual(quote["tax"]["amount"], "0.00")
        self.assertEqual(quote["tax_status"], "estimated")
        self.assertEqual(quote["renewal"], quote["today"])
        self.assertEqual(quote["renewal_interval"], "monthly")
        self.assertIsNone(quote_from_text("ChatGPT Plus\nMYR 92.50\n今日应付金额\n未知", "MYR")["today"])

    def test_conflicting_renewal_terms_remain_unknown(self):
        quote = quote_from_text("ChatGPT Plus\nRenews\nMYR 90.00\n将按 MYR 92.50/月 收费。", "MYR")
        self.assertIsNone(quote["renewal"])

    def test_http_credential_alias_no_session_required(self):
        token = json.loads(fixture())["accessToken"]
        self.assertEqual(c.parse_credential(json.dumps({"access_token": token}).encode()).account_id, "synthetic-account")

    def test_expired_access_is_accepted_only_for_browser_session_check(self):
        with self.assertRaises(c.Stop):
            c.parse_credential(fixture(expired=True))
        self.assertEqual(c.parse_browser_credential(fixture(expired=True)).account_id, "synthetic-account")

    def test_invalid_conflicting_inputs(self):
        data = json.loads(fixture())
        for raw in (b"{}", b"[]", b'{}{}', b'{"sessionToken":"a","sessionToken":"b"}',
                    json.dumps({**data, "session_token": "other"}).encode(),
                    json.dumps({**data, "access_token": "other"}).encode(),
                    json.dumps({**data, "account": {"id": "other"}}).encode(),
                    json.dumps({**data, "user": {"id": ""}}).encode(),
                    json.dumps({**data, "sessionToken": "cookie=value; Domain=other"}).encode()):
            with self.subTest(size=len(raw)), self.assertRaises(c.Stop):
                c.parse_browser_credential(raw)

    def test_missing_session_has_actionable_result(self):
        data = json.loads(fixture())
        del data["sessionToken"]
        with self.assertRaises(c.Stop) as caught:
            c.parse_browser_credential(json.dumps(data).encode())
        self.assertEqual(caught.exception.report["session_status"], "new_authorized_json_required")

    def test_cookie_chunking_and_no_repr_secrets(self):
        target = c.BrowserCredential("x" * 3937, "a", "u")
        cookies = c.session_cookies(target)
        self.assertEqual([x["name"] for x in cookies], ["__Secure-next-auth.session-token.0", "__Secure-next-auth.session-token.1"])
        self.assertEqual("".join(x["value"] for x in cookies), target.session_token)
        self.assertTrue(all(x["httpOnly"] and x["secure"] and x["url"] == "https://chatgpt.com/" for x in cookies))
        self.assertNotIn(target.session_token, repr(target))

    def test_cookie_that_fits_retains_original_name_and_value(self):
        for size in (3501, 3835, 3936):
            target = c.BrowserCredential("x" * size, "a", "u")
            cookies = c.session_cookies(target)
            self.assertEqual(len(cookies), 1)
            self.assertEqual(cookies[0]["name"], "__Secure-next-auth.session-token")
            self.assertEqual(cookies[0]["value"], target.session_token)

    def test_official_user_must_match(self):
        target = c.parse_browser_credential(fixture())
        with self.assertRaises(c.Stop) as caught:
            c.verify_official_session(json.loads(fixture(user_id="other")), target)
        self.assertEqual(caught.exception.report["reason"], "official_user_mismatch")

    def test_invalid_official_session_not_local_jwt_success(self):
        with self.assertRaises(c.Stop):
            c.verify_official_session({}, c.parse_browser_credential(fixture()))

    def test_official_refresh_replaces_expired_token(self):
        target = c.parse_browser_credential(fixture(expired=True))
        current = c.verify_official_session(json.loads(fixture()), target)
        self.assertGreater(current.expires_at, time.time())
        self.assertNotEqual(current.token, target.old_token)

    def test_official_account_must_match_not_first_account(self):
        with self.assertRaises(c.Stop):
            c.account_plan({"accounts": {"other": {"account": {"plan_type": "free"}}}}, "synthetic-account")

    def test_existing_subscription_conflict(self):
        data = account()
        data["accounts"]["synthetic-account"]["entitlement"] = {"has_active_subscription": True}
        with self.assertRaises(c.Stop):
            c.account_plan(data, "synthetic-account")

    def test_http_transport_is_read_only(self):
        with patch.object(c.http.client, "HTTPSConnection") as factory:
            with self.assertRaises(c.Stop):
                c.request("POST", c.CHECKOUT_PATH, c.parse_credential(fixture()), {"plan_name": "chatgptplusplan"})
            factory.assert_not_called()

    def test_http_no_redirect_and_no_session_header(self):
        with patch.object(c.http.client, "HTTPSConnection") as factory:
            conn = factory.return_value
            conn.getresponse.return_value.status = 302
            conn.getresponse.return_value.getheaders.return_value = []
            conn.getresponse.return_value.read.return_value = b"{}"
            with self.assertRaises(c.Stop):
                c.check_account(c.parse_credential(fixture()))
            self.assertEqual(factory.call_args.args, ("chatgpt.com",))
            headers = conn.request.call_args.args[3]
            self.assertNotIn("Cookie", headers)
            self.assertEqual(conn.request.call_count, 1)

    def test_error_redaction_and_request_id(self):
        token = c.parse_credential(fixture()).token
        raw = json.dumps({"error": {"code": "invalid_request", "param": "billing_details.currency",
                                    "message": "test@example.invalid " + token}}).encode()
        with self.assertRaises(c.Stop) as caught:
            c.response_json(400, {"x-request-id": "req-synthetic-123"}, raw, token)
        report = caught.exception.report
        self.assertEqual(report["server_param"], "billing_details.currency")
        self.assertEqual(report["x_request_id"], "req-synthetic-123")
        self.assertNotIn(token, str(report))
        self.assertNotIn("test@example.invalid", str(report))

    def test_challenge_is_observed_not_assumed(self):
        for headers, expected in (({}, False), ({"cf-mitigated": "challenge"}, True)):
            with self.assertRaises(c.Stop) as caught:
                c.response_json(403, headers, b"<html>blocked</html>", "")
            self.assertEqual(caught.exception.report["challenge_observed"], expected)

    def test_currency_is_actual_and_unknown_stays_unknown(self):
        for label, cur, amount in (("MYR 99.00", "MYR", "99.00"), ("PHP 1,100.00", "PHP", "1100.00"), ("JPY 3000", "JPY", "3000")):
            self.assertEqual(money(label)["currency"], cur)
            self.assertEqual(money(label)["amount"], amount)
        for label in ("$20.00", "MYR 99,00", "PHP 1.001", "USD 20 / MYR 99", "USD -20", "Tax 10%"):
            self.assertIsNone(money(label), label)

    def test_quote_requires_today_not_list_price(self):
        self.assertIsNone(quote_from_text("Plus\nUSD 20 per month")["today"])
        self.assertIsNone(quote_from_text("Plus\nDue today\nUnknown\nSubtotal USD 20.00")["today"])
        quote = quote_from_text("ChatGPT Plus\nTotal due today\nMYR 99.00\nTax\nMYR 0.00\nper month")
        self.assertEqual(quote["today"]["amount_minor"], 9900)
        self.assertEqual(quote["tax"]["amount_minor"], 0)

    def test_conflicting_quote_not_accepted(self):
        self.assertIsNone(quote_from_text("Plus\nDue today USD 20.00\nDue today USD 22.00")["today"])


class LedgerGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.target = c.parse_browser_credential(fixture())
        self.marker = self.state / (hashlib.sha256(self.target.account_id.encode()).hexdigest() + ".json")
        self.body = {"plan_name": "chatgptplusplan", "billing_details": {"currency": "MYR", "country": "MY"}}
        self.headers = {"authorization": "Bearer " + self.target.old_token, "chatgpt-account-id": self.target.account_id}

    def test_legacy_rejection_preserved_and_explicit_retry_once(self):
        before = json.dumps(rejected()).encode()
        self.marker.write_bytes(before)
        with self.assertRaises(c.Stop):
            with AttemptLedger(self.state, self.target.account_id):
                pass
        with AttemptLedger(self.state, self.target.account_id, retry_rejected=True) as ledger:
            self.assertEqual(self.marker.read_bytes(), before)
            ledger.begin()
            ledger.finish({**rejected(), "stage": "checkout_create"})
        self.assertEqual(next((self.state / "history").iterdir()).read_bytes(), before)
        with self.assertRaises(c.Stop):
            with AttemptLedger(self.state, self.target.account_id, retry_rejected=True):
                pass

    def test_unknown_timeout_paid_or_id_never_retry(self):
        for change in ({"http_status": 500}, {"reason": "network_timeout"}, {"status": "checkout_attempted"},
                       {"checkout_identifier": "oaics_test"}, {"payment_status": "unknown"},
                       {"challenge_observed": True}, {"response_format": "non_json"}):
            self.assertFalse(rejected_retry_allowed({**rejected(), **change}))

    def test_crash_marker_prevents_new_order(self):
        with AttemptLedger(self.state, self.target.account_id) as ledger:
            ledger.begin()
        self.assertEqual(json.loads(self.marker.read_text())["checkout_outcome"], "unknown")
        with self.assertRaises(c.Stop):
            with AttemptLedger(self.state, self.target.account_id, retry_rejected=True):
                pass

    def test_process_lock_and_double_begin(self):
        with AttemptLedger(self.state, self.target.account_id) as ledger:
            with self.assertRaises(c.Stop):
                with AttemptLedger(self.state, self.target.account_id):
                    pass
            ledger.begin()
            with self.assertRaises(c.Stop):
                ledger.begin()

    def test_session_only_and_account_mismatch_cannot_create(self):
        guard = NetworkGuard(self.target)
        url = "https://chatgpt.com" + c.CHECKOUT_PATH
        self.assertEqual(guard.classify("POST", url, self.body, self.headers), "unarmed")
        guard.armed, guard.ledger = True, object()
        self.assertEqual(guard.classify("POST", url, self.body, {**self.headers, "chatgpt-account-id": "other"}), "account_mismatch")
        self.assertFalse(self.marker.exists())

    def test_one_plus_only_and_preserves_website_currency(self):
        guard = NetworkGuard(self.target, object())
        guard.armed = True
        before = json.dumps(self.body)
        url = "https://chatgpt.com" + c.CHECKOUT_PATH
        self.assertEqual(guard.classify("POST", url, self.body, self.headers), "create")
        self.assertEqual(json.dumps(self.body), before)
        guard.sent = 1
        self.assertEqual(guard.classify("POST", url, self.body, self.headers), "duplicate")
        self.assertEqual(guard.classify("POST", url, {"plan_name": "pro"}, self.headers), "unknown_write")

    def test_payment_confirmation_and_unknown_writes_blocked(self):
        guard = NetworkGuard(self.target)
        for url in ("https://chatgpt.com/backend-api/payments/checkout/confirm", "https://api.stripe.com/v1/payment_intents/pi_test/confirm",
                    "https://api.stripe.com/v1/payment_methods"):
            self.assertEqual(guard.classify("POST", url), "payment")
        self.assertEqual(guard.classify("POST", "https://unknown.example/execute"), "unknown_write")

    def test_only_verified_original_checkout_initialization_is_allowed(self):
        guard = NetworkGuard(self.target)
        guard.checkout_id = "cs_synthetic"
        url = "https://api.stripe.com/v1/payment_pages/cs_synthetic/init"
        self.assertEqual(guard.classify("POST", url), "payment")
        guard.account_verified = True
        self.assertEqual(guard.classify("POST", url), "checkout_init")
        self.assertEqual(guard.classify("POST", url.replace("cs_synthetic", "cs_other")), "payment")
        self.assertEqual(guard.classify("POST", url.replace("/init", "/confirm")), "payment")

    def test_corrupt_state_blocks(self):
        self.marker.write_text("{")
        with self.assertRaises(ValueError):
            with AttemptLedger(self.state, self.target.account_id, retry_rejected=True):
                pass

    def test_existing_checkout_requires_observed_id_and_entity(self):
        self.marker.write_text(json.dumps({"plan": "chatgptplusplan", "checkout_identifier": "cs_synthetic"}))
        with self.assertRaises(c.Stop):
            existing_checkout(self.state, self.target.account_id)
        before = {"plan": "chatgptplusplan", "checkout_identifier": "cs_synthetic", "processor_entity": "openai_ie"}
        self.marker.write_text(json.dumps(before))
        self.assertEqual(existing_checkout(self.state, self.target.account_id), before)
        self.assertEqual(json.loads(self.marker.read_text()), before)

    def test_saved_state_contains_no_credentials(self):
        with AttemptLedger(self.state, self.target.account_id) as ledger:
            ledger.begin()
        saved = self.marker.read_text()
        for secret in (self.target.old_token, self.target.session_token, "test@example.invalid", "PASSWORD_NOT_TO_SEND"):
            self.assertNotIn(secret, saved)
        self.assertEqual(self.marker.stat().st_mode & 0o777, 0o600)

    def test_marker_failure_aborts_before_sending(self):
        async def exercise():
            with AttemptLedger(self.state, self.target.account_id) as ledger:
                guard = NetworkGuard(self.target, ledger)
                guard.armed = True
                route = AsyncMock()
                route.request.method = "POST"
                route.request.url = "https://chatgpt.com" + c.CHECKOUT_PATH
                route.request.post_data = json.dumps(self.body)
                route.request.post_data_json = self.body
                route.request.headers = self.headers
                with patch.object(ledger, "begin", side_effect=OSError()):
                    await guard.route(route)
                route.fallback.assert_not_awaited()
                route.abort.assert_awaited_once()
                self.assertEqual(guard.sent, 0)
        asyncio.run(exercise())


class PauseTests(unittest.IsolatedAsyncioTestCase):
    async def test_verification_pause_then_recheck_identity(self):
        target = c.parse_browser_credential(fixture())
        page = AsyncMock()
        page.title.side_effect = ["Just a moment", "ChatGPT"]
        with patch("browser_checkout.wait_for_user", new_callable=AsyncMock) as wait:
            with patch("browser_checkout.browser_read", side_effect=[json.loads(fixture()), account()]):
                _, result = await check_session(page, target, 30)
        wait.assert_awaited_once()
        self.assertTrue(result["account_matched"])

    async def test_account_change_after_verification_stops(self):
        target = c.parse_browser_credential(fixture())
        page = AsyncMock()
        page.title.side_effect = ["Just a moment", "ChatGPT"]
        with patch("browser_checkout.wait_for_user", new_callable=AsyncMock):
            with patch("browser_checkout.browser_read", return_value=json.loads(fixture(user_id="other"))):
                with self.assertRaises(c.Stop):
                    await check_session(page, target, 30)


class CliTests(unittest.TestCase):
    def test_session_default_and_preserves_old_report(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "fixture.json"
            source.write_bytes(fixture())
            old = root / "last-result.json"
            old.write_text("historical-result")
            with patch.object(subscribe, "ROOT", root), patch("browser_checkout.run_browser", new_callable=AsyncMock) as run:
                run.return_value = {"status": "session_verified"}
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(subscribe.main(["--json-file", str(source), "--check-session"]), 0)
                self.assertFalse(run.call_args.kwargs["create"])
            self.assertEqual(old.read_text(), "historical-result")


if __name__ == "__main__":
    unittest.main()
