"""Pro 档位回归：合成凭据、全部请求在本机拦截，绝不连接支付服务。"""
import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import urlsplit

from playwright._impl._errors import TargetClosedError
from playwright.async_api import TimeoutError as PlaywrightTimeoutError, async_playwright

from attempt_ledger import AttemptLedger, existing_checkout
from browser_checkout import NetworkGuard, quote_from_page, quote_from_text, workflow
from checkout_core import ROOT, CHECKOUT_PATH, Stop, parse_browser_credential
from pay import choose_plan, run_payment, verify_identity_again
from payment_state import PaymentLedger, outcome, quote_digest
from payment_recovery import recheck_in_context
from plans import checkout_option_plan, checkout_text_plan, plan_spec, selection_spec
from plan_selection import PRO_HEADING, Selection, select_plan, verify_selected_plan, price_pattern
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
                            ("USD 500.00\nMax usage", "pro-500"),
                            ("MYR 420\n标准", "pro-5x"),
                            ("MYR 999.90\n更多使用额度", "pro-20x"),
                            ("MYR 2,100\n最高使用额度", "pro-500")):
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

    def test_server_500_confirmation_enforces_plan_currency_and_complete_quote_without_cap(self):
        import server
        quote = {**pro_quote(), 'plan': 'pro-500'}
        safety = {'authorizeSinglePayment': True, 'lockedCurrency': 'MYR', 'maxAmountMinor': 1}
        with patch.object(server, 'callback') as callback:
            job = server.Job('synthetic-job', {'action': 'server', 'plan': 'pro-500', 'safety': safety})
            with patch.object(job.confirm_event, 'wait', side_effect=lambda _: job.signal(job.nonce)):
                self.assertTrue(job.confirm(quote, '4242'))
            self.assertEqual(callback.call_args[0][1]['result']['quote']['plan'], 'pro-500')
            for changed_quote, changed_safety in ((pro_quote(20), safety),
                    ({**quote, 'today': {**quote['today'], 'amount_minor': 41999}}, safety),
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
        output = io.StringIO()
        with patch("pay.sys.stdin.isatty", return_value=True), patch("pay.focus_input_terminal"), contextlib.redirect_stdout(output):
            for value, expected in (("1", "go"), ("2", "plus"), ("3", "pro-5x"), ("4", "pro-20x"), ("5", "pro-500")):
                with patch("builtins.input", return_value=value):
                    self.assertEqual(choose_plan(), expected)
            with patch("builtins.input", return_value=""), self.assertRaises(Stop):
                choose_plan()
        for number, label in ((1, "Go"), (2, "Plus"), (3, "Pro（标准）"), (4, "Pro（更多使用额度）"), (5, "Pro（最高使用额度）")):
            self.assertIn(f"{number}. {label}", output.getvalue())
        self.assertNotIn("美元", output.getvalue())


class ProMenuDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.page = MagicMock(name='menu-page')
        self.scope = MagicMock(name='plan-scope')
        self.cue = MagicMock(name='page-cue')
        self.cue.first = self.cue
        self.cue.or_.return_value = self.cue
        self.cue.wait_for = AsyncMock()
        self.cue.count = AsyncMock(return_value=0)
        self.scoped_cue = MagicMock(name='scoped-cue')
        self.scoped_cue.or_.return_value = self.scoped_cue
        self.scoped_cue.count = AsyncMock(return_value=1)
        self.report = MagicMock()
        self.selection = Selection(self.page, self.report)
        self.enterContext(patch.object(self.selection, 'timeout', return_value=1234))
        self.enterContext(patch('plan_selection.personal_control', side_effect=
            lambda scope: self.cue if scope is self.page else self.scoped_cue))
        self.enterContext(patch('plan_selection.buttons', side_effect=
            lambda scope, _name: self.cue if scope is self.page else self.scoped_cue))
        self.plan_scope = self.enterContext(patch('plan_selection.plan_scope',
            new=AsyncMock(return_value=self.scope)))

    async def test_menu_timeout_preserves_error_type_and_observed_zero(self):
        self.cue.wait_for.side_effect = PlaywrightTimeoutError('synthetic menu timeout')
        with self.assertRaises(Stop) as blocked:
            await self.selection.wait_for_plan_scope()
        self.assertEqual(blocked.exception.report['reason'], 'official_plan_menu_timeout')
        self.assertEqual(self.selection.diagnostics, {
            'step': 'open_menu', 'available_plans': [],
            'error_type': 'TimeoutError', 'matched_count': 0,
        })
        self.cue.count.assert_awaited_once_with()
        self.plan_scope.assert_not_awaited()

    async def test_closed_page_preserves_existing_stop_and_error_type(self):
        self.cue.wait_for.side_effect = TargetClosedError()
        with self.assertRaises(Stop) as blocked:
            await self.selection.wait_for_plan_scope()
        self.assertEqual(blocked.exception.report['reason'], 'official_plan_menu_timeout')
        self.assertEqual(self.selection.diagnostics['error_type'], 'TargetClosedError')
        self.cue.count.assert_awaited_once_with()
        self.plan_scope.assert_not_awaited()

    async def test_arbitrary_exception_body_does_not_enter_diagnostics(self):
        private_message = 'synthetic sessionToken=private; card=private; html=<input>'
        self.cue.wait_for.side_effect = RuntimeError(private_message)
        with self.assertRaises(Stop) as blocked:
            await self.selection.wait_for_plan_scope()
        self.assertEqual(blocked.exception.report['reason'], 'official_plan_menu_timeout')
        self.assertEqual(self.selection.diagnostics, {
            'step': 'open_menu', 'available_plans': [],
            'error_type': 'UnexpectedError', 'matched_count': 0,
        })
        public_values = json.dumps({'result': blocked.exception.report,
                                   'diagnostics': self.selection.diagnostics})
        self.assertNotIn(private_message, public_values)
        self.assertNotIn('sessionToken', public_values)
        self.assertNotIn('html', public_values)

    async def test_failed_count_query_keeps_original_error_without_fabricated_zero(self):
        self.cue.wait_for.side_effect = TargetClosedError()
        self.cue.count.side_effect = RuntimeError('synthetic diagnostic query failed')
        with self.assertRaises(Stop) as blocked:
            await self.selection.wait_for_plan_scope()
        self.assertEqual(blocked.exception.report['reason'], 'official_plan_menu_timeout')
        self.assertEqual(self.selection.diagnostics['error_type'], 'TargetClosedError')
        self.assertNotIn('matched_count', self.selection.diagnostics)
        self.cue.count.assert_awaited_once_with()
        self.plan_scope.assert_not_awaited()

    async def test_failed_count_query_drops_a_previous_measurement(self):
        self.selection.diagnostics['matched_count'] = 1
        self.cue.wait_for.side_effect = PlaywrightTimeoutError('synthetic menu timeout')
        self.cue.count.side_effect = TargetClosedError()
        with self.assertRaises(Stop) as blocked:
            await self.selection.wait_for_plan_scope()
        self.assertEqual(blocked.exception.report['reason'], 'official_plan_menu_timeout')
        self.assertEqual(self.selection.diagnostics['error_type'], 'TimeoutError')
        self.assertNotIn('matched_count', self.selection.diagnostics)

    async def test_observed_menu_count_is_bounded(self):
        self.cue.wait_for.side_effect = PlaywrightTimeoutError('synthetic menu timeout')
        self.cue.count.return_value = 125
        with self.assertRaises(Stop):
            await self.selection.wait_for_plan_scope()
        self.assertEqual(self.selection.diagnostics['matched_count'], 100)

    async def test_visible_page_cue_without_scoped_cue_preserves_stop_and_region_count(self):
        self.scoped_cue.count.return_value = 0
        with self.assertRaises(Stop) as blocked:
            await self.selection.wait_for_plan_scope()
        self.assertEqual(blocked.exception.report['reason'], 'official_plan_menu_timeout')
        self.assertEqual(self.selection.diagnostics, {
            'step': 'open_menu', 'available_plans': [], 'role': 'region', 'matched_count': 0,
        })
        self.cue.wait_for.assert_awaited_once_with(state='visible', timeout=1234)
        self.cue.count.assert_not_awaited()
        self.plan_scope.assert_awaited_once_with(self.page)
        self.scoped_cue.count.assert_awaited_once_with()

    async def test_ready_menu_returns_existing_scope_without_extra_diagnostics_or_calls(self):
        original = dict(self.selection.diagnostics)
        self.assertIs(await self.selection.wait_for_plan_scope(), self.scope)
        self.assertEqual(self.selection.diagnostics, original)
        self.cue.wait_for.assert_awaited_once_with(state='visible', timeout=1234)
        self.cue.count.assert_not_awaited()
        self.plan_scope.assert_awaited_once_with(self.page)
        self.scoped_cue.count.assert_awaited_once_with()
        self.report.assert_not_called()


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
        self.current_pro_card = False
        self.usage_controls = False
        self.usage_english = False
        self.subscription_plan = None
        self.trace_ips = ['8.8.8.8']
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
        elif path == '/cdn-cgi/trace':
            ip = self.trace_ips.pop(0) if len(self.trace_ips) > 1 else self.trace_ips[0]
            await route.fulfill(body=f'ip={ip}\nloc=US\n')
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
                <button type="button" data-testid="accounts-profile-button" role="button"
                  aria-haspopup="menu" aria-expanded="false" onclick="const menu=document.querySelector('#account-menu');
                  menu.hidden=!menu.hidden;this.setAttribute('aria-expanded',String(!menu.hidden))">Synthetic account</button>
                <div id="account-menu" role="menu" hidden><button role="menuitem">test@example.invalid</button></div>
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
            if self.usage_controls:
                labels = ('Standard', 'More usage', 'Max usage') if self.usage_english else ('标准', '更多使用额度', '最高使用额度')
                for old, amount, label in zip(('>$100/month</button>', '>Pro 200</button>', '>$500/month</button>'),
                                              ('MYR 420', 'MYR 999.90', 'MYR 2,100'), labels):
                    html = html.replace(old, f'>{amount}<br>{label}</button>')
                html = html.replace('<button id="five"', '<div role="radiogroup" aria-label="Pro 套餐"><button id="five"')
                html = html.replace('<p id="usage">', '</div><button role="radio">MYR 2,100 最高使用额度</button><p id="usage">')
            if self.current_pro_card:
                html = html.replace('<section role="dialog" hidden><button>Get Plus</button>',
                    '''<section role="dialog" hidden><button role="radio" aria-checked="true">个人</button>
                    <div id="pro-card" data-testid="pro-pricing-modal-column-top-half" hidden><h3>Pro</h3><button onclick="document.querySelector('#pro-card').hidden=true;
                      document.querySelector('#pro-details').hidden=false">升级订阅，获取更高使用额度</button></div>''')
                html = html.replace('<div role="radiogroup" aria-label="选择 Pro 套餐档位">',
                    '<div id="pro-details" data-testid="pro-pricing-modal-column-top-half"><h3>Pro</h3><div role="radiogroup" aria-label="Pro 用量">')
                html = html.replace('<button onclick="create()">升级至 Pro</button></section>',
                    '<button onclick="create()">升级订阅</button></div></section>')
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

    async def test_current_named_usage_tiers_select_by_name_not_local_currency(self):
        self.price_controls, self.usage_controls = True, True
        for english in (False, True):
            self.usage_english = english
            for plan in ('pro-5x', 'pro-20x', 'pro-500'):
                with self.subTest(plan=plan, english=english):
                    self.plan = plan
                    self.root = Path(self.temp.name) / f'{english}-{plan}'
                    result = await self.create()
                    self.assertEqual(result['status'], 'checkout_quote_verified', result)
                    self.assertEqual(result['quote']['plan'], plan)
                    self.assertEqual(self.creates[-1]['plan_name'], plan_spec(plan)['official_name'])
                    self.assertEqual(self.payments, 0)

    async def test_missing_named_max_usage_does_not_fall_back_to_price_or_other_plan(self):
        self.price_controls, self.usage_controls, self.missing_500 = True, True, True
        page = await self.context.new_page()
        await page.goto('https://chatgpt.com/')
        with patch('plan_selection.STEP_SECONDS', .2), patch('plan_selection.SELECTION_SECONDS', 1):
            with self.assertRaises(Stop) as blocked:
                await select_plan(page, 'pro-500', lambda *_args, **_kwargs: None)
        self.assertEqual(blocked.exception.report['reason'], 'official_plan_tier_not_found')
        self.assertFalse(self.creates)
        self.assertEqual(self.payments, 0)

    async def test_identity_can_be_verified_while_a_nonessential_script_is_still_loading(self):
        from browser_session import SessionBudget, load_session_page
        from browser_password_login import official_identity
        page = await self.context.new_page()
        release = asyncio.Event()
        async def delayed_script(route):
            await release.wait()
            await route.fulfill(content_type='application/javascript', body='')
        await page.route('**/late.js', delayed_script)
        await page.route('**/slow-session', lambda route: route.fulfill(
            content_type='text/html', body='<title>ChatGPT</title><script src="/late.js"></script>'))
        try:
            budget = SessionBudget(60)
            await load_session_page(page, 'https://chatgpt.com/slow-session', budget)
            verified = await official_identity(page, 'test@example.invalid', budget=budget, strict=True)
            self.assertEqual(verified[0].account_id, self.target.account_id)
            self.assertNotEqual(await page.evaluate('document.readyState'), 'complete')
            self.assertFalse(self.creates)
            self.assertEqual(self.payments, 0)
        finally:
            release.set()
            await page.close()

    async def test_server_max_usage_executes_with_durable_callback_before_each_write(self):
        import dataclasses
        import server
        import attempt_ledger
        import payment_state
        self.plan, self.price_controls, self.usage_controls = 'pro-500', True, True
        page = await self.context.new_page()
        await page.goto('https://chatgpt.com/')
        profile = page.get_by_test_id('accounts-profile-button')
        self.assertTrue(await profile.is_visible())
        self.assertTrue(await profile.is_enabled())
        await profile.click()
        self.assertTrue(await page.get_by_role('menuitem', name='test@example.invalid').is_visible())
        await profile.click()
        self.assertEqual(await profile.get_attribute('aria-expanded'), 'false')
        job = server.Job('11111111-1111-4111-8111-111111111111', {
            'action': 'server', 'plan': self.plan, 'sessionJson': fixture().decode(),
            'expectedEmail': 'test@example.invalid', 'expectedCountry': 'US',
            'proxy': {'mode': 'static'}, 'details': dataclasses.asdict(details()),
            'safety': {'authorizeSinglePayment': True, 'lockedCurrency': 'MYR', 'maxAmountMinor': 42000}
        })
        job.root = self.root
        records, events = {}, []
        def callback(_id, body):
            events.append(body)
            if body['type'] == 'restore':
                return {'records': []}
            if body['type'] == 'ledger':
                key = body['fileKey']
                if not key.startswith('payments/'):
                    self.assertIn('-pro-500.json', key)
                self.assertIsNotNone(server.RECORD_PATH.fullmatch(key))
                self.assertEqual(body['revision'], records.get(key, {}).get('revision', 0))
                records[key] = {'revision': body['revision'] + 1, 'document': body['document']}
                return {'revision': records[key]['revision']}
            if body['type'] == 'confirmation':
                job.signal(body['result']['nonce'])
            return {'ok': True}
        original = attempt_ledger.atomic_json
        def durable(path, document):
            job.persist(path, document)
            original(path, document)
        browser = MagicMock(new_context=AsyncMock(return_value=self.context))
        with (patch.object(server, 'callback', side_effect=callback),
              patch.object(server.server_proxy, 'resolve_proxy', return_value={'server': 'http://synthetic.invalid'}),
              patch.object(server.server_proxy, 'observe_exit', new=AsyncMock(return_value={'ip': '8.8.8.8', 'country': 'US'})),
              patch.object(attempt_ledger, 'atomic_json', side_effect=durable),
              patch.object(payment_state, 'atomic_json', side_effect=durable),
              patch.object(server.browser_checkout, 'progress', job.progress),
              patch.object(server.pay, 'progress', job.progress),
              patch.object(server.payment_network, 'progress', job.progress),
              patch.dict(os.environ, {'AUTO_RECHARGE_CALLBACK_URL': 'http://synthetic.invalid'})):
            result = await job.execute(browser=browser)
        self.assertEqual(result['status'], 'subscription_activated', result)
        self.assertEqual(result['subscription_status'], 'pro-500')
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(self.payments, 1)  # 仅拦截夹具计数，真实付款为 0。
        self.assertEqual(len(records), 2)
        self.assertTrue(any(e.get('result', {}).get('stage') == 'login_verified' for e in events))
        self.assertTrue(any(key.startswith('payments/') for key in records))
        self.assertNotIn('details', job.payload)

    async def test_exit_change_during_plan_selection_stops_before_checkout_and_payment(self):
        self.trace_ips = ['8.8.8.8', '1.1.1.1']
        with patch.dict(os.environ, {'AUTO_RECHARGE_CALLBACK_URL': 'http://synthetic.invalid'}):
            result = await self.create()
        self.assertEqual(result['reason'], 'proxy_ip_changed_during_login')
        self.assertFalse(self.creates)
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

    async def test_current_pro_card_500_preserves_official_request_and_quote_binding(self):
        self.plan = 'pro-500'
        self.price_controls = self.numeric_controls = self.current_pro_card = True
        result = await self.create()
        self.assertEqual(result['status'], 'checkout_quote_verified', result)
        self.assertEqual(result['quote']['plan'], 'pro-500')
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(self.creates[0]['plan_name'], 'chatgptpromax')
        self.assertEqual(self.payments, 0)

    async def test_current_pro_card_wrong_request_is_blocked_before_sending(self):
        self.plan = 'pro-500'
        self.price_controls = self.numeric_controls = self.current_pro_card = self.wrong_request = True
        result = await self.create()
        self.assertEqual(result['reason'], 'checkout_plan_mismatch', result)
        self.assertEqual(self.creates, [])
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

        # 同一币种下按选中的额度档位识别，不将当地价格当成美元档位。
        tiers = (("MYR 420", "标准", "pro-5x"),
                 ("MYR 999.90", "更多使用额度", "pro-20x"),
                 ("MYR 2,100", "最高使用额度", "pro-500"))
        for amount, _label, plan in tiers:
            options = ''.join(
                f'<button role="radio" aria-checked="{str(key == plan).lower()}">{price}<br>{label}</button>'
                for price, label, key in tiers)
            await page.set_content(f'<h1>Pro 套餐</h1><p>Total due today</p><p>{amount}</p>'
                                   f'<div role="radiogroup" aria-label="Pro 套餐">{options}</div>')
            quote = await quote_from_page(page)
            self.assertEqual(quote["plan"], plan)
            self.assertEqual(quote["today"]["currency"], "MYR")

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

    async def test_pro5_payment_is_once_and_official_pro20_does_not_mark_target_activation(self):
        result = await self.pay_original()
        self.assertEqual(result["status"], "paid_pending_activation", result)
        self.assertEqual(result["current_tier"], 20)
        self.assertEqual(result["target_plan"], "pro-5x")
        self.assertEqual(self.payments, 1)
        self.assertEqual(len(self.creates), 1)

    async def test_pro20_payment_uses_its_own_order(self):
        self.plan = "pro-20x"
        result = await self.pay_original()
        self.assertEqual(result["status"], "subscription_activated", result)
        self.assertEqual(result["current_tier"], 20)
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


class ProRegionDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    async def test_unavailable_region_count_preserves_stop_without_old_button_state(self):
        from plan_selection import plan_scope
        page = MagicMock()
        page.title = AsyncMock(return_value='ChatGPT')
        dialogs = page.get_by_role.return_value.filter.return_value
        dialogs.count = AsyncMock(side_effect=[2, RuntimeError('PRIVATE_COUNT_BODY')])
        assertion = MagicMock()
        assertion.to_have_count = AsyncMock(side_effect=PlaywrightTimeoutError('PRIVATE_TIMEOUT_BODY'))
        with patch('plan_selection.expect', return_value=assertion), self.assertRaises(Stop) as stopped:
            await plan_scope(page)
        selection = MagicMock()
        selection.run = AsyncMock(side_effect=stopped.exception)
        selection.diagnostics = {'step': 'choose_tier', 'role': 'button', 'matched_count': 1,
                                 'enabled': True, 'selected': True, 'error_type': 'Error',
                                 'available_plans': []}
        with patch('plan_selection.Selection', return_value=selection), self.assertRaises(Stop) as blocked:
            await select_plan(page, 'pro-500', lambda *_args, **_kwargs: None)
        self.assertEqual(blocked.exception.report['reason'], 'official_plan_region_ambiguous')
        self.assertEqual(blocked.exception.report['diagnostics'], {
            'step': 'choose_tier', 'role': 'region', 'available_plans': [], 'error_type': 'TimeoutError',
        })
        self.assertNotIn('PRIVATE', json.dumps(blocked.exception.report))

    async def test_closed_page_region_wait_keeps_original_error_without_fabricated_count(self):
        from plan_selection import plan_scope
        page = MagicMock()
        page.title = AsyncMock(side_effect=TargetClosedError())
        dialogs = page.get_by_role.return_value.filter.return_value
        dialogs.count = AsyncMock(side_effect=[2, TargetClosedError()])
        assertion = MagicMock()
        assertion.to_have_count = AsyncMock(side_effect=TargetClosedError())
        with patch('plan_selection.expect', return_value=assertion), self.assertRaises(Stop) as stopped:
            await plan_scope(page)
        selection = MagicMock()
        selection.run = AsyncMock(side_effect=stopped.exception)
        selection.diagnostics = {'step': 'choose_tier', 'role': 'button',
                                 'matched_count': 1, 'enabled': True}
        with patch('plan_selection.Selection', return_value=selection), self.assertRaises(Stop) as blocked:
            await select_plan(page, 'pro-500', lambda *_args, **_kwargs: None)
        self.assertEqual(blocked.exception.report['reason'], 'official_plan_region_ambiguous')
        self.assertEqual(blocked.exception.report['diagnostics'], {
            'step': 'choose_tier', 'role': 'region', 'error_type': 'TargetClosedError',
        })

    async def test_region_stop_accepts_only_measured_count_and_controlled_fields(self):
        page = MagicMock()
        page.title = AsyncMock(return_value='ChatGPT')
        for count, expected in ((2, 2), (0, 0), (True, None)):
            with self.subTest(count=count):
                selection = MagicMock()
                selection.diagnostics = {'step': 'choose_tier', 'role': 'button',
                                         'matched_count': 1, 'enabled': True, 'selected': True}
                selection.run = AsyncMock(side_effect=Stop('official_plan_region_ambiguous', diagnostics={
                    'role': 'region', 'matched_count': count, 'enabled': True,
                    'selected': True, 'html': 'PRIVATE_REGION_BODY', 'error_type': 'PRIVATE_ERROR',
                }))
                with patch('plan_selection.Selection', return_value=selection), self.assertRaises(Stop) as stopped:
                    await select_plan(page, 'pro-500', lambda *_args, **_kwargs: None)
                diagnostics = {'step': 'choose_tier', 'role': 'region'}
                if expected is not None:
                    diagnostics['matched_count'] = expected
                self.assertEqual(stopped.exception.report['diagnostics'], diagnostics)
                self.assertNotIn('PRIVATE', json.dumps(stopped.exception.report))


class ProSemanticParentMockTests(unittest.IsolatedAsyncioTestCase):
    """语义标题和直属父区域的选择边界；不启动浏览器或连接网络。"""
    def setUp(self):
        self.page = MagicMock(name='synthetic-page')
        self.selection = Selection(self.page, MagicMock())
        self.enterContext(patch('plan_selection.expect', side_effect=self.expect))

    @staticmethod
    def collection(count, *, enabled=True, attributes=None, owned=True):
        locator = MagicMock(name='synthetic-locator')
        locator.filter.return_value = locator
        locator.first = locator
        locator.count = AsyncMock(return_value=count)
        locator.is_visible = AsyncMock(return_value=count == 1)
        locator.is_enabled = AsyncMock(return_value=enabled)
        locator.get_attribute = AsyncMock(side_effect=lambda key: (attributes or {}).get(key))
        locator.evaluate = AsyncMock(return_value=owned)
        locator.click = AsyncMock()
        async def wait_for(**_kwargs):
            if count == 0:
                raise PlaywrightTimeoutError('synthetic control missing')
        locator.wait_for = AsyncMock(side_effect=wait_for)
        return locator

    @classmethod
    def region(cls, *, headings=(), button_names=(), enabled=True, group_label=None):
        """根据独立夹具的可访问名称回答查询，不预先指定选择结果。"""
        region = cls.collection(1)
        roles = {'heading': headings, 'button': button_names,
                 'radiogroup': () if group_label is None else (group_label,)}
        queries = {}
        def query(role, *, name=None):
            key = role, str(name)
            if key not in queries:
                labels = roles.get(role, ())
                matches = labels if name is None else [label for label in labels if
                    (name.search(label) if hasattr(name, 'search') else label == name)]
                queries[key] = cls.collection(len(matches), enabled=enabled,
                    attributes={'aria-label': group_label} if role == 'radiogroup' else None)
            return queries[key]
        region.get_by_role.side_effect = query
        return region

    def scene(self, *, headings=('ChatGPT Pro',), exact_pro_count=0, owned=True,
              inside_buttons=(), parent_buttons=(), parent_headings=None,
              parent_markers=1, enabled=True):
        card = self.region(headings=headings, button_names=inside_buttons)
        product = self.collection(exact_pro_count, owned=owned)
        card.get_by_text.return_value = product
        # Exact text and accessible heading queries exercise distinct paths.
        semantic = card.get_by_role('heading', name=PRO_HEADING)
        semantic.evaluate.return_value = owned
        parent = self.region(headings=headings if parent_headings is None else parent_headings,
                             button_names=parent_buttons, enabled=enabled)
        markers = self.collection(parent_markers)
        def parent_locator(selector):
            self.assertEqual(selector, '[data-testid="pro-pricing-modal-column-top-half"]')
            return markers
        parent.locator.side_effect = parent_locator
        def card_locator(selector):
            self.assertEqual(selector, '..')
            return parent
        card.locator.side_effect = card_locator
        scope = self.collection(1)
        scope.locator.return_value = card
        return scope, card, parent

    @staticmethod
    def expect(locator):
        assertion = MagicMock()
        async def count(expected, **_kwargs):
            if await locator.count() != expected:
                raise AssertionError('synthetic count mismatch')
        async def visible(**_kwargs):
            if not await locator.is_visible():
                raise AssertionError('synthetic control hidden')
        async def enabled(**_kwargs):
            if not await locator.is_enabled():
                raise AssertionError('synthetic control disabled')
        assertion.to_have_count = count
        assertion.to_be_visible = visible
        assertion.to_be_enabled = enabled
        return assertion

    async def ready_details(self, scene):
        scope, card, parent = scene
        group = self.collection(1, attributes={'aria-label': 'Pro 用量'})
        with patch('plan_selection.pro_detail_groups', return_value=group):
            result = await self.selection.open_pro_details(scope)
        self.assertIs(result, card)
        card.get_by_role('button').click.assert_not_awaited()
        parent.get_by_role.assert_not_called()
        self.page.goto.assert_not_called()
        return card, parent


    async def assert_entry_blocked(self, scene, reason):
        scope, card, parent = scene
        with patch('plan_selection.STEP_SECONDS', .05), \
                patch('plan_selection.plan_scope', new=AsyncMock(return_value=scope)), \
                self.assertRaises(Stop) as stopped:
            await self.selection.open_pro_details(scope)
        self.assertEqual(stopped.exception.report['reason'], reason)
        card.get_by_role('button').click.assert_not_awaited()
        parent.get_by_role('button').click.assert_not_awaited()
        self.page.goto.assert_not_called()
        return stopped.exception.report

    async def test_unique_accessible_pro_heading_keeps_existing_ready_details(self):
        for heading in ('ChatGPT Pro', 'Pro', '  ChatGPT Pro  '):
            with self.subTest(heading=heading):
                await self.ready_details(self.scene(headings=(heading,),
                    inside_buttons=('Synthetic final action',)))


    async def test_wrong_product_or_unowned_text_cannot_replace_pro_heading(self):
        for heading, count, owned in (('Plus', 0, True), ('ChatGPT Plus', 0, True),
                                     ('ChatGPT Pro Max', 0, True), ('Plus', 1, False)):
            with self.subTest(heading=heading, count=count):
                await self.assert_entry_blocked(self.scene(headings=(heading,),
                    exact_pro_count=count, owned=owned, parent_buttons=('Get Pro',)),
                    'official_plan_region_ambiguous')

    async def test_semantic_heading_does_not_rescue_existing_exact_text_ambiguity(self):
        for count, owned in ((1, False), (2, True)):
            with self.subTest(count=count):
                await self.assert_entry_blocked(self.scene(exact_pro_count=count, owned=owned,
                    parent_buttons=('Get Pro',)), 'official_plan_region_ambiguous')

    async def test_duplicate_or_missing_marker_headings_stop_before_parent_entry(self):
        for headings in ((), ('ChatGPT Pro', 'Pro'), ('ChatGPT Pro', 'Plus')):
            with self.subTest(headings=headings):
                report = await self.assert_entry_blocked(self.scene(headings=headings,
                    parent_buttons=('Get Pro',)), 'official_plan_region_ambiguous')
                self.assertEqual(report['diagnostics']['matched_count'], len(headings))

    async def test_direct_parent_pro_cta_does_not_prove_details_expansion(self):
        for label in ('Get Pro', 'Upgrade to Pro'):
            with self.subTest(label=label):
                await self.assert_entry_blocked(self.scene(headings=('Pro',), exact_pro_count=1,
                    parent_buttons=(label,)), 'official_plan_tier_not_found')


    async def test_inside_named_pro_cta_without_tiers_never_expands(self):
        for label in ('Get Pro', 'Upgrade to Pro'):
            with self.subTest(label=label):
                await self.assert_entry_blocked(self.scene(inside_buttons=(label,)),
                                                'official_plan_tier_not_found')

    async def test_extra_parent_buttons_headings_or_markers_are_not_owned(self):
        cases = (
            {'parent_buttons': ('Get Pro', 'Get Pro')},
            {'parent_buttons': ('Get Pro', 'Synthetic other action')},
            {'parent_buttons': ('Get Pro',), 'parent_headings': ('ChatGPT Pro', 'Plus')},
            {'parent_buttons': ('Get Pro',), 'parent_markers': 2},
        )
        for changed in cases:
            with self.subTest(changed=changed):
                await self.assert_entry_blocked(self.scene(headings=('Pro',), exact_pro_count=1,
                                                           **changed),
                                                'official_plan_tier_not_found')


    async def test_generic_wrong_product_or_grandparent_cta_is_not_a_pro_entry(self):
        for names in (('Synthetic details action',), ('Get Plus',), ()):
            with self.subTest(names=names):
                scene = self.scene(headings=('Pro',), exact_pro_count=1, parent_buttons=names)
                await self.assert_entry_blocked(scene, 'official_plan_tier_not_found')
                self.page.get_by_role.assert_not_called()


    async def test_disabled_parent_pro_cta_is_not_a_details_entry(self):
        await self.assert_entry_blocked(self.scene(headings=('Pro',), exact_pro_count=1,
                                                   parent_buttons=('Get Pro',), enabled=False),
                                        'official_plan_tier_not_found')
        self.assertNotIn('enabled', self.selection.diagnostics)



class ProCurrentMenuTests(unittest.IsolatedAsyncioTestCase):
    """当前卡片/用量控件夹具；全部网络请求终止于本机。"""
    async def asyncSetUp(self):
        os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / ".browsers"))
        self.p = await async_playwright().start()
        self.browser = await self.p.chromium.launch(headless=True)
        self.context = await self.browser.new_context(service_workers="block")
        self.requests = []
        async def block(route):
            self.requests.append(route.request.method)
            await route.abort()
        await self.context.route("**/*", block)
        self.page = await self.context.new_page()
        await self.page.set_content('''<html><body><section role="dialog" aria-label="升级套餐">
            <button role="radio" aria-checked="true">个人</button>
            <div id="cards" hidden>
              <article><h3>Go</h3><button>Get Go</button></article>
              <article><h3>Plus</h3><button>Get Plus</button></article>
              <article id="pro-card" data-testid="pro-pricing-modal-column-top-half"><div><h3>Pro</h3></div>
                <button id="entry" onclick="openPro()">升级订阅，获取更高使用额度</button></article>
            </div>
            <div id="pro-details" data-testid="pro-pricing-modal-column-top-half">
              <div><h3>Pro</h3></div>
              <div role="radiogroup" aria-label="Pro 用量" id="usage-group">
                <button role="radio" id="tier100" aria-checked="false" onclick="choose(100)">100</button>
                <button role="radio" id="tier200" aria-checked="true" onclick="choose(200)">200</button>
                <button role="radio" id="tier500" aria-checked="false" onclick="choose(500)">500</button>
              </div>
              <div><div><button id="final" onclick="finalClick()">升级订阅</button></div></div>
            </div>
            <aside><button role="radio" id="unrelated500" aria-checked="false"
                onclick="this.setAttribute('aria-checked','true')">500</button>
              <button id="unrelated-final" onclick="finalClick()">升级订阅</button></aside>
            </section><script>
              window.entryClicks=0;window.finalClicks=0;
              function openPro(){window.entryClicks++;document.querySelector('#cards').hidden=true;
                document.querySelector('#pro-details').hidden=false;}
              function choose(n){document.querySelectorAll('#usage-group [role=radio]').forEach(
                node=>node.setAttribute('aria-checked',node.textContent.trim()===String(n)));}
              function finalClick(){window.finalClicks++;fetch('https://chatgpt.com/backend-api/payments/checkout',
                {method:'POST',body:'synthetic'});}
            </script></body></html>''')

    async def asyncTearDown(self):
        await self.context.close()
        await self.browser.close()
        await self.p.stop()

    async def select(self, *, require_upgrade=False):
        with patch('plan_selection.STEP_SECONDS', .3), patch('plan_selection.SELECTION_SECONDS', 3):
            return await select_plan(self.page, 'pro-500', lambda *_args, **_kwargs: None,
                                     require_upgrade=require_upgrade)

    async def assert_unsubmitted(self):
        self.assertEqual(await self.page.evaluate('window.finalClicks'), 0)
        self.assertEqual(self.requests, [])
        self.assertEqual(await self.page.locator('#unrelated500').get_attribute('aria-checked'), 'false')

    async def assert_blocked(self, reason):
        with self.assertRaises(Stop) as stopped:
            await self.select()
        self.assertEqual(stopped.exception.report['reason'], reason)
        await self.assert_unsubmitted()
        return stopped.exception.report

    async def test_ready_details_select_maximum_and_return_only_scoped_cta(self):
        button = await self.select()
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)
        self.assertEqual(await button.get_attribute('id'), 'final')
        self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'), 'true')
        self.assertEqual(await self.page.locator('#tier200').get_attribute('aria-checked'), 'false')
        await verify_selected_plan(self.page, 'pro-500')
        await self.assert_unsubmitted()


    async def test_ready_details_wait_for_transient_dialog_overlap_to_become_unique(self):
        await self.page.evaluate("""() => {
            const overlay=document.createElement('section');overlay.setAttribute('role','dialog');
            overlay.textContent='Synthetic transition';document.body.append(overlay);
            setTimeout(()=>overlay.remove(),120);
        }""")
        button = await self.select()
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)
        self.assertEqual(await button.get_attribute('id'), 'final')
        self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'), 'true')
        await verify_selected_plan(self.page, 'pro-500')
        await self.assert_unsubmitted()


    async def test_view_all_waits_for_transient_dialog_overlap_before_ready_details(self):
        await self.page.evaluate("""() => {
            document.querySelector('#pro-details').hidden=true;
            const navigation=document.createElement('button');navigation.textContent='查看所有套餐';
            navigation.onclick=()=>{window.navigationClicks=(window.navigationClicks||0)+1;
              document.querySelector('#pro-details').hidden=false;navigation.remove();
              const overlay=document.createElement('section');overlay.setAttribute('role','dialog');
              overlay.textContent='Synthetic transition';document.body.append(overlay);
              setTimeout(()=>overlay.remove(),120);};
            document.querySelector('section').append(navigation);
        }""")
        button = await self.select()
        self.assertEqual(await self.page.evaluate('window.navigationClicks'), 1)
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)
        self.assertEqual(await button.get_attribute('id'), 'final')
        await verify_selected_plan(self.page, 'pro-500')
        await self.assert_unsubmitted()


    async def test_persistent_dialog_overlap_reports_region_count_without_button_state(self):
        await self.page.evaluate("""() => {
            const overlay=document.createElement('section');overlay.setAttribute('role','dialog');
            overlay.textContent='Synthetic persistent overlap';document.body.append(overlay);
        }""")
        report = await self.assert_blocked('official_plan_region_ambiguous')
        self.assertEqual(report['diagnostics'], {
            'step': 'open_menu', 'role': 'region', 'matched_count': 2, 'available_plans': [],
            'error_type': 'AssertionError',
        })
        self.assertEqual(await self.page.locator('#tier200').get_attribute('aria-checked'), 'true')


    async def test_dialog_transition_to_zero_never_falls_back_to_body(self):
        await self.page.evaluate("""() => {
            const overlay=document.createElement('section');overlay.setAttribute('role','dialog');
            overlay.textContent='Synthetic transition';document.body.append(overlay);
            setTimeout(()=>{document.querySelector('section').hidden=true;overlay.remove();},120);
        }""")
        report = await self.assert_blocked('official_plan_region_ambiguous')
        self.assertEqual(report['diagnostics'], {
            'step': 'open_menu', 'role': 'region', 'matched_count': 0, 'available_plans': [],
            'error_type': 'AssertionError',
        })


    async def test_transient_dialog_overlap_does_not_allow_duplicate_pro_markers(self):
        await self.page.evaluate("""() => {
            const details=document.querySelector('#pro-details');const copy=details.cloneNode(true);
            copy.querySelector('#usage-group').remove();details.after(copy);
            const overlay=document.createElement('section');overlay.setAttribute('role','dialog');
            overlay.textContent='Synthetic transition';document.body.append(overlay);
            setTimeout(()=>overlay.remove(),120);
        }""")
        report = await self.assert_blocked('official_plan_region_ambiguous')
        self.assertEqual(report['diagnostics']['role'], 'region')
        self.assertEqual(report['diagnostics']['matched_count'], 2)
        self.assertNotIn('enabled', report['diagnostics'])
        self.assertNotIn('selected', report['diagnostics'])


    async def test_duplicate_heading_reports_its_actual_count_before_tier_selection(self):
        await self.page.locator('#pro-details').evaluate('''node => {
            const heading=document.createElement('h3');heading.textContent='Plus';node.append(heading);
        }''')
        report = await self.assert_blocked('official_plan_region_ambiguous')
        self.assertEqual(report['diagnostics']['role'], 'region')
        self.assertEqual(report['diagnostics']['matched_count'], 2)
        self.assertNotIn('enabled', report['diagnostics'])
        self.assertEqual(await self.page.locator('#tier200').get_attribute('aria-checked'), 'true')

    async def test_pro_text_outside_heading_is_rejected_with_measured_count(self):
        await self.page.locator('#pro-details').evaluate('''node => {
            node.querySelector('h3').textContent='Plus';
            const product=document.createElement('span');product.textContent='Pro';node.append(product);
        }''')
        report = await self.assert_blocked('official_plan_region_ambiguous')
        self.assertEqual(report['diagnostics']['role'], 'region')
        self.assertEqual(report['diagnostics']['matched_count'], 1)
        self.assertNotIn('enabled', report['diagnostics'])
        self.assertEqual(await self.page.locator('#tier200').get_attribute('aria-checked'), 'true')

    async def test_existing_pro_details_and_plus_upgrade_reuse_only_verified_pro_scope(self):
        button = await self.select(require_upgrade=True)
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)
        self.assertEqual(await button.get_attribute('id'), 'final')
        await verify_selected_plan(self.page, 'pro-500', require_upgrade=True)
        await self.assert_unsubmitted()


    async def test_recommended_pro_heading_is_accepted_only_within_pro_marker(self):
        await self.page.locator('#pro-details h3').evaluate("""node => {
            node.innerHTML='<span>Pro</span><span>推荐</span>';
        }""")
        button = await self.select()
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)
        self.assertEqual(await button.get_attribute('id'), 'final')
        await verify_selected_plan(self.page, 'pro-500')
        await self.assert_unsubmitted()


    async def test_synthetic_locale_labels_use_only_observed_marker_structure(self):
        await self.page.locator('#entry').evaluate('node=>node.textContent="Synthetic details action"')
        await self.page.locator('#final').evaluate('node=>node.textContent="Synthetic final action"')
        await self.page.locator('#usage-group').evaluate('node=>node.setAttribute("aria-label","Synthetic usage group")')
        await self.page.locator('#pro-details h3').evaluate('node=>node.innerHTML="<span>Pro</span><span>Synthetic badge</span>"')
        button = await self.select()
        self.assertEqual(await button.get_attribute('id'), 'final')
        await verify_selected_plan(self.page, 'pro-500')
        await self.assert_unsubmitted()

    async def test_view_all_plans_reveals_ready_details_without_pro_cta_click(self):
        await self.page.evaluate("""() => {
            document.querySelector('#pro-details').hidden=true;
            const navigation=document.createElement('button');navigation.textContent='查看所有套餐';
            navigation.onclick=()=>{window.navigationClicks=(window.navigationClicks||0)+1;
              document.querySelector('#pro-details').hidden=false;navigation.remove();};
            document.querySelector('section').append(navigation);
        }""")
        button = await self.select()
        self.assertEqual(await self.page.evaluate('window.navigationClicks'), 1)
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)
        self.assertEqual(await button.get_attribute('id'), 'final')
        await verify_selected_plan(self.page, 'pro-500')
        await self.assert_unsubmitted()


    async def delayed_view_all_group(self, *, reveal_group=True, second_dialog=False):
        """合成本地挂载顺序；不是官网现场 DOM 证据。"""
        await self.page.evaluate('''options => {
            document.querySelector('#pro-details').hidden=true;
            document.querySelector('#usage-group').hidden=true;
            const navigation=document.createElement('button');navigation.textContent='查看所有套餐';
            navigation.onclick=()=>{window.navigationClicks=(window.navigationClicks||0)+1;
              document.querySelector('#pro-details').hidden=false;navigation.remove();
              if(options.revealGroup){setTimeout(()=>document.querySelector('#usage-group').hidden=false,120);}
              if(options.secondDialog){setTimeout(()=>{
                const other=document.createElement('section');other.setAttribute('role','dialog');
                other.setAttribute('aria-label','Synthetic other task');
                const action=document.createElement('button');action.textContent='Synthetic action';
                other.append(action);document.body.append(other);},40);}
            };
            document.querySelector('section').append(navigation);
        }''', {'revealGroup': reveal_group, 'secondDialog': second_dialog})

    async def test_view_all_marker_before_group_waits_without_checkout(self):
        await self.delayed_view_all_group()
        try:
            button=await self.select()
            self.assertEqual(await button.get_attribute('id'),'final')
            self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'true')
            await verify_selected_plan(self.page,'pro-500')
        finally:
            self.assertEqual(await self.page.evaluate('window.navigationClicks'),1)
            self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
            await self.assert_unsubmitted()

    async def test_personal_switch_marker_after_menu_waits_for_group_without_checkout(self):
        # 控制真实本地 DOM 在 open_menu 返回边界挂载，确定性模拟个人切换后的 race。
        await self.page.evaluate('''() => {
            document.querySelector('#pro-details').hidden=true;
            const personal=document.querySelector('section > [role=radio]');
            personal.setAttribute('aria-checked','false');
            personal.onclick=()=>{window.personalClicks=(window.personalClicks||0)+1;
              personal.setAttribute('aria-checked','true');};
        }''')
        original_open_menu=Selection.open_menu
        async def mount_after_menu(selection,target_plan):
            scope=await original_open_menu(selection,target_plan)
            await self.page.evaluate('''() => {
                document.querySelector('#usage-group').hidden=true;
                document.querySelector('#pro-details').hidden=false;
                setTimeout(()=>document.querySelector('#usage-group').hidden=false,120);
            }''')
            return scope
        try:
            with patch.object(Selection,'open_menu',new=mount_after_menu):
                button=await self.select()
            self.assertEqual(await button.get_attribute('id'),'final')
            self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'true')
            await verify_selected_plan(self.page,'pro-500')
        finally:
            self.assertEqual(await self.page.evaluate('window.personalClicks'),1)
            self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
            await self.assert_unsubmitted()

    async def test_missing_delayed_group_reports_zero_without_checkout(self):
        await self.delayed_view_all_group(reveal_group=False)
        try:
            report=await self.assert_blocked('official_plan_tier_not_found')
            self.assertEqual(report['diagnostics']['step'],'choose_tier')
            self.assertEqual(report['diagnostics']['role'],'region')
            self.assertEqual(report['diagnostics']['matched_count'],0)
            self.assertNotIn('enabled',report['diagnostics'])
            self.assertNotIn('selected',report['diagnostics'])
            self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'false')
        finally:
            self.assertEqual(await self.page.evaluate('window.navigationClicks'),1)
            self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
            await self.assert_unsubmitted()

    async def test_post_menu_unnamed_group_reports_one_without_checkout(self):
        await self.page.locator('#pro-details').evaluate('node=>node.hidden=true')
        original_open_menu=Selection.open_menu
        async def mount_unnamed_after_menu(selection,target_plan):
            scope=await original_open_menu(selection,target_plan)
            await self.page.evaluate('''() => {
                document.querySelector('#usage-group').removeAttribute('aria-label');
                document.querySelector('#pro-details').hidden=false;
            }''')
            return scope
        try:
            with patch.object(Selection,'open_menu',new=mount_unnamed_after_menu):
                report=await self.assert_blocked('official_plan_tier_not_found')
            self.assertEqual(report['diagnostics']['step'],'choose_tier')
            self.assertEqual(report['diagnostics']['role'],'region')
            self.assertEqual(report['diagnostics']['matched_count'],1)
            self.assertNotIn('enabled',report['diagnostics'])
            self.assertNotIn('selected',report['diagnostics'])
            self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'false')
        finally:
            self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
            await self.assert_unsubmitted()

    async def test_delayed_group_with_second_dialog_blocks_before_selection(self):
        await self.delayed_view_all_group(second_dialog=True)
        try:
            report=await self.assert_blocked('official_plan_region_ambiguous')
            self.assertEqual(report['diagnostics']['role'],'region')
            self.assertEqual(report['diagnostics']['matched_count'],2)
            self.assertNotIn('enabled',report['diagnostics'])
            self.assertNotIn('selected',report['diagnostics'])
            self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'false')
        finally:
            self.assertEqual(await self.page.evaluate('window.navigationClicks'),1)
            self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
            await self.assert_unsubmitted()


    async def test_view_all_named_pro_cta_cannot_supply_missing_tiers(self):
        async def navigation(entry_name, duplicate=False):
            await self.page.evaluate('''options => {
                document.querySelector('#cards').hidden=true;
                document.querySelector('#pro-details').hidden=true;
                document.querySelector('#entry').textContent=options.entryName;
                choose(200);window.entryClicks=0;window.navigationClicks=0;
                const button=document.createElement('button');button.textContent='查看所有套餐';
                button.onclick=()=>{window.navigationClicks++;
                  document.querySelector('#cards').hidden=false;
                  if(options.duplicate){const copy=document.querySelector('#pro-card').cloneNode(true);
                    copy.id='duplicate-pro-card';document.querySelector('#cards').append(copy);}
                  button.remove();};
                document.querySelector('section').append(button);
            }''', {'entryName': entry_name, 'duplicate': duplicate})

        for entry_name in ('Get Pro', 'Upgrade to Pro'):
            with self.subTest(entry_name=entry_name):
                await navigation(entry_name)
                await self.assert_blocked('official_plan_tier_not_found')
                self.assertEqual(await self.page.evaluate('window.navigationClicks'), 1)
                self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)

        await navigation('Get Pro', duplicate=True)
        await self.assert_blocked('official_plan_region_ambiguous')
        self.assertEqual(await self.page.evaluate('window.navigationClicks'), 1)
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)

    async def test_pro_cta_or_generic_without_tiers_has_zero_clicks_and_requests(self):
        await self.page.evaluate("""() => {
            document.querySelector('#cards').hidden=false;
            document.querySelector('#pro-details').hidden=true;
        }""")
        for placement in ('inside_marker', 'direct_parent'):
            for label in ('Get Pro', 'Upgrade to Pro', '获取 Pro', '升级至 Pro', 'Synthetic details action'):
                with self.subTest(placement=placement, label=label):
                    await self.page.evaluate("""options => {
                        const card=document.querySelector('#pro-card'), header=card.firstElementChild;
                        card.removeAttribute('data-testid');header.removeAttribute('data-testid');
                        const marker=options.placement==='inside_marker'?card:header;
                        marker.setAttribute('data-testid','pro-pricing-modal-column-top-half');
                        const entry=document.querySelector('#entry');entry.textContent=options.label;
                        entry.onclick=()=>{window.entryClicks++;
                          fetch('https://chatgpt.com/backend-api/payments/checkout',
                            {method:'POST',body:JSON.stringify({plan_name:'chatgptpro'})});};
                    }""", {'placement': placement, 'label': label})
                    selection=Selection(self.page,lambda *_args,**_kwargs:None)
                    with patch('plan_selection.STEP_SECONDS', .3), self.assertRaises(Stop) as stopped:
                        await selection.open_pro_details(self.page.get_by_role('dialog'))
                    self.assertEqual(stopped.exception.report['reason'],'official_plan_tier_not_found')
                    await self.assert_unsubmitted()
                    self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)
                    self.assertEqual(self.requests, [])


    async def test_ready_three_tier_group_selects_500_without_clicking_named_checkout_cta(self):
        await self.page.evaluate("""() => {
            openPro();window.entryClicks=0;
            document.querySelector('#final').textContent='Get Pro';
        }""")
        button=await self.select()
        self.assertEqual(await button.get_attribute('id'), 'final')
        self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'), 'true')
        self.assertEqual(await self.page.locator('#tier200').get_attribute('aria-checked'), 'false')
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)
        await verify_selected_plan(self.page, 'pro-500')
        await self.assert_unsubmitted()

    async def native_pricing_redirect(self, *, details=True, duplicate=False, delay=False, group_delay=False):
        if details:
            await self.page.evaluate("""() => {
                document.querySelector('#cards').hidden=true;
                document.querySelector('#pro-details').hidden=false;
                document.querySelector('#pro-details h3').textContent='ChatGPT Pro';
            }""")
        else:
            await self.page.evaluate("""() => {
                document.querySelector('#cards').hidden=false;
                document.querySelector('#pro-details').hidden=true;
            }""")
        if duplicate:
            await self.page.locator('#pro-details').evaluate('node=>node.after(node.cloneNode(true))')
        if delay:
            await self.page.locator('#pro-details').evaluate('node=>node.hidden=true')
        if group_delay:
            await self.page.locator('#usage-group').evaluate('node=>node.hidden=true')
        html=await self.page.content()
        if group_delay:
            html=html.replace('</body>',"<script>setTimeout(()=>document.querySelector('#usage-group').hidden=false,100)</script></body>")
        if delay:
            html=html.replace('</body>',"<script>setTimeout(()=>document.querySelector('#pro-details').hidden=false,100)</script></body>")
        paths=[]
        async def native_route(route):
            request=route.request
            parts=urlsplit(request.url)
            if request.method=='GET' and parts.hostname=='chatgpt.com' and parts.path=='/pricing':
                paths.append('/pricing')
                await route.fulfill(content_type='text/html; charset=utf-8',body="<html><body><script>setTimeout(()=>location.replace('/'),0)</script></body></html>")
            elif request.method=='GET' and parts.hostname=='chatgpt.com' and parts.path=='/':
                paths.append('/')
                await route.fulfill(content_type='text/html; charset=utf-8',body=html)
            else:
                self.requests.append(request.method)
                await route.abort()
        await self.context.route('**/*',native_route)
        return paths


    async def test_pricing_native_redirect_reuses_verified_pro_details_without_marketing_link(self):
        paths=await self.native_pricing_redirect()
        selection=Selection(self.page,lambda *_args,**_kwargs:None)
        with patch('plan_selection.STEP_SECONDS', 2),patch('plan_selection.SELECTION_SECONDS',3):
            scope=await selection.open_pricing_card('pro-500')
        self.assertEqual(await scope.get_attribute('role'),'dialog')
        self.assertEqual(paths,['/pricing','/'])
        self.assertEqual(self.page.url,'https://chatgpt.com/')
        button=await self.select()
        self.assertEqual(await button.get_attribute('id'),'final')
        self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'true')
        self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
        await verify_selected_plan(self.page,'pro-500')
        await self.assert_unsubmitted()

    async def test_pricing_native_overview_without_tiers_stops_without_expansion(self):
        paths=await self.native_pricing_redirect(details=False)
        selection=Selection(self.page,lambda *_args,**_kwargs:None)
        with patch('plan_selection.STEP_SECONDS', 2),self.assertRaises(Stop) as stopped:
            await selection.open_pricing_card('pro-500')
        self.assertEqual(stopped.exception.report['reason'],'official_plan_tier_not_found')
        self.assertEqual(paths,['/pricing','/'])
        self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
        await self.assert_unsubmitted()

    async def test_pricing_native_duplicate_pro_details_stop_before_any_click(self):
        paths=await self.native_pricing_redirect(duplicate=True)
        selection=Selection(self.page,lambda *_args,**_kwargs:None)
        with patch('plan_selection.STEP_SECONDS', 2),self.assertRaises(Stop) as stopped:
            await selection.open_pricing_card('pro-500')
        self.assertEqual(stopped.exception.report['reason'],'official_plan_region_ambiguous')
        self.assertEqual(stopped.exception.report['diagnostics']['matched_count'],2)
        self.assertEqual(paths,['/pricing','/'])
        self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
        await self.assert_unsubmitted()

    async def test_pricing_native_delayed_details_without_marketing_anchor_use_original_budget(self):
        paths=await self.native_pricing_redirect(delay=True)
        selection=Selection(self.page,lambda *_args,**_kwargs:None)
        with patch('plan_selection.STEP_SECONDS', 2),patch('plan_selection.SELECTION_SECONDS',3):
            scope=await selection.open_pricing_card('pro-500')
        self.assertEqual(await scope.get_attribute('role'),'dialog')
        self.assertEqual(paths,['/pricing','/'])
        self.assertEqual(await self.page.get_by_role('link').count(),0)
        button=await self.select()
        self.assertEqual(await button.get_attribute('id'),'final')
        self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'true')
        self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
        await self.assert_unsubmitted()

    async def home_overview(self):
        await self.page.evaluate("""() => {
            document.querySelector('#cards').hidden=false;
            document.querySelector('#pro-details').hidden=true;
            document.querySelector('#entry').textContent='Get Pro';
            document.querySelector('#entry').onclick=()=>{window.entryClicks++;
              fetch('https://chatgpt.com/backend-api/payments/checkout',{method:'POST',body:'synthetic'});};
        }""")

    async def pricing_document_fixture(self, *, controls=True, pending_script=False,
                                       status=200, redirect_host=None):
        """真实 Chromium 导航夹具；外部 defer 由本机挂起，所有写请求本机拦截。"""
        await self.page.evaluate("""controls => {
            document.querySelector('#cards').hidden=true;
            const details=document.querySelector('#pro-details');
            details.hidden=false;
            details.querySelector('h3').textContent='ChatGPT Pro';
            if(!controls)details.remove();
        }""", controls)
        html=await self.page.content()
        html=html.replace('</body>', '''<button id="payment" onclick="window.paymentClicks++;
            fetch('https://api.stripe.com/v1/payment_pages/cs_synthetic/confirm',
              {method:'POST',body:'synthetic'})">Pay</button><script>
            window.domContentLoadedObserved=false;window.paymentClicks=0;window.nonTierClicks=0;
            document.addEventListener('DOMContentLoaded',()=>window.domContentLoadedObserved=true);
            document.addEventListener('click',event=>{
                const button=event.target.closest('button');
                if(button && button.getAttribute('role')!=='radio')window.nonTierClicks++;
            },true);
            </script></body>''')
        if pending_script:
            html=html.replace('</body>', '<script defer src="https://synthetic-assets.invalid/nonessential-pricing.js"></script></body>')
        paths=[]
        release=asyncio.Event()
        requested=asyncio.Event()
        async def local_route(route):
            request=route.request
            parts=urlsplit(request.url)
            if request.method=='GET' and parts.hostname=='chatgpt.com' and parts.path=='/pricing':
                paths.append('/pricing')
                if redirect_host:
                    # 路由重定向是第二次独立导航，仍由本机 handler 返回，不发实际域名请求。
                    await route.fulfill(content_type='text/html; charset=utf-8',body=
                        '<html><body><script>location.replace(' +
                        json.dumps(f'https://{redirect_host}/pricing') + ')</script></body></html>')
                else:
                    await route.fulfill(status=status,content_type='text/html; charset=utf-8',body=html)
            elif request.method=='GET' and parts.hostname==redirect_host and parts.path=='/pricing':
                paths.append('untrusted/pricing')
                await route.fulfill(content_type='text/html; charset=utf-8',body=html)
            elif request.method=='GET' and parts.hostname=='synthetic-assets.invalid' and parts.path=='/nonessential-pricing.js':
                paths.append('nonessential-pricing.js')
                requested.set()
                await release.wait()
                await route.fulfill(content_type='application/javascript',body='')
            else:
                self.requests.append(request.method)
                await route.abort()
        await self.context.route('**/*',local_route)
        # 初始页没有档位；选择器必须走真实 pricing 导航，而非直接复用旧 DOM。
        await self.page.set_content('''<main><article data-testid="pro-pricing-modal-column-top-half">
            <h3>Pro</h3><button onclick="fetch('/backend-api/payments/checkout',
              {method:'POST',body:'synthetic'})">Get Pro</button></article></main>''')
        return paths,release,requested

    async def assert_pricing_writes_unsubmitted(self):
        self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
        self.assertEqual(await self.page.evaluate('window.finalClicks'),0)
        self.assertEqual(await self.page.evaluate('window.paymentClicks'),0)
        self.assertEqual(await self.page.evaluate('window.nonTierClicks'),0)
        self.assertEqual(self.requests,[])

    async def test_pricing_pending_defer_selects_500_before_domcontentloaded_without_any_cta(self):
        paths,release,requested=await self.pricing_document_fixture(pending_script=True)
        try:
            with patch('plan_selection.STEP_SECONDS',1),patch('plan_selection.SELECTION_SECONDS',3):
                button=await select_plan(self.page,'pro-500',lambda *_args,**_kwargs:None)
            self.assertTrue(requested.is_set())
            self.assertEqual(paths,['/pricing','nonessential-pricing.js'])
            self.assertEqual(await self.page.evaluate('document.readyState'),'interactive')
            self.assertFalse(await self.page.evaluate('window.domContentLoadedObserved'))
            self.assertEqual(await button.get_attribute('id'),'final')
            self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'true')
            self.assertEqual(await self.page.locator('#tier200').get_attribute('aria-checked'),'false')
            await verify_selected_plan(self.page,'pro-500')
        finally:
            await self.assert_pricing_writes_unsubmitted()
            release.set()
            await self.page.wait_for_load_state('domcontentloaded',timeout=3000)

    async def test_pricing_pending_defer_without_pro_controls_stops_without_any_cta(self):
        paths,release,requested=await self.pricing_document_fixture(controls=False,pending_script=True)
        try:
            with patch('plan_selection.STEP_SECONDS',.3),patch('plan_selection.SELECTION_SECONDS',2),self.assertRaises(Stop) as stopped:
                await select_plan(self.page,'pro-500',lambda *_args,**_kwargs:None)
            self.assertEqual(stopped.exception.report['reason'],'official_pricing_plan_entry_not_found')
            self.assertEqual(stopped.exception.report['diagnostics']['step'],'pricing_page')
            self.assertTrue(requested.is_set())
            self.assertEqual(paths,['/pricing','nonessential-pricing.js'])
            self.assertFalse(await self.page.evaluate('window.domContentLoadedObserved'))
        finally:
            await self.assert_pricing_writes_unsubmitted()
            release.set()
            await self.page.wait_for_load_state('domcontentloaded',timeout=3000)

    async def test_pricing_http_failure_cannot_supply_fake_ready_pro_controls(self):
        paths,_release,_requested=await self.pricing_document_fixture(status=403)
        with patch('plan_selection.STEP_SECONDS',1),patch('plan_selection.SELECTION_SECONDS',3),self.assertRaises(Stop) as stopped:
            await select_plan(self.page,'pro-500',lambda *_args,**_kwargs:None)
        self.assertEqual(stopped.exception.report['reason'],'official_pricing_plan_entry_not_found')
        self.assertEqual(paths,['/pricing'])
        self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'false')
        await self.assert_pricing_writes_unsubmitted()

    async def test_pricing_untrusted_https_redirect_cannot_supply_fake_ready_pro_controls(self):
        paths,_release,_requested=await self.pricing_document_fixture(redirect_host='synthetic-untrusted.invalid')
        with patch('plan_selection.STEP_SECONDS',1),patch('plan_selection.SELECTION_SECONDS',3),self.assertRaises(Stop) as stopped:
            await select_plan(self.page,'pro-500',lambda *_args,**_kwargs:None)
        self.assertEqual(stopped.exception.report['reason'],'official_plan_browser_error')
        self.assertEqual(paths,['/pricing','untrusted/pricing'])
        self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'false')
        await self.assert_pricing_writes_unsubmitted()

    async def test_home_overview_reads_native_pricing_once_then_selects_ready_500(self):
        paths=await self.native_pricing_redirect()
        await self.home_overview()
        with patch('plan_selection.STEP_SECONDS',2),patch('plan_selection.SELECTION_SECONDS',3):
            button=await select_plan(self.page,'pro-500',lambda *_args,**_kwargs:None)
        self.assertEqual(paths,['/pricing','/'])
        self.assertEqual(await button.get_attribute('id'),'final')
        self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'true')
        self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
        await verify_selected_plan(self.page,'pro-500')
        await self.assert_unsubmitted()

    async def test_home_overview_native_overview_stops_after_one_read_without_cta(self):
        paths=await self.native_pricing_redirect(details=False)
        await self.home_overview()
        with patch('plan_selection.STEP_SECONDS',.3),patch('plan_selection.SELECTION_SECONDS',2),self.assertRaises(Stop) as stopped:
            await select_plan(self.page,'pro-500',lambda *_args,**_kwargs:None)
        self.assertEqual(stopped.exception.report['reason'],'official_plan_tier_not_found')
        self.assertEqual(paths,['/pricing','/'])
        self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
        await self.assert_unsubmitted()

    async def test_ready_home_details_reuse_scope_without_pricing_navigation(self):
        button=await self.select()
        self.assertEqual(await button.get_attribute('id'),'final')
        self.assertEqual(self.page.url,'about:blank')
        self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'true')
        self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
        await self.assert_unsubmitted()

    async def test_pricing_native_marker_before_group_waits_within_original_budget(self):
        paths=await self.native_pricing_redirect(group_delay=True)
        selection=Selection(self.page,lambda *_args,**_kwargs:None)
        with patch('plan_selection.STEP_SECONDS',2),patch('plan_selection.SELECTION_SECONDS',3):
            scope=await selection.open_pricing_card('pro-500')
        self.assertEqual(await scope.get_attribute('role'),'dialog')
        self.assertEqual(paths,['/pricing','/'])
        button=await self.select()
        self.assertEqual(await button.get_attribute('id'),'final')
        self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'true')
        self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
        await self.assert_unsubmitted()

    async def test_native_group_wait_rechecks_unique_dialog_before_any_selection(self):
        paths=await self.native_pricing_redirect()
        selection=Selection(self.page,lambda *_args,**_kwargs:None)
        original_wait=selection.wait_native_pro_details
        async def dialog_during_wait(scope):
            self.assertEqual(await self.page.get_by_role('dialog').count(),1)
            await self.page.evaluate("""() => {
                document.querySelector('#usage-group').hidden=true;
                setTimeout(()=>{const other=document.createElement('section');
                  other.setAttribute('role','dialog');other.setAttribute('aria-label','Synthetic other task');
                  const control=document.createElement('button');control.textContent='Synthetic action';
                  other.append(control);document.body.append(other);},50);
                setTimeout(()=>document.querySelector('#usage-group').hidden=false,150);
            }""")
            self.assertFalse(await self.page.locator('#usage-group').is_visible())
            return await original_wait(scope)
        with patch.object(selection,'wait_native_pro_details',new=dialog_during_wait), \
                patch('plan_selection.STEP_SECONDS',2),patch('plan_selection.REGION_TRANSITION_SECONDS',.1), \
                self.assertRaises(Stop) as stopped:
            await selection.open_pricing_card('pro-500')
        self.assertEqual(stopped.exception.report['reason'],'official_plan_region_ambiguous')
        self.assertEqual(stopped.exception.report['diagnostics']['matched_count'],2)
        self.assertEqual(paths,['/pricing','/'])
        self.assertEqual(await self.page.locator('#tier500').get_attribute('aria-checked'),'false')
        self.assertEqual(await self.page.evaluate('window.entryClicks'),0)
        await self.assert_unsubmitted()

    async def test_nested_pro_header_and_group_use_sibling_cta_in_same_card(self):
        await self.page.locator('#pro-details').evaluate('''node => {
            const header=document.createElement('div');
            header.append(node.querySelector('h3'),node.querySelector('#usage-group'));
            node.prepend(header);
        }''')
        button = await self.select()
        self.assertEqual(await button.get_attribute('id'), 'final')
        await verify_selected_plan(self.page, 'pro-500')
        await self.assert_unsubmitted()

    async def test_duplicate_view_all_navigation_is_not_used(self):
        await self.page.evaluate('''() => {
            document.querySelector('#cards').hidden=true;
            document.querySelector('#pro-details').hidden=true;
            for(let n=0;n<2;n++){const button=document.createElement('button');
              button.textContent='查看所有套餐';document.querySelector('section').append(button);}
        }''')
        await self.assert_blocked('official_plan_option_ambiguous')
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)

    async def test_overview_duplicate_or_disabled_generic_entry_never_clicks(self):
        await self.page.evaluate("""() => {
            document.querySelector('#cards').hidden=false;
            document.querySelector('#pro-details').hidden=true;
        }""")
        await self.page.locator('#entry').evaluate('node=>node.after(node.cloneNode(true))')
        selection=Selection(self.page,lambda *_args,**_kwargs:None)
        with patch('plan_selection.STEP_SECONDS', .3), self.assertRaises(Stop) as stopped:
            await selection.open_pro_details(self.page.get_by_role('dialog'))
        self.assertEqual(stopped.exception.report['reason'],'official_plan_tier_not_found')
        await self.assert_unsubmitted()
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)
        await self.page.locator('#pro-card #entry').last.evaluate('node=>node.remove()')
        await self.page.locator('#entry').evaluate('node=>node.disabled=true')
        selection=Selection(self.page,lambda *_args,**_kwargs:None)
        with patch('plan_selection.STEP_SECONDS', .3), self.assertRaises(Stop) as stopped:
            await selection.open_pro_details(self.page.get_by_role('dialog'))
        self.assertEqual(stopped.exception.report['reason'],'official_plan_tier_not_found')
        await self.assert_unsubmitted()
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)


    async def test_missing_maximum_cannot_use_unrelated_500_or_lower_tier(self):
        await self.page.locator('#tier500').evaluate('node=>node.remove()')
        report = await self.assert_blocked('official_plan_tier_not_found')
        self.assertEqual(report['diagnostics']['step'], 'choose_tier')
        self.assertEqual(report['diagnostics']['matched_count'], 0)
        self.assertEqual(await self.page.locator('#tier200').get_attribute('aria-checked'), 'true')

    async def test_explicit_price_outside_pro_group_cannot_supply_missing_tier(self):
        await self.page.locator('#usage-group').evaluate('''node => {
            node.innerHTML='<button role="radio" aria-checked="true">Unknown</button>';
            const outside=document.createElement('button');outside.id='outside-price';
            outside.setAttribute('role','radio');outside.setAttribute('aria-checked','true');
            node.after(outside);
        }''')
        for label in ('$500', 'Pro 500'):
            await self.page.locator('#outside-price').evaluate('(node,label)=>node.textContent=label', label)
            report = await self.assert_blocked('official_plan_tier_not_found')
            self.assertEqual(report['diagnostics']['matched_count'], 0)

    async def test_go_and_plus_do_not_expand_pro_or_require_its_tiers(self):
        await self.page.evaluate("() => {document.querySelector('#cards').hidden=false;document.querySelector('#pro-details').hidden=true;}")
        for entry_label in ('升级订阅，获取更高使用额度', 'Get Pro', 'Upgrade to Pro'):
            await self.page.locator('#entry').evaluate('(node,label)=>node.textContent=label', entry_label)
            for target, label in (('go', 'Get Go'), ('plus', 'Get Plus')):
                button = await select_plan(self.page, target, lambda *_args, **_kwargs: None)
                self.assertEqual(await button.inner_text(), label)
                await verify_selected_plan(self.page, target)
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)
        await self.assert_unsubmitted()

    async def test_duplicate_or_disabled_maximum_stops_without_selecting_another_tier(self):
        await self.page.locator('#tier500').evaluate('node=>node.after(node.cloneNode(true))')
        await self.assert_blocked('official_plan_option_ambiguous')
        await self.page.locator('#usage-group #tier500').last.evaluate('node=>node.remove()')
        await self.page.locator('#tier500').evaluate('node=>node.disabled=true')
        await self.assert_blocked('official_plan_option_disabled')
        self.assertEqual(await self.page.locator('#tier200').get_attribute('aria-checked'), 'true')

    async def test_unnamed_group_never_authorizes_bare_numbers(self):
        await self.page.locator('#usage-group').evaluate('node=>node.removeAttribute("aria-label")')
        await self.assert_blocked('official_plan_tier_not_found')

    async def test_duplicate_pro_group_is_rejected(self):
        await self.page.locator('#usage-group').evaluate('node=>node.after(node.cloneNode(true))')
        await self.assert_blocked('official_plan_region_ambiguous')

    async def test_missing_or_duplicate_pro_card_marker_is_rejected(self):
        await self.page.locator('#pro-details').evaluate('node=>node.removeAttribute("data-testid")')
        await self.assert_blocked('official_plan_tier_not_found')
        await self.page.locator('#pro-details').evaluate('''node => {
            node.setAttribute('data-testid','pro-pricing-modal-column-top-half');
            node.after(node.cloneNode(true));
        }''')
        await self.assert_blocked('official_plan_region_ambiguous')

    async def test_pro_marker_cannot_include_another_plan_heading(self):
        await self.page.locator('#pro-details').evaluate('''node => {
            const heading=document.createElement('h3');heading.id='other-heading';heading.textContent='Plus';node.append(heading);
        }''')
        await self.assert_blocked('official_plan_region_ambiguous')
        await self.page.locator('#other-heading').evaluate('node=>node.textContent="ChatGPT Plus"')
        await self.assert_blocked('official_plan_region_ambiguous')

    async def test_missing_pro_cta_cannot_fall_back_to_outside_generic_cta(self):
        await self.page.locator('#final').evaluate('node=>node.remove()')
        await self.assert_blocked('official_plan_option_not_found')

    async def test_duplicate_or_disabled_final_cta_stops_before_checkout(self):
        await self.page.locator('#final').evaluate('node=>node.after(node.cloneNode(true))')
        await self.assert_blocked('official_plan_option_ambiguous')
        await self.page.locator('#pro-details #final').last.evaluate('node=>node.remove()')
        await self.page.locator('#final').evaluate('node=>node.disabled=true')
        await self.assert_blocked('official_plan_option_disabled')

    async def test_multiple_visible_pro_headings_never_assign_generic_cta(self):
        await self.page.locator('#pro-details').evaluate('node=>node.after(node.cloneNode(true))')
        await self.assert_blocked('official_plan_region_ambiguous')
        self.assertEqual(await self.page.evaluate('window.entryClicks'), 0)

    async def test_generic_cta_cannot_escape_nearest_pro_heading_and_group_container(self):
        await self.page.locator('#final').evaluate('node=>document.querySelector("section").append(node)')
        await self.assert_blocked('official_plan_option_not_found')

    async def test_generic_cta_in_other_plan_card_is_not_owned_by_pro(self):
        await self.page.locator('#final').evaluate('''node => {
            const other=document.createElement('article');other.innerHTML='<h3>Plus</h3>';
            other.append(node);document.querySelector('section').append(other);
        }''')
        await self.assert_blocked('official_plan_option_not_found')

    async def test_changed_tier_or_multiple_checked_radios_blocks_reverification(self):
        await self.select()
        await self.page.locator('#tier200').evaluate('node=>node.setAttribute("aria-checked","true")')
        with self.assertRaises(Stop) as stopped:
            await verify_selected_plan(self.page, 'pro-500')
        self.assertEqual(stopped.exception.report['reason'], 'selected_plan_changed')
        await self.page.evaluate('choose(200)')
        with self.assertRaises(Stop) as stopped:
            await verify_selected_plan(self.page, 'pro-500')
        self.assertEqual(stopped.exception.report['reason'], 'selected_plan_changed')
        await self.assert_unsubmitted()

    async def test_legacy_get_pro_is_not_accepted_as_plus_upgrade_entry(self):
        await self.page.evaluate('''() => {
            openPro();document.querySelector('#usage-group').setAttribute('aria-label','选择 Pro 套餐档位');
            document.querySelector('#final').textContent='Get Pro';
            document.querySelectorAll('[data-testid]').forEach(node=>node.removeAttribute('data-testid'));
        }''')
        button = await self.select()
        self.assertEqual(await button.get_attribute('id'), 'final')
        with self.assertRaises(Stop) as stopped:
            await self.select(require_upgrade=True)
        self.assertEqual(stopped.exception.report['reason'], 'official_plan_option_not_found')
        await self.assert_unsubmitted()


if __name__ == "__main__":
    unittest.main()
