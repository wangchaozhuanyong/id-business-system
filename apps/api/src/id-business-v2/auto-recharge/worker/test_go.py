"""Go 接入与付款保护：仅使用合成数据，Chromium 全请求在本机拦截。"""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

from attempt_ledger import AttemptLedger, existing_checkout
from browser_checkout import NetworkGuard, quote_from_text, workflow
from checkout_core import CHECKOUT_PATH, ROOT, Stop, parse_browser_credential
from pay import run_payment
from payment_recovery import recheck_in_context
from payment_state import PaymentLedger, outcome, quote_digest
from plan_selection import select_plan, verify_selected_plan
from plans import checkout_text_plan, plan_spec, subscription_match
from test_payment import details
from test_subscribe import account, fixture


def go_quote():
    return quote_from_text('ChatGPT Go\nTotal due today\nMYR 24.00\nTax\nMYR 0.00\n'
                           'Renews\nMYR 24.00\nper month', 'MYR')


class GoStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'state'
        self.target = parse_browser_credential(fixture())

    def tearDown(self):
        self.temp.cleanup()

    def marker(self, plan):
        with AttemptLedger(self.root, self.target.account_id, target_plan=plan) as ledger:
            ledger.begin()
            ledger.finish({'checkout_identifier': f'cs_{plan}_synthetic', 'processor_entity': 'openai_ie'})
            return ledger.path

    def test_only_official_paid_go_request_can_be_created(self):
        self.assertEqual(plan_spec('go')['official_name'], 'chatgptgoplan')
        with AttemptLedger(self.root, self.target.account_id, target_plan='go') as ledger:
            guard = NetworkGuard(self.target, ledger)
            guard.armed = True
            headers = {'authorization': 'Bearer ' + self.target.old_token}
            for name, expected in [('chatgptgoplan', 'create'), ('chatgptplusplan', 'plan_mismatch'),
                                   ('chatgptpro', 'plan_mismatch'),
                                   ('chatgptgofreeplan_with_expiration', 'unknown_write'),
                                   ('chatgptgo_partner_managed', 'unknown_write')]:
                with self.subTest(name=name):
                    self.assertEqual(guard.classify('POST', 'https://chatgpt.com' + CHECKOUT_PATH,
                                                    {'plan_name': name}, headers), expected)

    def test_go_quote_requires_explicit_title_and_preserves_local_currency(self):
        for title in ('Go', 'ChatGPT Go'):
            self.assertEqual(checkout_text_plan(title + '\nMYR 24.00'), 'go')
        for text in ('Go to checkout\nMYR 24.00', 'Total due today\nMYR 24.00',
                     'ChatGPT Go\nChatGPT Plus', 'Go\nPro 100'):
            self.assertIsNone(checkout_text_plan(text))
        quote = go_quote()
        self.assertEqual(quote['plan'], 'go')
        self.assertEqual(quote['today'], {'currency': 'MYR', 'amount': '24.00', 'amount_minor': 2400})
        self.assertEqual(quote['renewal_interval'], 'monthly')

    def test_go_records_and_plus_records_are_isolated(self):
        plus = self.marker('plus')
        original = plus.read_bytes()
        go = self.marker('go')
        self.assertNotEqual(plus, go)
        self.assertTrue(go.name.endswith('-go.json'))
        self.assertEqual(plus.read_bytes(), original)
        self.assertEqual(existing_checkout(self.root, self.target.account_id, 'go')['target_plan'], 'go')

    def test_go_quote_and_activation_cannot_use_plus(self):
        self.marker('go')
        evidence = {'kind': 'checkout_session', 'identifier': 'cs_go_synthetic',
                    'amount_minor': 2400, 'currency': 'MYR'}
        with PaymentLedger(self.root, self.target.account_id, target_plan='go') as ledger:
            wrong = {**go_quote(), 'plan': 'plus'}
            with self.assertRaises(Stop):
                ledger.begin(wrong, confirmed_digest=quote_digest(wrong), card_last4='4242')
            self.assertFalse(ledger.path.exists())
            quote = go_quote()
            ledger.begin(quote, confirmed_digest=quote_digest(quote), card_last4='4242')
            ledger.update(payment_status='paid', evidence=evidence, current_plan='go')
            self.assertEqual(ledger.record['subscription_status'], 'go')
            self.assertEqual(ledger.record['current_plan'], 'go')
        self.assertEqual(subscription_match('go', 'plus'), 'target_not_verified')
        self.assertEqual(outcome('paid', 'plus', evidence, target_plan='go'), 'paid_pending_activation')
        self.assertEqual(outcome('paid', 'go', evidence, target_plan='go'), 'subscription_activated')
        self.assertEqual(outcome('unknown', 'go', target_plan='go'), 'payment_result_unknown')

    def test_switching_to_plus_cannot_bypass_go_payment_attempt(self):
        self.marker('go')
        self.marker('plus')
        quote = go_quote()
        with PaymentLedger(self.root, self.target.account_id, target_plan='go') as ledger:
            ledger.begin(quote, confirmed_digest=quote_digest(quote), card_last4='4242')
        with self.assertRaises(Stop) as blocked:
            with PaymentLedger(self.root, self.target.account_id, target_plan='plus'):
                pass
        self.assertEqual(blocked.exception.report['recheck_plan'], 'go')
        self.assertEqual(blocked.exception.report['reason'], 'account_has_other_payment_attempt')

    def test_server_and_connector_accept_only_supported_record_names(self):
        import server
        import bitbrowser_connector as connector
        for name in ('a' * 64 + '-go.json', 'payments/' + 'b' * 64 + '.json',
                     'a' * 64 + '-pro-500.json'):
            self.assertIsNotNone(server.RECORD_PATH.fullmatch(name))
            job = connector.LocalJob.__new__(connector.LocalJob)
            job.root, job.account_key, job.revisions = self.root, 'a' * 64, {}
            job.callback = SimpleNamespace(send=Mock(return_value={'revision': 1}))
            job.persist(self.root / name, {'target_plan': 'go'})
            self.assertEqual(job.callback.send.call_args.args[0]['fileKey'], name)
        for name in ('../' + 'a' * 64 + '-go.json', 'a' * 64 + '-go-free.json',
                     'a' * 64 + '-business.json'):
            self.assertIsNone(server.RECORD_PATH.fullmatch(name))
            with self.assertRaises(Stop):
                job.persist(self.root / name, {})

    def test_server_go_confirmation_keeps_currency_amount_and_authorization_guards(self):
        import server
        quote = go_quote()
        safety = {'authorizeSinglePayment': True, 'lockedCurrency': 'MYR', 'maxAmountMinor': 2400}
        with patch.object(server, 'callback') as callback:
            job = server.Job('synthetic-job', {'action': 'server', 'plan': 'go', 'safety': safety})
            self.assertTrue(job.confirm(quote, '4242'))
            self.assertEqual(callback.call_args.args[1]['result']['quote']['plan'], 'go')
            for changed_quote, changed_safety in (({**quote, 'plan': 'plus'}, safety),
                    (quote, {**safety, 'maxAmountMinor': 2399}),
                    (quote, {**safety, 'lockedCurrency': 'USD'}),
                    (quote, {**safety, 'authorizeSinglePayment': False})):
                callback.reset_mock()
                job = server.Job('synthetic-job', {'action': 'server', 'plan': 'go', 'safety': changed_safety})
                with self.assertRaises(Stop):
                    job.confirm(changed_quote, '4242')
                callback.assert_not_called()

    def test_connector_go_start_and_original_recheck_preserve_plan(self):
        import bitbrowser_connector as connector
        from test_bitbrowser_connector import payload
        value = {**payload(), 'plan': 'go'}
        self.assertIs(connector.validate_payload(value), value)
        with self.assertRaises(Stop):
            connector.validate_payload({**value, 'authorizeSinglePayment': False})
        recheck = {key: value[key] for key in (
            'id', 'plan', 'windowName', 'sessionJson', 'bitBrowser', 'callbackUrl', 'agentToken')}
        recheck['mode'] = 'recheck'
        self.assertEqual(connector.validate_payload(recheck)['plan'], 'go')
        with self.assertRaises(Stop):
            connector.validate_payload({**recheck, 'details': value['details']})


class GoBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', str(ROOT / '.browsers'))
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(headless=True)
        self.context = await self.browser.new_context(service_workers='block')
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'state'
        self.target = parse_browser_credential(fixture())
        self.creates, self.payments = [], 0
        self.label, self.go_count, self.disabled = 'Try Go', 1, False
        self.request_plan, self.quote_plan, self.activated_plan = 'chatgptgoplan', 'ChatGPT Go', 'go'
        self.pricing_fallback = False
        self.pricing_opened = False
        await self.context.route('**/*', self.server)

    async def asyncTearDown(self):
        await self.context.close()
        await self.browser.close()
        await self.playwright.stop()
        self.temp.cleanup()

    async def server(self, route):
        request = route.request
        path = urlsplit(request.url).path
        if request.method == 'OPTIONS':
            return await route.fulfill(headers={'Access-Control-Allow-Origin': 'https://chatgpt.com',
                                                'Access-Control-Allow-Headers': '*',
                                                'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'})
        if path == '/api/auth/session':
            return await route.fulfill(json=json.loads(fixture()))
        if path == '/backend-api/accounts/check/v4-2023-04-27':
            return await route.fulfill(json=account(self.activated_plan if self.payments else 'free'))
        if path == '/cdn-cgi/trace':
            return await route.fulfill(body='ip=8.8.8.8\nloc=MY\n')
        if path == CHECKOUT_PATH:
            self.creates.append(request.post_data_json)
            return await route.fulfill(json={'checkout_session_id': 'cs_go_synthetic',
                                             'processor_entity': 'openai_ie',
                                             'billing_details': {'currency': 'MYR'}})
        if path == '/v1/payment_pages/cs_go_synthetic/init':
            return await route.fulfill(json={'id': 'cs_go_synthetic', 'status': 'open', 'currency': 'myr',
                                             'total_summary': {'due': 2400, 'total': 2400}},
                                       headers={'Access-Control-Allow-Origin': 'https://chatgpt.com'})
        if path == '/v1/payment_methods':
            return await route.fulfill(json={'id': 'pm_synthetic'},
                                       headers={'Access-Control-Allow-Origin': 'https://chatgpt.com'})
        if path == '/v1/payment_pages/cs_go_synthetic/confirm':
            self.payments += 1
            record = json.loads(next((self.root / 'payments').glob('*.json')).read_text())
            self.assertEqual(record['confirmation_requests_sent'], 1)
            return await route.fulfill(json={'object': 'checkout.session', 'session_id': 'cs_go_synthetic',
                                             'id': 'page_synthetic', 'status': 'complete', 'payment_status': 'paid',
                                             'total_summary': {'due': 2400}, 'currency': 'myr'},
                                       headers={'Access-Control-Allow-Origin': 'https://chatgpt.com'})
        if path.startswith('/checkout/'):
            html = '''<html><body><h1>TITLE</h1><p>Total due today</p><p>MYR 24.00</p>
                <p>Tax</p><p>MYR 0.00</p><p>Renews</p><p>MYR 24.00</p><p>per month</p>
                <input autocomplete="cc-number"><input autocomplete="cc-exp"><input autocomplete="cc-csc"
                oninput="fetch('https://api.stripe.com/v1/payment_pages/cs_go_synthetic/init',{method:'POST',body:'billing=changed'})">
                <button type="submit" onclick="pay()">订阅</button><script>
                fetch('https://api.stripe.com/v1/payment_pages/cs_go_synthetic/init',{method:'POST',body:'read=1'});
                async function pay(){await fetch('https://api.stripe.com/v1/payment_methods',{method:'POST',body:'type=card'});
                await fetch('https://api.stripe.com/v1/payment_pages/cs_go_synthetic/confirm',{method:'POST',body:'payment_method=pm_synthetic'});}
                </script></body></html>'''.replace('TITLE', self.quote_plan)
        elif path == '/pricing':
            self.pricing_opened = True
            html = '<html><body><main><section><h2>Go</h2><a href="/#pricing">Get Go</a></section>' \
                   '<section><h2>Plus</h2><a href="/#pricing">Get Plus</a></section></main></body></html>'
        elif path == '/':
            if self.pricing_fallback and not self.pricing_opened:
                html = '<html><title>ChatGPT</title><body>Home</body></html>'
            else:
                headers = json.dumps({'Authorization': 'Bearer ' + self.target.old_token,
                                      'Content-Type': 'application/json'})
                options = ''.join(f'<button {"disabled" if self.disabled else ""} onclick="create()">{self.label}</button>'
                                  for _ in range(self.go_count))
                html = '''<html><title>ChatGPT</title><body><section role="dialog">OPTIONS
                    <button>Get Plus</button><button>Get Pro</button></section><script>
                    async function create(){const r=await fetch('CHECKOUT',{method:'POST',headers:HEADERS,
                    body:JSON.stringify({plan_name:PLAN,billing_details:{country:'MY',currency:'MYR'}})});
                    if(r.ok)location.href='/checkout/openai_ie/'+(await r.json()).checkout_session_id;}
                    </script></body></html>'''.replace('OPTIONS', options).replace('CHECKOUT', CHECKOUT_PATH) \
                    .replace('HEADERS', headers).replace('PLAN', json.dumps(self.request_plan))
        else:
            return await route.abort()
        await route.fulfill(content_type='text/html; charset=utf-8', body=html)

    async def create(self):
        with AttemptLedger(self.root, self.target.account_id, target_plan='go') as ledger, \
                contextlib.redirect_stderr(io.StringIO()):
            return await workflow(self.context, self.target, ledger=ledger, target_plan='go', quote_timeout=1)

    async def test_go_create_and_local_quote(self):
        result = await self.create()
        self.assertEqual(result['status'], 'checkout_quote_verified', result)
        self.assertEqual(result['quote']['plan'], 'go')
        self.assertEqual(result['quote']['today']['currency'], 'MYR')
        self.assertEqual([item['plan_name'] for item in self.creates], ['chatgptgoplan'])
        self.assertEqual(self.payments, 0)

    async def test_localized_and_english_go_buttons_do_not_choose_plus(self):
        for label in ('Get Go', 'Try Go', 'Upgrade to Go', '获取 Go', '试用 Go', '升级至 Go'):
            with self.subTest(label=label):
                self.label = label
                page = await self.context.new_page()
                await page.goto('https://chatgpt.com/')
                button = await select_plan(page, 'go', lambda *_args, **_kwargs: None)
                self.assertEqual(await button.inner_text(), label)
                await verify_selected_plan(page, 'go')
                await page.close()
        self.assertFalse(self.creates)

    async def test_go_pricing_card_fallback_still_creates_only_once(self):
        self.pricing_fallback = True
        with patch('plan_selection.HOME_ENTRY_SECONDS', .1):
            result = await self.create()
        self.assertEqual(result['status'], 'checkout_quote_verified', result)
        self.assertTrue(self.pricing_opened)
        self.assertEqual([item['plan_name'] for item in self.creates], ['chatgptgoplan'])
        self.assertEqual(self.payments, 0)

    async def test_missing_disabled_and_duplicate_go_stop_before_creation(self):
        for count, disabled, reason in ((0, False, 'official_plan_option_not_found'),
                                        (1, True, 'official_plan_option_disabled'),
                                        (2, False, 'official_plan_option_ambiguous')):
            with self.subTest(count=count, disabled=disabled):
                self.go_count, self.disabled = count, disabled
                page = await self.context.new_page()
                await page.goto('https://chatgpt.com/')
                with patch('plan_selection.STEP_SECONDS', .2), patch('plan_selection.SELECTION_SECONDS', 1):
                    with self.assertRaises(Stop) as blocked:
                        await select_plan(page, 'go', lambda *_args, **_kwargs: None)
                self.assertEqual(blocked.exception.report['reason'], reason)
                await page.close()
        self.assertFalse(self.creates)
        self.assertEqual(self.payments, 0)

    async def test_changed_go_button_stops_before_creation(self):
        page = await self.context.new_page()
        await page.goto('https://chatgpt.com/')
        await select_plan(page, 'go', lambda *_args, **_kwargs: None)
        await page.get_by_role('button', name='Try Go').evaluate("node => node.disabled = true")
        with self.assertRaises(Stop) as blocked:
            await verify_selected_plan(page, 'go')
        self.assertEqual(blocked.exception.report['reason'], 'selected_plan_changed')
        self.assertFalse(self.creates)

    async def test_plus_request_is_blocked_when_go_selected(self):
        self.request_plan = 'chatgptplusplan'
        result = await self.create()
        self.assertEqual(result['status'], 'blocked', result)
        self.assertFalse(self.creates)
        self.assertEqual(self.payments, 0)

    async def test_plus_quote_cannot_be_confirmed_as_go(self):
        self.quote_plan = 'ChatGPT Plus'
        result = await self.create()
        self.assertEqual(result['status'], 'blocked', result)
        self.assertEqual(self.payments, 0)

    async def test_go_payment_and_original_recheck_are_single_attempt(self):
        await self.create()
        async def local_browser(target, **kwargs):
            return await workflow(self.context, target, existing=existing_checkout(self.root, target.account_id, 'go'),
                                  target_plan=kwargs['target_plan'], quote_handler=kwargs['quote_handler'],
                                  guard_factory=kwargs['guard_factory'])
        with PaymentLedger(self.root, self.target.account_id, target_plan='go') as ledger:
            with patch('pay.run_browser', side_effect=local_browser), contextlib.redirect_stderr(io.StringIO()):
                result = await run_payment(self.target, ledger, pay=True, details_reader=details,
                                           confirmer=lambda *_: True, wait_seconds=.3,
                                           poll_count=1, poll_interval=.01)
            self.assertEqual(result['status'], 'subscription_activated', result)
            with self.assertRaises(Stop):
                await run_payment(self.target, ledger, pay=True)
            with contextlib.redirect_stderr(io.StringIO()):
                recheck = await recheck_in_context(self.context, self.target, ledger, timeout=.3,
                                                  poll_count=1, poll_interval=.01)
            self.assertEqual(recheck['status'], 'subscription_activated', recheck)
            self.assertEqual(recheck['payment_requests_sent'], 0)
            self.assertEqual(ledger.record['subscription_status'], 'go')
        self.assertEqual(self.payments, 1)
        self.assertEqual(len(self.creates), 1)


if __name__ == '__main__':
    unittest.main()
