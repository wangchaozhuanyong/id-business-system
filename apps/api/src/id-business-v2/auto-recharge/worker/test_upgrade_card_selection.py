"""Authorized replacement-card fixtures. All browser requests are fulfilled locally."""
import asyncio
import json
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import urlencode, urlsplit

from playwright.async_api import async_playwright

from checkout_core import Stop, parse_browser_credential, parse_credential
from payment_form import validate_details
from test_payment import details
from test_payment_3ds import Frame, Request, Response
from test_subscribe import fixture
from upgrade_card_network import BASE, UpgradeCardChange, method_matches_card
from upgrade_card_selection import matching_methods, prepare_upgrade_card, verify_selected_upgrade_card


def method(identifier='pm_New', **card):
    return {'id': identifier, 'type': 'card', 'card': {'last4': '4242', 'exp_month': 12, 'exp_year': 2039, **card}}


class CardNetworkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.target = parse_browser_credential(fixture())
        self.frame = Frame('https://chatgpt.com/')
        self.stripe = Frame('https://js.stripe.com/card', parent=self.frame)
        self.guard = UpgradeCardChange(self.target, self.frame)
        self.details = validate_details(details())
        self.guard.arm(self.details)
        self.addCleanup(self.guard.close)

    def native(self, path=BASE, **values):
        body = {'account_id': self.target.account_id, 'caller_surface': 'plan_management', **values}
        return Request('https://chatgpt.com' + path, frame=self.frame, data=json.dumps(body),
                       headers={'authorization': 'Bearer ' + self.target.old_token})

    def stripe_request(self, path, **values):
        return Request('https://api.stripe.com' + path, frame=self.stripe, data=urlencode(values))

    async def accept(self, request, data):
        self.assertTrue(await self.guard.decision(request))
        await self.guard.response(Response(request, data))
        self.assertIsNone(self.guard.error)

    async def legacy(self):
        await self.accept(self.native(), {'client_secret': 'seti_Synthetic_secret_temporary'})
        self.guard.authorize_submit()
        await self.accept(self.stripe_request('/v1/payment_methods', type='card'), method())

    async def token(self):
        self.guard.authorize_submit()
        await self.accept(self.stripe_request('/v1/confirmation_tokens', **{'payment_method_data[type]': 'card'}),
                          {'id': 'ctoken_Synthetic', 'payment_method_preview': method()})

    async def test_legacy_new_card_finalizes_canonical_different_pm_without_charging(self):
        await self.legacy()
        await self.accept(self.stripe_request('/v1/setup_intents/seti_Synthetic/confirm',
            client_secret='seti_Synthetic_secret_temporary', payment_method='pm_New'),
            {'object': 'setup_intent', 'id': 'seti_Synthetic', 'status': 'succeeded', 'payment_method': 'pm_New'})
        await self.accept(self.native(BASE + '/pm_New/finalize', setup_intent_id='seti_Synthetic'),
                          {'canonical_payment_method_id': 'pm_Canonical', 'status': 'added'})
        self.assertEqual(self.guard.method_id, 'pm_Canonical')
        self.assertEqual(self.guard.native_confirms, 0)

    async def test_confirmation_token_binds_authorized_card_and_native_selected_pm(self):
        await self.token()
        await self.accept(self.native(BASE + '/confirm', confirmation_token_id='ctoken_Synthetic'),
                          {'status': 'succeeded', 'payment_method_id': 'pm_New', 'finalization_status': 'added'})
        self.assertEqual(self.guard.method_id, 'pm_New')
        self.assertFalse(self.guard.setup_succeeded)

    async def test_token_preview_missing_or_wrong_card_stops_before_native_confirm(self):
        for preview in (None, method(last4='9999'), method(exp_year=2040), {'type': 'bank_account'}):
            with self.subTest(preview=preview):
                guard = UpgradeCardChange(self.target, self.frame)
                guard.arm(self.details)
                guard.authorize_submit()
                request = self.stripe_request('/v1/confirmation_tokens', type='card')
                self.assertTrue(await guard.decision(request))
                await guard.response(Response(request, {'id': 'ctoken_Synthetic', 'payment_method_preview': preview}))
                self.assertTrue(guard.closed)
                self.assertIsNone(guard.method_id)
                self.assertFalse(await guard.decision(self.native(BASE + '/confirm', confirmation_token_id='ctoken_Synthetic')))

    async def test_card_request_wrong_pan_expiry_or_cvc_is_blocked(self):
        self.guard.authorize_submit()
        for values in ({'card[number]': '4000000000000002'}, {'card[exp_month]': '1'},
                       {'card[exp_year]': '2040'}, {'card[cvc]': '999'}, {'amount': '0'},
                       {'payment_method_data[type]': 'bank_account'}):
            self.assertFalse(await self.guard.decision(self.stripe_request('/v1/confirmation_tokens', **values)))
        self.assertFalse(self.guard.reserved)

    async def test_setup_creation_account_caller_and_frame_are_exact(self):
        for request in (self.native(account_id='other'), self.native(caller_surface='billing_settings'),
                        self.native(extra='unexpected')):
            self.assertFalse(await self.guard.decision(request))
        foreign = self.native()
        foreign.frame = Frame('https://chatgpt.com/')
        self.assertFalse(await self.guard.decision(foreign))
        request = self.native()
        request.headers['authorization'] = 'Bearer invalid'
        self.assertFalse(await self.guard.decision(request))
        self.assertFalse(self.guard.reserved)

    async def test_original_frame_navigation_invalidates_new_card(self):
        self.frame.url = 'https://chatgpt.com/other'
        self.assertFalse(await self.guard.decision(self.native()))
        self.guard.authorize_submit()
        self.assertFalse(await self.guard.decision(self.stripe_request('/v1/confirmation_tokens', type='card')))

    async def test_legacy_setup_confirmation_secret_method_and_money_are_bound(self):
        await self.legacy()
        for values in ({'client_secret': 'seti_Other_secret_synthetic', 'payment_method': 'pm_New'},
                       {'client_secret': 'seti_Synthetic_secret_temporary', 'payment_method': 'pm_Other'},
                       {'client_secret': 'seti_Synthetic_secret_temporary', 'amount': '100'}):
            self.assertFalse(await self.guard.decision(self.stripe_request('/v1/setup_intents/seti_Synthetic/confirm', **values)))
        self.assertFalse(await self.guard.decision(self.stripe_request('/v1/setup_intents/seti_Other/confirm',
            client_secret='seti_Other_secret_synthetic', payment_method='pm_New')))

    async def test_charge_default_new_checkout_and_extra_setup_paths_remain_blocked(self):
        await self.legacy()
        for path in ('/v1/payment_intents/pi_Other/confirm', '/v1/tokens', '/v1/charges',
                     '/v1/payment_pages/cs_Other/confirm', '/v1/setup_intents/seti_Other/confirm'):
            self.assertFalse(await self.guard.decision(self.stripe_request(path, type='card')))
        self.assertFalse(await self.guard.decision(self.native(BASE + '/default', payment_method_id='pm_New')))
        self.assertFalse(await self.guard.decision(self.native(BASE + '/backup', enabled=True)))

    async def test_duplicate_token_requests_reserve_before_header_await(self):
        self.guard.authorize_submit()
        entered, release = asyncio.Event(), asyncio.Event()
        async def headers(*_args):
            entered.set()
            await release.wait()
            return True
        with patch.object(self.guard.auth, 'safe_headers', side_effect=headers):
            first = asyncio.create_task(self.guard.decision(self.stripe_request('/v1/confirmation_tokens', type='card')))
            await entered.wait()
            self.assertFalse(await self.guard.decision(self.stripe_request('/v1/confirmation_tokens', type='card')))
            release.set()
            self.assertTrue(await first)

    async def test_closed_during_header_await_cannot_send(self):
        self.guard.authorize_submit()
        entered, release = asyncio.Event(), asyncio.Event()
        async def headers(*_args):
            entered.set()
            await release.wait()
            return True
        with patch.object(self.guard.auth, 'safe_headers', side_effect=headers):
            task = asyncio.create_task(self.guard.decision(self.stripe_request('/v1/confirmation_tokens', type='card')))
            await entered.wait()
            self.guard.close()
            release.set()
            self.assertFalse(await task)

    async def test_stripe_account_token_leak_is_blocked(self):
        self.guard.authorize_submit()
        request = self.stripe_request('/v1/confirmation_tokens', type='card')
        request.headers = {'authorization': 'Bearer ' + self.target.old_token}
        self.assertFalse(await self.guard.decision(request))

    async def test_readonly_or_closed_never_opens_card_changes(self):
        for guard in (UpgradeCardChange(self.target, self.frame, read_only=True), self.guard):
            if not guard.read_only:
                guard.method_id = 'pm_New'
                guard.close()
            with self.assertRaises(Stop):
                guard.arm(self.details)
            for request in (self.native(), self.stripe_request('/v1/confirmation_tokens', type='card')):
                self.assertFalse(await guard.decision(request))
        self.assertEqual(self.guard.method_id, 'pm_New')
        self.assertIsNone(self.guard.details)
        self.assertIsNone(self.guard.setup_secret)
        self.assertIsNone(self.guard.token_id)

    async def test_failed_setup_or_payment_intent_response_does_not_finalize(self):
        await self.legacy()
        request = self.stripe_request('/v1/setup_intents/seti_Synthetic/confirm',
            client_secret='seti_Synthetic_secret_temporary', payment_method='pm_New')
        self.assertTrue(await self.guard.decision(request))
        await self.guard.response(Response(request, {'object': 'payment_intent', 'id': 'pi_Charge', 'status': 'succeeded'}))
        self.assertTrue(self.guard.closed)
        self.assertFalse(self.guard.setup_succeeded)
        self.assertIsNone(self.guard.method_id)

    async def test_token_cannot_be_reconfirmed_without_original_setup_succeeded(self):
        await self.token()
        await self.accept(self.native(BASE + '/confirm', confirmation_token_id='ctoken_Synthetic'),
                          {'status': 'requires_action', 'client_secret': 'seti_Synthetic_secret_temporary'})
        self.assertFalse(await self.guard.decision(self.native(BASE + '/confirm', confirmation_token_id='ctoken_Synthetic')))
        self.assertFalse(await self.guard.decision(self.native(BASE + '/confirm', confirmation_token_id='ctoken_Other')))
        self.guard.observe_setup({'object': 'setup_intent', 'id': 'seti_Synthetic', 'status': 'succeeded', 'payment_method': 'pm_New'})
        await self.accept(self.native(BASE + '/confirm', confirmation_token_id='ctoken_Synthetic'),
                          {'status': 'succeeded', 'payment_method_id': 'pm_New', 'finalization_status': 'added'})
        self.assertFalse(await self.guard.decision(self.native(BASE + '/confirm', confirmation_token_id='ctoken_Synthetic')))

    async def test_original_setup_authentication_resumes_only_same_confirmation_token(self):
        await self.token()
        await self.accept(self.native(BASE + '/confirm', confirmation_token_id='ctoken_Synthetic'),
                          {'status': 'requires_action', 'client_secret': 'seti_Synthetic_secret_temporary'})
        read = Request('https://api.stripe.com/v1/setup_intents/seti_Synthetic', method='GET', frame=self.stripe)
        await self.accept(read, {'id': 'seti_Synthetic', 'object': 'setup_intent', 'status': 'requires_action',
            'payment_method': 'pm_New', 'client_secret': 'seti_Synthetic_secret_temporary',
            'next_action': {'type': 'use_stripe_sdk', 'use_stripe_sdk': {
                'type': 'stripe_3ds2_fingerprint', 'three_d_secure_2_source': 'src_setup'}}})
        authenticate = self.stripe_request('/v1/3ds2/authenticate', source='src_setup', setup_intent='seti_Synthetic')
        await self.accept(authenticate, {'source': 'src_setup', 'state': 'succeeded', 'setup_intent': {
            'object': 'setup_intent', 'id': 'seti_Synthetic', 'status': 'succeeded', 'payment_method': 'pm_New'}})
        self.assertTrue(self.guard.setup_succeeded)
        self.assertEqual(self.guard.auth.status, 'completed')
        await self.accept(self.native(BASE + '/confirm', confirmation_token_id='ctoken_Synthetic'),
                          {'status': 'succeeded', 'payment_method_id': 'pm_New'})
        self.assertEqual(self.guard.method_id, 'pm_New')

    async def test_closed_card_gate_leaves_original_upgrade_authentication_to_upgrade_guard(self):
        self.guard.close()
        self.assertIsNone(await self.guard.decision(self.stripe_request('/v1/3ds2/authenticate', source='src_upgrade')))
        self.assertIsNone(await self.guard.decision(self.stripe_request('/v1/payment_intents/pi_Upgrade/confirm')))
        self.assertFalse(await self.guard.decision(self.stripe_request('/v1/setup_intents/seti_Synthetic/confirm')))

    async def test_missing_origin_frame_has_no_add_card_authority(self):
        guard = UpgradeCardChange(self.target, None)
        with self.assertRaises(Stop):
            guard.arm(self.details)
        self.assertFalse(await guard.decision(self.native()))

    async def test_late_setup_body_after_close_cannot_repopulate_secrets_or_binding(self):
        request = self.native()
        self.assertTrue(await self.guard.decision(request))
        entered, release = asyncio.Event(), asyncio.Event()
        response = Response(request, {})
        async def body():
            entered.set()
            await release.wait()
            return json.dumps({'client_secret': 'seti_Late_secret_temporary'}).encode()
        response.body = body
        observer = asyncio.create_task(self.guard.response(response))
        await entered.wait()
        self.guard.close()
        release.set()
        await observer
        self.assertIsNone(self.guard.setup_id)
        self.assertIsNone(self.guard.setup_secret)
        self.assertIsNone(self.guard.method_id)

    async def test_cancel_during_header_inspection_closes_before_network_send(self):
        self.guard.authorize_submit()
        entered, release = asyncio.Event(), asyncio.Event()
        state = {'cancelled': False}
        self.guard.cancelled = lambda: state['cancelled']
        async def headers(*_args):
            entered.set()
            await release.wait()
            return True
        with patch.object(self.guard.auth, 'safe_headers', side_effect=headers):
            task = asyncio.create_task(self.guard.decision(self.stripe_request('/v1/confirmation_tokens', type='card')))
            await entered.wait()
            state['cancelled'] = True
            release.set()
            self.assertFalse(await task)
        self.assertTrue(self.guard.closed)
        self.assertEqual(self.guard.error.report['reason'], 'operation_cancelled')

    async def test_cancelled_before_original_setup_creation_does_not_send(self):
        self.guard.cancelled = lambda: True
        self.assertFalse(await self.guard.decision(self.native()))
        self.assertFalse(self.guard.requests)
        self.assertTrue(self.guard.closed)

    async def test_existing_pm_response_wrong_card_rejects_setup_and_finalize(self):
        await self.accept(self.native(), {'client_secret': 'seti_Synthetic_secret_temporary'})
        self.guard.authorize_submit()
        request = self.stripe_request('/v1/payment_methods', type='card')
        self.assertTrue(await self.guard.decision(request))
        await self.guard.response(Response(request, method(exp_month=11)))
        self.assertTrue(self.guard.closed)
        self.assertIsNone(self.guard.token_method_id)
        self.assertFalse(await self.guard.decision(self.native(BASE + '/pm_New/finalize', setup_intent_id='seti_Synthetic')))

    async def test_card_matching_ignores_historical_default_but_rejects_ambiguity(self):
        old = method('pm_Old', last4='9999')
        matches = matching_methods([old, method()], self.details)
        self.assertEqual([value['id'] for value in matches], ['pm_New'])
        self.assertEqual(len(matching_methods([method(), method('pm_Duplicate')], self.details)), 2)
        self.assertFalse(method_matches_card(method(exp_year=2040), self.details))

    async def test_json_nested_card_cannot_skip_authorized_card_check(self):
        self.guard.authorize_submit()
        request = Request('https://api.stripe.com/v1/confirmation_tokens', frame=self.stripe,
                          data=json.dumps({'payment_method_data': {'type': 'card', 'card': {'number': '4000000000000002'}}}))
        self.assertFalse(await self.guard.decision(request))
        self.assertFalse(self.guard.reserved)

    async def test_setup_or_token_confirm_mixed_charge_response_closes_without_selected_card(self):
        await self.token()
        request = self.native(BASE + '/confirm', confirmation_token_id='ctoken_Synthetic')
        self.assertTrue(await self.guard.decision(request))
        await self.guard.response(Response(request, {'status': 'succeeded', 'payment_method_id': 'pm_New',
            'payment_intent': {'object': 'payment_intent', 'id': 'pi_Unexpected', 'status': 'succeeded'}}))
        self.assertTrue(self.guard.closed)
        self.assertIsNone(self.guard.method_id)

    async def test_card_setup_authentication_cancelled_during_header_await_does_not_send(self):
        await self.token()
        await self.accept(self.native(BASE + '/confirm', confirmation_token_id='ctoken_Synthetic'),
                          {'status': 'requires_action', 'client_secret': 'seti_Synthetic_secret_temporary'})
        self.guard.observe_setup({'id': 'seti_Synthetic', 'object': 'setup_intent', 'status': 'requires_action',
            'payment_method': 'pm_New', 'next_action': {'type': 'use_stripe_sdk', 'use_stripe_sdk': {
                'type': 'stripe_3ds2_fingerprint', 'three_d_secure_2_source': 'src_setup'}}})
        entered, release = asyncio.Event(), asyncio.Event()
        state = {'cancelled': False}
        self.guard.cancelled = lambda: state['cancelled']
        async def headers(*_args):
            entered.set()
            await release.wait()
            return True
        with patch.object(self.guard.auth, 'safe_headers', side_effect=headers):
            task = asyncio.create_task(self.guard.decision(self.stripe_request('/v1/3ds2/authenticate', source='src_setup')))
            await entered.wait()
            state['cancelled'] = True
            release.set()
            self.assertFalse(await task)
        self.assertTrue(self.guard.closed)

    async def test_only_auth_gate_closed_during_async_decision_still_blocks_late_authentication(self):
        self.guard.auth.active = True
        entered, release = asyncio.Event(), asyncio.Event()
        async def decision(*_args):
            entered.set()
            await release.wait()
            return True
        with patch.object(self.guard.auth, 'decision', side_effect=decision):
            task = asyncio.create_task(self.guard.decision(self.stripe_request('/v1/3ds2/authenticate', source='src_setup')))
            await entered.wait()
            self.guard.auth.close('completed')
            release.set()
            self.assertFalse(await task)
        self.assertTrue(self.guard.active)

    async def test_known_card_cors_preflight_has_no_write_authority_or_reservation(self):
        for path in ('/v1/payment_methods', '/v1/confirmation_tokens'):
            request = Request('https://api.stripe.com' + path, method='OPTIONS', frame=self.stripe)
            self.assertTrue(await self.guard.decision(request))
        unknown = Request('https://api.stripe.com/v1/payment_intents/pi_Other/confirm', method='OPTIONS', frame=self.stripe)
        self.assertFalse(await self.guard.decision(unknown))
        self.assertFalse(self.guard.reserved)


class CardBrowserFixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        binary = os.environ.get('V2_REGISTRATION_FINGERPRINT_BINARY')
        if binary:
            from fingerprint_runtime import launch_fingerprint_browser
            self.browser = await launch_fingerprint_browser(self.pw, headless=True, executable_path=binary)
        else:
            self.browser = await self.pw.chromium.launch(headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context(service_workers='block')
        self.addAsyncCleanup(self.context.close)
        self.target = parse_browser_credential(fixture())
        self.mode, self.saved, self.duplicate, self.wrong_preview = 'legacy', False, False, False
        self.methods = [method('pm_Old', last4='9999')]
        self.writes, self.blocked, self.tasks = [], [], set()
        await self.context.route('**/*', self.server)
        self.page = await self.context.new_page()

    async def server(self, route):
        request, p = route.request, urlsplit(route.request.url)
        cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'}
        if request.method == 'OPTIONS':
            await route.fulfill(status=204, headers=cors)
            return
        if request.method == 'POST':
            self.writes.append(p.path)
        if p.hostname == 'chatgpt.com' and p.path == '/':
            await route.fulfill(content_type='text/html', body=self.home())
            return
        if p.hostname == 'js.stripe.com':
            await route.fulfill(content_type='text/html', body=self.card_form())
            return
        if p.path == '/backend-api/payments/payment_methods':
            data = {'account_id': self.target.account_id, 'default_payment_method_id': 'pm_Old', 'payment_methods': self.methods}
        elif p.path == BASE:
            data = {'client_secret': 'seti_Synthetic_secret_temporary'}
        elif p.path == '/v1/payment_methods':
            data = method()
        elif p.path == '/v1/confirmation_tokens':
            data = {'id': 'ctoken_Synthetic', 'payment_method_preview': method(last4='9999' if self.wrong_preview else '4242')}
        elif p.path == '/v1/setup_intents/seti_Synthetic/confirm':
            data = {'id': 'seti_Synthetic', 'object': 'setup_intent', 'status': 'succeeded', 'payment_method': 'pm_New'}
        elif p.path == BASE + '/pm_New/finalize':
            self.methods.append(method('pm_Canonical'))
            data = {'canonical_payment_method_id': 'pm_Canonical', 'status': 'added'}
        elif p.path == BASE + '/confirm':
            self.methods.append(method())
            data = {'status': 'succeeded', 'payment_method_id': 'pm_New', 'finalization_status': 'added'}
        else:
            await route.fulfill(status=404, headers=cors, body='{}')
            return
        await route.fulfill(content_type='application/json', headers=cors, body=json.dumps(data))

    def home(self):
        headers = json.dumps({'authorization': 'Bearer ' + self.target.old_token, 'content-type': 'application/json'})
        body = json.dumps({'account_id': self.target.account_id, 'caller_surface': 'plan_management'})
        return '''<style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}label{display:block;min-height:30px}</style>
        <button onclick="change()">Change payment method</button><div id="methods"></div>
        <script>const headers=''' + headers + ''', account=''' + body + ''', mode=''' + json.dumps(self.mode) + ''';
        const post=async(path,body)=>(await fetch(path,{method:'POST',headers,body:JSON.stringify({...account,...body})})).json();
        function radio(id, checked=false){const n=document.createElement('input');n.type='radio';n.name='plan-upgrade-payment-method';n.value=id;n.checked=checked;n.className='peer sr-only';const label=document.createElement('label');label.append(n,document.createTextNode(id));document.querySelector('#methods').append(label)}
        function change(){radio('pm_Old');''' + ("radio('pm_New');" if self.saved else '') + '''const b=document.createElement('button');b.textContent='Add new';b.onclick=add;document.querySelector('#methods').append(b)}
        async function add(){if(mode==='legacy')await post(''' + json.dumps(BASE) + ''',{});
        const modal=document.createElement('div');modal.dataset.testid='modal-add-payment-method';modal.innerHTML='<iframe src="https://js.stripe.com/card" id="card"></iframe><button id="continue">Continue</button>';document.body.append(modal);
        document.querySelector('#continue').onclick=()=>document.querySelector('#card').contentWindow.postMessage({mode},'https://js.stripe.com')}
        window.addEventListener('message',async(event)=>{if(event.origin!=='https://js.stripe.com')return;
        let result;if(mode==='legacy')result=await post(''' + json.dumps(BASE + '/pm_New/finalize') + ''',{setup_intent_id:'seti_Synthetic'});
        else result=await post(''' + json.dumps(BASE + '/confirm') + ''',{confirmation_token_id:event.data.id});
        radio(result.canonical_payment_method_id||result.payment_method_id,true);document.querySelector('[data-testid=modal-add-payment-method]').remove()});
        </script>'''

    def card_form(self):
        address = """<input autocomplete='name'><input autocomplete='email'><select autocomplete='country'><option value='US'>United States</option></select>
        <input autocomplete='address-line1'><input autocomplete='address-line2'><input autocomplete='address-level2'><input autocomplete='address-level1'><input autocomplete='postal-code'>"""
        return """<input autocomplete='cc-number'><input autocomplete='cc-exp'><input autocomplete='cc-csc'>""" + address + '''
        <script>const post=async(path,body)=>(await fetch('https://api.stripe.com'+path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)})).json();
        window.addEventListener('message',async(event)=>{if(event.origin!=='https://chatgpt.com')return;
        const values={type:'card','card[number]':document.querySelector('[autocomplete=cc-number]').value,
        'card[exp_month]':'12','card[exp_year]':'2039','card[cvc]':document.querySelector('[autocomplete=cc-csc]').value};
        if(event.data.mode==='legacy'){const pm=await post('/v1/payment_methods',values);await post('/v1/setup_intents/seti_Synthetic/confirm',{client_secret:'seti_Synthetic_secret_temporary',payment_method:pm.id});parent.postMessage({ok:true},'https://chatgpt.com')}
        else{const token=await post('/v1/confirmation_tokens',values);parent.postMessage({id:token.id},'https://chatgpt.com')}});
        </script>'''

    async def prepare(self):
        if self.saved:
            self.methods.append(method())
        if self.duplicate:
            self.methods.extend([method(), method('pm_Duplicate')])
        await self.page.goto('https://chatgpt.com/')
        self.guard = UpgradeCardChange(self.target, self.page.main_frame)
        self.addCleanup(self.guard.close)
        async def network(route):
            decision = await self.guard.decision(route.request)
            if decision is False:
                self.blocked.append(urlsplit(route.request.url).path)
                await route.abort('blockedbyclient')
            elif decision is True or route.request.method in {'GET', 'HEAD', 'OPTIONS'}:
                await route.fallback()
            else:
                self.blocked.append(urlsplit(route.request.url).path)
                await route.abort('blockedbyclient')
        await self.context.route('**/*', network)
        def observe(response):
            task = asyncio.create_task(self.guard.response(response))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        self.context.on('response', observe)
        async def clean():
            self.context.remove_listener('response', observe)
            if self.tasks:
                await asyncio.gather(*self.tasks, return_exceptions=True)
        self.addAsyncCleanup(clean)
        self.details = details()
        self.addCleanup(self.details.clear)
        return await prepare_upgrade_card(self.page, self.target, self.details, self.guard,
            credential=parse_credential(json.dumps({'accessToken': self.target.old_token}).encode()), wait_seconds=15)

@unittest.skipUnless(os.environ.get('V2_PAYMENT_3DS_BROWSER_TEST') == '1', 'Explicit local intercepted browser fixtures')
class CardBrowserTests(CardBrowserFixture):
    async def test_saved_nondefault_card_selected_without_card_writes(self):
        self.saved = True
        selected = await self.prepare()
        self.assertEqual(selected, 'pm_New')
        self.assertFalse(self.writes)
        self.assertTrue(self.guard.closed)
        self.assertEqual(await verify_selected_upgrade_card(self.page, self.guard, self.details), 'pm_New')

    async def test_legacy_add_card_original_form_and_canonical_pm(self):
        self.assertEqual(await self.prepare(), 'pm_Canonical')
        self.assertEqual(self.writes, [BASE, '/v1/payment_methods', '/v1/setup_intents/seti_Synthetic/confirm', BASE + '/pm_New/finalize'])
        self.assertFalse(self.blocked)
        self.assertIsNone(self.guard.details)
        self.assertIsNone(self.guard.setup_secret)

    async def test_confirmation_token_add_card_original_form(self):
        self.mode = 'token'
        self.assertEqual(await self.prepare(), 'pm_New')
        self.assertEqual(self.writes, ['/v1/confirmation_tokens', BASE + '/confirm'])
        self.assertFalse(self.blocked)

    async def test_duplicate_authorized_card_never_guesses_or_submits(self):
        self.duplicate = True
        with self.assertRaises(Stop) as blocked:
            await self.prepare()
        self.assertEqual(blocked.exception.report['reason'], 'upgrade_payment_method_ambiguous')
        self.assertFalse(self.writes)

    async def test_wrong_token_card_does_not_call_native_confirm(self):
        self.mode, self.wrong_preview = 'token', True
        with self.assertRaises(Stop):
            await self.prepare()
        self.assertEqual(self.writes, ['/v1/confirmation_tokens'])
        self.assertTrue(self.guard.closed)

    async def test_selected_card_change_before_upgrade_is_rejected(self):
        self.saved = True
        await self.prepare()
        await self.page.locator("input[value='pm_Old']").locator('xpath=ancestor::label[1]').click()
        with self.assertRaises(Stop) as blocked:
            await verify_selected_upgrade_card(self.page, self.guard, self.details)
        self.assertEqual(blocked.exception.report['reason'], 'upgrade_payment_method_changed')
        self.assertFalse(self.writes)


if __name__ == '__main__':
    unittest.main()
