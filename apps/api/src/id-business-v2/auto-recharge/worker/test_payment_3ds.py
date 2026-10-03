"""原付款的 3DS 门禁；合成数据，浏览器所有请求均在本机截获。"""
import asyncio
import base64
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from urllib.parse import urlencode, urlsplit

from attempt_ledger import AttemptLedger
from checkout_core import ROOT, Stop, parse_browser_credential
from payment_3ds import ThreeDSAuthentication, https_origin
from payment_network import PaymentGuard
from payment_state import PaymentLedger, quote_digest
from test_subscribe import fixture


PROJECT = Path(__file__).resolve().parents[6]
OUTPUT = PROJECT / '.runtime/recharge-flow-completion-20261003/upgrade-async-final/fixtures-checkout'


def quote():
    today = {'currency': 'MYR', 'amount': '92.50', 'amount_minor': 9250}
    return {'plan': 'plus', 'today': today, 'tax': {'currency': 'MYR', 'amount': '0.00', 'amount_minor': 0},
            'renewal': today, 'renewal_interval': 'monthly'}


def intent(**updates):
    return {'id': 'pi_synthetic', 'object': 'payment_intent', 'status': 'requires_action',
            'amount': 9250, 'currency': 'myr', 'confirmation_method': 'automatic',
            'next_action': {'type': 'use_stripe_sdk', 'use_stripe_sdk': {
                'type': 'stripe_3ds2_fingerprint', 'three_d_secure_2_source': 'src_synthetic'}}, **updates}


def setup_intent(**updates):
    return {'id': 'seti_synthetic', 'object': 'setup_intent', 'status': 'requires_action',
            'next_action': {'type': 'use_stripe_sdk', 'use_stripe_sdk': {
                'type': 'stripe_3ds2_fingerprint', 'three_d_secure_2_source': 'src_setup'}}, **updates}


def encoded(data):
    return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip('=')


class Frame:
    def __init__(self, url='https://chatgpt.com/checkout/openai_ie/cs_synthetic', parent=None, actions=()):
        self.url, self.parent_frame, self.actions = url, parent, actions

    async def eval_on_selector_all(self, _selector, _script):
        return self.actions


class Request:
    def __init__(self, url, *, method='POST', data=None, frame=None, navigation=False, headers=None, previous=None):
        self.url, self.method, self.post_data = url, method, data
        self.frame, self.navigation = frame or Frame(), navigation
        self.headers, self.redirected_from = headers or {}, previous

    def is_navigation_request(self):
        return self.navigation

    @property
    def post_data_json(self):
        return json.loads(self.post_data)

    async def all_headers(self):
        return self.headers


class Route:
    def __init__(self, request):
        self.request, self.passed, self.blocked = request, False, False

    async def fallback(self):
        self.passed = True

    async def abort(self, *_args):
        self.blocked = True


class Response:
    def __init__(self, request, data=None, status=200, headers=None):
        self.request, self.url, self.status = request, request.url, status
        self.data, self.headers = data or {}, headers or {}

    async def body(self):
        return json.dumps(self.data).encode()

    async def all_headers(self):
        return self.headers


class Ledger:
    target_plan, checkout_id = 'plus', 'cs_synthetic'
    record = {'payment_attempted': True}

    def __init__(self):
        self.sent, self.observations = 0, []

    def mark_confirmation_sent(self):
        if self.sent:
            raise Stop('duplicate_payment_blocked')
        self.sent += 1

    def update(self, **values):
        self.observations.append(values)


class ThreeDSGuardTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.target = parse_browser_credential(fixture())
        self.guard = PaymentGuard(self.target, Ledger())
        self.guard.checkout_id, self.guard.account_verified = 'cs_synthetic', True
        self.guard.approve(quote())
        self.frame = Frame()

    async def confirm(self, data=None):
        request = Request('https://api.stripe.com/v1/payment_pages/cs_synthetic/confirm', data='{}', frame=self.frame)
        route = Route(request)
        await self.guard.route(route)
        self.assertTrue(route.passed)
        await self.guard.response(Response(request, {'payment_intent': intent() if data is None else data}))
        return request

    async def auth(self, *, source='src_synthetic', path='authenticate', frame=None, extra=None, headers=None):
        data = {'source': source, **(extra or {})}
        request = Request('https://api.stripe.com/v1/3ds2/' + path, data=urlencode(data),
                          frame=frame or self.frame, headers=headers)
        route = Route(request)
        await self.guard.route(route)
        return route

    async def test_frictionless_original_authentication_can_prove_paid(self):
        await self.confirm()
        route = await self.auth()
        self.assertTrue(route.passed)
        await self.guard.response(Response(route.request, {'source': 'src_synthetic',
            'payment_intent': intent(status='succeeded', amount_received=9250, next_action=None)}))
        self.assertEqual(self.guard.payment_state, 'paid')
        self.assertEqual(self.guard.three_ds.status, 'completed')
        self.assertEqual(self.guard.evidence['identifier'], 'pi_synthetic')
        self.assertEqual(self.guard.confirmation_sent, 1)

    async def test_authentication_not_allowed_before_original_confirm(self):
        route = await self.auth()
        self.assertTrue(route.blocked)
        self.assertFalse(self.guard.three_ds.active)

    async def test_explicit_origin_frame_is_exact_and_navigation_revokes_it(self):
        root = Frame('https://chatgpt.com/')
        auth = ThreeDSAuthentication(root)
        self.assertTrue(auth.frame_allowed(root, None))
        self.assertTrue(auth.frame_allowed(Frame('https://js.stripe.com/v3', parent=root), None))
        self.assertFalse(auth.frame_allowed(Frame('https://chatgpt.com/'), None))
        self.assertFalse(auth.frame_allowed(Frame('https://chatgpt.com/checkout/openai_ie/cs_synthetic'), 'cs_synthetic'))
        root.url = 'https://chatgpt.com/settings'
        self.assertFalse(auth.frame_allowed(root, None))
        evil = Frame('https://evil.invalid/')
        self.assertFalse(ThreeDSAuthentication(evil).frame_allowed(evil, None))

    async def test_closed_authentication_response_cannot_add_challenge(self):
        auth = ThreeDSAuthentication()
        self.assertTrue(auth.bind(intent(), 'pi_synthetic'))
        request = Request('https://api.stripe.com/v1/3ds2/authenticate')
        auth.requests[request] = '/v1/3ds2/authenticate'
        auth.close()
        self.assertTrue(auth.observe_authentication(request, {'source': 'src_synthetic', 'ares': {
            'acsURL': 'https://bank.example.com/acs', 'threeDSServerTransID': 'server-id',
            'acsTransID': 'acs-id'}}, allow_challenge=False))
        self.assertFalse(auth.active)
        self.assertFalse(auth.entries)
        self.assertEqual(auth.status, 'authenticating')

    async def test_late_same_fingerprint_does_not_rewind_ares_challenge(self):
        await self.confirm()
        auth = await self.auth()
        await self.guard.response(Response(auth.request, {'source': 'src_synthetic', 'ares': {
            'acsURL': 'https://bank.example.com/acs', 'threeDSServerTransID': 'server-id', 'acsTransID': 'acs-id'}}))
        linked = Request('https://api.stripe.com/v1/payment_intents/pi_synthetic', method='GET', frame=self.frame)
        await self.guard.response(Response(linked, intent()))
        self.assertEqual(self.guard.three_ds.status, 'awaiting_user')
        self.assertTrue((await self.auth(path='challenge_complete')).passed)
        self.assertEqual(self.guard.confirmation_sent, 1)

    async def test_closed_or_completed_authentication_cannot_rebind_or_regress(self):
        auth = ThreeDSAuthentication()
        self.assertTrue(auth.bind(intent(), 'pi_synthetic'))
        auth.close()
        self.assertFalse(auth.bind(intent(), 'pi_synthetic'))
        self.assertFalse(auth.active)
        auth.close('completed')
        self.assertFalse(auth.bind(intent(), 'pi_synthetic'))
        auth.close('failed')
        self.assertEqual(auth.status, 'completed')

    async def test_finish_during_header_inspection_blocks_reserved_authentication(self):
        await self.confirm()
        started, release = asyncio.Event(), asyncio.Event()
        request = Request('https://api.stripe.com/v1/3ds2/authenticate', data='source=src_synthetic', frame=self.frame)
        async def held_headers():
            started.set()
            await release.wait()
            return {}
        request.all_headers = held_headers
        route = Route(request)
        task = asyncio.create_task(self.guard.route(route))
        await started.wait()
        self.guard.finish_three_ds()
        release.set()
        await task
        self.assertTrue(route.blocked)
        self.assertFalse(route.passed)
        self.assertEqual(self.guard.three_ds.requests[request], '/v1/3ds2/authenticate')
        self.assertEqual(self.guard.confirmation_sent, 1)

    async def test_finish_during_form_inspection_blocks_original_issuer_submission(self):
        await self.confirm(intent(next_action={'type': 'redirect_to_url', 'redirect_to_url': {
            'url': 'https://bank.example.com/acs'}}))
        bank = Frame('https://bank.example.com/acs', self.frame)
        self.guard.three_ds.frames[bank] = 'https://bank.example.com'
        started, release = asyncio.Event(), asyncio.Event()
        async def held_forms(_selector, _script):
            started.set()
            await release.wait()
            return ['https://bank.example.com/verified']
        bank.eval_on_selector_all = held_forms
        request = Request('https://bank.example.com/verified', frame=bank, data='approved=synthetic')
        route = Route(request)
        task = asyncio.create_task(self.guard.route(route))
        await started.wait()
        self.guard.finish_three_ds()
        release.set()
        await task
        self.assertTrue(route.blocked)
        self.assertFalse(route.passed)
        self.assertIsNone(self.guard.evidence)

    async def test_close_during_redirect_headers_cannot_add_another_bank_entry(self):
        auth = ThreeDSAuthentication()
        self.assertTrue(auth.bind(intent(), 'pi_synthetic'))
        started, release = asyncio.Event(), asyncio.Event()
        request = Request('https://hooks.stripe.com/synthetic', method='GET', navigation=True)
        auth.requests[request] = 'navigation'
        response = Response(request, status=302)
        async def held_headers():
            started.set()
            await release.wait()
            return {'location': 'https://bank.example.com/acs'}
        response.all_headers = held_headers
        task = asyncio.create_task(auth.observe_redirect(response))
        await started.wait()
        auth.close()
        release.set()
        await task
        self.assertFalse(auth.entries)
        self.assertFalse(auth.frames)
        self.assertFalse(auth.active)

    async def test_only_same_source_and_original_intent(self):
        await self.confirm()
        for extra, source in [({}, 'src_other'), ({'payment_intent': 'pi_other'}, 'src_synthetic'),
                              ({'amount': '9250'}, 'src_synthetic'), ({'payment_method': 'pm_other'}, 'src_synthetic')]:
            with self.subTest(extra=extra, source=source):
                self.assertTrue((await self.auth(source=source, extra=extra)).blocked)
        self.assertTrue((await self.auth()).passed)

    async def test_repeated_authenticate_and_payment_writes_blocked(self):
        await self.confirm()
        self.assertTrue((await self.auth()).passed)
        self.assertTrue((await self.auth()).blocked)
        for path in ['/v1/payment_pages/cs_synthetic/confirm', '/v1/payment_pages/cs_other/confirm',
                     '/v1/payment_intents/pi_synthetic/confirm', '/v1/payment_methods', '/v1/tokens']:
            route = Route(Request('https://api.stripe.com' + path, data='{"type":"card"}'))
            await self.guard.route(route)
            self.assertTrue(route.blocked)
        self.assertEqual(self.guard.payment_ledger.sent, 1)
        self.assertEqual(self.guard.tokenization_sent, 0)

    async def test_wrong_response_intent_or_source_cannot_be_paid(self):
        for updates in [{'id': 'pi_other'}, {'source': 'src_other'}, {'session_id': 'cs_other'}]:
            with self.subTest(updates=updates):
                self.setUp()
                await self.confirm()
                route = await self.auth()
                paid = intent(status='succeeded', amount_received=9250, next_action=None)
                data = {'source': 'src_synthetic', 'payment_intent': paid}
                if 'id' in updates:
                    paid.update(updates)
                else:
                    data.update(updates)
                await self.guard.response(Response(route.request, data))
                self.assertIsNone(self.guard.evidence)
                self.assertEqual(self.guard.three_ds.status, 'failed')

    async def test_wrong_amount_or_currency_cannot_be_paid(self):
        for updates in [{'amount_received': 1}, {'currency': 'usd'}]:
            with self.subTest(updates=updates):
                self.setUp()
                await self.confirm()
                route = await self.auth()
                paid = intent(status='succeeded', amount_received=9250, next_action=None)
                paid.update(updates)
                await self.guard.response(Response(route.request, {'payment_intent': paid}))
                self.assertIsNone(self.guard.evidence)
                self.assertNotEqual(self.guard.payment_state, 'paid')

    async def test_wrong_action_amount_manual_or_unknown_shape_are_unsupported(self):
        for updates in [{'amount': 1}, {'currency': 'usd'}, {'confirmation_method': 'manual'},
                        {'next_action': {'type': 'use_stripe_sdk', 'use_stripe_sdk': {'type': 'new_unknown_sdk'}}}]:
            with self.subTest(updates=updates):
                self.setUp()
                await self.confirm(intent(**updates))
                self.assertEqual(self.guard.three_ds.status, 'unsupported')
                self.assertTrue((await self.auth()).blocked)

    async def test_session_header_cookie_or_body_cannot_escape(self):
        for headers, extra in [({'Cookie': '__Secure-next-auth.session-token=synthetic'}, {}),
                               ({'Authorization': 'Bearer ' + self.target.old_token}, {}),
                               ({'chatgpt-account-id': 'synthetic-account'}, {}),
                               ({}, {'browser': self.target.session_token})]:
            with self.subTest(headers=list(headers), extra=list(extra)):
                self.setUp()
                await self.confirm()
                self.assertTrue((await self.auth(headers=headers, extra=extra)).blocked)
        self.setUp()
        await self.confirm()
        self.assertTrue((await self.auth(headers={'Authorization': 'Bearer pk_test_synthetic'})).passed)

    async def test_unknown_frame_and_changed_bank_origin_blocked(self):
        await self.confirm()
        self.assertTrue((await self.auth(frame=Frame('https://evil.example.com/', self.frame))).blocked)
        bank = Frame('https://bank.example.com/acs', self.frame)
        self.guard.three_ds.frames[bank] = 'https://bank.example.com'
        bank.url = 'https://evil.example.com/'
        self.assertTrue((await self.auth(frame=bank)).blocked)
        stripe = Frame('https://js.stripe.com/v3/', self.frame)
        self.assertTrue((await self.auth(frame=stripe)).passed)

    async def test_unknown_external_navigation_without_server_callback_is_blocked(self):
        await self.confirm()
        self.guard.three_ds_ready.set()
        for frame, navigation in [(self.frame, True), (Frame('https://evil.example.com/', self.frame), False)]:
            route = Route(Request('https://evil.example.com/unknown', method='GET', frame=frame, navigation=navigation))
            await self.guard.route(route)
            self.assertTrue(route.blocked)

    async def test_only_dynamic_bank_url_and_visible_same_origin_form(self):
        await self.confirm(intent(next_action={'type': 'redirect_to_url', 'redirect_to_url': {
            'url': 'https://bank.example.com/acs'}}))
        bank = Frame('about:blank', self.frame)
        route = Route(Request('https://bank.example.com/acs', method='GET', frame=bank, navigation=True))
        await self.guard.route(route)
        self.assertTrue(route.passed)
        bank.url, bank.actions = 'https://bank.example.com/acs', ['https://bank.example.com/verify']
        for url, passed in [('https://bank.example.com/verify', True), ('https://bank.example.com/unknown', False),
                            ('https://evil.example.com/verify', False), ('https://bank.example.com/payments/charge', False)]:
            request = Request(url, frame=bank, data='approval=synthetic', navigation=True)
            route = Route(request)
            await self.guard.route(route)
            self.assertEqual(route.passed, passed)
        self.assertIsNone(self.guard.evidence)
        self.assertTrue(self.guard.three_ds.needs_user)

    async def test_safe_original_redirect_chain_can_bind_next_bank_origin(self):
        await self.confirm(intent(next_action={'type': 'redirect_to_url', 'redirect_to_url': {
            'url': 'https://hooks.stripe.com/3d_secure/synthetic'}}))
        bank = Frame('about:blank', self.frame)
        request = Request('https://hooks.stripe.com/3d_secure/synthetic', method='GET', frame=bank, navigation=True)
        route = Route(request)
        await self.guard.route(route)
        self.assertTrue(route.passed)
        bank.url = request.url
        response = Response(request, status=302, headers={'location': 'https://bank.example.com/acs'})
        request.response = lambda: asyncio.sleep(0, result=response)
        redirected = Route(Request('https://bank.example.com/acs', method='GET', frame=bank,
                                   navigation=True, previous=request))
        await self.guard.route(redirected)
        self.assertTrue(redirected.passed)

    async def test_method_and_challenge_post_are_bound_to_transaction_ids(self):
        sdk = {'type': 'stripe_3ds2_challenge', 'three_d_secure_2_source': 'src_synthetic',
               'server_transaction_id': 'server-synthetic', 'acs_transaction_id': 'acs-synthetic',
               'acs_url': 'https://bank.example.com/acs', 'three_ds_method_url': 'https://bank.example.com/method'}
        await self.confirm(intent(next_action={'type': 'use_stripe_sdk', 'use_stripe_sdk': sdk}))
        bank = Frame('about:blank', self.frame)
        for key, path, values in [('threeDSMethodData', 'method', {
                'threeDSServerTransID': 'server-synthetic', 'threeDSMethodNotificationURL': 'https://hooks.stripe.com/notify'}),
                ('creq', 'acs', {'threeDSServerTransID': 'server-synthetic', 'acsTransID': 'acs-synthetic',
                                'messageType': 'CReq', 'messageVersion': '2.2.0'})]:
            wrong = {**values, 'threeDSServerTransID': 'server-other'}
            route = Route(Request('https://bank.example.com/' + path, frame=bank, navigation=True,
                                  data=urlencode({key: encoded(wrong)})))
            await self.guard.route(route)
            self.assertTrue(route.blocked)
            route = Route(Request('https://bank.example.com/' + path, frame=bank, navigation=True,
                                  data=urlencode({key: encoded(values)})))
            await self.guard.route(route)
            self.assertTrue(route.passed)
            bank.url = route.request.url
        notify = Route(Request('https://hooks.stripe.com/notify', frame=bank, navigation=True,
                               data=urlencode({'threeDSMethodData': encoded({'threeDSServerTransID': 'server-synthetic'})})))
        await self.guard.route(notify)
        self.assertTrue(notify.passed)

    async def test_official_ares_can_bind_challenge_and_complete_once(self):
        await self.confirm()
        auth = await self.auth()
        await self.guard.response(Response(auth.request, {'source': 'src_synthetic', 'ares': {
            'acsURL': 'https://bank.example.com/acs', 'threeDSServerTransID': 'server-synthetic',
            'acsTransID': 'acs-synthetic'}}))
        self.assertTrue(self.guard.three_ds.needs_user)
        self.assertEqual(self.guard.three_ds.entries['https://bank.example.com/acs'], 'challenge')
        complete = await self.auth(path='challenge_complete')
        self.assertTrue(complete.passed)
        self.assertTrue((await self.auth(path='challenge_complete')).blocked)

    async def test_authentication_failure_has_no_paid_claim_or_new_payment(self):
        await self.confirm()
        auth = await self.auth()
        await self.guard.response(Response(auth.request, {'state': 'failed'}, status=402))
        self.assertEqual(self.guard.three_ds.status, 'failed')
        self.assertEqual(self.guard.payment_error, 'three_ds_authentication_failed')
        self.assertIsNone(self.guard.evidence)
        self.assertTrue((await self.auth()).blocked)
        self.assertEqual(self.guard.confirmation_sent, 1)

    async def test_readonly_and_finished_flow_cannot_reactivate(self):
        for readonly in [True, False]:
            with self.subTest(readonly=readonly):
                self.setUp()
                await self.confirm()
                if readonly:
                    self.guard.read_only = True
                else:
                    self.guard.finish_three_ds()
                read = Request('https://api.stripe.com/v1/payment_intents/pi_synthetic', method='GET')
                await self.guard.response(Response(read, intent()))
                self.assertTrue((await self.auth()).blocked)
                if not readonly:
                    self.assertFalse(self.guard.three_ds.active)

    async def test_confirm_observer_race_holds_original_authentication(self):
        request = Request('https://api.stripe.com/v1/payment_pages/cs_synthetic/confirm', data='{}')
        route = Route(request)
        await self.guard.route(route)
        pending = asyncio.create_task(self.auth())
        await asyncio.sleep(.01)
        self.assertFalse(pending.done())
        await self.guard.response(Response(request, {'payment_intent': intent()}))
        self.assertTrue((await pending).passed)

    async def test_expired_authority_and_secret_free_summary(self):
        await self.confirm()
        self.guard.three_ds.deadline = 0
        self.assertTrue((await self.auth()).blocked)
        self.assertEqual(self.guard.three_ds.status, 'failed')
        summary = json.dumps(self.guard.summary())
        for secret in [self.target.old_token, self.target.session_token, 'src_synthetic']:
            self.assertNotIn(secret, summary)

    def test_invalid_or_privileged_authentication_urls_rejected(self):
        for url in ['http://bank.example.com/acs', 'https://127.0.0.1/acs', 'https://[::1]/acs',
                    'https://bank.local/acs', 'https://user:password@bank.example.com/acs',
                    'https://bank.example.com:444/acs', 'https://bank.example.com/acs#fragment',
                    'https://api.stripe.com/v1/payment_pages/cs_synthetic/confirm', 'https://chatgpt.com/backend-api/payments/checkout']:
            with self.subTest(url=url):
                auth = ThreeDSAuthentication()
                self.assertFalse(auth.bind(intent(next_action={'type': 'redirect_to_url',
                    'redirect_to_url': {'url': url}}), 'pi_synthetic'))
        self.assertEqual(https_origin('https://bank.example.com/acs'), 'https://bank.example.com')


class SetupIntentAuthenticationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.target = parse_browser_credential(fixture())
        self.frame = Frame('https://chatgpt.com/')
        self.auth = ThreeDSAuthentication(self.frame, intent_kind='setup_intent')

    def bind(self):
        self.assertTrue(self.auth.bind(setup_intent(), 'seti_synthetic'))

    async def request(self, *, data=None, path='authenticate', frame=None):
        request = Request('https://api.stripe.com/v1/3ds2/' + path, frame=frame or self.frame,
                          data=urlencode(data or {'source': 'src_setup', 'setup_intent': 'seti_synthetic'}))
        return request, await self.auth.decision(request, self.target, None)

    def test_setup_binding_has_no_payment_amount_or_evidence(self):
        self.bind()
        self.assertEqual(self.auth.intent_kind, 'setup_intent')
        self.assertEqual(self.auth.intent_id, 'seti_synthetic')
        self.assertEqual(self.auth.status, 'authenticating')
        self.assertFalse(hasattr(self.auth, 'evidence'))
        self.assertNotIn('amount', setup_intent())

    def test_unknown_authentication_intent_kind_is_rejected(self):
        with self.assertRaises(ValueError):
            ThreeDSAuthentication(intent_kind='unknown_intent')

    def test_setup_binding_rejects_payment_kind_ref_and_mixed_object(self):
        cases = [(intent(), 'pi_synthetic'), (setup_intent(id='pi_synthetic'), 'pi_synthetic'),
                 (setup_intent(object='payment_intent'), 'seti_synthetic'),
                 (setup_intent(payment_intent=intent()), 'seti_synthetic'),
                 (setup_intent(id='seti_other'), 'seti_synthetic'),
                 (setup_intent(status='succeeded'), 'seti_synthetic')]
        for data, expected_id in cases:
            with self.subTest(data=data, expected_id=expected_id):
                auth = ThreeDSAuthentication(self.frame, intent_kind='setup_intent')
                self.assertFalse(auth.bind(data, expected_id))
                self.assertTrue(auth.closed)
                self.assertFalse(auth.active)

    async def test_setup_original_authentication_and_single_request_reservation(self):
        self.bind()
        request, allowed = await self.request()
        self.assertTrue(allowed)
        self.assertEqual(self.auth.requests[request], '/v1/3ds2/authenticate')
        self.assertFalse((await self.request())[1])
        self.assertTrue(self.auth.observe_authentication(request, {
            'source': 'src_setup', 'setup_intent': setup_intent(status='succeeded', next_action=None)}))
        self.assertEqual(self.auth.intent_id, 'seti_synthetic')
        self.assertFalse(hasattr(self.auth, 'evidence'))

    async def test_setup_authentication_rejects_wrong_or_mixed_request_fields(self):
        self.bind()
        for data in [{'source': 'src_other'}, {'source': 'src_setup', 'setup_intent': 'seti_other'},
                     {'source': 'src_setup', 'payment_intent': 'pi_synthetic'},
                     {'source': 'src_setup', 'payment_intent': 'seti_synthetic'},
                     {'source': 'src_setup', 'setup_intent[id]': 'seti_synthetic'},
                     {'source': 'src_setup', 'amount': '0'}, {'source': 'src_setup', 'card[number]': 'synthetic'},
                     {'source': 'src_setup', 'payment_method': 'pm_other'}]:
            with self.subTest(data=data):
                self.assertFalse((await self.request(data=data))[1])
        self.assertFalse(self.auth.requests)
        self.assertTrue((await self.request())[1])

    async def test_setup_response_rejects_wrong_kind_ref_source_or_mixed_intent(self):
        cases = [{'object': 'payment_intent', 'id': 'pi_synthetic'}, {'payment_intent': intent()},
                 {'setup_intent': setup_intent(id='seti_other')},
                 {'setup_intent': setup_intent(object='payment_intent')},
                 {'setup_intent': setup_intent(), 'payment_intent': None},
                 {'setup_intent': setup_intent(payment_intent=intent())},
                 {'setup_intent': None}, {'source': 'src_other'}, {'source': {}}, None]
        for data in cases:
            with self.subTest(data=data):
                self.setUp()
                self.bind()
                request, allowed = await self.request()
                self.assertTrue(allowed)
                self.assertFalse(self.auth.observe_authentication(request, data))
                self.assertEqual(self.auth.status, 'failed')
                self.assertTrue(self.auth.closed)

    async def test_setup_root_response_and_same_source_are_recognized(self):
        self.bind()
        request, allowed = await self.request()
        self.assertTrue(allowed)
        self.assertTrue(self.auth.observe_authentication(request, setup_intent(status='succeeded', next_action=None)))
        self.assertFalse(self.auth.observe_authentication(Request(request.url), setup_intent()))

    async def test_setup_challenge_is_bound_and_late_fingerprint_cannot_regress(self):
        self.bind()
        request, allowed = await self.request()
        self.assertTrue(allowed)
        self.assertTrue(self.auth.observe_authentication(request, {'source': {'id': 'src_setup'}, 'ares': {
            'acsURL': 'https://bank.example.com/acs', 'threeDSServerTransID': 'server-setup',
            'acsTransID': 'acs-setup'}}))
        self.assertTrue(self.auth.needs_user)
        self.assertTrue(self.auth.bind(setup_intent(), 'seti_synthetic'))
        self.assertTrue(self.auth.needs_user)
        complete, allowed = await self.request(path='challenge_complete')
        self.assertTrue(allowed)
        self.assertTrue(self.auth.observe_authentication(complete, {'source': 'src_setup',
            'setup_intent': setup_intent(status='succeeded', next_action=None)}))
        self.auth.close('completed')
        self.assertFalse(self.auth.bind(setup_intent(), 'seti_synthetic'))
        self.assertFalse((await self.request(path='challenge_complete'))[1])
        self.auth.close('failed')
        self.assertEqual(self.auth.status, 'completed')

    async def test_setup_close_during_headers_blocks_in_flight_authentication(self):
        self.bind()
        started, release = asyncio.Event(), asyncio.Event()
        request = Request('https://api.stripe.com/v1/3ds2/authenticate', frame=self.frame,
                          data='source=src_setup&setup_intent=seti_synthetic')
        async def held_headers():
            started.set()
            await release.wait()
            return {}
        request.all_headers = held_headers
        pending = asyncio.create_task(self.auth.decision(request, self.target, None))
        await started.wait()
        self.auth.close()
        release.set()
        self.assertFalse(await pending)
        self.assertTrue(self.auth.closed)
        self.assertFalse(self.auth.active)

    async def test_setup_closed_response_cannot_reopen_bank_entries(self):
        self.bind()
        request, allowed = await self.request()
        self.assertTrue(allowed)
        self.auth.close()
        self.assertTrue(self.auth.observe_authentication(request, {'source': 'src_setup', 'ares': {
            'acsURL': 'https://bank.example.com/acs', 'threeDSServerTransID': 'server-setup',
            'acsTransID': 'acs-setup'}}))
        self.assertFalse(self.auth.entries)
        self.assertFalse(self.auth.active)
        self.assertFalse(self.auth.bind(setup_intent(), 'seti_synthetic'))

    async def test_default_payment_authentication_rejects_setup_fields_and_response(self):
        self.auth = ThreeDSAuthentication(self.frame)
        self.assertTrue(self.auth.bind(intent(), 'pi_synthetic'))
        self.assertFalse((await self.request(data={'source': 'src_synthetic', 'setup_intent': 'seti_synthetic'}))[1])
        request, allowed = await self.request(data={'source': 'src_synthetic', 'payment_intent': 'pi_synthetic'})
        self.assertTrue(allowed)
        self.assertFalse(self.auth.observe_authentication(request, {'setup_intent': setup_intent()}))
        self.assertEqual(self.auth.status, 'failed')


@unittest.skipUnless(os.environ.get('V2_PAYMENT_3DS_BROWSER_TEST') == '1', '本地浏览器夹具需显式启用')
class ThreeDSBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from playwright.async_api import async_playwright
        os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', str(ROOT / '.browsers'))
        self.driver = await async_playwright().start()
        if os.environ.get('V2_REGISTRATION_FINGERPRINT_BINARY'):
            from fingerprint_runtime import launch_fingerprint_browser
            self.browser = await launch_fingerprint_browser(self.driver, headless=True,
                executable_path=os.environ['V2_REGISTRATION_FINGERPRINT_BINARY'])
        else:
            self.browser = await self.driver.chromium.launch(headless=True)
        self.context = await self.browser.new_context(service_workers='block', accept_downloads=False)
        self.context.set_default_timeout(5000)
        OUTPUT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=OUTPUT)
        root = Path(self.temp.name) / 'state'
        self.target = parse_browser_credential(fixture())
        with AttemptLedger(root, self.target.account_id) as checkout:
            checkout.begin()
            checkout.finish({'checkout_identifier': 'cs_synthetic', 'processor_entity': 'openai_ie',
                             'returned_currency': 'MYR', 'checkout_outcome': 'created'})
        self.ledger = PaymentLedger(root, self.target.account_id).__enter__()
        self.ledger.begin(quote(), confirmed_digest=quote_digest(quote()), card_last4='4242')
        self.guard = PaymentGuard(self.target, self.ledger)
        self.guard.checkout_id, self.guard.account_verified = 'cs_synthetic', True
        self.guard.approve(quote())
        self.counts = {'confirm': 0, 'authenticate': 0, 'issuer': 0, 'complete': 0, 'unexpected': 0}
        self.mode, self.errors, self.tasks = 'frictionless', [], []
        await self.context.route('**/*', self.server)
        await self.context.route('**/*', self.guard.route)
        self.context.on('response', lambda response: self.tasks.append(asyncio.create_task(self.guard.response(response))))
        self.page = await self.context.new_page()
        self.page.on('pageerror', lambda _error: self.errors.append('page_error'))

    async def asyncTearDown(self):
        await self.context.close()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.browser.close()
        await self.driver.stop()
        self.ledger.__exit__()
        self.temp.cleanup()

    async def server(self, route):
        request = route.request
        p = urlsplit(request.url)
        cors = {'Access-Control-Allow-Origin': 'https://chatgpt.com', 'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'}
        if request.method == 'OPTIONS':
            return await route.fulfill(status=204, headers=cors)
        if p.hostname == 'chatgpt.com' and p.path.endswith('/cs_synthetic'):
            await route.fulfill(content_type='text/html; charset=utf-8', body='''<!doctype html><meta charset="utf-8"><button id="start">原付款一次确认</button>
                <output id="status"></output><div id="bank"></div><script>
                const api = 'https://api.stripe.com/v1/';
                const post = async (path, body) => (await fetch(api+path, {method:'POST',
                    headers:{'Content-Type':'application/x-www-form-urlencoded'}, body})).json();
                document.querySelector('#start').onclick = async () => {
                    try {
                        await post('payment_pages/cs_synthetic/confirm', 'original=synthetic');
                        const result = await post('3ds2/authenticate', 'source=src_synthetic');
                        if (result.ares) {
                            const f=document.createElement('iframe'); f.name='bank'; f.id='challenge';
                            document.querySelector('#bank').appendChild(f); f.src=result.ares.acsURL;
                            document.querySelector('#status').textContent='awaiting_user';
                        } else document.querySelector('#status').textContent='paid';
                    } catch (_error) { document.querySelector('#status').textContent='blocked'; }
                };
                window.addEventListener('message', async event => {
                    if (event.origin !== 'https://bank.example.com' || event.data !== 'synthetic-user-finished') return;
                    const result=await post('3ds2/challenge_complete', 'source=src_synthetic');
                    document.querySelector('#status').textContent=result.payment_intent?.status || 'unknown';
                });</script>''')
        elif p.path == '/v1/payment_pages/cs_synthetic/confirm':
            self.counts['confirm'] += 1
            self.assertEqual(json.loads(self.ledger.path.read_text())['confirmation_requests_sent'], 1)
            await route.fulfill(json={'payment_intent': intent()}, headers=cors)
        elif p.path == '/v1/3ds2/authenticate':
            self.counts['authenticate'] += 1
            data = {'source': 'src_synthetic'}
            if self.mode == 'challenge':
                data['ares'] = {'acsURL': 'https://bank.example.com/acs',
                                'threeDSServerTransID': 'server-synthetic', 'acsTransID': 'acs-synthetic'}
            else:
                data['payment_intent'] = intent(status='succeeded', amount_received=9250, next_action=None)
            await route.fulfill(json=data, headers=cors)
        elif p.hostname == 'bank.example.com' and p.path == '/acs' and request.method == 'GET':
            await route.fulfill(content_type='text/html; charset=utf-8', body='''<!doctype html><meta charset="utf-8"><form method="post" action="/verify">
                <button type="submit" name="approved" value="synthetic">本人完成合成验证</button></form>''')
        elif p.hostname == 'bank.example.com' and p.path == '/verify' and request.method == 'POST':
            self.counts['issuer'] += 1
            await route.fulfill(content_type='text/html; charset=utf-8', body='''<!doctype html><meta charset="utf-8"><p>合成验证已完成</p>
                <script>parent.postMessage('synthetic-user-finished','https://chatgpt.com');</script>''')
        elif p.path == '/v1/3ds2/challenge_complete':
            self.counts['complete'] += 1
            await route.fulfill(json={'source': 'src_synthetic', 'payment_intent': intent(
                status='succeeded', amount_received=9250, next_action=None)}, headers=cors)
        else:
            self.counts['unexpected'] += 1
            await route.abort('blockedbyclient')

    async def start(self, mode):
        self.mode = mode
        await self.page.goto('https://chatgpt.com/checkout/openai_ie/cs_synthetic')
        await self.page.locator('#start').click()

    async def test_original_frictionless_authentication_then_official_paid(self):
        await self.start('frictionless')
        await self.page.wait_for_function("document.querySelector('#status').textContent === 'paid'")
        await asyncio.wait_for(self.guard.payment_done.wait(), timeout=5)
        if self.tasks:
            await asyncio.gather(*self.tasks)
        self.assertEqual(self.guard.payment_state, 'paid')
        self.assertEqual(self.guard.three_ds.status, 'completed')
        self.assertEqual(self.counts, {'confirm': 1, 'authenticate': 1, 'issuer': 0, 'complete': 0, 'unexpected': 0})
        self.assertEqual(self.errors, [])

    async def test_bank_iframe_and_user_form_then_same_intent_completed(self):
        await self.start('challenge')
        await self.page.wait_for_function("document.querySelector('#status').textContent === 'awaiting_user'")
        self.assertTrue(self.guard.three_ds.needs_user)
        self.assertIsNone(self.guard.evidence)
        bank_button = self.page.frame_locator('#challenge').locator('button')
        await bank_button.wait_for()
        button_text = await bank_button.inner_text()
        if button_text != '本人完成合成验证':
            (OUTPUT / 'first-bank-button-encoding.json').write_text(json.dumps({
                'fixture_button_matches': False, 'observed_code_points': [ord(value) for value in button_text]},
                ensure_ascii=True) + '\n')
        self.assertEqual(button_text, '本人完成合成验证')
        await self.page.frame_locator('#challenge').get_by_role('button', name='本人完成合成验证').click()
        await self.page.wait_for_function("document.querySelector('#status').textContent === 'succeeded'")
        if self.tasks:
            await asyncio.gather(*self.tasks)
        self.assertEqual(self.guard.payment_state, 'paid')
        self.assertEqual(self.guard.evidence['identifier'], 'pi_synthetic')
        self.assertEqual(self.counts, {'confirm': 1, 'authenticate': 1, 'issuer': 1, 'complete': 1, 'unexpected': 0})
        self.assertEqual(self.errors, [])

    async def test_finished_challenge_blocks_repayment_and_unknown_issuer_post(self):
        await self.start('challenge')
        await self.page.wait_for_function("document.querySelector('#status').textContent === 'awaiting_user'")
        for path in ['payment_pages/cs_synthetic/confirm', 'payment_pages/cs_other/confirm', 'payment_methods',
                     '3ds2/authenticate']:
            blocked = await self.page.evaluate('''async path => {
                try { await fetch('https://api.stripe.com/v1/'+path, {method:'POST',
                    headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'source=src_synthetic&type=card'});
                    return false; } catch (_error) { return true; }
            }''', path)
            self.assertTrue(blocked)
        frame = self.page.frame_locator('#challenge')
        await frame.locator('form').wait_for()
        bank = next(item for item in self.page.frames if item.url == 'https://bank.example.com/acs')
        self.assertTrue(await bank.evaluate('''async () => {
            try { await fetch('/unknown', {method:'POST', body:'synthetic=1'}); return false; }
            catch (_error) { return true; }
        }'''))
        self.guard.finish_three_ds()
        self.assertFalse(self.guard.three_ds.active)
        self.assertEqual(self.counts, {'confirm': 1, 'authenticate': 1, 'issuer': 0, 'complete': 0, 'unexpected': 0})
        self.assertIsNone(self.guard.evidence)


if __name__ == '__main__':
    unittest.main()
