"""真实原生结算结构的合成回归；不访问官网，不使用真实卡片。"""
import asyncio
import contextlib
from copy import deepcopy
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from attempt_ledger import AttemptLedger, atomic_json, checkout_record_path
from browser_checkout import NetworkGuard, run_browser
from checkout_core import CHECKOUT_PATH, Stop
from native_checkout import (billing_fingerprint, native_quote_binding, read_original_native_checkout,
                             request_document, unknown_checkout_recoverable)
from pay import current_quote, verified_quote_once
from pay import payment_handler
from payment_network import PaymentGuard
from payment_state import PaymentLedger
from test_native_pro_checkout import credential
from test_payment import details
from test_subscribe import fixture, account
from checkout_core import parse_browser_credential
from playwright.async_api import async_playwright
from urllib.parse import urlsplit


SID = 'oaics_synthetic_native'
ENTITY = 'openai_llc'
ADDRESS = {'country': 'US', 'line1': 'Synthetic street', 'line2': '',
           'city': 'Synthetic city', 'state': 'OR', 'postal_code': '97204'}


def session(*, due=110000, tax=11786, address=None):
    return {'tag': 'custom_checkout_session', 'checkout_session_id': SID, 'processor_entity': ENTITY,
        'plan_name': 'chatgptplusplan', 'status': 'open', 'payment_status': 'unpaid',
        'billing_details': {'currency': 'php', 'country': 'PH'},
        'checkout_state': {'id': SID, 'currency': 'php', 'canConfirm': False,
            'billingAddress': {'address': address or ADDRESS, 'name': 'Synthetic User'},
            'lineItems': [{'quantity': 1, 'recurring': {'interval': 'month'},
                'subtotal': {'minorUnitsAmount': due-tax, 'amount': None}}],
            'taxAmounts': [{'minorUnitsAmount': tax, 'amount': None}],
            'total': {'total': {'minorUnitsAmount': due, 'amount': None}}}}


class Request:
    def __init__(self, target, *, path=CHECKOUT_PATH, method='POST', data=None, available=True):
        self.url, self.method = 'https://chatgpt.com' + path, method
        self.headers = {'authorization': 'Bearer ' + target.old_token, 'chatgpt-account-id': target.account_id}
        self.post_data_json = data if available else None
        self.post_data_buffer = json.dumps(data).encode() if available else None
        self.post_data = json.dumps(data) if available else None

    async def all_headers(self):
        return self.headers


class Response:
    def __init__(self, request, data, status=200):
        self.request, self.url, self.data, self.status = request, request.url, data, status

    async def body(self):
        return json.dumps(self.data).encode()

    async def all_headers(self):
        return {'content-type': 'application/json'}


def unknown_record():
    return {'status': 'blocked', 'reason': 'checkout_unknown_write', 'stage': 'checkout_create',
        'account_matched': True, 'payment_status': 'not_attempted', 'checkout_requests_sent': 1,
        'payment_requests_sent': 0, 'payment_attempted': False,
        'plan': 'chatgptplusplan', 'target_plan': 'plus'}


class CheckoutObservationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.target = credential()
        self.ledger = SimpleNamespace(target_plan='plus', begin=lambda: None, finish=lambda _: None)
        self.guard = NetworkGuard(self.target, self.ledger)
        self.guard.account_verified = True
        self.guard.begin_checkout()

    async def test_missing_request_body_waits_for_verified_original_response(self):
        request = Request(self.target, available=False)
        self.guard.observe_request(request)
        self.assertIsNone(self.guard.error)
        self.assertFalse(self.guard.response_done.is_set())
        await self.guard.response(Response(request, session()))
        self.assertEqual(self.guard.checkout_id, SID)
        self.assertEqual(self.guard.checkout_plan, 'plus')
        self.assertEqual(self.guard.sent, 1)
        self.assertEqual(self.guard.summary()['checkout_request_body_state'], 'unavailable')

    async def test_parsed_json_does_not_depend_on_text_post_data(self):
        request = Request(self.target, data={'plan_name': 'chatgptplusplan'})
        request.post_data = None
        self.guard.observe_request(request)
        await self.guard.response(Response(request, session()))
        self.assertEqual(self.guard.checkout_id, SID)
        self.assertEqual(self.guard.summary()['checkout_request_plan_state'], 'matched')

    async def test_missing_body_cannot_bind_another_account_or_plan(self):
        for kind in ('account', 'plan', 'state_id'):
            with self.subTest(kind=kind):
                self.setUp()
                request = Request(self.target, available=False)
                data = session()
                if kind == 'account':request.headers['chatgpt-account-id'] = 'another-account'
                if kind == 'plan':data['plan_name'] = 'chatgptpro'
                if kind == 'state_id':data['checkout_state']['id'] = 'oaics_another'
                self.guard.observe_request(request)
                await self.guard.response(Response(request, data))
                self.assertIsNone(self.guard.checkout_id)
                self.assertIsNotNone(self.guard.error)

    async def test_duplicate_is_never_accepted_as_another_checkout(self):
        request = Request(self.target, available=False)
        self.guard.observe_request(request)
        self.guard.observe_request(Request(self.target, available=False))
        await self.guard.response(Response(request, session()))
        self.assertEqual(self.guard.sent, 2)
        self.assertEqual(self.guard.error.report['reason'], 'checkout_result_unknown')


class NativeQuoteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.target = credential()
        self.guard = PaymentGuard(self.target, target_plan='plus')
        self.guard.account_verified = True
        self.guard.checkout_id = SID
        self.guard.result = {'processor_entity': ENTITY}

    def request(self, suffix='/taxes'):
        return Request(self.target, path=CHECKOUT_PATH + suffix, data={
            'checkout_session_id': SID, 'processor_entity': ENTITY,
            'billing_address': ADDRESS, 'billing_name': 'Synthetic User'})

    async def observe(self, request, data):
        self.guard.observe_request(request)
        await self.guard.response(Response(request, {'checkout_session': data}))

    async def test_current_native_tax_response_is_projected_without_secrets(self):
        await self.observe(self.request(), session())
        self.assertEqual(self.guard.official_quote_binding['amount_minor'], 110000)
        self.assertEqual(self.guard.official_quote_binding['tax_minor'], 11786)
        self.assertIsNone(self.guard.summary()['quote_authority'])
        self.assertNotIn('billing_address', self.guard.official_quote_binding)

    async def test_late_response_and_foreign_checkout_cannot_replace_latest_total(self):
        old, latest = self.request(), self.request()
        self.guard.observe_request(old)
        await self.observe(latest, session(due=98214, tax=0))
        await self.guard.response(Response(old, {'checkout_session': session()}))
        self.assertEqual(self.guard.official_quote_binding['amount_minor'], 98214)
        foreign = session();foreign['checkout_session_id'] = 'oaics_another'
        await self.observe(self.request(), foreign)
        self.assertIsNone(self.guard.official_quote_binding)

    async def test_tax_pending_invalidates_previously_ready_quote(self):
        await self.observe(self.request(), session())
        self.guard.final_quote_verified = True
        self.guard.observe_request(self.request())
        self.assertIsNone(self.guard.official_quote_binding)
        self.assertIsNone(self.guard.summary()['quote_authority'])

    async def test_quote_must_match_complete_current_billing_details(self):
        await self.observe(self.request(), session())
        self.guard.expected_billing_fingerprint = billing_fingerprint({**ADDRESS, 'state': 'AK'}, 'Synthetic User')
        reader = AsyncMock()
        with patch('pay.quote_from_page', reader):
            self.assertIsNone(await verified_quote_once(object(), self.guard))
        reader.assert_not_called()

    async def test_pre_fill_response_cannot_satisfy_new_quote_version(self):
        await self.observe(self.request(), session())
        with patch('pay.quote_from_page', AsyncMock()) as reader, patch('pay.progress'):
            with self.assertRaises(Stop) as failed:
                await current_quote(object(), self.guard, 2, wait_seconds=.01)
        self.assertEqual(failed.exception.report['reason'], 'payment_quote_not_ready')
        reader.assert_not_called()

    async def test_missing_tax_or_annual_recurrence_is_not_a_final_quote(self):
        for change in ('tax', 'interval', 'amount'):
            data = session()
            if change == 'tax':data['checkout_state'].pop('taxAmounts')
            if change == 'interval':data['checkout_state']['lineItems'][0]['recurring']['interval'] = 'year'
            if change == 'amount':data['checkout_state']['total']['total']['minorUnitsAmount'] = True
            self.assertIsNone(native_quote_binding(data, SID, ENTITY, 'plus'))

    async def test_native_confirmation_counts_once_and_only_bound_stripe_receipt_proves_payment(self):
        self.guard.payment_ledger = SimpleNamespace(checkout_id=SID,
            record={'payment_attempted': True}, mark_confirmation_sent=Mock(), update=Mock())
        price = {'currency': 'PHP', 'amount': '982.14', 'amount_minor': 98214}
        quote = {'plan': 'plus', 'today': price, 'renewal': price, 'renewal_interval': 'monthly',
                 'tax': {'currency': 'PHP', 'amount': '0.00', 'amount_minor': 0}}
        self.guard.approve(quote)
        request = Request(self.target, path=CHECKOUT_PATH+'/confirm', data={'checkout_session_id': SID})
        self.guard.observe_request(request)
        await self.guard.response(Response(request, {'type': 'payment_intent',
            'client_secret': 'pi_SyntheticNative_secret_NOTREAL'}))
        self.assertEqual(self.guard.confirmation_sent, 1)
        self.assertEqual(self.guard.linked_intent, 'pi_SyntheticNative')
        self.assertIsNone(self.guard.evidence)
        self.guard.payment_ledger.mark_confirmation_sent.assert_called_once()
        stripe = Request(self.target)
        stripe.url = 'https://api.stripe.com/v1/payment_intents/pi_SyntheticNative/confirm'
        await self.guard.response(Response(stripe, {'object': 'payment_intent', 'id': 'pi_SyntheticNative',
            'status': 'succeeded', 'amount_received': 98214, 'currency': 'php'}))
        self.assertEqual(self.guard.payment_state, 'paid')
        self.assertEqual(self.guard.evidence['amount_minor'], 98214)
        self.assertNotIn('NOTREAL', json.dumps(self.guard.summary()))


class OriginalRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_recovery_is_readonly_and_requires_official_original_session(self):
        page = SimpleNamespace(url='https://chatgpt.com/checkout/' + ENTITY + '/' + SID,
                               evaluate=AsyncMock(return_value=session()))
        result = await read_original_native_checkout(page, credential(), 'plus')
        self.assertEqual(result['checkout_session_id'], SID)
        expression, parameters = page.evaluate.await_args.args
        self.assertIn("method:'GET'", expression)
        self.assertNotIn('body:', expression)
        self.assertEqual(parameters['path'], CHECKOUT_PATH + '/' + ENTITY + '/' + SID)

    async def test_unknown_marker_never_authorizes_another_create(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atomic_json(checkout_record_path(root, credential().account_id), unknown_record())
            with AttemptLedger(root, credential().account_id, recover_unknown_checkout=True) as ledger:
                with self.assertRaises(Stop):ledger.begin()
                self.assertEqual(ledger.record, unknown_record())

    async def test_payment_or_confirmation_marker_disables_unknown_recovery(self):
        self.assertTrue(unknown_checkout_recoverable(unknown_record()))
        for changes in ({'payment_attempted': True}, {'confirmation_requests_sent': 1},
                        {'payment_evidence': {'kind': 'payment_intent'}}, {'account_matched': False},
                        {'checkout_requests_sent': 2}, {'manual_confirmation_accepted': True}):
            self.assertFalse(unknown_checkout_recoverable({**unknown_record(), **changes}))


class NativeBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtime = await async_playwright().start()
        self.browser = await self.runtime.chromium.launch(headless=True)
        self.context = await self.browser.new_context(service_workers='block')
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.target = parse_browser_credential(fixture())
        self.writes = []
        self.total, self.tax = 110000, 11786
        self.original_plan = 'chatgptplusplan'
        await self.context.route('**/*', self.server)

    async def asyncTearDown(self):
        await self.context.close()
        await self.browser.close()
        await self.runtime.stop()
        self.temp.cleanup()

    async def server(self, route):
        request, path = route.request, urlsplit(route.request.url).path
        if path == '/api/auth/session':
            return await route.fulfill(json=json.loads(fixture()))
        if path.startswith('/backend-api/accounts/'):
            return await route.fulfill(json=account())
        if path == CHECKOUT_PATH + '/' + ENTITY + '/' + SID:
            data = session();data['plan_name'] = self.original_plan
            return await route.fulfill(json=data)
        if path == CHECKOUT_PATH + '/taxes':
            self.writes.append(path)
            data = request.post_data_json
            address = data['billing_address']
            self.assertEqual(address['city'], 'Synthetic city')
            self.assertEqual(address['postal_code'], '97204')
            self.total, self.tax = 98214, 0
            response = session(due=self.total, tax=self.tax, address=address)
            return await route.fulfill(json={'checkout_session': response})
        if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
            self.writes.append(path)
            return await route.abort()
        if path == '/card-form':
            return await route.fulfill(content_type='text/html', body='''<input autocomplete="cc-number">
                <input autocomplete="cc-exp"><input autocomplete="cc-csc">''')
        if path == '/checkout/' + ENTITY + '/' + SID:
            headers = json.dumps({'content-type': 'application/json', 'authorization': 'Bearer ' + self.target.old_token})
            return await route.fulfill(content_type='text/html; charset=utf-8', body='''<h1>ChatGPT Plus</h1>
                <p>今日应付金额</p><p id="today">PHP 1100.00</p>
                <p>增值税 (VAT)</p><p id="tax">PHP 117.86</p>
                <p id="renew">将按 PHP 1100.00/月 收费。</p>
                <iframe src="https://js.stripe.com/card-form"></iframe>
                <select autocomplete="country"><option value="PH">PH</option><option value="US">US</option></select>
                <input autocomplete="name"><input autocomplete="email">
                <input autocomplete="address-line1"><input autocomplete="address-line2">
                <input autocomplete="address-level2">
                <select autocomplete="address-level1"><option value="OR">Oregon</option></select>
                <input autocomplete="postal-code" onblur="reprice()">
                <button type="submit">订阅</button>
                <script>async function reprice(){
                  const value=k=>document.querySelector('[autocomplete="'+k+'"]').value;
                  const data={checkout_session_id:'SID',processor_entity:'ENTITY',billing_name:value('name'),
                    billing_address:{country:value('country'),line1:value('address-line1'),line2:value('address-line2'),
                    city:value('address-level2'),state:value('address-level1'),postal_code:value('postal-code')}};
                  await fetch('TAX_PATH',{method:'POST',headers:HEADERS,body:JSON.stringify(data)});
                  document.querySelector('#today').textContent='PHP 982.14';
                  document.querySelector('#tax').textContent='PHP 0.00';
                  document.querySelector('#renew').textContent='将按 PHP 982.14/月 收费。';
                }</script>'''.replace('HEADERS', headers).replace('TAX_PATH', CHECKOUT_PATH+'/taxes')
                    .replace("'SID'", json.dumps(SID)).replace("'ENTITY'", json.dumps(ENTITY)))
        await route.abort()

    async def prepare_original(self, *, pay=False, confirmer=lambda *_: False):
        page = await self.context.new_page()
        original = 'https://chatgpt.com/checkout/' + ENTITY + '/' + SID
        await page.goto(original)
        atomic_json(checkout_record_path(self.root, self.target.account_id), unknown_record())
        async def prepare(active, guard, identity, _quote):
            with PaymentLedger(self.root, self.target.account_id, held_lock_fd=guard.ledger.fd) as ledger:
                guard.attach_payment_ledger(ledger)
                return await payment_handler(active, guard, identity, ledger, self.target, pay=pay,
                    details_reader=details, confirmer=confirmer, wait_seconds=0,
                    poll_count=0, poll_interval=0, quote_wait_seconds=3)
        with contextlib.redirect_stderr(io.StringIO()):
            result = await run_browser(self.target, inspect_existing=True, recover_unknown_checkout=True,
                state_dir=self.root, browser_context=self.context, quote_handler=prepare,
                guard_factory=lambda target, ledger: PaymentGuard(target, checkout_ledger=ledger))
        return page, result

    async def test_original_checkout_resumes_fills_all_fields_and_returns_recalculated_final_amount(self):
        page, result = await self.prepare_original()
        self.assertEqual(result.get('status'), 'payment_prepared', result)
        self.assertEqual(result['initial_quote']['today']['amount_minor'], 110000)
        self.assertEqual(result['quote']['today']['amount_minor'], 98214)
        self.assertEqual(result['quote']['tax']['amount_minor'], 0)
        self.assertEqual(result['quote_authority'], 'official_checkout_response')
        self.assertTrue(result['checkout_recovered_from_original'])
        self.assertEqual(page.url, 'https://chatgpt.com/checkout/' + ENTITY + '/' + SID)
        self.assertEqual(self.writes, [CHECKOUT_PATH+'/taxes'])
        self.assertEqual(result['payment_requests_sent'], 0)
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertFalse(list((self.root/'payments').glob('*.json')))

    async def test_confirmation_receives_only_repriced_amount_and_cancel_never_submits(self):
        seen = []
        def cancel(quote, _last4):
            seen.append(quote)
            return False
        _, result = await self.prepare_original(pay=True, confirmer=cancel)
        self.assertEqual(result['status'], 'payment_cancelled', result)
        self.assertEqual([q['today']['amount_minor'] for q in seen], [98214])
        self.assertEqual(self.writes, [CHECKOUT_PATH+'/taxes'])
        self.assertFalse(list((self.root/'payments').glob('*.json')))

    async def test_failed_discovery_retains_original_unknown_marker_and_window(self):
        self.original_plan = 'chatgptpro'
        page, result = await self.prepare_original()
        self.assertEqual(result['reason'], 'existing_checkout_unverified', result)
        record = json.loads(checkout_record_path(self.root, self.target.account_id).read_text())
        self.assertEqual(record, unknown_record())
        self.assertEqual(page.url, 'https://chatgpt.com/checkout/' + ENTITY + '/' + SID)
        self.assertEqual(self.writes, [])


if __name__ == '__main__':
    unittest.main()
