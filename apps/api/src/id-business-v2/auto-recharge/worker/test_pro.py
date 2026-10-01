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
from browser_checkout import NetworkGuard, quote_from_page, quote_from_text, workflow
from checkout_core import ROOT, CHECKOUT_PATH, Stop, parse_browser_credential
from pay import choose_plan, run_payment, verify_identity_again
from payment_state import PaymentLedger, outcome, quote_digest
from payment_recovery import recheck_in_context
from plans import checkout_option_plan, checkout_text_plan, plan_spec, selection_spec
from plan_selection import select_plan, verify_selected_plan, price_pattern
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
        for plan, official in (("pro-5x", "chatgptprolite"), ("pro-20x", "chatgptpro"), ("pro-500", "chatgptpromax")):
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
        five, twenty, maximum = (self.marker(plan) for plan in ("pro-5x", "pro-20x", "pro-500"))
        self.assertEqual(plus.read_bytes(), before)
        self.assertEqual(len({plus, five, twenty, maximum}), 4)
        for plan in ("plus", "pro-5x", "pro-20x", "pro-500"):
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
        with self.assertRaises(Stop) as blocked:
            with PaymentLedger(self.root, self.target.account_id):
                pass
        self.assertEqual(blocked.exception.report["reason"], "account_has_other_payment_attempt")
        self.assertEqual(blocked.exception.report["recheck_plan"], "pro-5x")
        self.assertEqual(blocked.exception.report["checkout_identifier"], "cs_pro5x_synthetic")
        with self.assertRaises(Stop) as blocked:
            with AttemptLedger(self.root, self.target.account_id, target_plan="pro-20x"):
                pass
        self.assertEqual(blocked.exception.report["recheck_plan"], "pro-5x")
        with PaymentLedger(self.root, self.target.account_id, target_plan="pro-5x") as ledger:
            self.assertEqual(ledger.record["target_plan"], "pro-5x")
            with self.assertRaises(Stop) as same_plan:
                ledger.assert_unattempted()
            self.assertEqual(same_plan.exception.report["recheck_plan"], "pro-5x")
            self.assertEqual(
                same_plan.exception.report["checkout_identifier"], "cs_pro5x_synthetic"
            )

    def test_quote_tier_is_required_and_never_inferred_from_price(self):
        self.assertEqual(checkout_text_plan("ChatGPT Pro 5×"), "pro-5x")
        self.assertEqual(checkout_text_plan("ChatGPT Pro 20x\nIncludes Plus"), "pro-20x")
        self.assertEqual(checkout_text_plan("ChatGPT Pro\nMYR 420"), "pro")
        self.assertEqual(checkout_text_plan("ChatGPT Pro\n5x\n20x"), "pro")
        with self.assertRaises(Stop):
            quote_digest({**pro_quote(), "plan": "pro"})

    def test_pro_price_names_are_distinct_from_checkout_amounts(self):
        for price, plan in ((100, "pro-5x"), (200, "pro-20x"), (500, "pro-500")):
            self.assertEqual(checkout_text_plan(f"ChatGPT Pro {price}\nIncludes Plus"), plan)
        self.assertEqual(checkout_text_plan("ChatGPT Pro\nTotal due today\nUSD 500"), "pro")
        self.assertEqual(checkout_text_plan("Pro 100\nPro 500"), "pro")
        self.assertEqual(checkout_text_plan("Pro 500\n20x"), "pro")

    def test_scoped_checkout_keeps_legacy_tiers_and_rejects_conflicts(self):
        for label, plan in (("相比 Plus 多 5 倍使用额度", "pro-5x"), ("20×", "pro-20x"),
                            ("USD 500.00\nMax usage", "pro-500")):
            self.assertEqual(checkout_option_plan(label), plan)
        for label in ("Pro 500\n20x", "5x\n20x", "USD 500.00"):
            self.assertIsNone(checkout_option_plan(label))

    def test_500_requires_its_own_quote_and_promax_subscription(self):
        self.assertEqual(selection_spec("pro-500")["price_usd"], 500)
        self.assertEqual(plan_spec("pro-500")["official_name"], "chatgptpromax")
        self.marker("pro-500")
        quote = {**pro_quote(), "plan": "pro-500"}
        evidence = {"kind": "checkout_session", "identifier": "cs_pro500_synthetic",
                    "amount_minor": 42000, "currency": "MYR"}
        with PaymentLedger(self.root, self.target.account_id, target_plan="pro-500") as ledger:
            with self.assertRaises(Stop):
                ledger.begin(pro_quote(20), confirmed_digest=quote_digest(pro_quote(20)), card_last4="4242")
            self.assertFalse(ledger.path.exists())
            ledger.begin(quote, confirmed_digest=quote_digest(quote), card_last4="4242")
            ledger.update(payment_status="paid", evidence=evidence, current_plan="pro", current_tier=20)
            self.assertEqual(ledger.record["status"], "paid_pending_activation")
            ledger.update(current_plan="promax")
            self.assertEqual(ledger.record["status"], "subscription_activated")
            self.assertEqual(ledger.record["subscription_status"], "pro-500")
        with PaymentLedger(self.root, self.target.account_id, target_plan="pro-500") as ledger:
            with self.assertRaises(Stop):
                ledger.assert_unattempted()

    def test_server_500_confirmation_enforces_plan_currency_and_actual_cap(self):
        import server
        quote = {**pro_quote(), 'plan': 'pro-500'}
        safety = {'authorizeSinglePayment': True, 'lockedCurrency': 'MYR', 'maxAmountMinor': 42000}
        with patch.object(server, 'callback') as callback:
            job = server.Job('synthetic-job', {'action': 'server', 'plan': 'pro-500', 'safety': safety})
            self.assertTrue(job.confirm(quote, '4242'))
            self.assertEqual(callback.call_args[0][1]['result']['quote']['plan'], 'pro-500')
            for changed_quote, changed_safety in ((pro_quote(20), safety),
                    (quote, {**safety, 'maxAmountMinor': 41999}),
                    (quote, {**safety, 'lockedCurrency': 'USD'}),
                    (quote, {**safety, 'authorizeSinglePayment': False})):
                callback.reset_mock()
                job = server.Job('synthetic-job', {'action': 'server', 'plan': 'pro-500', 'safety': changed_safety})
                with self.assertRaises(Stop):
                    job.confirm(changed_quote, '4242')
                callback.assert_not_called()

    def test_local_connector_500_dispatch_preserves_single_payment_authorization(self):
        import bitbrowser_connector as connector
        from test_bitbrowser_connector import payload
        value = {**payload(), 'plan': 'pro-500'}
        self.assertIs(connector.validate_payload(value), value)
        with self.assertRaises(Stop):
            connector.validate_payload({**value, 'authorizeSinglePayment': False})
        recheck = {key: value[key] for key in (
            'id', 'plan', 'windowName', 'sessionJson', 'bitBrowser', 'callbackUrl', 'agentToken')}
        recheck['mode'] = 'recheck'
        self.assertEqual(connector.validate_payload(recheck)['plan'], 'pro-500')
        with self.assertRaises(Stop):
            connector.validate_payload({**recheck, 'details': value['details']})

    def test_price_choice_requires_explicit_usd_or_plan_name(self):
        for label in ("$500", "$500/month", "$500.00 USD / 月", "USD 500", "500 美元/月", "Pro 500"):
            self.assertRegex(label, price_pattern(500))
        for label in ("500", "PHP 500", "$200", "Pro 200", "500x", "$5000", "Total due today $500"):
            self.assertNotRegex(label, price_pattern(500))

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
            for value, expected in (("1", "plus"), ("2", "pro-5x"), ("3", "pro-20x"), ("4", "pro-500")):
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
        self.omit_plus = False
        self.localized_controls = False
        self.nonmodal = False
        self.missing_tier = False
        self.price_controls = False
        self.missing_500 = False
        self.duplicate_500 = False
        self.numeric_controls = False
        self.subscription_plan = None
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
            await route.fulfill(json=account((self.subscription_plan or ("promax" if self.plan == "pro-500" else "pro")) if self.payments else "free"))
        elif path == CHECKOUT_PATH:
            self.creates.append(request.post_data_json)
            self.assertTrue(list(self.root.glob("*.json")))
            await route.fulfill(json={"checkout_session_id": "cs_pro_synthetic", "processor_entity": "openai_ie", "billing_details": {"currency": "MYR"}})
        elif path == "/v1/payment_methods":
            await route.fulfill(json={"id": "pm_synthetic"}, headers={"Access-Control-Allow-Origin": "https://chatgpt.com"})
        elif path == "/v1/payment_pages/cs_pro_synthetic/init":
            await route.fulfill(json={"id": "cs_pro_synthetic", "status": "open", "currency": "myr",
                                      "total_summary": {"due": 42000, "total": 42000}},
                                headers={"Access-Control-Allow-Origin": "https://chatgpt.com"})
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
            if self.plan == "pro-500" and not self.generic_quote:
                labels = (("pro-5x", "标准"), ("pro-20x", "更多使用额度"), ("pro-500", "最高使用额度"))
                radios = '<div role="radiogroup" aria-label="Pro 套餐">' + ''.join(
                    f'<button role="radio" aria-checked="{str(self.plan == plan).lower()}">MYR 420.00<br>{label}</button>'
                    for plan, label in labels) + '</div>'
            await route.fulfill(content_type="text/html; charset=utf-8", body='''<html><body>
                <h1>TITLE</h1>RADIOS<p>Total due today</p><p>MYR 420.00</p><p>Tax</p><p>MYR 0.00</p>
                <p>Renews</p><p>MYR 420.00</p><p>per month</p>
                <input autocomplete="cc-number"><input autocomplete="cc-exp"><input autocomplete="cc-csc"
                  oninput="fetch('https://api.stripe.com/v1/payment_pages/cs_pro_synthetic/init',{method:'POST',body:'billing=changed'})">
                <button type="submit" onclick="pay()">订阅</button>
                <script>fetch('https://api.stripe.com/v1/payment_pages/cs_pro_synthetic/init',{method:'POST',body:'read=1'});
                async function pay(){
                    await fetch('https://api.stripe.com/v1/payment_methods',{method:'POST',body:'type=card'});
                    await fetch('https://api.stripe.com/v1/payment_pages/cs_pro_synthetic/confirm',{method:'POST',body:'payment_method=pm_synthetic'});
                }</script></body></html>'''.replace("TITLE", title).replace("RADIOS", radios))
        elif path == "/":
            headers = json.dumps({"Authorization": "Bearer " + self.target.old_token, "Content-Type": "application/json"})
            html = '''<html><title>ChatGPT</title><body>
                <button onclick="document.querySelector('[role=dialog]').hidden=false">Upgrade</button>
                <section role="dialog" hidden><button>Get Plus</button>
                <button id="five" role="radio" aria-checked="true" onclick="choose(5)">5x</button>
                <button id="twenty" role="radio" aria-checked="false" onclick="choose(20)">20x</button>
                <p id="usage">5x Plus</p><button onclick="create()">升级至 Pro</button></section>
                <script>let tier=5;function choose(n){tier=n;document.querySelector('#five').setAttribute('aria-checked',n===5);
                    document.querySelector('#twenty').setAttribute('aria-checked',n===20);document.querySelector('#usage').innerText=n+'x Plus';}
                async function create(){const r=await fetch('CHECKOUT',{method:'POST',headers:HEADERS,
                    body:JSON.stringify({plan_name:WRONG?'chatgptpro':tier===500?'chatgptpromax':tier===5?'chatgptprolite':'chatgptpro',billing_details:{country:'MY',currency:'MYR'}})});
                    if(r.ok)location.href='/checkout/openai_ie/'+(await r.json()).checkout_session_id;}
                </script></body></html>'''.replace("CHECKOUT", CHECKOUT_PATH).replace("HEADERS", headers).replace("WRONG", str(self.wrong_request).lower())
            if self.omit_plus:
                html = html.replace('<button>Get Plus</button>', '')
            if self.localized_controls:
                html = html.replace('>Upgrade</button>', '>升级</button>').replace('>5x</button>', '>5 倍</button>').replace('>20x</button>', '>20×</button>')
            if self.nonmodal:
                html = html.replace('role="dialog"', 'role="main"').replace('[role=dialog]', '[role=main]')
            if self.missing_tier:
                html = html.replace('>20x</button>', '>不同档位</button>')
            if self.price_controls:
                html = html.replace('>5x</button>', '>$100/month</button>').replace('>20x</button>', '>Pro 200</button>')
                maximum = '<button id="maximum" role="radio" aria-checked="false" onclick="choose(500)">$500/month</button>'
                if not self.missing_500:
                    html = html.replace('<p id="usage">', maximum + '<p id="usage">')
                if self.duplicate_500:
                    html = html.replace('<p id="usage">', maximum.replace('id="maximum"', 'id="duplicate"') + '<p id="usage">')
                html = html.replace("document.querySelector('#usage').innerText=n+'x Plus';",
                                    "document.querySelector('#maximum')?.setAttribute('aria-checked',n===500);document.querySelector('#usage').innerText=n+'x Plus';")
            if self.numeric_controls:
                html = html.replace('>$100/month</button>', '>100</button>').replace('>Pro 200</button>', '>200</button>').replace('>$500/month</button>', '>500</button>')
                html = html.replace('<button id="five"', '<div role="radiogroup" aria-label="选择 Pro 套餐档位"><button id="five"')
                html = html.replace('<p id="usage">', '</div><button role="radio">500</button><p id="usage">')
            await route.fulfill(content_type="text/html; charset=utf-8", body=html)
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

    async def test_current_pro200_price_control_keeps_existing_request_binding(self):
        self.plan, self.price_controls = "pro-20x", True
        result = await self.create()
        self.assertEqual(result["status"], "checkout_quote_verified", result)
        self.assertEqual(self.creates[0]["plan_name"], "chatgptpro")
        self.assertEqual(self.payments, 0)

    async def test_pro500_choice_can_be_prepared_without_creating_checkout(self):
        self.price_controls = True
        page = await self.context.new_page()
        await page.goto("https://chatgpt.com/")
        button = await select_plan(page, "pro-500", lambda *_args, **_kwargs: None)
        self.assertEqual(await button.inner_text(), "升级至 Pro")
        self.assertEqual(await page.get_by_role("radio", name="$500/month").get_attribute("aria-checked"), "true")
        await verify_selected_plan(page, "pro-500")
        await page.get_by_role("radio", name="Pro 200").click()
        with self.assertRaises(Stop) as changed:
            await verify_selected_plan(page, "pro-500")
        self.assertEqual(changed.exception.report["reason"], "selected_plan_changed")
        self.assertFalse(self.creates)
        self.assertEqual(self.payments, 0)

    async def test_missing_or_ambiguous_500_option_never_selects_another_plan(self):
        self.price_controls = True
        for duplicate in (False, True):
            self.missing_500, self.duplicate_500 = not duplicate, duplicate
            page = await self.context.new_page()
            await page.goto("https://chatgpt.com/")
            with patch("plan_selection.STEP_SECONDS", .2), patch("plan_selection.SELECTION_SECONDS", 1):
                with self.assertRaises(Stop) as blocked:
                    await select_plan(page, "pro-500", lambda *_args, **_kwargs: None)
            self.assertEqual(blocked.exception.report["reason"],
                             "official_plan_option_ambiguous" if duplicate else "official_plan_tier_not_found")
            await page.close()
        self.assertFalse(self.creates)
        self.assertEqual(self.payments, 0)

    async def test_pro500_official_selection_request_and_quote(self):
        self.plan, self.price_controls, self.numeric_controls = "pro-500", True, True
        result = await self.create()
        self.assertEqual(result["status"], "checkout_quote_verified", result)
        self.assertEqual(result["quote"]["plan"], "pro-500")
        self.assertEqual(result["quote"]["today"]["currency"], "MYR")
        self.assertEqual(self.creates[0]["plan_name"], "chatgptpromax")
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(self.payments, 0)

    async def test_pro500_wrong_request_is_blocked_before_sending(self):
        self.plan, self.price_controls, self.wrong_request = "pro-500", True, True
        result = await self.create()
        self.assertEqual(result["reason"], "checkout_plan_mismatch", result)
        self.assertFalse(self.creates)
        self.assertEqual(self.payments, 0)

    async def test_pro500_payment_and_recheck_never_charge_twice(self):
        self.plan, self.price_controls, self.numeric_controls = "pro-500", True, True
        result = await self.pay_original()
        self.assertEqual(result["status"], "subscription_activated", result)
        self.assertEqual(result["current_plan"], "promax")
        await self.context.close()
        self.context = await self.browser.new_context(service_workers="block")
        await self.context.route("**/*", self.server)
        with PaymentLedger(self.root, self.target.account_id, target_plan=self.plan) as ledger, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(Stop):
                await run_payment(self.target, ledger, pay=True)
            recheck = await recheck_in_context(self.context, self.target, ledger, timeout=.3, poll_count=1, poll_interval=.01)
            self.assertEqual(recheck["status"], "subscription_activated", recheck)
            self.assertEqual(recheck["payment_requests_sent"], 0)
            self.assertEqual(ledger.record["subscription_status"], "pro-500")
        self.assertEqual(self.payments, 1)
        self.assertEqual(len(self.creates), 1)

    async def test_pro500_generic_pro_cannot_mark_activation(self):
        self.plan, self.price_controls, self.subscription_plan = "pro-500", True, "pro"
        result = await self.pay_original()
        self.assertEqual(result["status"], "paid_pending_activation", result)
        self.assertEqual(self.payments, 1)

    async def test_checkout_max_usage_requires_unique_scoped_selection(self):
        page = await self.context.new_page()
        base = '<h1>Pro 套餐</h1><p>Total due today</p><p>USD 500.00</p>'
        for label in ("Max usage", "最高使用额度"):
            with self.subTest(label=label):
                options = ('<button role="radio" aria-checked="false">USD 100.00<br>Standard</button>'
                           f'<button role="radio" aria-checked="true">USD 500.00<br>{label}</button>')
                await page.set_content(base + options)
                self.assertEqual((await quote_from_page(page))["plan"], "pro")
                group = '<div role="radiogroup" aria-label="Pro plan">' + options + '</div>'
                await page.set_content(base + group)
                self.assertEqual((await quote_from_page(page))["plan"], "pro-500")
                await page.set_content(base + group.replace('aria-checked="false"', 'aria-checked="true"'))
                self.assertEqual((await quote_from_page(page))["plan"], "pro")
                await page.set_content(base + group + group)
                self.assertEqual((await quote_from_page(page))["plan"], "pro")

    async def test_numeric_pro_controls_require_unique_selection_before_creation(self):
        self.price_controls = self.numeric_controls = True
        page = await self.context.new_page()
        await page.goto("https://chatgpt.com/")
        await select_plan(page, "pro-500", lambda *_args, **_kwargs: None)
        await page.get_by_role('radio', name='200', exact=True).evaluate(
            "n => n.setAttribute('aria-checked','true')")
        with self.assertRaises(Stop) as blocked:
            await verify_selected_plan(page, "pro-500")
        self.assertEqual(blocked.exception.report['reason'], 'selected_plan_changed')
        self.assertFalse(self.creates)

    async def test_pro_does_not_require_plus_button(self):
        self.omit_plus = True
        result = await self.create()
        self.assertEqual(result['status'], 'checkout_quote_verified', result)
        self.assertEqual(len(self.creates), 1)

    async def test_localized_nonmodal_pro20_selection(self):
        self.plan = 'pro-20x'
        self.nonmodal = self.localized_controls = True
        result = await self.create()
        self.assertEqual(result['status'], 'checkout_quote_verified', result)
        self.assertEqual(result['quote']['plan'], 'pro-20x')

    async def test_missing_tier_is_not_replaced_by_another_plan(self):
        self.plan, self.missing_tier = 'pro-20x', True
        with patch('plan_selection.STEP_SECONDS', .5), patch('plan_selection.SELECTION_SECONDS', 2):
            result = await self.create()
        self.assertEqual(result['reason'], 'official_plan_tier_not_found', result)
        self.assertEqual(result['diagnostics']['step'], 'choose_tier')
        self.assertEqual(result['diagnostics']['matched_count'], 0)
        self.assertFalse(self.creates)
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
