"""Pro 档位回归：合成凭据、全部请求在本机拦截，绝不连接支付服务。"""
import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

from attempt_ledger import AttemptLedger, existing_checkout
from browser_checkout import NetworkGuard, quote_from_text, workflow
from checkout_core import ROOT, CHECKOUT_PATH, Stop, parse_browser_credential
from pay import choose_plan, run_payment, verify_identity_again
from payment_state import PaymentLedger, outcome, quote_digest
from plans import checkout_text_plan
from test_payment import details
from test_subscribe import fixture, account


def pro_quote(tier=5):
    return quote_from_text(f"ChatGPT Pro {tier}x\nTotal due today\nMYR 420.00\nTax\nMYR 0.00\nRenews\nMYR 420.00\nper month")


class ProStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "state"
        self.target = parse_browser_credential(fixture())

    def tearDown(self):
        self.temp.cleanup()

    def marker(self, plan):
        with AttemptLedger(self.root, self.target.account_id, target_plan=plan) as ledger:
            ledger.begin()
            ledger.finish({"checkout_identifier": "cs_" + plan.replace("-", "") + "_synthetic", "processor_entity": "openai_ie"})
            return ledger.path

    def test_pro_mapping_is_the_observed_official_request(self):
        for plan, official in (("pro-5x", "chatgptprolite"), ("pro-20x", "chatgptpro")):
            with self.subTest(plan=plan), AttemptLedger(self.root, self.target.account_id, target_plan=plan) as ledger:
                guard = NetworkGuard(self.target, ledger)
                guard.armed = True
                headers = {"authorization": "Bearer " + self.target.old_token}
                self.assertEqual(guard.classify("POST", "https://chatgpt.com" + CHECKOUT_PATH, {"plan_name": official}, headers), "create")
                wrong = "chatgptpro" if plan == "pro-5x" else "chatgptprolite"
                self.assertEqual(guard.classify("POST", "https://chatgpt.com" + CHECKOUT_PATH, {"plan_name": wrong}, headers), "plan_mismatch")

    def test_plan_records_are_distinct_and_old_plus_bytes_preserved(self):
        plus = self.marker("plus")
        before = plus.read_bytes()
        five, twenty = self.marker("pro-5x"), self.marker("pro-20x")
        self.assertEqual(plus.read_bytes(), before)
        self.assertEqual(len({plus, five, twenty}), 3)
        for plan in ("plus", "pro-5x", "pro-20x"):
            self.assertEqual(existing_checkout(self.root, self.target.account_id, plan)["target_plan"], plan)
            with self.assertRaises(Stop):
                with AttemptLedger(self.root, self.target.account_id, target_plan=plan):
                    pass

    def test_cross_plan_account_lock(self):
        with AttemptLedger(self.root, self.target.account_id, target_plan="pro-5x"):
            with self.assertRaises(Stop):
                with AttemptLedger(self.root, self.target.account_id, target_plan="pro-20x"):
                    pass

    def test_changing_plan_cannot_bypass_any_payment_attempt(self):
        self.marker("plus")
        self.marker("pro-5x")
        with PaymentLedger(self.root, self.target.account_id, target_plan="pro-5x") as ledger:
            ledger.begin(pro_quote(), confirmed_digest=quote_digest(pro_quote()), card_last4="4242")
        with self.assertRaises(Stop):
            with PaymentLedger(self.root, self.target.account_id):
                pass
        with self.assertRaises(Stop):
            with AttemptLedger(self.root, self.target.account_id, target_plan="pro-20x"):
                pass
        with PaymentLedger(self.root, self.target.account_id, target_plan="pro-5x") as ledger:
            self.assertEqual(ledger.record["target_plan"], "pro-5x")
            with self.assertRaises(Stop):
                ledger.assert_unattempted()

    def test_quote_tier_is_required_and_never_inferred_from_price(self):
        self.assertEqual(checkout_text_plan("ChatGPT Pro 5×"), "pro-5x")
        self.assertEqual(checkout_text_plan("ChatGPT Pro 20x\nIncludes Plus"), "pro-20x")
        self.assertEqual(checkout_text_plan("ChatGPT Pro\nMYR 420"), "pro")
        self.assertEqual(checkout_text_plan("ChatGPT Pro\n5x\n20x"), "pro")
        with self.assertRaises(Stop):
            quote_digest({**pro_quote(), "plan": "pro"})

    def test_wrong_tier_quote_cannot_be_paid(self):
        self.marker("pro-20x")
        with PaymentLedger(self.root, self.target.account_id, target_plan="pro-20x") as ledger:
            with self.assertRaises(Stop):
                ledger.begin(pro_quote(), confirmed_digest=quote_digest(pro_quote()), card_last4="4242")
            self.assertFalse(ledger.path.exists())

    def test_generic_pro_status_does_not_prove_multiplier(self):
        evidence = {"kind": "checkout_session", "identifier": "cs_synthetic", "amount_minor": 42000, "currency": "MYR"}
        self.assertEqual(outcome("paid", "pro", evidence, target_plan="pro-5x"), "paid_tier_pending_verification")
        self.assertEqual(outcome("paid", "pro", evidence, target_plan="pro-5x", current_tier=20), "paid_pending_activation")
        self.assertEqual(outcome("paid", "pro", evidence, target_plan="pro-20x", current_tier=20), "subscription_activated")
        self.assertEqual(outcome("unknown", "pro", target_plan="pro-20x", current_tier=20), "payment_result_unknown")

    def test_native_plan_choice_selects_exact_tier_and_cancel_never_defaults(self):
        with patch("pay.sys.stdin.isatty", return_value=True), patch("pay.focus_input_terminal"), contextlib.redirect_stdout(io.StringIO()):
            for value, expected in (("1", "plus"), ("2", "pro-5x"), ("3", "pro-20x")):
                with patch("builtins.input", return_value=value):
                    self.assertEqual(choose_plan(), expected)
            with patch("builtins.input", return_value=""), self.assertRaises(Stop):
                choose_plan()


class ProBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / ".browsers"))
        self.p = await async_playwright().start()
        self.browser = await self.p.chromium.launch(headless=True)
        self.context = await self.browser.new_context(service_workers="block")
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "state"
        self.target = parse_browser_credential(fixture())
        self.plan = "pro-5x"
        self.creates, self.payments = [], 0
        self.wrong_request = False
        self.generic_quote = False
        await self.context.route("**/*", self.server)

    async def asyncTearDown(self):
        await self.context.close()
        await self.browser.close()
        await self.p.stop()
        self.temp.cleanup()

    async def server(self, route):
        request = route.request
        path = urlsplit(request.url).path
        if path == "/api/auth/session":
            await route.fulfill(json=json.loads(fixture()))
        elif path.startswith("/backend-api/accounts/"):
            await route.fulfill(json=account("pro" if self.payments else "free"))
        elif path == CHECKOUT_PATH:
            self.creates.append(request.post_data_json)
            self.assertTrue(list(self.root.glob("*.json")))
            await route.fulfill(json={"checkout_session_id": "cs_pro_synthetic", "processor_entity": "openai_ie", "billing_details": {"currency": "MYR"}})
        elif path == "/v1/payment_methods":
            await route.fulfill(json={"id": "pm_synthetic"}, headers={"Access-Control-Allow-Origin": "https://chatgpt.com"})
        elif path == "/v1/payment_pages/cs_pro_synthetic/confirm":
            self.payments += 1
            files = list((self.root / "payments").glob("*.json"))
            self.assertEqual(json.loads(files[0].read_text())["confirmation_requests_sent"], 1)
            await route.fulfill(json={"object": "checkout.session", "session_id": "cs_pro_synthetic", "id": "page_synthetic",
                                     "status": "complete", "payment_status": "paid", "total_summary": {"due": 42000}, "currency": "myr"},
                                headers={"Access-Control-Allow-Origin": "https://chatgpt.com"})
        elif path.startswith("/checkout/"):
            title = "Pro 套餐"
            radios = "" if self.generic_quote else (
                '<button role="radio" aria-label="相比 Plus 多 5 倍使用额度" aria-checked="' + str(self.plan == "pro-5x").lower() + '">5 倍</button>'
                '<button role="radio" aria-label="相比 Plus 多 20 倍使用额度" aria-checked="' + str(self.plan == "pro-20x").lower() + '">20 倍</button>')
            await route.fulfill(content_type="text/html; charset=utf-8", body='''<html><body>
                <h1>TITLE</h1>RADIOS<p>Total due today</p><p>MYR 420.00</p><p>Tax</p><p>MYR 0.00</p>
                <p>Renews</p><p>MYR 420.00</p><p>per month</p>
                <input autocomplete="cc-number"><input autocomplete="cc-exp"><input autocomplete="cc-csc">
                <button type="submit" onclick="pay()">订阅</button>
                <script>async function pay(){
                    await fetch('https://api.stripe.com/v1/payment_methods',{method:'POST',body:'type=card'});
                    await fetch('https://api.stripe.com/v1/payment_pages/cs_pro_synthetic/confirm',{method:'POST',body:'payment_method=pm_synthetic'});
                }</script></body></html>'''.replace("TITLE", title).replace("RADIOS", radios))
        elif path == "/":
            headers = json.dumps({"Authorization": "Bearer " + self.target.old_token, "Content-Type": "application/json"})
            await route.fulfill(content_type="text/html; charset=utf-8", body='''<html><title>ChatGPT</title><body>
                <button onclick="document.querySelector('[role=dialog]').hidden=false">Upgrade</button>
                <section role="dialog" hidden><button>Get Plus</button>
                <button id="five" role="radio" aria-checked="true" onclick="choose(5)">5x</button>
                <button id="twenty" role="radio" aria-checked="false" onclick="choose(20)">20x</button>
                <p id="usage">5x Plus</p><button onclick="create()">升级至 Pro</button></section>
                <script>let tier=5;function choose(n){tier=n;document.querySelector('#five').setAttribute('aria-checked',n===5);
                    document.querySelector('#twenty').setAttribute('aria-checked',n===20);document.querySelector('#usage').innerText=n+'x Plus';}
                async function create(){const r=await fetch('CHECKOUT',{method:'POST',headers:HEADERS,
                    body:JSON.stringify({plan_name:WRONG?'chatgptpro':tier===5?'chatgptprolite':'chatgptpro',billing_details:{country:'MY',currency:'MYR'}})});
                    if(r.ok)location.href='/checkout/openai_ie/'+(await r.json()).checkout_session_id;}
                </script></body></html>'''.replace("CHECKOUT", CHECKOUT_PATH).replace("HEADERS", headers).replace("WRONG", str(self.wrong_request).lower()))
        else:
            await route.abort()

    async def create(self):
        with AttemptLedger(self.root, self.target.account_id, target_plan=self.plan) as ledger, contextlib.redirect_stderr(io.StringIO()):
            return await workflow(self.context, self.target, ledger=ledger, target_plan=self.plan, quote_timeout=1)

    async def test_pro5_official_selection_request_and_quote(self):
        result = await self.create()
        self.assertEqual(result["status"], "checkout_quote_verified", result)
        self.assertEqual(result["quote"]["plan"], "pro-5x")
        self.assertEqual(self.creates[0]["plan_name"], "chatgptprolite")
        self.assertEqual(self.payments, 0)

    async def test_pro20_official_selection_request_and_quote(self):
        self.plan = "pro-20x"
        result = await self.create()
        self.assertEqual(result["status"], "checkout_quote_verified", result)
        self.assertEqual(result["quote"]["plan"], "pro-20x")
        self.assertEqual(self.creates[0]["plan_name"], "chatgptpro")
        self.assertEqual(self.payments, 0)

    async def test_wrong_tier_request_never_leaves_browser(self):
        self.wrong_request = True
        result = await self.create()
        self.assertEqual(result["reason"], "checkout_plan_mismatch", result)
        self.assertEqual(self.creates, [])

    async def test_quote_without_multiplier_is_not_accepted_for_payment(self):
        self.generic_quote = True
        result = await self.create()
        self.assertEqual(result["reason"], "checkout_tier_not_verified", result)
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(self.payments, 0)

    async def pay_original(self):
        await self.create()
        await self.context.close()
        self.context = await self.browser.new_context(service_workers="block")
        await self.context.route("**/*", self.server)
        async def local_browser(target, **kwargs):
            return await workflow(self.context, target, existing=existing_checkout(self.root, target.account_id, self.plan),
                                  target_plan=kwargs["target_plan"], quote_handler=kwargs["quote_handler"], guard_factory=kwargs["guard_factory"])
        with PaymentLedger(self.root, self.target.account_id, target_plan=self.plan) as ledger:
            with patch("pay.run_browser", side_effect=local_browser), contextlib.redirect_stderr(io.StringIO()):
                result = await run_payment(self.target, ledger, pay=True, details_reader=details, confirmer=lambda *_: True,
                                           wait_seconds=.3, poll_count=1, poll_interval=.01)
            return result

    async def test_pro_payment_is_once_and_generic_pro_requires_tier_recheck(self):
        result = await self.pay_original()
        self.assertEqual(result["status"], "paid_tier_pending_verification", result)
        self.assertEqual(result["target_plan"], "pro-5x")
        self.assertEqual(self.payments, 1)
        self.assertEqual(len(self.creates), 1)

    async def test_pro20_payment_uses_its_own_order(self):
        self.plan = "pro-20x"
        result = await self.pay_original()
        self.assertEqual(result["status"], "paid_tier_pending_verification", result)
        self.assertEqual(result["target_plan"], "pro-20x")
        self.assertEqual(self.payments, 1)

    async def test_switching_checkout_tier_after_confirmation_blocks_payment(self):
        async def switch(page, target):
            identity = await verify_identity_again(page, target)
            await page.get_by_role("radio").evaluate_all("""nodes => nodes.forEach(n => {
                n.setAttribute('aria-checked',n.getAttribute('aria-label').includes('20')?'true':'false');
            })""")
            return identity
        with patch("pay.verify_identity_again", side_effect=switch):
            result = await self.pay_original()
        self.assertEqual(result["reason"], "payment_quote_changed", result)
        self.assertEqual(self.payments, 0)


if __name__ == "__main__":
    unittest.main()
