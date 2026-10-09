"""Synthetic original-frame handoff: no external traffic, accounts, or payment."""
import asyncio
import base64
import json
import io
import os
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import payment_handoff as h
import server
from checkout_core import Stop, parse_browser_credential
from payment_network import PaymentGuard
from test_payment_3ds import Frame, Request, Response, Route, quote
from test_subscribe import fixture
from upgrade_authentication import wait_upgrade_authentication


def command(session=None, kind='click', **values):
    return {'commandId': str(uuid4()), 'sessionId': session.session_id if session else str(uuid4()),
            'frameId': session.frame_id if session else str(uuid4()),
            'revision': session.revision if session else 1, 'type': kind, **values}


class CommandsAndConfirmationTests(unittest.TestCase):
    def test_strict_union_rejects_navigation_js_extra_keys_and_invalid_values(self):
        valid = [command(x=1, y=2), command(kind='text', text='synthetic'),
                 command(kind='key', key='Tab'), command(kind='scroll', deltaY=600)]
        for value in valid:
            self.assertIs(h.command_value(value), value)
        invalid = [command(kind='url', url='https://example.invalid'), command(x=True, y=1),
                   command(x=float('nan'), y=1), command(kind='text', text='x' * 65),
                   command(kind='text', text='\n'), command(kind='key', key='Control+L'),
                   command(kind='scroll', deltaY=601), {**command(x=1, y=1), 'js': 'alert(1)'},
                   {**command(x=1, y=1), 'type': {}}, command(kind='key', key={}),
                   {**command(x=1, y=1), 'revision': True}]
        for value in invalid:
            with self.subTest(kind=str(value.get('type'))), self.assertRaises(Stop):
                h.command_value(value)

    def job(self, manual=True):
        return server.Job('synthetic', {'action': 'server', 'plan': 'plus',
            'manualPaymentConfirmation': manual, 'safety': {'authorizeSinglePayment': True,
            'lockedCurrency': 'MYR'}})

    def test_manual_confirmation_waits_for_current_nonce_once_after_quote(self):
        job = self.job()
        job.payload['safety'].update(maxAmount='1.00', maxAmountMinor=1)
        received, values = [], []
        with patch.object(server, 'callback', side_effect=lambda _, body: received.append(body)):
            thread = threading.Thread(target=lambda: values.append(job.confirm(quote(), '0000')))
            thread.start()
            for _ in range(1000):
                if job.waiting_confirmation:
                    break
                threading.Event().wait(.001)
            self.assertEqual(values, [])
            self.assertEqual(received[0]['result']['status'], 'awaiting_confirmation')
            with self.assertRaises(Stop):
                job.signal('wrong')
            job.signal(job.nonce)
            with self.assertRaises(Stop):
                job.signal(job.nonce)
            thread.join(2)
        self.assertEqual(values, [True])
        self.assertFalse(job.waiting_confirmation)
        with self.assertRaises(Stop):
            job.confirm(quote(), '0000')

    def test_legacy_false_missing_or_true_flag_never_auto_confirms_and_cancel_still_stops(self):
        for manual in (False, True, None):
            job = self.job(True if manual is None else manual)
            if manual is None:
                job.payload.pop('manualPaymentConfirmation')
            with patch.object(server, 'callback') as callback, patch.object(job.confirm_event, 'wait', return_value=False) as wait:
                self.assertFalse(job.confirm(quote(), '0000'))
                wait.assert_called_once_with(300)
                self.assertEqual(callback.call_args.args[1]['result']['status'], 'awaiting_confirmation')
                self.assertFalse(job.confirmed)
            self.assertFalse(job.waiting_confirmation)
        job = self.job()
        with patch.object(server, 'callback'), patch.object(job.confirm_event, 'wait', side_effect=lambda _: job.signal(cancel=True)):
            self.assertFalse(job.confirm(quote(), '0000'))
        job = self.job()
        job.payload['safety'].update(maxAmount='1.00', maxAmountMinor=1)
        with patch.object(server, 'callback') as callback, patch.object(job.confirm_event, 'wait', return_value=False) as wait:
            self.assertFalse(job.confirm(quote(), '0000'))
            wait.assert_called_once_with(300)
            self.assertEqual(callback.call_args.args[1]['result']['quote']['today']['amount_minor'], 9250)
            self.assertEqual(callback.call_args.args[1]['result']['status'], 'awaiting_confirmation')
            self.assertFalse(job.confirmed)

    def test_server_bad_quote_or_currency_stops_before_manual_confirmation(self):
        good = quote()
        for changed in ({**good, 'tax': None},
                        {**good, 'renewal': {**good['renewal'], 'amount': '0.00', 'amount_minor': 0}},
                        {**good, 'today': {**good['today'], 'amount_minor': 9251}},
                        {**good, 'tax': {**good['tax'], 'currency': 'USD'}},
                        {**good, 'renewal_interval': None}):
            with self.subTest(changed=list(changed)):
                job = self.job()
                with patch.object(server, 'callback') as callback, self.assertRaises(Stop) as stopped:
                    job.confirm(changed, '0000')
                self.assertEqual(stopped.exception.report['reason'], 'payment_quote_outside_authorization')
                callback.assert_not_called()
                self.assertFalse(job.confirmed)

    def test_manual_flag_is_optional_strict_server_boolean(self):
        server.Job('test', {'action': 'server'})
        for payload in ({'action': 'server', 'manualPaymentConfirmation': 1},
                        {'action': 'login', 'manualPaymentConfirmation': False}):
            with self.assertRaises(Stop):
                server.Job('test', payload)

    def test_callback_whitelist_never_returns_image_text_or_command(self):
        result = server.public_result({'handoff_available': True, 'handoff_kind': 'bank',
            'handoff_expires_at': '2026-10-04T00:00:00.000Z', 'image': 'private', 'text': 'private',
            'sessionId': str(uuid4()), 'commandId': str(uuid4())})
        self.assertEqual(set(result), {'handoff_available', 'handoff_kind', 'handoff_expires_at'})

    def test_private_http_get_and_post_bind_authenticated_current_job_only(self):
        job = server.Job(str(uuid4()), {'action': 'server'})
        snapshot = {'sessionId': str(uuid4()), 'frameId': str(uuid4()), 'revision': 1,
                    'kind': 'hcaptcha', 'image': 'data:image/jpeg;base64,synthetic',
                    'width': 10, 'height': 10, 'expiresAt': '2026-10-04T00:00:00.000Z'}
        body = command(kind='key', key='Tab')
        handler = object.__new__(server.Handler)
        handler.path, handler.job = '/jobs/' + job.id + '/handoff', job
        handler.reply = MagicMock()
        job.handoff_request = MagicMock(side_effect=[snapshot, {'commandId': body['commandId'], 'accepted': True}])
        encoded = json.dumps(body).encode()
        handler.headers = {'X-Recharge-Worker': 'fixture-worker', 'Content-Length': str(len(encoded))}
        handler.rfile = io.BytesIO(encoded)
        with patch.object(server, 'TOKEN', 'fixture-worker'):
            handler.do_GET()
            handler.reply.assert_called_once_with(200, snapshot)
            handler.reply.reset_mock()
            handler.do_POST()
            handler.reply.assert_called_once_with(200, {'commandId': body['commandId'], 'accepted': True})
            self.assertEqual(job.handoff_request.call_count, 2)
            handler.headers['X-Recharge-Worker'] = 'wrong'
            handler.reply.reset_mock()
            handler.do_GET()
            handler.reply.assert_called_once_with(403, {'ok': False})
            self.assertEqual(job.handoff_request.call_count, 2)


class WidgetNetworkTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.target = parse_browser_credential(fixture())
        self.guard = PaymentGuard(self.target)
        self.guard.account_verified = self.guard.hcaptcha_enabled = True

    async def test_widget_initial_navigation_and_requests_only_in_official_ancestry(self):
        root = Frame()
        blank = Frame('about:blank', root)
        widget = Frame('https://newassets.hcaptcha.com/captcha.html', root)
        accepted = [Request('https://newassets.hcaptcha.com/captcha.html', method='GET', frame=blank, navigation=True),
                    Request('https://js.hcaptcha.com/1/api.js', method='GET', frame=root),
                    Request('https://api.hcaptcha.com/checksiteconfig', frame=root),
                    Request('https://api.hcaptcha.com/getcaptcha/synthetic', frame=widget)]
        for request in accepted:
            route = Route(request)
            await self.guard.route(route)
            self.assertTrue(route.passed)
            self.assertFalse(route.blocked)
        rejected = [Request('https://api.hcaptcha.com/siteverify', frame=widget),
                    Request('https://api.hcaptcha.com/getcaptcha/synthetic', frame=root),
                    Request('https://api.hcaptcha.com/getcaptcha/synthetic', frame=widget, headers={'Authorization': 'Bearer private'}),
                    Request('https://api.hcaptcha.com/getcaptcha/synthetic', frame=Frame('https://example.invalid')),
                    Request('https://hcaptcha.com.evil.invalid/captcha.html', method='GET', frame=root)]
        with patch.dict(os.environ, {'AUTO_RECHARGE_CALLBACK_URL': 'fixture'}):
            for request in rejected:
                route = Route(request)
                await self.guard.route(route)
                self.assertTrue(route.blocked)
                self.assertFalse(route.passed)

    async def test_cancel_denies_late_first_confirm_and_bank_authentication(self):
        ledger = SimpleNamespace(record={'payment_attempted': True}, target_plan='plus', checkout_id='cs_synthetic',
                                 mark_confirmation_sent=MagicMock())
        self.guard.payment_ledger, self.guard.checkout_id = ledger, 'cs_synthetic'
        self.guard.approve(quote())
        self.guard.operation_cancelled = lambda: True
        for path in ('/v1/payment_pages/cs_synthetic/confirm', '/v1/3ds2/challenge_complete'):
            route = Route(Request('https://api.stripe.com' + path))
            await self.guard.route(route)
            self.assertTrue(route.blocked)
            self.assertFalse(route.passed)
        ledger.mark_confirmation_sent.assert_not_called()
        self.assertEqual(self.guard.confirmation_sent, 0)

    async def test_budget_exhaustion_fences_late_first_confirm_before_driver_poll(self):
        controller = SimpleNamespace(cancelled=False, handoff_deadline=time.monotonic() - .01)
        self.guard.operation_cancelled = lambda: h.controller_cancelled(controller)
        self.guard.approved = True
        route = Route(Request('https://api.stripe.com/v1/payment_pages/cs_synthetic/confirm'))
        await self.guard.route(route)
        self.assertTrue(route.blocked)
        self.assertFalse(route.passed)
        self.assertEqual(self.guard.confirmation_sent, 0)

    async def test_revoked_handoff_keeps_late_original_paid_evidence_read_only(self):
        ledger = SimpleNamespace(record={'payment_attempted': True}, target_plan='plus', checkout_id='cs_synthetic',
                                 update=MagicMock())
        self.guard.payment_ledger, self.guard.checkout_id, self.guard.quote = ledger, 'cs_synthetic', quote()
        self.guard.approved, self.guard.read_only, self.guard.confirmation_sent = False, True, 1
        original = Request('https://api.stripe.com/v1/payment_pages/cs_synthetic/confirm')
        self.guard.confirm_request = original
        receipt = {'id': 'cs_synthetic', 'object': 'checkout.session', 'status': 'complete',
                   'payment_status': 'paid', 'amount_total': 9250, 'currency': 'myr'}
        await self.guard.response(Response(original, receipt))
        self.assertEqual(self.guard.payment_state, 'paid')
        self.assertFalse(self.guard.approved)
        self.assertTrue(self.guard.read_only)
        self.assertEqual(self.guard.evidence['identifier'], 'cs_synthetic')
        route = Route(Request('https://api.stripe.com/v1/payment_pages/cs_synthetic/confirm'))
        await self.guard.route(route)
        self.assertTrue(route.blocked)

    async def test_upgrade_handoff_wait_observes_original_order_without_reconfirm(self):
        guard = SimpleNamespace(done=asyncio.Event(), error=None, three_ds=SimpleNamespace(needs_user=True, status='awaiting_user'),
                                upgrade_ledger=SimpleNamespace(record={'payment_status': 'requires_action'}))
        guard.done.set()
        async def handoff(page, current, kind):
            self.assertIs(current, guard)
            self.assertEqual(kind, 'bank')
            current.upgrade_ledger.record['payment_status'] = 'paid'
            current.three_ds.needs_user = False
        action = AsyncMock(side_effect=handoff)
        await wait_upgrade_authentication(guard, .01, lambda: None, lambda *args, **kwargs: None,
                                          page='original', handoff=action)
        action.assert_awaited_once()


@unittest.skipUnless(os.environ.get('V2_PAYMENT_HANDOFF_BROWSER_TEST') == '1', 'explicit isolated browser fixture')
class HandoffBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from playwright.async_api import async_playwright
        self.driver = await async_playwright().start()
        self.browser = await self.driver.chromium.launch(headless=True)
        self.context = await self.browser.new_context(service_workers='block', accept_downloads=False)
        self.context.set_default_timeout(5000)
        self.top = '<body style="margin:0"><iframe style="border:0;width:320px;height:180px" src="https://newassets.hcaptcha.com/captcha.html"></iframe><button id="parent">Parent</button></body>'
        self.widget = '<body style="margin:0;background:white"><input id="code" style="position:absolute;left:10px;top:10px;width:100px;height:25px" value="synthetic"><button id="action" style="position:absolute;left:10px;top:60px" onclick="window.actions=(window.actions||0)+1">Challenge</button></body>'
        self.requests = 0
        async def fixture_server(route):
            self.requests += 1
            if '/api/auth/session' in route.request.url:
                return await route.fulfill(status=200, content_type='application/json', body=fixture())
            body = self.widget if h.hcaptcha_url(route.request.url) or route.request.url.startswith('https://issuer.example.invalid/') else self.top
            await route.fulfill(status=200, content_type='text/html', body=body)
        await self.context.route('**/*', fixture_server)
        self.page = await self.context.new_page()
        await self.page.goto('https://chatgpt.com/checkout/openai_ie/cs_synthetic')
        await self.page.locator('iframe').content_frame.locator('#action').wait_for()
        self.frame = self.page.frames[1]
        self.target = parse_browser_credential(fixture())
        record = {'payment_attempted': True, 'checkout_identifier': 'cs_synthetic', 'quote_digest': 'synthetic-digest'}
        self.guard = PaymentGuard(self.target, SimpleNamespace(record=record, target_plan='plus', checkout_id='cs_synthetic'))
        self.guard.checkout_id, self.guard.account_verified, self.guard.approved = 'cs_synthetic', True, True
        self.job = server.Job('synthetic', {'action': 'server'})
        self.session = h.PaymentHandoff(self.job, self.page, self.guard, 'hcaptcha')

    async def asyncTearDown(self):
        self.session.close()
        await self.context.close()
        await self.browser.close()
        await self.driver.stop()

    async def test_snapshot_exact_protocol_jpeg_crop_masks_all_input_values(self):
        image = await self.session.snapshot()
        self.assertEqual(set(image), {'sessionId','frameId','revision','kind','image','width','height','expiresAt'})
        self.assertEqual((image['width'], image['height']), (320, 180))
        self.assertRegex(image['expiresAt'], r'Z$')
        raw = base64.b64decode(image['image'].split(',', 1)[1])
        self.assertTrue(raw.startswith(b'\xff\xd8'))
        self.assertLess(len(image['image']), 1_400_000)
        pixel = await self.page.evaluate('''data => new Promise(resolve => {
            const image = new Image(); image.onload = () => {
                const canvas = document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height;
                const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0);
                resolve(Array.from(ctx.getImageData(40,20,1,1).data).slice(0,3));
            }; image.src=data;
        })''', image['image'])
        self.assertLess(max(pixel), 20)
        self.assertFalse(hasattr(self.session, 'image'))

    async def test_snapshot_discards_sensitive_overlay_inserted_during_screenshot(self):
        from playwright.async_api import ElementHandle
        original = ElementHandle.screenshot
        captured = []
        async def overlay(element, **kwargs):
            await self.page.evaluate("document.body.insertAdjacentHTML('beforeend','<input type=password style=\"position:absolute;left:10px;top:10px;z-index:9\" value=synthetic>')")
            captured.append(await original(element, **kwargs))
            return captured[-1]
        with patch.object(ElementHandle, 'screenshot', overlay), self.assertRaises(Stop):
            await self.session.snapshot()
        self.assertEqual(len(captured), 1)
        self.assertFalse(hasattr(self.session, 'image'))

    async def test_click_text_and_replay_stay_inside_current_frame(self):
        await self.session.snapshot()
        click = command(self.session, x=30, y=20)
        self.assertTrue((await self.session.command(click))['accepted'])
        with self.assertRaises(Stop):
            await self.session.command(click)
        await self.session.command(command(self.session, kind='text', text='synthetic-next'))
        self.assertEqual(await self.frame.locator('#code').input_value(), 'synthetic-next')
        self.assertEqual(await self.page.locator('#parent').evaluate('el => el.dataset.clicked || null'), None)

    async def test_tab_leaving_frame_denies_next_enter_and_parent_action(self):
        await self.session.snapshot()
        await self.session.command(command(self.session, x=30, y=75))
        await self.session.command(command(self.session, kind='key', key='Tab'))
        with self.assertRaises(Stop):
            await self.session.command(command(self.session, kind='key', key='Enter'))
        self.assertEqual(await self.frame.evaluate('window.actions'), 1)

    async def test_old_revision_frame_replacement_page_and_intent_changes_stop(self):
        await self.session.snapshot()
        previous = command(self.session, x=30, y=75)
        self.session.revision += 1
        with self.assertRaises(Stop):
            await self.session.command(previous)
        self.guard.linked_intent = 'pi_different'
        with self.assertRaises(Stop):
            await self.session.snapshot()
        self.guard.linked_intent = None
        await self.page.evaluate("document.querySelector('iframe').src='https://newassets.hcaptcha.com/replaced.html'")
        await self.frame.wait_for_url('**/replaced.html')
        with self.assertRaises(Stop):
            await self.session.command(previous)
        new_page = await self.context.new_page()
        with self.assertRaises(Stop):
            await self.session.snapshot()
        await new_page.close()

    async def test_dom_change_invalidates_previous_picture_coordinates(self):
        await self.session.snapshot()
        previous = command(self.session, x=30, y=75)
        await self.frame.locator('#action').evaluate("el => el.style.left='100px'")
        with self.assertRaises(Stop):
            await self.session.command(previous)
        self.assertEqual(await self.frame.evaluate('window.actions || 0'), 0)

    async def test_sensitive_frame_overlay_and_sibling_frame_are_rejected(self):
        await self.frame.locator('#code').evaluate("el => el.type='password'")
        with self.assertRaises(Stop):
            await self.session.snapshot()
        await self.frame.locator('#code').evaluate("el => el.type='text'")
        await self.page.evaluate("document.body.insertAdjacentHTML('beforeend','<div id=overlay style=\"position:fixed;inset:0;background:white;z-index:5\">Blocked</div>')")
        with self.assertRaises(Stop):
            await self.session.snapshot()
        await self.page.locator('#overlay').evaluate('el => el.remove()')
        await self.page.evaluate("document.body.insertAdjacentHTML('beforeend','<iframe style=\"position:absolute;left:0;top:0;width:100px;height:50px;z-index:5\" srcdoc=\"<input autocomplete=cc-number>\"></iframe>')")
        with self.assertRaises(Stop):
            await self.session.snapshot()

    async def test_opaque_bank_modal_over_card_is_allowed_reverse_overlay_is_rejected(self):
        self.session.close()
        await self.frame.goto('https://issuer.example.invalid/challenge')
        self.guard.three_ds.active, self.guard.three_ds.status = True, 'awaiting_user'
        self.guard.three_ds.intent_id, self.guard.linked_intent = 'pi_synthetic', 'pi_synthetic'
        self.guard.three_ds.frames[self.frame] = 'https://issuer.example.invalid'
        await self.page.locator('iframe').evaluate("el => {el.id='bank';el.style.position='relative';el.style.zIndex='2'}")
        await self.page.evaluate("document.body.insertAdjacentHTML('beforeend','<iframe id=card style=\"position:absolute;left:0;top:0;width:320px;height:180px;z-index:1\" srcdoc=\"<input autocomplete=cc-number value=synthetic>\"></iframe>')")
        await self.page.locator('#card').content_frame.locator('input').wait_for()
        self.session = h.PaymentHandoff(self.job, self.page, self.guard, 'bank')
        snapshot = await self.session.snapshot()
        self.assertEqual(snapshot['kind'], 'bank')
        self.assertEqual(snapshot['width'], 320)
        await self.page.locator('#card').evaluate("el => el.style.zIndex='3'")
        with self.assertRaises(Stop):
            await self.session.snapshot()

    async def test_cancel_during_auto_wait_cancels_action_and_revokes_first_confirm(self):
        from playwright.async_api import ElementHandle
        actions = []
        await self.context.expose_binding('fixtureAction', lambda *_args: actions.append(True))
        await self.frame.locator('#action').evaluate("el => el.onclick=()=>window.fixtureAction()")
        await self.session.snapshot()
        self.job.handoff = self.session
        started = asyncio.Event()
        original_click = ElementHandle.click
        async def auto_wait(element, **kwargs):
            await element.evaluate("el=>el.animate([{transform:'translateX(0px)'},{transform:'translateX(20px)'}],{duration:100,iterations:10})")
            started.set()
            await original_click(element, **kwargs)
        with patch.object(ElementHandle, 'click', auto_wait):
            task = asyncio.create_task(self.session.command(command(self.session, x=30, y=75)))
            await started.wait()
            await asyncio.sleep(.03)
            self.assertFalse(task.done())
            self.assertTrue(self.session.operations)
            self.job.signal(cancel=True)
            with self.assertRaises((asyncio.CancelledError, Stop)):
                await task
            await asyncio.sleep(.15)
        self.assertFalse(self.guard.approved)
        self.assertTrue(self.guard.read_only)
        self.assertEqual(actions, [])
        self.assertTrue(self.page.is_closed())

    async def test_normal_retirement_with_pending_auto_wait_cannot_open_bank_session(self):
        from playwright.async_api import ElementHandle
        actions = []
        await self.context.expose_binding('fixtureAction', lambda *_args: actions.append(True))
        await self.frame.locator('#action').evaluate("el => el.onclick=()=>window.fixtureAction()")
        await self.session.snapshot()
        started = asyncio.Event()
        original = ElementHandle.click
        async def waiting(element, **kwargs):
            await element.evaluate("el=>el.animate([{transform:'translateX(0px)'},{transform:'translateX(20px)'}],{duration:100,iterations:10})")
            started.set()
            await original(element, **kwargs)
        with patch.object(ElementHandle, 'click', waiting):
            task = asyncio.create_task(self.session.command(command(self.session, x=30, y=75)))
            await started.wait()
            self.assertFalse(task.done())
            self.session.close()
            with self.assertRaises((asyncio.CancelledError, Stop)):
                await task
            await asyncio.sleep(.15)
        self.assertTrue(self.page.is_closed())
        self.assertTrue(self.job.handoff_revoked)
        self.assertTrue(self.guard.read_only)
        self.assertEqual(actions, [])
        with self.assertRaises(Stop):
            await self.job.await_handoff(self.page, self.guard, 'bank')

    async def test_caller_cancel_cannot_erase_browser_pending_input_fence(self):
        from playwright.async_api import ElementHandle
        actions = []
        await self.context.expose_binding('fixtureAction', lambda *_args: actions.append(True))
        await self.frame.locator('#action').evaluate("el => el.onclick=()=>window.fixtureAction()")
        await self.session.snapshot()
        started = asyncio.Event()
        original = ElementHandle.click
        async def waiting(element, **kwargs):
            await element.evaluate("el=>el.animate([{transform:'translateX(0px)'},{transform:'translateX(20px)'}],{duration:100,iterations:10})")
            started.set()
            await original(element, **kwargs)
        with patch.object(ElementHandle, 'click', waiting):
            task = asyncio.create_task(self.session.command(command(self.session, x=30, y=75)))
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertFalse(self.session.operations)
            self.assertTrue(self.session.browser_operations)
            self.session.close(revoke=True)
            await asyncio.sleep(.15)
        self.assertTrue(self.page.is_closed())
        self.assertTrue(self.guard.read_only)
        self.assertEqual(actions, [])

    async def test_iframe_url_and_dom_change_during_wait_revoke_without_input(self):
        from playwright.async_api import ElementHandle
        started, release = asyncio.Event(), asyncio.Event()
        original = ElementHandle.click
        async def waiting(element, **kwargs):
            started.set()
            await release.wait()
            await original(element, **kwargs)
        for change in ('dom', 'url'):
            with self.subTest(change=change):
                if change == 'url':
                    await self.context.close()
                    self.context = await self.browser.new_context(service_workers='block')
                    async def fixture_server(route):
                        if '/api/auth/session' in route.request.url:
                            await route.fulfill(json=json.loads(fixture()))
                        else:
                            await route.fulfill(content_type='text/html', body=self.widget if h.hcaptcha_url(route.request.url) else self.top)
                    await self.context.route('**/*', fixture_server)
                    self.page = await self.context.new_page()
                    await self.page.goto('https://chatgpt.com/checkout/openai_ie/cs_synthetic')
                    await self.page.locator('iframe').content_frame.locator('#action').wait_for()
                    self.frame = self.page.frames[1]
                    self.job = server.Job('synthetic', {'action': 'server'})
                    self.session = h.PaymentHandoff(self.job, self.page, self.guard, 'hcaptcha')
                await self.session.snapshot()
                started.clear()
                with patch.object(ElementHandle, 'click', waiting):
                    task = asyncio.create_task(self.session.command(command(self.session, x=30, y=75)))
                    await started.wait()
                    if change == 'dom':
                        await self.frame.locator('#action').evaluate("el => el.textContent='Changed challenge'")
                    else:
                        await self.frame.goto('https://newassets.hcaptcha.com/new-challenge.html')
                    with self.assertRaises((asyncio.CancelledError, Stop)):
                        await task
                    await asyncio.sleep(.1)
                self.assertTrue(self.page.is_closed())
                self.assertTrue(self.session.revoked)
                self.assertTrue(self.job.handoff_revoked)
                self.assertTrue(self.guard.read_only)

    async def test_expiry_identity_mismatch_and_cancel_have_zero_actions(self):
        self.session.deadline = time.monotonic() - 1
        with self.assertRaises(Stop):
            await self.session.command(command(self.session, x=30, y=75))
        self.session.deadline = time.monotonic() + 300
        with patch('browser_checkout.browser_read', new=AsyncMock(return_value={'user': {'id': 'other'}})):
            with self.assertRaises(Stop):
                await self.session.snapshot()
        self.job.cancelled = True
        with self.assertRaises(Stop):
            await self.session.command(command(self.session, x=30, y=75))
        self.assertEqual(await self.frame.evaluate('window.actions || 0'), 0)

    async def test_first_widget_navigation_passes_guard_without_external_network(self):
        self.guard.hcaptcha_enabled = True
        await self.context.route('**/*', self.guard.route)
        await self.page.reload()
        await self.page.locator('iframe').content_frame.locator('#action').wait_for()
        self.assertTrue(h.hcaptcha_url(self.page.frames[1].url))

    async def test_stripe_top_page_uses_retained_original_identity_page(self):
        stripe = await self.context.new_page()
        await stripe.goto('https://checkout.stripe.com/cs_synthetic')
        await stripe.locator('iframe').content_frame.locator('#action').wait_for()
        self.session.close()
        self.session = h.PaymentHandoff(self.job, stripe, self.guard, 'hcaptcha')
        self.assertIs(self.session.identity_page, self.page)
        self.assertEqual((await self.session.snapshot())['kind'], 'hcaptcha')
        await self.page.close()
        with self.assertRaises(Stop):
            await self.session.snapshot()

    async def test_hcaptcha_to_original_bank_uses_same_budget_and_new_session_generation(self):
        received = []
        with patch.object(server, 'callback', side_effect=lambda _, body: received.append(body)):
            first = asyncio.create_task(self.job.await_handoff(self.page, self.guard, 'hcaptcha'))
            for _ in range(100):
                if received:
                    break
                await asyncio.sleep(.01)
            first_snapshot = await asyncio.to_thread(self.job.handoff_request)
            self.guard.three_ds.active, self.guard.three_ds.status = True, 'awaiting_user'
            self.guard.three_ds.intent_id, self.guard.linked_intent = 'pi_synthetic', 'pi_synthetic'
            self.guard.payment_state = 'requires_action'
            await first
            self.guard.three_ds.frames[self.frame] = 'https://newassets.hcaptcha.com'
            second = asyncio.create_task(self.job.await_handoff(self.page, self.guard, 'bank'))
            for _ in range(100):
                if len(received) >= 3:
                    break
                await asyncio.sleep(.01)
            second_snapshot = await asyncio.to_thread(self.job.handoff_request)
            self.assertEqual(first_snapshot['expiresAt'], second_snapshot['expiresAt'])
            self.assertNotEqual(first_snapshot['sessionId'], second_snapshot['sessionId'])
            stale = {**command(self.job.handoff, x=30, y=75), 'sessionId': first_snapshot['sessionId']}
            with self.assertRaises(Stop):
                await self.job.handoff.command(stale)
            self.guard.payment_state = 'paid'
            await second
        results = [entry['result'] for entry in received]
        self.assertEqual([entry['handoff_available'] for entry in results], [True, False, True, False])
        self.assertEqual([entry['handoff_generation'] for entry in results], [1, 1, 2, 2])
        self.assertEqual(results[0]['handoff_session_id'], first_snapshot['sessionId'])
        self.assertEqual(results[2]['handoff_session_id'], second_snapshot['sessionId'])
        self.assertIsNone(self.job.handoff)
        self.assertEqual(self.guard.confirmation_sent, 0)

    async def test_unbound_bank_frame_and_full_page_challenge_have_no_handoff(self):
        self.guard.three_ds.active, self.guard.three_ds.status = True, 'awaiting_user'
        self.assertEqual(await h.challenge_frames(self.page, self.guard, 'bank'), [])
        await self.page.locator('iframe').evaluate('el => el.remove()')
        self.assertEqual(await h.challenge_frames(self.page, self.guard), [])


@unittest.skipUnless(os.environ.get('V2_PAYMENT_HANDOFF_BROWSER_TEST') == '1', 'explicit isolated browser fixture')
class FlowIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_ordinary_checkout_handoff_observes_paid_once_without_second_confirm(self):
        from test_payment import PaymentBrowserTests
        fixture_browser = PaymentBrowserTests('test_prepare_fills_card_without_any_payment_or_new_order')
        await fixture_browser.asyncSetUp()
        try:
            fixture_browser.result_mode = 'unknown'
            job = server.Job(str(uuid4()), {'action': 'server', 'plan': 'plus', 'safety': {
                'authorizeSinglePayment': True, 'lockedCurrency': 'MYR', 'maxAmountMinor': 9250}})
            async def human_action(page, guard, kind):
                self.assertIs(page.context, fixture_browser.context)
                self.assertEqual(kind, 'hcaptcha')
                for _ in range(100):
                    if guard.confirm_request is not None and fixture_browser.confirmations == 1:
                        break
                    await asyncio.sleep(.01)
                self.assertEqual(guard.confirmation_sent, 1)
                self.assertTrue(guard.payment_ledger.record['payment_attempted'])
                await guard.response(Response(guard.confirm_request, {'id': 'cs_synthetic',
                    'object': 'checkout.session', 'status': 'complete', 'payment_status': 'paid',
                    'amount_total': 9250, 'currency': 'myr'}))
            bridge = AsyncMock(side_effect=human_action)
            with patch.object(server, 'callback'), patch.object(job, 'await_handoff', bridge), \
                    patch.object(job.confirm_event, 'wait', side_effect=lambda _: job.signal(job.nonce)), \
                    patch('pay.challenge_frames', AsyncMock(return_value=[object()])):
                result = await fixture_browser.flow(confirmer=job.confirm)
            bridge.assert_awaited_once()
            self.assertEqual(result['payment_status'], 'paid', result)
            self.assertEqual(result['payment_requests_sent'], 1)
            self.assertEqual(fixture_browser.confirmations, 1)
            self.assertEqual(fixture_browser.new_checkouts, 0)
        finally:
            await fixture_browser.asyncTearDown()

    async def test_subscription_upgrade_handoff_keeps_single_original_update(self):
        from contextlib import ExitStack
        from pathlib import Path
        import tempfile
        from subscription_upgrade import run_upgrade_in_context, UPGRADE_PATH
        from test_subscription_upgrade import preview, minor_money, details, action_intent
        target = parse_browser_credential(fixture())
        context = SimpleNamespace(unroute=AsyncMock(), on=MagicMock(), remove_listener=MagicMock())
        frame = Frame('https://chatgpt.com/')
        page = SimpleNamespace(main_frame=frame, context=context)
        def attach(_pattern, route):
            context.guard = route.__self__
        context.route = AsyncMock(side_effect=attach)
        async def submit():
            request = Request('https://chatgpt.com' + UPGRADE_PATH, data=json.dumps({
                'account_id': target.account_id, 'updated_plan': 'chatgptpro',
                'payment_method_id': 'pm_Synthetic'}), frame=frame,
                headers={'authorization': 'Bearer ' + target.old_token})
            route = Route(request)
            await context.guard.route(route)
            self.assertTrue(route.passed)
        button = SimpleNamespace(click=AsyncMock(side_effect=submit))
        choice = SimpleNamespace(click=AsyncMock())
        job = server.Job(str(uuid4()), {'action': 'server', 'plan': 'pro-20x', 'safety': {
            'authorizeSinglePayment': True, 'lockedCurrency': 'MYR', 'maxAmountMinor': 40000}})
        async def read(_page, path, _credential):
            return preview() if '/preview' in path else {}
        async def human_action(original_page, guard, kind):
            self.assertIs(original_page, page)
            self.assertEqual(kind, 'hcaptcha')
            self.assertEqual(guard.sent, 1)
            await guard.response(Response(guard.update_request, action_intent(status='succeeded',
                amount_received=40000, next_action=None)))
        bridge = AsyncMock(side_effect=human_action)
        async def inspect(_page, _target, ledger, guard, **_kwargs):
            return {'status': 'paid_pending_activation', 'payment_status': ledger.record['payment_status'],
                    'payment_requests_sent': guard.sent}
        with tempfile.TemporaryDirectory() as directory, ExitStack() as patches:
            for name, replacement in {
                'read_subscription': AsyncMock(return_value=(target, {'current_plan': 'plus'}, {
                    'plan_type': 'plus', 'is_processor_stripe': True, 'will_renew': True})),
                'select_plan': AsyncMock(return_value=choice), 'verify_selected_plan': AsyncMock(),
                'visible_renewal': AsyncMock(return_value=minor_money('MYR', 42000)),
                'verify_preview_dom': AsyncMock(return_value=button), 'browser_read': AsyncMock(side_effect=read),
                'prepare_upgrade_card': AsyncMock(return_value='pm_Synthetic'),
                'verify_selected_upgrade_card': AsyncMock(return_value='pm_Synthetic'),
                'inspect_upgrade': AsyncMock(side_effect=inspect)}.items():
                patches.enter_context(patch('subscription_upgrade.' + name, replacement))
            patches.enter_context(patch.object(server, 'callback'))
            patches.enter_context(patch.object(job.confirm_event, 'wait', side_effect=lambda _: job.signal(job.nonce)))
            patches.enter_context(patch.object(job, 'await_handoff', bridge))
            patches.enter_context(patch('payment_handoff.challenge_frames', AsyncMock(return_value=[object()])))
            result = await run_upgrade_in_context(page, target, Path(directory), 'pro-20x',
                details_reader=lambda _quote: details(), confirmer=job.confirm)
        self.assertEqual(bridge.await_count, 1, result)
        self.assertEqual(result['payment_status'], 'paid', result)
        self.assertEqual(result['payment_requests_sent'], 1)
        button.click.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
