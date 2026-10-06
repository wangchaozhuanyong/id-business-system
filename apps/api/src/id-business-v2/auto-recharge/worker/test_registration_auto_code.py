"""Automatic registration email delivery; API and browser networks stay in memory."""
import asyncio
import json
import os
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import urlsplit

from checkout_core import Stop
import registration_builtin as builtin
import registration_job
from registration_browser import RegistrationBrowser
from test_registration_builtin import server_payload


class MemoryResponse:
    def __init__(self, value):
        self.body = json.dumps({'success': True, 'data': value}).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, limit):
        if len(self.body) > limit:
            raise AssertionError('Synthetic response exceeded the production limit')
        return self.body


class MemoryMailApi:
    def __init__(self, job, deliveries, *, on_read=None):
        self.job = job
        self.deliveries = iter(deliveries)
        self.on_read = on_read
        self.polls = 0
        self.events = []
        self.rejections = []

    def deliver_next(self):
        value = next(self.deliveries, None)
        if value is None:
            return
        if not value.get('code'):
            # One empty catch-up followed by a distinct synthetic arrival event.
            asyncio.get_running_loop().call_soon(self.deliver_next)
            return
        if self.on_read:
            self.on_read()
        try:
            self.job.signal_code(value['code'], value['attempt'], value['step'], value['mailId'])
        except Stop as error:
            self.rejections.append(error.report['reason'])
            self.job.signal_cancel()

    def open(self, request, timeout):
        if type(timeout) not in (int, float) or not 0 < timeout <= 10 or request.get_method() != 'POST':
            raise AssertionError('Unexpected automatic email API request')
        body = json.loads(request.data)
        if request.full_url == self.job.payload['callbackUrl'] + '/code':
            self.polls += 1
            raise AssertionError('The Worker must not query mail on a fixed interval')
        if request.full_url != self.job.payload['callbackUrl']:
            raise AssertionError('No external API destination is permitted')
        self.events.append(body)
        if body['type'] == 'waiting_email':
            asyncio.get_running_loop().call_soon(self.deliver_next)
        return MemoryResponse({'step': body['step']})


def fixture(deliveries, *, on_read=None, prepare=True):
    value = server_payload()
    job = builtin.RegistrationServerJob(
        value['id'], value,
        'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
    api = MemoryMailApi(job, deliveries, on_read=on_read)
    stack = ExitStack()
    stack.enter_context(patch.object(builtin, 'build_opener', return_value=api))
    stack.enter_context(patch.object(registration_job, 'build_opener', return_value=api))
    if prepare:
        job.prepare_mail('email_code')
    return job, api, stack


def delivery(*, attempt=1, step='email_code'):
    return {'code': '123456', 'mailId': 'synthetic-current-mail',
            'attempt': attempt, 'step': step}


class AutoMailEventTests(unittest.IsolatedAsyncioTestCase):
    async def test_waiting_mail_always_binds_an_explicit_boolean_request_kind(self):
        for new_request in [False, True]:
            with self.subTest(new_request=new_request):
                job, api, stack = fixture([], prepare=False)
                with stack:
                    job.prepare_mail('email_code', new_request=new_request)
                self.assertEqual(len(api.events), 1)
                self.assertEqual(api.events[0]['type'], 'waiting_email')
                self.assertIs(api.events[0]['newMailRequest'], new_request)

    async def test_non_boolean_request_kind_cannot_change_pending_mail_state(self):
        for new_request in [1, 'true', None]:
            with self.subTest(value_type=type(new_request).__name__):
                job, api, stack = fixture([], prepare=False)
                with stack:
                    with self.assertRaises(Stop) as stopped:
                        job.prepare_mail('email_code', new_request=new_request)
                self.assertEqual(stopped.exception.report['reason'], 'invalid_registration_payload')
                self.assertFalse(job.awaiting_code)
                self.assertIsNone(job.pending_code)
                self.assertEqual(api.events, [])

    async def test_resumed_email_form_marks_a_new_request_before_continue_click(self):
        job, api, stack = fixture([], prepare=False)
        job.step = 'email_code'
        form = SimpleNamespace()
        field = SimpleNamespace(fill=AsyncMock(), press=AsyncMock(),
                                input_value=AsyncMock(return_value=job.payload['email']),
                                evaluate_handle=AsyncMock(return_value=SimpleNamespace(as_element=lambda: form)))
        async def submit(*, timeout):
            self.assertGreater(timeout, 0)
            waiting = [event for event in api.events if event['type'] == 'waiting_email']
            self.assertEqual(len(waiting), 1)
            self.assertIs(waiting[0]['newMailRequest'], True)
            self.assertEqual(waiting[0]['step'], 'email_code')
            self.assertEqual(api.polls, 0)
            raise Stop('operation_cancelled')
        button = SimpleNamespace(is_enabled=AsyncMock(return_value=True),
                                 click=AsyncMock(side_effect=submit))
        flow = RegistrationBrowser(job, None)
        flow.page = SimpleNamespace(url='https://auth.openai.com/email-verification')
        flow.registration_view = AsyncMock(return_value=('email', field))
        flow.button = AsyncMock(return_value=button)
        flow.email_submit_control = AsyncMock(return_value=(field, button, None))
        flow.email_submit_unchanged = AsyncMock(return_value=True)
        flow.field = AsyncMock(return_value=field)
        flow.challenge = AsyncMock(return_value=False)
        with stack:
            with self.assertRaises(Stop) as stopped:
                await asyncio.wait_for(flow.register(), 3)
        self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
        field.fill.assert_awaited_once_with(job.payload['email'])
        button.click.assert_awaited_once()
        flow.email_submit_unchanged.assert_awaited_once_with(
            field, button, form, flow.page, flow.page.url)
        field.press.assert_not_awaited()
        self.assertEqual([event['type'] for event in api.events], ['progress', 'waiting_email'])

    async def test_existing_code_page_restores_the_original_request_then_submits_once(self):
        job, api, stack = fixture([delivery()], prepare=False)
        job.step = 'email_code'
        field = SimpleNamespace(fill=AsyncMock(), press=AsyncMock())
        flow = RegistrationBrowser(job, None)
        flow.page = SimpleNamespace(url='https://auth.openai.com/email-verification')
        flow.registration_view = AsyncMock(side_effect=[('code', field), Stop('operation_cancelled')])
        flow.field = AsyncMock(return_value=field)
        flow.settle = AsyncMock()
        with stack:
            with self.assertRaises(Stop) as stopped:
                await asyncio.wait_for(flow.register(), 3)
        self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
        self.assertEqual([event['type'] for event in api.events], ['waiting_email', 'mail_accepted'])
        self.assertIs(api.events[0]['newMailRequest'], False)
        self.assertEqual(api.polls, 0)
        field.fill.assert_awaited_once_with('123456')
        field.press.assert_awaited_once_with('Enter')
        self.assertFalse(job.awaiting_code)
        self.assertIsNone(job.pending_code)

    async def test_private_delivery_consumes_matching_mail_and_acknowledges_once(self):
        job, api, stack = fixture([delivery()])
        with stack:
            self.assertEqual(await asyncio.wait_for(job.wait_code(), 3), '123456')
            self.assertEqual(api.polls, 0)
            self.assertFalse(job.awaiting_code)
            self.assertIsNone(job.pending_code)
            accepted = [event for event in api.events if event['type'] == 'mail_accepted']
            self.assertEqual(len(accepted), 1)
            self.assertEqual(accepted[0]['mailId'], 'synthetic-current-mail')
            self.assertFalse(job.resume_event.is_set())
            with self.assertRaises(Stop) as stopped:
                job.signal_code('654321', attempt=1, step='email_code',
                                mail_id='synthetic-late-mail')
            self.assertEqual(stopped.exception.report['reason'], 'invalid_login_code')
            self.assertIsNone(job.pending_code)

    async def test_wrong_attempt_or_step_from_api_cannot_be_consumed(self):
        for value in [delivery(attempt=2), delivery(step='password')]:
            with self.subTest(binding='attempt' if value['attempt'] != 1 else 'step'):
                job, api, stack = fixture([value])
                with stack:
                    with self.assertRaises(Stop) as stopped:
                        await asyncio.wait_for(job.wait_code(), 3)
                    self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
                    self.assertEqual(api.rejections, ['invalid_login_code'])
                    self.assertIsNone(job.pending_code)
                    self.assertFalse(any(event['type'] == 'mail_accepted' for event in api.events))

    async def test_cancel_during_read_rejects_late_mail_before_acknowledgement(self):
        job, api, stack = fixture([delivery()])
        api.on_read = job.signal_cancel
        with stack:
            with self.assertRaises(Stop) as stopped:
                await asyncio.wait_for(job.wait_code(), 3)
            self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
            self.assertEqual(api.polls, 0)
            self.assertFalse(any(event['type'] == 'mail_accepted' for event in api.events))


@unittest.skipUnless(os.environ.get('V2_REGISTRATION_BROWSER_TEST') == '1', 'explicit local fixture')
class AutoMailBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def browser_flow(self, deliveries, *, expected_reason=None, cancel_during_read=False):
        from playwright.async_api import async_playwright
        job, api, stack = fixture(deliveries, prepare=False)
        self.addCleanup(stack.close)
        if cancel_during_read:
            api.on_read = job.signal_cancel
        writes = []
        errors = []
        html = '''<!doctype html><html><head><meta charset="utf-8"></head><body>
<form><p>Check your email. Email verification code</p>
<input name="code" autocomplete="one-time-code"><button>Continue</button></form>
<script>
window.fillCount = 0; window.submitCount = 0;
document.querySelector('input').addEventListener('input', () => window.fillCount++);
document.querySelector('form').onsubmit = async event => {
  event.preventDefault(); window.submitCount++;
  await fetch('/fixture/verify', {method: 'POST', body: JSON.stringify({
    code: document.querySelector('input').value})});
  document.querySelector('p').textContent = 'Synthetic email accepted';
};
</script></body></html>'''
        async with async_playwright() as driver:
            browser = await driver.chromium.launch(headless=True,
                args=['--disable-background-networking'])
            context = await browser.new_context(service_workers='block')
            try:
                async def serve(route):
                    request = route.request
                    path = urlsplit(request.url).path
                    if request.method == 'POST':
                        self.assertEqual(path, '/fixture/verify')
                        self.assertEqual(json.loads(request.post_data), {'code': '123456'})
                        writes.append(path)
                        await route.fulfill(content_type='application/json', body='{}')
                    else:
                        self.assertEqual(request.method, 'GET')
                        await route.fulfill(content_type='text/html', body=html)
                await context.route('**/*', serve)
                page = await context.new_page()
                page.on('pageerror', lambda error: errors.append(type(error).__name__))
                await page.goto('https://auth.openai.com/email-verification')
                flow = RegistrationBrowser(job, context)
                with stack:
                    job.prepare_mail('email_code')
                    if expected_reason:
                        with self.assertRaises(Stop) as stopped:
                            await asyncio.wait_for(flow.mail(page), 15)
                        self.assertEqual(stopped.exception.report['reason'], expected_reason)
                    else:
                        await asyncio.wait_for(flow.mail(page), 15)
                        await page.get_by_text('Synthetic email accepted', exact=True).wait_for()
                counts = await page.evaluate('({fills: window.fillCount, submits: window.submitCount})')
                expected = 0 if expected_reason else 1
                self.assertEqual(counts, {'fills': expected, 'submits': expected})
                self.assertEqual(len(writes), expected)
                self.assertFalse(job.resume_event.is_set())
                self.assertEqual(errors, [])
                self.assertFalse(job.payload['passwordVerified'])
                self.assertFalse(job.payload['mfaVerified'])
                return api
            finally:
                stack.close()
                await context.close()
                await browser.close()

    async def test_api_email_is_automatically_filled_and_entered_once(self):
        api = await self.browser_flow([delivery()])
        self.assertEqual(api.polls, 0)
        self.assertEqual([event['type'] for event in api.events], ['waiting_email', 'mail_accepted'])

    async def test_empty_catchup_then_arrival_event_is_submitted_once(self):
        api = await self.browser_flow([{'code': None}, delivery()])
        self.assertEqual(api.polls, 0)
        self.assertEqual([event['type'] for event in api.events], ['waiting_email', 'mail_accepted'])

    async def test_wrong_attempt_and_step_never_fill_or_submit_the_page(self):
        for value in [delivery(attempt=2), delivery(step='password')]:
            with self.subTest(binding='attempt' if value['attempt'] != 1 else 'step'):
                api = await self.browser_flow([value], expected_reason='operation_cancelled')
                self.assertEqual(api.rejections, ['invalid_login_code'])
                self.assertEqual([event['type'] for event in api.events], ['waiting_email'])

    async def test_cancelled_read_never_fills_or_submits_late_mail(self):
        api = await self.browser_flow([delivery()], expected_reason='operation_cancelled',
                                      cancel_during_read=True)
        self.assertEqual([event['type'] for event in api.events], ['waiting_email'])
