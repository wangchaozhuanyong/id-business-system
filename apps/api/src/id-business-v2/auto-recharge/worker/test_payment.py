"""付款阶段的本地合成数据与 Chromium 测试，全部网络请求在本机拦截。"""
import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

from attempt_ledger import AttemptLedger
from browser_checkout import quote_from_text, workflow
from checkout_core import ROOT, Stop, parse_browser_credential
from pay import include_payment_record, run_payment
from payment_recovery import recheck_in_context
from payment_form import PaymentDetails, validate_details
from payment_network import PaymentGuard
from payment_state import PaymentLedger, outcome, payment_evidence, quote_digest
from test_subscribe import fixture, account


def details():
    # Stripe 公布的测试 Visa 号，仅用于本地拦截夹具；绝不访问真实服务。
    return PaymentDetails("4242424242424242", "12/39", "123", "Synthetic User", "test@example.invalid",
                          "MY", "Synthetic address", "", "Synthetic city", "", "00000")


def quote():
    return quote_from_text("ChatGPT Plus\n今日应付金额\nMYR 92.50\n预估税费\nMYR 0.00\n将按 每月 自动续订。将按 MYR 92.50/月 收费。", "MYR")


def create_marker(root, target):
    with AttemptLedger(root, target.account_id) as ledger:
        ledger.begin()
        ledger.finish({"checkout_identifier": "cs_synthetic", "processor_entity": "openai_ie",
                       "returned_currency": "MYR", "checkout_outcome": "created"})


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "state"
        self.target = parse_browser_credential(fixture())
        create_marker(self.root, self.target)

    def tearDown(self):
        self.temp.cleanup()

    def test_crash_before_click_and_restart_never_repay(self):
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            ledger.begin(quote(), confirmed_digest=quote_digest(quote()), card_last4="4242")
            path = ledger.path
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            with self.assertRaises(Stop):
                ledger.assert_unattempted()
            self.assertEqual(ledger.record["payment_status"], "unknown")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        saved = path.read_text()
        for secret in (self.target.old_token, self.target.session_token, details().number, details().email):
            self.assertNotIn(secret, saved)
        self.assertNotIn('"cvc"', saved)

    def test_quote_change_before_marker_stops(self):
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            with self.assertRaises(Stop):
                ledger.begin(quote(), confirmed_digest="old", card_last4="4242")
            self.assertFalse(ledger.path.exists())

    def test_concurrent_account_operation_is_blocked(self):
        with PaymentLedger(self.root, self.target.account_id):
            with self.assertRaises(Stop):
                with PaymentLedger(self.root, self.target.account_id):
                    pass

    def test_confirmation_before_send_and_duplicate(self):
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            ledger.begin(quote(), confirmed_digest=quote_digest(quote()), card_last4="4242")
            ledger.mark_confirmation_sent()
            self.assertEqual(json.loads(ledger.path.read_text())["confirmation_requests_sent"], 1)
            with self.assertRaises(Stop):
                ledger.mark_confirmation_sent()

    def test_payment_success_requires_order_amount_currency_and_subscription(self):
        paid = {"id": "cs_synthetic", "object": "checkout.session", "status": "complete", "payment_status": "paid",
                "amount_total": 9250, "currency": "myr"}
        evidence = payment_evidence(paid, "cs_synthetic", quote())
        self.assertIsNotNone(evidence)
        for change in ({"id": "cs_other"}, {"amount_total": 9251}, {"currency": "usd"}, {"payment_status": "unpaid"}):
            self.assertIsNone(payment_evidence({**paid, **change}, "cs_synthetic", quote()))
        self.assertEqual(outcome("paid", "free", evidence), "paid_pending_activation")
        self.assertEqual(outcome("paid", "plus", evidence), "subscription_activated")
        self.assertEqual(outcome("unknown", "plus"), "payment_result_unknown")

    def test_decline_cannot_overwrite_existing_paid_evidence(self):
        evidence = {"kind": "checkout_session", "identifier": "cs_synthetic", "amount_minor": 9250, "currency": "MYR"}
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            ledger.begin(quote(), confirmed_digest=quote_digest(quote()), card_last4="4242")
            ledger.update(payment_status="paid", evidence=evidence)
            ledger.update(payment_status="declined", current_plan="plus")
            self.assertEqual(ledger.record["status"], "subscription_activated")

    def test_bad_card_and_sensitive_repr(self):
        card = details()
        self.assertNotIn(card.number, repr(card))
        card.number = "4242424242424241"
        with self.assertRaises(Stop):
            validate_details(card)
        card = details()
        card.expiry = "01/20"
        with self.assertRaises(Stop):
            validate_details(card)
        card.clear()
        self.assertFalse(card.number or card.cvc)

    def test_recovery_guard_cannot_submit_even_with_approval_state(self):
        async def exercise():
            with PaymentLedger(self.root, self.target.account_id) as ledger:
                ledger.begin(quote(), confirmed_digest=quote_digest(quote()), card_last4="4242")
                guard = PaymentGuard(self.target, ledger)
                guard.account_verified = True
                guard.checkout_id = ledger.checkout_id
                guard.approve(quote())
                guard.read_only = True
                route = AsyncMock()
                route.request.method = "POST"
                route.request.url = "https://api.stripe.com/v1/payment_pages/cs_synthetic/confirm"
                route.request.post_data = "x=y"
                route.request.post_data_json = None
                route.request.headers = {}
                await guard.route(route)
                route.fallback.assert_not_awaited()
                route.abort.assert_awaited_once()
                self.assertEqual(guard.confirmation_sent, 0)
        asyncio.run(exercise())

    def test_price_representation_must_match_charged_minor_amount(self):
        for change in ({"amount": "0.01"}, {"amount_minor": True}, {"currency": "UNKNOWN"}):
            value = quote()
            value["today"].update(change)
            with self.assertRaises(Stop):
                quote_digest(value)

    def test_recovery_rejects_modified_quote_without_changing_record(self):
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            ledger.begin(quote(), confirmed_digest=quote_digest(quote()), card_last4="4242")
            record, path = dict(ledger.record), ledger.path
        record["quote"]["today"]["amount"] = "1.00"
        path.write_text(json.dumps(record))
        original = path.read_bytes()
        with self.assertRaises(Stop):
            with PaymentLedger(self.root, self.target.account_id):
                pass
        self.assertEqual(path.read_bytes(), original)

    def test_wrong_order_and_paid_without_evidence_are_not_persisted(self):
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            ledger.begin(quote(), confirmed_digest=quote_digest(quote()), card_last4="4242")
            with self.assertRaises(Stop):
                ledger.update(payment_status="paid")
            with self.assertRaises(Stop):
                ledger.update(payment_status="paid", evidence={"kind": "checkout_session", "identifier": "cs_other",
                              "amount_minor": 9250, "currency": "MYR"})
            self.assertEqual(ledger.record["payment_status"], "unknown")

    def test_fresh_paid_evidence_survives_old_unknown_disk_record(self):
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            ledger.begin(quote(), confirmed_digest=quote_digest(quote()), card_last4="4242")
            evidence = {"kind": "checkout_session", "identifier": ledger.checkout_id,
                        "amount_minor": 9250, "currency": "MYR"}
            result = include_payment_record({"status": "paid_pending_activation", "payment_status": "paid",
                                             "payment_evidence": evidence, "payment_record_write_failed": True}, ledger)
            self.assertEqual(result["payment_status"], "paid")
            self.assertEqual(result["payment_evidence"], evidence)
            self.assertTrue(result["payment_record_write_failed"])

    def test_unverified_recheck_cannot_reuse_previous_plus(self):
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            ledger.begin(quote(), confirmed_digest=quote_digest(quote()), card_last4="4242")
            ledger.update(payment_status="paid", current_plan="plus", evidence={"kind": "checkout_session",
                          "identifier": ledger.checkout_id, "amount_minor": 9250, "currency": "MYR"})
            ledger.update(current_plan=None)
            self.assertEqual(ledger.record["status"], "paid_pending_activation")
            result = include_payment_record({"status": "blocked", "reason": "official_account_mismatch"}, ledger)
            self.assertEqual(result["status"], "paid_pending_activation")
            self.assertNotEqual(result["payment_outcome"], "subscription_activated")

    def test_observed_official_total_summary_shape_requires_paid_and_matching_due(self):
        data = {"id": "cs_synthetic", "object": "checkout.session", "status": "complete",
                "payment_status": "paid", "currency": "myr", "total_summary": {"due": 9250, "total": 9250}}
        self.assertIsNotNone(payment_evidence(data, "cs_synthetic", quote()))
        for change in ({"status": "open"}, {"payment_status": "unpaid"}, {"id": "cs_other"},
                       {"total_summary": {"due": 0, "total": 9250}}, {"total_summary": {"due": "9250"}},
                       {"amount_total": 100}):
            self.assertIsNone(payment_evidence({**data, **change}, "cs_synthetic", quote()))
        self.assertIsNotNone(payment_evidence({**data, "id": "page_synthetic", "session_id": "cs_synthetic"},
                                             "cs_synthetic", quote()))
        self.assertIsNone(payment_evidence({**data, "session_id": "cs_other"}, "cs_synthetic", quote()))


class PaymentBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / ".browsers"))
        self.p = await async_playwright().start()
        self.browser = await self.p.chromium.launch(headless=True)
        self.context = await self.browser.new_context(service_workers="block")
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "state"
        self.target = parse_browser_credential(fixture())
        create_marker(self.root, self.target)
        self.confirmations = 0
        self.tokenizations = 0
        self.new_checkouts = 0
        self.result_mode = "paid"
        self.activation_delayed = False
        self.recovery_paid = False
        self.recovery_activated = False
        self.official_totals_shape = False
        await self.context.route("**/*", self.server)

    async def asyncTearDown(self):
        await self.context.close()
        await self.browser.close()
        await self.p.stop()
        self.temp.cleanup()

    async def server(self, route):
        r = route.request
        p = urlsplit(r.url)
        if p.path == "/api/auth/session":
            await route.fulfill(json=json.loads(fixture()))
        elif p.path.startswith("/backend-api/accounts/"):
            plan = "plus" if (self.confirmations and self.result_mode == "paid" and not self.activation_delayed
                              or self.recovery_activated and not self.activation_delayed) else "free"
            await route.fulfill(json=account(plan))
        elif p.path == "/backend-api/payments/checkout":
            self.new_checkouts += 1
            await route.abort()
        elif p.path == "/v1/payment_methods":
            self.tokenizations += 1
            await route.fulfill(json={"id": "pm_synthetic"}, headers={"Access-Control-Allow-Origin": "https://chatgpt.com"})
        elif p.path == "/v1/payment_pages/cs_synthetic/init":
            if self.recovery_paid:
                self.recovery_activated = True
                data = {"id": "cs_synthetic", "object": "checkout.session", "status": "complete", "payment_status": "paid",
                        "amount_total": 9250, "currency": "myr"}
            else:
                data = {"id": "cs_synthetic", "status": "open"}
            await route.fulfill(json=data, headers={"Access-Control-Allow-Origin": "https://chatgpt.com"})
        elif p.path == "/v1/payment_pages/cs_synthetic/confirm":
            self.confirmations += 1
            files = list((self.root / "payments").glob("*.json"))
            self.assertEqual(len(files), 1)
            self.assertEqual(json.loads(files[0].read_text())["confirmation_requests_sent"], 1)
            if self.result_mode == "declined":
                data = {"error": {"code": "card_declined"}}
            elif self.result_mode == "action":
                data = {"payment_intent": {"id": "pi_synthetic", "status": "requires_action"}}
            elif self.result_mode == "unknown":
                data = {"status": "processing"}
            else:
                data = {"id": "cs_synthetic", "object": "checkout.session", "status": "complete", "payment_status": "paid",
                        "amount_total": 9250, "currency": "myr"}
                if self.official_totals_shape:
                    data.pop("amount_total")
                    data["id"] = "page_synthetic"
                    data["session_id"] = "cs_synthetic"
                    data["total_summary"] = {"due": 9250, "total": 9250}
            await route.fulfill(json=data, headers={"Access-Control-Allow-Origin": "https://chatgpt.com"})
        elif p.hostname == "js.stripe.com" and p.path == "/card-fixture":
            await route.fulfill(content_type="text/html; charset=utf-8", body='''<html><body>
              <label>卡号<input autocomplete="cc-number"></label>
              <label>有效期<input autocomplete="cc-exp"></label>
              <label>安全码<input autocomplete="cc-csc"></label>
              <label>将支付详情保存<input type="checkbox" name="savePayment" checked></label>
              </body></html>''')
        elif p.path.startswith("/checkout/"):
            await route.fulfill(content_type="text/html; charset=utf-8", body='''<html><body>
              <h1>ChatGPT Plus</h1><p>今日应付金额</p><p id="today">MYR 92.50</p>
              <p>预估税费</p><p>MYR 0.00</p><p>将按 每月 自动续订。将按 MYR 92.50/月 收费。</p>
              <iframe src="https://js.stripe.com/card-fixture"></iframe>
              <button type="submit" onclick="pay()">订阅</button>
              <script>fetch('https://api.stripe.com/v1/payment_pages/cs_synthetic/init',{method:'POST',body:'read=1'});
              async function pay(){
                await fetch('https://api.stripe.com/v1/payment_methods',{method:'POST',body:'type=card'});
                const u='https://api.stripe.com/v1/payment_pages/cs_synthetic/confirm';
                const a=fetch(u,{method:'POST',body:'payment_method=pm_synthetic'});
                fetch(u,{method:'POST',body:'payment_method=pm_synthetic'}).catch(()=>{});
                await a;
              }</script></body></html>''')
        elif p.path == "/":
            await route.fulfill(content_type="text/html; charset=utf-8", body="<html><title>ChatGPT</title><body>ChatGPT</body></html>")
        else:
            await route.abort()  # 禁止任何请求到公网，包括未列出的边界情况。

    async def flow(self, pay=True, confirmer=None):
        async def local_browser(target, **kwargs):
            from attempt_ledger import existing_checkout
            return await workflow(self.context, target, existing=existing_checkout(self.root, target.account_id),
                                  quote_handler=kwargs["quote_handler"], guard_factory=kwargs["guard_factory"])
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            with patch("pay.run_browser", side_effect=local_browser), contextlib.redirect_stderr(io.StringIO()):
                return await run_payment(self.target, ledger, pay=pay, details_reader=details,
                                         confirmer=confirmer or (lambda *_: True), wait_seconds=.3, poll_count=2, poll_interval=.01)

    async def test_prepare_fills_card_without_any_payment_or_new_order(self):
        result = await self.flow(False)
        self.assertEqual(result["status"], "payment_prepared", result)
        self.assertTrue(result["card_fields_filled"])
        self.assertEqual(self.confirmations + self.tokenizations + self.new_checkouts, 0)
        self.assertFalse(list((self.root / "payments").glob("*.json")))

    async def test_one_payment_success_and_double_submit_blocked(self):
        result = await self.flow()
        self.assertEqual(result["status"], "subscription_activated", result)
        self.assertEqual(self.confirmations, 1)
        self.assertEqual(self.tokenizations, 1)
        self.assertEqual(self.new_checkouts, 0)
        self.assertEqual(result["payment_status"], "paid")

    async def test_decline_and_unknown_are_not_success(self):
        self.result_mode = "declined"
        result = await self.flow()
        self.assertEqual(result["status"], "payment_failed", result)
        self.assertEqual(self.confirmations, 1)

    async def test_unknown_never_retries(self):
        self.result_mode = "unknown"
        result = await self.flow()
        self.assertEqual(result["status"], "payment_result_unknown", result)
        self.assertEqual(self.confirmations, 1)
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            with self.assertRaises(Stop):
                ledger.assert_unattempted()

    async def test_bank_verification_pauses_without_second_confirm(self):
        self.result_mode = "action"
        result = await self.flow()
        self.assertEqual(result["status"], "verification_required", result)
        self.assertEqual(self.confirmations, 1)

    async def test_paid_but_not_active_is_pending(self):
        self.activation_delayed = True
        result = await self.flow()
        self.assertEqual(result["status"], "paid_pending_activation", result)
        self.assertEqual(result["payment_status"], "paid")

    async def test_cancel_never_tokenizes_or_attempts_payment(self):
        result = await self.flow(confirmer=lambda *_: False)
        self.assertEqual(result["status"], "payment_cancelled", result)
        self.assertEqual(self.confirmations + self.tokenizations, 0)

    async def test_quote_changes_after_confirmation_stop_before_payment(self):
        async def changed(*_):
            await self.context.pages[0].locator("#today").evaluate("n=>n.textContent='MYR 93.00'")
            return {"current_plan": "free"}
        with patch("pay.verify_identity_again", side_effect=changed):
            result = await self.flow()
        self.assertEqual(result["reason"], "payment_quote_changed", result)
        self.assertEqual(self.confirmations + self.tokenizations, 0)

    async def test_account_change_stops_before_payment(self):
        with patch("pay.verify_identity_again", side_effect=Stop("official_account_mismatch")):
            result = await self.flow()
        self.assertEqual(result["reason"], "official_account_mismatch", result)
        self.assertEqual(self.confirmations + self.tokenizations, 0)

    async def test_disk_failure_stops_before_any_card_request(self):
        with patch("payment_state.atomic_json", side_effect=OSError()):
            result = await self.flow()
        self.assertEqual(result["status"], "blocked", result)
        self.assertEqual(self.confirmations + self.tokenizations, 0)

    async def test_paid_response_is_preserved_when_all_later_disk_writes_fail(self):
        from attempt_ledger import atomic_json
        def fail_after_paid(path, data):
            if data.get("payment_status") == "paid":
                raise OSError()
            return atomic_json(path, data)
        with patch("payment_state.atomic_json", side_effect=fail_after_paid):
            result = await self.flow()
        self.assertEqual(result["status"], "subscription_activated", result)
        self.assertEqual(result["payment_status"], "paid")
        self.assertTrue(result["payment_record_write_failed"])
        self.assertIsNotNone(result["payment_evidence"])
        self.assertEqual(self.confirmations, 1)
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            self.assertEqual(ledger.record["payment_status"], "unknown")
            self.assertEqual(include_payment_record(result, ledger)["payment_status"], "paid")
            with self.assertRaises(Stop):
                ledger.assert_unattempted()

    async def test_delayed_preflight_duplicate_cannot_override_success(self):
        original = PaymentGuard.approve
        def slow_preflight(guard, value):
            original(guard, value)
            previous = guard.validate_before_confirm
            async def wait_once():
                await asyncio.sleep(.1)
                await previous()
            guard.validate_before_confirm = wait_once
        with patch.object(PaymentGuard, "approve", slow_preflight):
            result = await self.flow()
        self.assertEqual(result["status"], "subscription_activated", result)
        self.assertIsNone(result["payment_failure_reason"])
        self.assertEqual(self.confirmations, 1)

    async def test_observed_official_totals_shape_can_verify_payment(self):
        self.official_totals_shape = True
        result = await self.flow()
        self.assertEqual(result["status"], "subscription_activated", result)
        self.assertEqual(self.confirmations, 1)

    async def test_new_billing_field_after_confirmation_stops_payment(self):
        async def changed(*_):
            await self.context.pages[0].evaluate("""() => {
                const input=document.createElement('input'); input.autocomplete='postal-code';
                document.body.append(input);
            }""")
            return {"current_plan": "free"}
        with patch("pay.verify_identity_again", side_effect=changed):
            result = await self.flow()
        self.assertEqual(result["reason"], "billing_fields_changed", result)
        self.assertEqual(self.confirmations + self.tokenizations, 0)

    async def recover(self):
        await self.context.close()
        self.context = await self.browser.new_context(service_workers="block")
        await self.context.route("**/*", self.server)
        with PaymentLedger(self.root, self.target.account_id) as ledger, contextlib.redirect_stderr(io.StringIO()):
            return await recheck_in_context(self.context, self.target, ledger, timeout=.3, poll_count=2, poll_interval=.01)

    async def test_restart_reads_original_order_then_fresh_plan_without_new_payment(self):
        self.result_mode = "unknown"
        await self.flow()
        self.recovery_paid = True
        result = await self.recover()
        self.assertEqual(result["status"], "subscription_activated", result)
        self.assertEqual(result["payment_requests_sent"], 0)
        self.assertEqual(self.confirmations, 1)
        self.assertEqual(self.new_checkouts, 0)

    async def test_restart_unknown_order_stays_unknown_and_does_not_repay(self):
        self.result_mode = "unknown"
        await self.flow()
        result = await self.recover()
        self.assertEqual(result["status"], "payment_result_unknown", result)
        self.assertEqual(self.confirmations, 1)
        self.assertEqual(result["payment_requests_sent"], 0)

    async def test_restart_wrong_account_preserves_paid_but_invalidates_subscription(self):
        await self.flow()
        with patch("pay.verify_identity_again", side_effect=Stop("official_account_mismatch")):
            result = await self.recover()
        self.assertEqual(result["status"], "paid_pending_activation", result)
        self.assertFalse(result["account_matched"])
        self.assertEqual(self.confirmations, 1)
        self.assertEqual(result["payment_requests_sent"], 0)


if __name__ == "__main__":
    unittest.main()
