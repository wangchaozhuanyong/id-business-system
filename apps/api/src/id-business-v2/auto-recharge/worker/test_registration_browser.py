"""Real browser DOM fixture; all requests are fulfilled locally in memory."""
import asyncio
import base64
import os
import json
import time
from urllib.parse import urlsplit
import unittest
import threading
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock, MagicMock
from checkout_core import Stop
from registration_security import totp
from registration_browser import RegistrationBrowser


@unittest.skipUnless(os.environ.get('V2_REGISTRATION_BROWSER_TEST') == '1', 'explicit local fixture')
class BrowserTests(unittest.IsolatedAsyncioTestCase):
    async def test_full_local_registration_flow(self):
        await self.full_flow()

    async def test_fresh_registration_email_only_login_sets_then_proves_password(self):
        await self.full_flow(fresh_mail_login=True)

    async def test_fresh_email_identity_without_add_password_entry_does_not_configure(self):
        await self.full_flow(fresh_mail_login=True, entry='missing', expected_reason='verification_required')

    async def test_fresh_email_identity_cannot_configure_another_original_window(self):
        await self.full_flow(fresh_mail_login=True, wrong_original=True, expected_reason='official_login_not_verified')

    async def test_fresh_email_identity_with_configured_password_evidence_does_not_configure(self):
        for entry in ['current_password', 'change_password', 'reset_password', 'ambiguous']:
            with self.subTest(entry=entry):
                await self.full_flow(fresh_mail_login=True, entry=entry, expected_reason='verification_required')

    async def test_fresh_email_identity_cannot_configure_while_original_has_captcha(self):
        await self.full_flow(fresh_mail_login=True, original_captcha=True, expected_reason='verification_required')

    async def test_saved_password_still_requires_strict_password_login(self):
        await self.full_flow(fresh_mail_login=True, email_after_save=True, expected_reason='verification_required')

    async def full_flow(self, *, fresh_mail_login=False, entry='add', wrong_original=False,
                        original_captcha=False, email_after_save=False, expected_reason=None):
        from playwright.async_api import async_playwright
        state = {'registered': False, 'password': None, 'mfa': False}
        events = []; receipts = []; expected = 'owner@example.test'; key = 'JBSWY3DPEHPK3PXP'
        operations = []; contexts = []; page_errors = []
        class Job:
            def __init__(self):
                self.payload = dict(email=expected, password='synthetic-only-password', displayName='李华', birthDate='1996-01-01', registered=False, passwordVerified=False, mfaVerified=False, totpSecret=None)
                self.step = 'queued'; self.awaiting_code = False
                self.cancelled = threading.Event()
            def check(self):
                pass
            def event(self, event_type, **data):
                events.append(event_type); self.step = data.get('step', self.step)
                receipts.append((event_type, data))
            def prepare_mail(self, step, *, new_request=False):
                receipts.append(('waiting_email', {'step': step, 'newMailRequest': new_request}))
                self.step = step; self.awaiting_code = True
            async def wait_code(self):
                self.awaiting_code = False; return '123456'
            async def manual(self, reason):
                raise AssertionError('Supported local fixture unexpectedly paused: ' + reason)
        html = '''<!doctype html><html><body><main id="app"></main><script>
const root=document.getElementById('app');window.accountEmail='';
function profile(){root.innerHTML='<form><input name="name" autocomplete="name"><input type="date" name="birthdate"><button>Continue</button></form>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();await window.fixture('profile',{name:root.querySelector('[name=name]').value,birth:root.querySelector('[name=birthdate]').value});window.accountEmail='owner@example.test';settings();};}
function settings(){root.innerHTML='<button>Security</button><button>Add password</button><button role="switch" aria-label="Authenticator app" aria-checked="false">Authenticator app</button><aside><div aria-label="Special offer">Try 1 month free</div></aside>';const buttons=root.querySelectorAll('button');buttons[0].onclick=()=>{};buttons[1].onclick=()=>{root.innerHTML='<form><input type="password" autocomplete="new-password"><input type="password" autocomplete="new-password"><button>Save password</button></form>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();await window.fixture('password',{password:root.querySelector('input').value});settings();};};buttons[2].onclick=()=>{root.innerHTML='<div role="dialog" aria-label="Set authenticator"><span>Scan setup key</span><code>JBSWY3DPEHPK3PXP</code><form><input name="code" autocomplete="one-time-code"><button>Continue</button></form></div>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();await window.fixture('enroll',{code:root.querySelector('input').value});settings();root.querySelector('[role=switch]').setAttribute('aria-checked','true');};};}
root.innerHTML='<form><input type="email" name="email"><button>Continue</button></form>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const email=root.querySelector('input').value;const snapshot=await window.fixture('email',{email});if(!snapshot.registered){root.innerHTML='<form><input name="code" autocomplete="one-time-code"><button>Continue</button></form>';root.querySelector('form').onsubmit=ev=>{ev.preventDefault();profile();};}else{root.innerHTML='<form><input type="password" autocomplete="current-password"><button>Continue</button></form>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const check=await window.fixture('login',{password:root.querySelector('input').value});if(!check.correct){root.innerHTML='<p>Wrong password</p>';return;}if(!check.mfa){window.accountEmail=email;settings();return;}root.innerHTML='<form><p>Authenticator app</p><input name="code" autocomplete="one-time-code"><button>Continue</button></form>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();await window.fixture('challenge',{code:root.querySelector('input').value});window.accountEmail=email;settings();};};}};
</script></body></html>'''
        if fresh_mail_login:
            email_only = '''if(snapshot.password === null || __EMAIL_AFTER_SAVE__){root.innerHTML='<form><p>Check your email. Email verification code</p><input name="code" autocomplete="one-time-code"><button>Continue</button></form>';root.querySelector('form').onsubmit=async ev=>{ev.preventDefault();await window.fixture('login-email',{code:root.querySelector('input').value});window.accountEmail=email;settings();};return;}'''
            html = html.replace("}else{root.innerHTML='<form><input type=\"password\"", "}else{" + email_only.replace('__EMAIL_AFTER_SAVE__', json.dumps(email_after_save)) + "root.innerHTML='<form><input type=\"password\"")
            html = html.replace('buttons[1].onclick=()=>{', "buttons[1].onclick=async()=>{await window.fixture('password-open',{});")
        entry_markup = {
            'missing': "buttons[1].style.display='none';",
            'current_password': "root.insertAdjacentHTML('beforeend','<input type=\"password\" autocomplete=\"current-password\">');",
            'change_password': "root.insertAdjacentHTML('beforeend','<button>Change password</button>');",
            'reset_password': "root.insertAdjacentHTML('beforeend','<button>Reset password</button>');",
            'ambiguous': "root.insertAdjacentHTML('beforeend','<button>Add password</button>');"
        }
        html = html.replace("const buttons=root.querySelectorAll('button');", "const buttons=root.querySelectorAll('button');" + entry_markup.get(entry, ''))
        html = html.replace('const root=', "window.fixture=async (operation,data)=>{const response=await fetch('/fixture/'+operation,{method:'POST',body:JSON.stringify(data)});return response.json();};const root=").replace("window.accountEmail='owner@example.test'", "window.accountEmail='owner@example.test';document.documentElement.dataset.accountEmail=window.accountEmail").replace('window.accountEmail=email', 'window.accountEmail=email;document.documentElement.dataset.accountEmail=window.accountEmail')
        async def binding(_source, operation, data):
            operations.append(operation)
            if operation == 'email':
                self.assertEqual(data['email'], expected); return dict(state)
            if operation == 'profile':
                self.assertEqual(data, {'name': '李华', 'birth': '1996-01-01'}); state['registered'] = True
            if operation == 'password':
                self.assertFalse(job.payload['passwordVerified'])
                state['password'] = data['password']
            if operation == 'password-open':
                self.assertFalse(job.payload['passwordVerified'])
                self.assertIsNone(state['password'])
                self.assertIn('login-email', operations[:-1])
            if operation == 'login-email':
                self.assertEqual(data['code'], '123456')
                self.assertFalse(job.payload['passwordVerified'])
                if original_captcha:
                    await flow.page.evaluate('document.body.insertAdjacentHTML("beforeend", "<div class=cf-turnstile>Verify you are human</div>")')
            if operation == 'login':
                return {'correct': state['password'] is not None and data['password'] == state['password'], 'mfa': state['mfa']}
            if operation in {'enroll', 'challenge'}:
                self.assertEqual(data['code'], totp(key)); state['mfa'] = True
            return dict(state)
        async def identity(page, email, **_kwargs):
            if wrong_original and len(contexts) > 1 and page is flow.page:
                return None
            current = await page.evaluate('document.documentElement.dataset.accountEmail || \"\"'); self.assertIn(current, ['', expected])
            return ('synthetic-target', 'synthetic-identity') if current == email else None
        async with async_playwright() as driver:
            if os.environ.get('V2_REGISTRATION_FINGERPRINT_BINARY'):
                from fingerprint_runtime import launch_fingerprint_browser
                browser = await launch_fingerprint_browser(driver, headless=True,
                    executable_path=os.environ['V2_REGISTRATION_FINGERPRINT_BINARY'])
            else:
                browser = await driver.chromium.launch(headless=True)
            original_context = browser.new_context
            async def fixture_context():
                context = await original_context(); original_page = context.new_page
                contexts.append(context)
                async def fixture_page():
                    page = await original_page()
                    page.on('pageerror', lambda error: page_errors.append(type(error).__name__))
                    async def serve(route):
                        path = urlsplit(route.request.url).path
                        if path == '/cdn-cgi/trace':
                            await route.fulfill(content_type='text/plain', body='ip=192.0.2.1\nloc=PH\n')
                        elif path.startswith('/fixture/'):
                            data = await binding(None, path.split('/')[-1], json.loads(route.request.post_data))
                            await route.fulfill(content_type='application/json', body=json.dumps(data))
                        else:
                            await route.fulfill(content_type='text/html', body=html)
                    await page.route('**/*', serve)
                    return page
                context.new_page = fixture_page
                return context
            browser.new_context = fixture_context
            context = await fixture_context(); job = Job(); flow = RegistrationBrowser(job, context)
            async def settle(_seconds=2):
                await asyncio.sleep(.02)
            flow.settle = settle
            try:
                with patch('registration_browser.official_identity', identity):
                    if expected_reason:
                        with self.assertRaises(Stop) as stopped: await flow.run()
                        self.assertEqual(stopped.exception.report['reason'], expected_reason)
                    else:
                        await flow.run()
                self.assertEqual(page_errors, [])
                if expected_reason:
                    self.assertTrue(state['registered'])
                    self.assertFalse(job.payload['passwordVerified'])
                    self.assertNotIn('password_verified', events)
                    self.assertNotIn('mfa_verified', events)
                    self.assertNotIn('complete', events)
                    if email_after_save:
                        self.assertIn('password', operations)
                        self.assertEqual(operations.count('login-email'), 2)
                    else:
                        self.assertIsNone(state['password'])
                        self.assertNotIn('password-open', operations)
                    return
                self.assertTrue(state['registered']); self.assertTrue(state['mfa']); self.assertEqual(state['password'], job.payload['password'])
                for stage in ['registered', 'password_verified', 'totp_pending', 'mfa_verified', 'offer', 'complete']:
                    self.assertIn(stage, events)
                self.assertTrue(job.payload['passwordVerified']); self.assertTrue(job.payload['mfaVerified'])
                registered = [data for event_type, data in receipts if event_type == 'registered']
                self.assertEqual(len(registered), 1)
                self.assertEqual(registered[0]['registrationCountryCode'], 'PH')
                self.assertNotIn('ip', registered[0])
                if fresh_mail_login:
                    self.assertEqual(operations.count('password-open'), 1)
                    self.assertEqual(operations.count('login-email'), 1)
                    self.assertLess(operations.index('login-email'), operations.index('password-open'))
                    self.assertLess(operations.index('password-open'), operations.index('password'))
                    self.assertGreater(operations.count('login'), 0)
            finally:
                await browser.close()


@unittest.skipUnless(os.environ.get('V2_REGISTRATION_BROWSER_TEST') == '1', 'explicit local fixture')
class VerificationBrowserTests(unittest.IsolatedAsyncioTestCase):
    """Clean-context login challenges; every request is fulfilled in memory."""
    async def verify(self, stages, *, mfa=False, change_during_mail=None, mail_value='123456', delay_code=False,
                     change_on_fill=None, offer_password_choice=False, tel_codes=False, allow_email_identity=False):
        from playwright.async_api import async_playwright
        expected = 'verification@example.invalid'
        secret = 'JBSWY3DPEHPK3PXP'
        submissions = []; contexts = []; pages = []; order = []; page_errors = []
        index = 0
        html = '''<!doctype html><html><head><meta charset="utf-8"></head><body><main></main><script>
        const changeOnFill = __CHANGE_ON_FILL__;
        const passwordChoice = __PASSWORD_CHOICE__;
        window.render = stage => {
          document.documentElement.dataset.stage = stage;
          const root = document.querySelector('main');
          if (stage === 'identity') { root.innerHTML = '<p>Welcome</p>'; return; }
          if (stage === 'blank') { root.innerHTML = '<p>Loading...</p>'; return; }
          if (stage === 'wrong_password') { root.innerHTML = '<p>Wrong password</p>'; return; }
          const field = stage === 'email' ? '<input type="email" name="username" autocomplete="username">'
            : stage === 'password' ? '<input type="password" autocomplete="current-password">'
            : stage === 'phone' ? '<input type="tel" name="phone_number">'
            : '<input name="code" autocomplete="one-time-code">';
          const label = stage === 'email_code' ? 'Check your email. Email verification code'
            : stage === 'totp_code' ? 'Authenticator app'
            : stage === 'sms' ? 'Text message sent to your phone number'
            : stage === 'phone' ? 'Verify your phone number'
            : stage === 'captcha' ? 'Verify you are human. Check your email'
            : stage === 'email_chinese' ? '安全验证：邮箱验证码'
            : stage === 'totp_chinese' ? '安全验证：身份验证应用'
            : stage === 'unknown' ? 'Enter verification code' : 'Continue';
          root.innerHTML = '<form><p>' + label + '</p>' + field + '<button>Continue</button></form>'
            + (stage === 'captcha_frame' ? '<div class="cf-turnstile">Challenge</div>' : '');
          root.querySelector('input').oninput = event => {
            if (event.target.value && changeOnFill[stage]) {
              root.querySelector('p').textContent = changeOnFill[stage] === 'totp_code'
                ? 'Authenticator app' : 'Check your email. Email verification code';
            }
          };
          if (stage === 'email_code' && passwordChoice) {
            const button = document.createElement('button'); button.textContent = 'Use password';
            button.onclick = async () => {const response = await fetch('/fixture/use-password', {method:'POST'});
              window.render((await response.json()).next);};
            root.appendChild(button);
          }
          root.querySelector('form').onsubmit = async event => {
            event.preventDefault();
            const response = await fetch('/fixture/submit', {method:'POST',
              body:JSON.stringify({stage, value:root.querySelector('input').value})});
            const next = await response.json();
            if (next.delay) { setTimeout(() => window.render(next.next), next.delay); }
            else { window.render(next.next); }
          };
        };
        window.render('email');
        </script></body></html>'''
        html = html.replace('__CHANGE_ON_FILL__', json.dumps(change_on_fill or {})).replace(
            '__PASSWORD_CHOICE__', json.dumps(offer_password_choice))
        if tel_codes:
            html = html.replace('<input name="code" autocomplete="one-time-code">',
                                '<input type="tel" name="code" autocomplete="one-time-code">')
        async with async_playwright() as driver:
            if os.environ.get('V2_REGISTRATION_FINGERPRINT_BINARY'):
                from fingerprint_runtime import launch_fingerprint_browser
                browser = await launch_fingerprint_browser(driver, headless=True,
                    executable_path=os.environ['V2_REGISTRATION_FINGERPRINT_BINARY'])
            else:
                browser = await driver.chromium.launch(headless=True)
            original = await browser.new_context()
            async def new_context():
                context = await browser.new_context(); contexts.append(context)
                create_page = context.new_page
                async def new_page():
                    page = await create_page(); pages.append(page)
                    page.on('pageerror', lambda error: page_errors.append(type(error).__name__))
                    async def local(route):
                        nonlocal index
                        if urlsplit(route.request.url).path == '/fixture/use-password':
                            self.assertEqual(stages[index], 'email_code')
                            submissions.append('use_password'); index += 1
                            await route.fulfill(content_type='application/json', body=json.dumps({'next': stages[index]}))
                        elif urlsplit(route.request.url).path == '/fixture/submit':
                            value = json.loads(route.request.post_data)
                            self.assertEqual(value['stage'], stages[index])
                            submissions.append(value['stage']); order.append(value['stage'])
                            if value['stage'] == 'email':
                                self.assertEqual(value['value'], expected)
                            elif value['stage'] == 'password':
                                self.assertEqual(value['value'], 'synthetic-only-password')
                            elif value['stage'] in ['email_code', 'email_chinese']:
                                self.assertEqual(value['value'], '123456')
                            elif value['stage'] in ['totp_code', 'totp_chinese']:
                                self.assertEqual(value['value'], totp(secret))
                            else:
                                self.fail('Unrecognized challenge must never be submitted')
                            index += 1
                            await route.fulfill(content_type='application/json',
                                body=json.dumps({'next': stages[index], 'delay': 150 if delay_code and value['stage'] in ['email_code', 'totp_code'] else 0}))
                        else:
                            await route.fulfill(content_type='text/html', body=html)
                    await page.route('**/*', local)
                    return page
                context.new_page = new_page
                return context
            def prepare(step, *, new_request=False):
                self.assertEqual(step, 'mfa' if mfa else 'password')
                self.assertIs(new_request, True)
                order.append('prepared')
            async def mail():
                order.append('mail_read')
                if change_during_mail == 'cancel':
                    job.check = MagicMock(side_effect=Stop('operation_cancelled'))
                elif change_during_mail == 'expired':
                    raise Stop('registration_authorization_expired')
                elif change_during_mail == 'timeout':
                    raise asyncio.TimeoutError()
                elif change_during_mail:
                    labels = {'totp_code': 'Authenticator app', 'unknown': 'Enter verification code',
                              'sms': 'Text message sent to your phone number', 'captcha': 'Verify you are human'}
                    await pages[0].evaluate('label => {document.querySelector("main").innerHTML = "<form><p>" + label + "</p><input name=code autocomplete=one-time-code><button>Continue</button></form>";}', labels[change_during_mail])
                return mail_value
            job = SimpleNamespace(payload={'email': expected, 'password': 'synthetic-only-password',
                'totpSecret': secret}, step='mfa' if mfa else 'password', check=lambda: None,
                new_verification_context=AsyncMock(side_effect=new_context),
                prepare_mail=MagicMock(side_effect=prepare), wait_code=AsyncMock(side_effect=mail))
            flow = RegistrationBrowser(job, original)
            async def settle(_seconds=2):
                await asyncio.sleep(.025)
            flow.settle = settle
            async def identity(page, email, **_kwargs):
                self.assertEqual(email, expected)
                return ('synthetic-target', 'synthetic-identity') if await page.evaluate(
                    'document.documentElement.dataset.stage') == 'identity' else None
            try:
                with patch('registration_browser.official_identity', identity):
                    try:
                        verified = await flow.verify_login(mfa=mfa, allow_email_identity=allow_email_identity)
                        result = 'verified' if verified is True else 'email_identity_only' if verified is False else 'unknown'
                    except Stop as stopped:
                        result = stopped.report['reason']
                self.assertEqual(page_errors, [])
                self.assertEqual(len(contexts), 1)
                self.assertEqual(browser.contexts, [original])
                self.assertEqual(job.new_verification_context.await_count, 1)
                return result, submissions, job, order
            finally:
                await browser.close()

    async def test_email_before_password_uses_current_step_and_request_window(self):
        result, submissions, job, order = await self.verify(['email', 'email_code', 'password', 'identity'])
        self.assertEqual(result, 'verified')
        self.assertEqual(submissions, ['email', 'email_code', 'password'])
        job.prepare_mail.assert_called_once_with('password', new_request=True); job.wait_code.assert_awaited_once()
        self.assertLess(order.index('prepared'), order.index('email'))

    async def test_email_after_password_uses_the_same_verification_context(self):
        result, submissions, job, _ = await self.verify(['email', 'password', 'email_code', 'identity'])
        self.assertEqual(result, 'verified')
        self.assertEqual(submissions, ['email', 'password', 'email_code'])
        job.prepare_mail.assert_called_once_with('password', new_request=True); job.wait_code.assert_awaited_once()

    async def test_email_and_totp_are_verified_separately_in_both_orders(self):
        for codes in [('email_code', 'totp_code'), ('totp_code', 'email_code')]:
            with self.subTest(codes=codes):
                result, submissions, job, _ = await self.verify(['email', 'password', *codes, 'identity'], mfa=True)
                self.assertEqual(result, 'verified')
                self.assertEqual(submissions, ['email', 'password', *codes])
                job.prepare_mail.assert_called_once_with('mfa', new_request=True); job.wait_code.assert_awaited_once()

    async def test_email_before_password_then_totp_proves_both_credentials(self):
        result, submissions, job, _ = await self.verify(['email', 'email_code', 'password', 'totp_code', 'identity'], mfa=True)
        self.assertEqual(result, 'verified')
        self.assertEqual(submissions, ['email', 'email_code', 'password', 'totp_code'])
        job.wait_code.assert_awaited_once()

    async def test_email_alone_cannot_prove_mfa_or_replace_password(self):
        for stages, mfa, reason in [(['email', 'password', 'email_code', 'identity'], True, 'mfa_unverified'),
                                   (['email', 'email_code', 'identity'], False, 'verification_required')]:
            with self.subTest(mfa=mfa):
                result, submissions, job, _ = await self.verify(stages, mfa=mfa)
                self.assertEqual(result, reason)
                self.assertEqual(submissions, stages[:-1]); job.wait_code.assert_awaited_once()

    async def test_email_identity_candidate_is_private_requires_otp_and_never_proves_mfa(self):
        result, submissions, job, _ = await self.verify(['email', 'email_code', 'identity'], allow_email_identity=True)
        self.assertEqual(result, 'email_identity_only')
        self.assertEqual(submissions, ['email', 'email_code']); job.wait_code.assert_awaited_once()
        result, _, job, _ = await self.verify(['email', 'email_code', 'identity'], mfa=True, allow_email_identity=True)
        self.assertEqual(result, 'verification_required'); job.wait_code.assert_awaited_once()
        result, submissions, job, _ = await self.verify(['email', 'identity'], allow_email_identity=True)
        self.assertEqual(result, 'verification_required')
        self.assertEqual(submissions, ['email']); job.wait_code.assert_not_awaited()

    async def test_unrecognized_empty_pages_never_claim_a_missing_password(self):
        for stages in [['email', 'blank', 'identity'], ['email', 'password', 'blank', 'identity']]:
            with self.subTest(stages=stages):
                result, submissions, job, _ = await self.verify(stages)
                self.assertEqual(result, 'verification_required')
                self.assertEqual(submissions, stages[:stages.index('blank')]); job.wait_code.assert_not_awaited()

    async def test_explicit_wrong_password_preserves_original_configuration_recovery(self):
        result, submissions, job, _ = await self.verify(['email', 'password', 'wrong_password'])
        self.assertEqual(result, 'password_unverified')
        self.assertEqual(submissions, ['email', 'password']); job.wait_code.assert_not_awaited()

    async def test_explicit_chinese_code_text_is_not_mistaken_for_captcha(self):
        result, submissions, job, _ = await self.verify(['email', 'password', 'email_chinese', 'totp_chinese', 'identity'], mfa=True)
        self.assertEqual(result, 'verified')
        self.assertEqual(submissions, ['email', 'password', 'email_chinese', 'totp_chinese']); job.wait_code.assert_awaited_once()

    async def test_delayed_code_transition_waits_without_resubmitting(self):
        result, submissions, job, _ = await self.verify(['email', 'password', 'totp_code', 'email_code', 'identity'], mfa=True, delay_code=True)
        self.assertEqual(result, 'verified')
        self.assertEqual(submissions, ['email', 'password', 'totp_code', 'email_code']); job.wait_code.assert_awaited_once()

    async def test_available_password_choice_is_used_before_email_only_login(self):
        result, submissions, job, _ = await self.verify(['email', 'email_code', 'password', 'identity'], offer_password_choice=True)
        self.assertEqual(result, 'verified')
        self.assertEqual(submissions, ['email', 'use_password', 'password']); job.wait_code.assert_not_awaited()

    async def test_input_event_changing_code_type_cannot_submit_to_another_challenge(self):
        for current, changed in [('email_code', 'totp_code'), ('totp_code', 'email_code')]:
            with self.subTest(current=current):
                result, submissions, job, _ = await self.verify(['email', 'password', current, 'identity'], mfa=True,
                    change_on_fill={current: changed})
                self.assertEqual(result, 'verification_required')
                self.assertEqual(submissions, ['email', 'password'])
                self.assertEqual(job.wait_code.await_count, int(current == 'email_code'))

    async def test_tel_input_for_explicit_email_code_is_not_a_phone_challenge(self):
        result, submissions, job, _ = await self.verify(['email', 'password', 'email_code', 'identity'], tel_codes=True)
        self.assertEqual(result, 'verified')
        self.assertEqual(submissions, ['email', 'password', 'email_code']); job.wait_code.assert_awaited_once()

    async def test_each_code_type_and_password_are_submitted_at_most_once(self):
        for repeated, mfa in [('email_code', False), ('totp_code', True), ('password', False)]:
            with self.subTest(repeated=repeated):
                stages = ['email', 'password'] + ([] if repeated == 'password' else [repeated]) + [repeated, 'identity']
                result, submissions, job, _ = await self.verify(stages, mfa=mfa)
                self.assertEqual(result, 'verification_required')
                self.assertEqual(submissions.count(repeated), 1)
                self.assertEqual(job.wait_code.await_count, int(repeated == 'email_code'))

    async def test_unknown_phone_and_captcha_challenges_never_receive_codes(self):
        for challenge in ['unknown', 'sms', 'phone', 'captcha', 'captcha_frame']:
            with self.subTest(challenge=challenge):
                result, submissions, job, _ = await self.verify(['email', 'password', challenge, 'identity'], mfa=True)
                self.assertEqual(result, 'verification_required')
                self.assertEqual(submissions, ['email', 'password']); job.wait_code.assert_not_awaited()

    async def test_challenge_change_while_reading_mail_never_receives_email_code(self):
        for changed in ['totp_code', 'unknown', 'sms', 'captcha']:
            with self.subTest(changed=changed):
                result, submissions, job, _ = await self.verify(['email', 'password', 'email_code', 'identity'],
                    mfa=True, change_during_mail=changed)
                self.assertEqual(result, 'verification_required')
                self.assertEqual(submissions, ['email', 'password']); job.wait_code.assert_awaited_once()

    async def test_email_verification_links_or_invalid_codes_do_not_prove_login(self):
        for value in ['https://auth.openai.com/verify?code=synthetic', 'unexpected']:
            with self.subTest(value_type='link' if value.startswith('https:') else 'invalid'):
                result, submissions, job, _ = await self.verify(['email', 'password', 'email_code', 'identity'], mail_value=value)
                self.assertEqual(result, 'verification_required')
                self.assertEqual(submissions, ['email', 'password']); job.wait_code.assert_awaited_once()


    async def test_cancel_expiry_and_mail_timeout_never_submit_a_late_code(self):
        for change, reason in [('cancel', 'operation_cancelled'), ('expired', 'registration_authorization_expired'),
                               ('timeout', 'verification_required')]:
            with self.subTest(change=change):
                result, submissions, job, _ = await self.verify(['email', 'password', 'email_code', 'identity'],
                    change_during_mail=change)
                self.assertEqual(result, reason)
                self.assertEqual(submissions, ['email', 'password']); job.wait_code.assert_awaited_once()


class VerificationRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def flow(self):
        job = SimpleNamespace(payload={'totpSecret': 'JBSWY3DPEHPK3PXP'}, event=MagicMock(),
                              manual=AsyncMock())
        flow = RegistrationBrowser(job, None)
        flow.settings = AsyncMock(side_effect=Stop('fixture_settings_entered'))
        return flow

    async def test_unknown_challenge_and_authority_failures_never_enter_settings_recovery(self):
        for method in ['password', 'mfa']:
            for reason in ['verification_required', 'durable_state_unavailable',
                           'registration_authorization_expired', 'operation_cancelled']:
                with self.subTest(method=method, reason=reason):
                    flow = self.flow(); flow.verify_login = AsyncMock(side_effect=Stop(reason))
                    with self.assertRaises(Stop) as stopped: await getattr(flow, method)()
                    self.assertEqual(stopped.exception.report['reason'], reason)
                    flow.settings.assert_not_awaited(); flow.job.manual.assert_not_awaited()
                    flow.verify_login.assert_awaited_once()

    async def test_only_original_unverified_reasons_enter_settings_recovery(self):
        for method, reason in [('password', 'password_unverified'), ('mfa', 'mfa_unverified')]:
            with self.subTest(method=method):
                flow = self.flow(); flow.verify_login = AsyncMock(side_effect=Stop(reason))
                with self.assertRaises(Stop) as stopped: await getattr(flow, method)()
                self.assertEqual(stopped.exception.report['reason'], 'fixture_settings_entered')
                flow.settings.assert_awaited_once(); flow.verify_login.assert_awaited_once()

    async def test_manual_password_recovery_does_not_swallow_unknown_challenge(self):
        flow = self.flow(); flow.settings = AsyncMock()
        flow.verify_login = AsyncMock(side_effect=[Stop('password_unverified'), Stop('verification_required')])
        inputs = SimpleNamespace(count=AsyncMock(return_value=0))
        flow.page = SimpleNamespace(locator=lambda _: inputs)
        flow.button = AsyncMock(return_value=None)
        with self.assertRaises(Stop) as stopped: await flow.password()
        self.assertEqual(stopped.exception.report['reason'], 'verification_required')
        flow.settings.assert_awaited_once(); flow.job.manual.assert_awaited_once_with('password_unverified')
        self.assertEqual(flow.verify_login.await_count, 2)


class CountryTests(unittest.IsolatedAsyncioTestCase):
    def flow(self):
        class Job:
            payload = {}
            def check(self):
                pass
        flow = RegistrationBrowser(Job(), None)
        flow.page = type('Page', (), {'url': 'https://chatgpt.com/'})()
        return flow

    async def test_country_is_observed_from_registration_page_only(self):
        flow = self.flow()
        with patch('registration_browser.observe_page_network', AsyncMock(return_value={'ip': '192.0.2.1', 'country': 'PH'})) as probe:
            self.assertEqual(await flow.registration_country(), 'PH')
            probe.assert_awaited_once_with(flow.page)

    async def test_unknown_trace_keeps_country_empty(self):
        with patch('registration_browser.observe_page_network', AsyncMock(side_effect=Stop('proxy_network_unconfirmed'))):
            self.assertIsNone(await self.flow().registration_country())
        with patch('registration_browser.observe_page_network', AsyncMock(return_value={'country': 'ZZ'})):
            self.assertIsNone(await self.flow().registration_country())

    async def test_cancelled_probe_is_not_treated_as_success(self):
        with patch('registration_browser.observe_page_network', AsyncMock(side_effect=Stop('cancelled'))):
            with self.assertRaises(Stop) as failure:
                await self.flow().registration_country()
            self.assertEqual(failure.exception.report['reason'], 'cancelled')


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    def flow(self, url='https://chatgpt.com/onboarding'):
        job = SimpleNamespace(payload={'email': 'owner@example.test', 'birthDate': '1996-01-01', 'displayName': '李华'},
            check=lambda: None, cancelled=threading.Event(), event=lambda *_args, **_kwargs: None,
            manual=AsyncMock(side_effect=Stop('fixture_paused')))
        context = SimpleNamespace(route=AsyncMock(), unroute=AsyncMock())
        flow = RegistrationBrowser(job, context)
        flow.page = SimpleNamespace(url=url, goto=AsyncMock(return_value=SimpleNamespace(status=200)), reload=AsyncMock())
        flow.settle = AsyncMock()
        flow.registration_country = AsyncMock(return_value='US')
        return flow

    async def test_stalled_page_refreshes_same_page_once_then_waits(self):
        flow = self.flow()
        flow.registration_view = AsyncMock(return_value=('unknown', None))
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 0):
            with self.assertRaises(Stop): await flow.register()
        flow.page.goto.assert_awaited_once_with('https://chatgpt.com/onboarding', wait_until='domcontentloaded', timeout=0)
        flow.page.reload.assert_not_awaited()
        flow.job.manual.assert_awaited_once_with('form_unrecognized')
        self.assertEqual(flow.context.route.await_count, 1)
        readonly = flow.context.route.await_args.args[1]
        post = SimpleNamespace(request=SimpleNamespace(method='POST'), abort=AsyncMock(), fallback=AsyncMock())
        await readonly(post)
        post.abort.assert_awaited_once(); post.fallback.assert_not_awaited()
        read = SimpleNamespace(request=SimpleNamespace(method='GET'), abort=AsyncMock(), fallback=AsyncMock())
        await readonly(read)
        read.abort.assert_not_awaited(); read.fallback.assert_awaited_once()
        flow.context.unroute.assert_awaited_once_with('**/*', readonly)

    async def test_refresh_reobserves_registered_identity_and_returns(self):
        flow = self.flow()
        flow.registration_view = AsyncMock(side_effect=[('unknown', None), ('registered', None)])
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 0): await flow.register()
        self.assertTrue(flow.data['registered'])
        flow.page.goto.assert_awaited_once(); flow.job.manual.assert_not_awaited()

    async def test_one_time_payment_and_nonofficial_urls_cannot_be_refreshed(self):
        for url in ['https://auth.openai.com/email-verification?code=synthetic',
                    'https://auth.openai.com/onboarding?token=synthetic',
                    'https://auth.openai.com/onboarding?verification_code=',
                    'https://auth.openai.com/callback', 'https://chatgpt.com/checkout',
                    'https://chatgpt.com/onboarding#synthetic', 'https://evil.test/onboarding']:
            flow = self.flow(url)
            if 'evil.test' in url:
                with self.assertRaises(Stop): await flow.refresh_registration()
            else:
                self.assertFalse(await flow.refresh_registration())
            flow.page.goto.assert_not_awaited(); flow.context.route.assert_not_awaited()

    async def test_refresh_guard_is_removed_before_manual_challenge(self):
        flow = self.flow()
        flow.page.goto.return_value = SimpleNamespace(status=403)
        async def manual(_reason, **_kwargs):
            self.assertEqual(flow.context.unroute.await_count, 1)
        flow.job.manual = AsyncMock(side_effect=manual)
        self.assertTrue(await flow.refresh_registration())
        flow.job.manual.assert_awaited_once_with('verification_required', can_resume=flow.verification_resolved)

    async def test_cancelled_refresh_cannot_navigate(self):
        flow = self.flow(); flow.job.cancelled.set()
        with self.assertRaises(Stop) as stopped: await flow.refresh_registration()
        self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
        flow.page.goto.assert_not_awaited(); flow.context.unroute.assert_awaited_once()

    async def test_refresh_http_errors_never_claim_recovery(self):
        for status in [401, 404, 429, 500]:
            flow = self.flow(); flow.page.goto.return_value = SimpleNamespace(status=status)
            with self.assertRaises(Stop) as stopped: await flow.refresh_registration()
            self.assertEqual(stopped.exception.report, {'status': 'blocked', 'reason': 'http_error', 'http_status': status})
            flow.job.manual.assert_not_awaited(); flow.context.unroute.assert_awaited_once()

    async def test_network_observation_failure_uses_only_bounded_get_recovery(self):
        flow = self.flow()
        flow.registration_view = AsyncMock(side_effect=[Stop('session_network_error'), ('registered', None)])
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 0): await flow.register()
        flow.page.goto.assert_awaited_once()

    async def test_old_registered_checkpoint_requires_manual_onboarding_without_step_replay(self):
        flow = self.flow(); flow.challenge = AsyncMock(return_value=False)
        flow.profile_fields = AsyncMock(side_effect=[(None, None, None, None), None])
        flow.job.manual = AsyncMock()
        await flow.guard_registered_onboarding()
        flow.job.manual.assert_awaited_once_with('form_unrecognized')
        flow.page.goto.assert_not_awaited()

    async def test_old_registered_checkpoint_cannot_continue_while_profile_is_pending(self):
        flow = self.flow(); flow.challenge = AsyncMock(return_value=False)
        flow.profile_fields = AsyncMock(return_value=(None, None, None, None))
        flow.job.manual = AsyncMock()
        with self.assertRaises(Stop) as stopped: await flow.guard_registered_onboarding()
        self.assertEqual(stopped.exception.report['reason'], 'form_unrecognized')
        flow.page.goto.assert_not_awaited()


@unittest.skipUnless(os.environ.get('V2_REGISTRATION_BROWSER_TEST') == '1', 'explicit local fixture')
class ProfileBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from playwright.async_api import async_playwright
        self.driver = await async_playwright().start()
        if os.environ.get('V2_REGISTRATION_FINGERPRINT_BINARY'):
            from fingerprint_runtime import launch_fingerprint_browser
            self.browser = await launch_fingerprint_browser(self.driver, headless=True,
                executable_path=os.environ['V2_REGISTRATION_FINGERPRINT_BINARY'])
        else:
            self.browser = await self.driver.chromium.launch(headless=True)
        self.context = await self.browser.new_context(service_workers='block', accept_downloads=False)
        self.page = await self.context.new_page()
        self.events = []; self.submissions = []; self.navigation_methods = []
        self.page_errors = []
        self.page.on('pageerror', lambda error: self.page_errors.append(str(error)))
        self.job = SimpleNamespace(payload=dict(email='owner@example.test', birthDate='1996-01-01',
            displayName='李华', registrationAge=45, registered=False), check=lambda: None,
            cancelled=threading.Event(), event=lambda name, **data: self.events.append(name),
            manual=AsyncMock(side_effect=Stop('fixture_paused')), awaiting_code=False)
        self.flow = RegistrationBrowser(self.job, self.context)
        self.flow.page = self.page
        async def settle(_seconds=2): await asyncio.sleep(.02)
        self.flow.settle = settle
        self.flow.registration_country = AsyncMock(return_value='US')

    async def asyncTearDown(self):
        await self.browser.close()
        await self.driver.stop()

    async def registration_code_fixture(self, *, delay=0, navigate=True):
        html = '''<!doctype html><html><body><form aria-busy="false">
        <input name="code" autocomplete="one-time-code"><button>Continue</button></form><script>
        document.querySelector('form').onsubmit=async event=>{
          event.preventDefault();const form=event.target;form.setAttribute('aria-busy','true');
          await fetch('/fixture/code',{method:'POST',body:JSON.stringify({code:form.querySelector('input').value})});
          __AFTER_SUBMISSION__
        }; </script></body></html>'''.replace('__AFTER_SUBMISSION__',
            "window.location.assign('/welcome');" if navigate else
            "form.setAttribute('aria-busy','false');form.insertAdjacentHTML('beforeend','<p role=alert>Invalid code</p>');")
        async def local(route):
            self.navigation_methods.append(route.request.method)
            path = urlsplit(route.request.url).path
            if path == '/fixture/code':
                self.submissions.append(json.loads(route.request.post_data))
                await asyncio.sleep(delay)
                await route.fulfill(content_type='application/json', body='{}')
            elif path == '/welcome':
                await route.fulfill(content_type='text/html', body='<main>Welcome</main>')
            else:
                await route.fulfill(content_type='text/html', body=html)
        await self.page.route('**/*', local)
        await self.page.goto('https://chatgpt.com/email-verification', wait_until='domcontentloaded')
        def prepare_mail(step, *, new_request=False):
            self.job.awaiting_code = True
        async def wait_code():
            self.job.awaiting_code = False
            return '123456'
        self.job.prepare_mail = MagicMock(side_effect=prepare_mail)
        self.job.wait_code = AsyncMock(side_effect=wait_code)

    async def test_registration_code_navigation_after_three_seconds_does_not_pause_or_resubmit(self):
        await self.registration_code_fixture(delay=7)
        self.flow.settle = RegistrationBrowser.settle.__get__(self.flow)
        async def identity(page, email, **_kwargs):
            return ('fixture', 'identity') if urlsplit(page.url).path == '/welcome' else None
        with patch('registration_browser.official_identity', identity):
            await self.flow.register()
        self.assertTrue(self.flow.data['registered'])
        self.assertEqual(self.submissions, [{'code': '123456'}])
        self.assertEqual(self.navigation_methods.count('POST'), 1)
        self.job.prepare_mail.assert_called_once_with('email_code')
        self.job.wait_code.assert_awaited_once()
        self.job.manual.assert_not_awaited()
        self.assertFalse(self.flow.registration_refreshed)
        self.assertEqual(self.page_errors, [])

    async def test_registration_code_stays_after_submission_pauses_only_after_budget(self):
        await self.registration_code_fixture(navigate=False)
        observed_code_after_submit = []
        original_view = self.flow.registration_view
        async def view():
            result = await original_view()
            if self.submissions and result[0] == 'code':
                observed_code_after_submit.append(result[0])
            return result
        self.flow.registration_view = view
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 1):
            with self.assertRaises(Stop) as stopped:
                await self.flow.register()
        self.assertEqual(stopped.exception.report['reason'], 'fixture_paused')
        self.assertGreater(len(observed_code_after_submit), 1)
        self.assertEqual(self.submissions, [{'code': '123456'}])
        self.job.prepare_mail.assert_called_once_with('email_code')
        self.job.wait_code.assert_awaited_once()
        self.job.manual.assert_awaited_once_with('form_unrecognized')
        self.assertFalse(self.flow.registration_refreshed)
        self.assertEqual(self.page_errors, [])

    async def observation_fixture(self, mode):
        from browser_session import SessionBudget
        self.session_reads = 0
        async def local(route):
            self.navigation_methods.append(route.request.method)
            path = urlsplit(route.request.url).path
            if path == '/api/auth/session':
                self.session_reads += 1
                if mode == 'network' or (mode == 'recover' and self.session_reads == 1):
                    await route.abort('failed')
                    return
                if mode == 'timeout':
                    await asyncio.sleep(.5)
                await route.fulfill(content_type='application/json', body='{}')
                return
            body = '<main>Preparing</main>'
            if mode == 'recover' and self.session_reads:
                body = '<form><input type="email"><button>Continue</button></form>'
            await route.fulfill(content_type='text/html', body='<!doctype html><html><body>' + body + '</body></html>')
        await self.page.route('**/*', local)
        await self.page.goto('https://chatgpt.com/auth/login')
        if mode == 'timeout':
            self.flow.observation_budget = SessionBudget(.15, cancelled=self.job.cancelled.is_set)

    async def test_anonymous_session_is_observed_without_mocking_identity(self):
        await self.observation_fixture('healthy')
        self.assertEqual(await self.flow.registration_view(), ('unknown', None))
        self.assertEqual(self.session_reads, 1)
        self.assertFalse(self.job.payload['registered'])
        self.assertTrue(all(method == 'GET' for method in self.navigation_methods))

    async def test_failed_session_fetch_is_controlled_and_recoverable(self):
        from browser_session import retryable_page_load_error
        await self.observation_fixture('network')
        with self.assertRaises(Stop) as stopped:
            await self.flow.registration_view()
        self.assertEqual(stopped.exception.report['reason'], 'session_network_error')
        self.assertTrue(retryable_page_load_error(stopped.exception))
        self.assertEqual(self.job.registration_operation, 'identity_read')
        self.assertTrue(all(method == 'GET' for method in self.navigation_methods))

    async def test_session_timeout_uses_observation_budget(self):
        await self.observation_fixture('timeout')
        with self.assertRaises(Stop) as stopped:
            await self.flow.identity()
        self.assertEqual(stopped.exception.report['reason'], 'session_load_timeout')
        self.assertLess(self.flow.observation_budget.elapsed, .5)

    async def test_network_failure_refreshes_same_page_then_recognizes_email(self):
        await self.observation_fixture('recover')
        def progress(name, **data):
            if data.get('step') == 'email':
                raise Stop('fixture_email_reached')
        self.job.event = progress
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 0):
            with self.assertRaises(Stop) as stopped:
                await self.flow.register()
        self.assertEqual(stopped.exception.report['reason'], 'fixture_email_reached')
        self.assertTrue(self.flow.registration_refreshed)
        self.assertEqual(self.session_reads, 2)
        self.assertIs(self.flow.page, self.page)
        self.job.manual.assert_not_awaited()
        self.assertTrue(all(method == 'GET' for method in self.navigation_methods))

    async def test_network_recovery_exhaustion_pauses_without_submission(self):
        await self.observation_fixture('network')
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 0):
            with self.assertRaises(Stop) as stopped:
                await self.flow.register()
        self.assertEqual(stopped.exception.report['reason'], 'fixture_paused')
        self.job.manual.assert_awaited_once_with('form_unrecognized')
        self.assertEqual(self.session_reads, 2)
        self.assertTrue(all(method == 'GET' for method in self.navigation_methods))

    async def test_disappearing_submitted_form_reobserves_without_manual_handoff(self):
        import registration_browser
        await self.serve('<form><input name="name"><input name="birthdate" type="date"><button>Continue</button></form>')
        original = registration_browser.unique_visible
        async def detach_after_name(page, selector):
            field = await original(page, selector)
            if selector == registration_browser.NAME_INPUT and field:
                await self.page.evaluate("document.body.innerHTML='<main>Preparing</main>'")
            return field
        with patch('registration_browser.unique_visible', detach_after_name):
            self.assertEqual(await self.flow.registration_view(), ('unknown', None))
        self.assertTrue(self.flow.registration_loading)
        self.job.manual.assert_not_awaited()
        self.assertEqual(self.submissions, [])

    async def serve(self, body):
        html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' + body + '''<script>
        document.querySelectorAll('form').forEach(form=>{form.onsubmit=async event=>{
          event.preventDefault();const values={};form.querySelectorAll('input[name]').forEach(input=>{values[input.name]=input.value;});
          await fetch('/fixture/profile',{method:'POST',body:JSON.stringify(values)});document.body.innerHTML='<main>Welcome</main>';
        };}); </script></body></html>'''
        async def local(route):
            self.navigation_methods.append(route.request.method)
            if urlsplit(route.request.url).path == '/fixture/profile':
                self.submissions.append(json.loads(route.request.post_data))
                await route.fulfill(content_type='application/json', body='{}')
                return
            await route.fulfill(content_type='text/html', body=html)
        await self.page.route('**/*', local)
        await self.page.goto('https://chatgpt.com/onboarding', wait_until='domcontentloaded')

    async def register_with_session(self):
        with patch('registration_browser.official_identity', AsyncMock(return_value=('fixture', 'identity'))) as identity:
            try:
                await self.flow.register()
            except Stop:
                self.assertEqual(self.page_errors, [])
                raise
        self.assertEqual(self.page_errors, [])
        return identity

    async def test_authenticated_name_age_onboarding_finishes_before_registered(self):
        await self.serve('<button>Continue</button><form><label>Name<input name="name"></label><label>Age<input name="age" type="number"></label><button>Continue</button></form>')
        identity = await self.register_with_session()
        self.assertEqual(self.submissions, [{'name': '李华', 'age': '45'}])
        self.assertTrue(self.flow.registration_state['profile_submitted'])
        self.assertEqual(self.events, ['progress', 'registered'])
        identity.assert_awaited_once()

    async def test_name_age_uses_task_snapshot_for_20_21_45_and_wrapped_20(self):
        with patch('registration_browser.birth_age', side_effect=AssertionError('Fixed age must not be recalculated')):
            for age in [20, 21, 45, 20]:
                with self.subTest(age=age):
                    self.job.payload.update(registrationAge=age, registered=False)
                    self.flow = RegistrationBrowser(self.job, self.context); self.flow.page = self.page
                    self.flow.settle = AsyncMock(); self.flow.registration_country = AsyncMock(return_value='US')
                    await self.serve('<form><input name="name"><input name="age" type="number"><button>Continue</button></form>')
                    await self.register_with_session()
        self.assertEqual(self.submissions, [{'name': '李华', 'age': str(age)} for age in [20, 21, 45, 20]])

    async def test_manual_continue_keeps_age_snapshot_without_birthdate_calculation(self):
        self.job.payload['registrationAge'] = 20
        await self.serve('''<form><input name="name"><input name="age" type="number"><button disabled>Continue</button></form>
        <script>document.querySelector('[name=age]').addEventListener('input',()=>{document.documentElement.dataset.ageInputs=String(Number(document.documentElement.dataset.ageInputs||0)+1);});</script>''')
        async def resume(reason):
            self.assertEqual(reason, 'form_unrecognized')
            self.assertEqual(await self.page.locator('[name="age"]').input_value(), '20')
            self.assertEqual(self.job.payload['registrationAge'], 20)
            self.assertEqual(self.job.payload['birthDate'], '1996-01-01')
            await self.page.locator('button').evaluate('button => {button.disabled = false;}')
        self.job.manual = AsyncMock(side_effect=resume)
        self.flow.refresh_registration = AsyncMock(return_value=False)
        with (patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 0),
              patch('registration_browser.birth_age', side_effect=AssertionError('Continue must not recalculate fixed age'))):
            await self.register_with_session()
        self.job.manual.assert_awaited_once_with('form_unrecognized')
        self.assertEqual(self.submissions, [{'name': '李华', 'age': '20'}])
        self.assertEqual(await self.page.evaluate('document.documentElement.dataset.ageInputs'), '1')

    async def test_prepopulated_age_is_replaced_with_task_snapshot_without_appending(self):
        self.job.payload['registrationAge'] = 20
        await self.serve('<form><input name="name"><input name="age" type="number" value="21"><button>Continue</button></form>')
        with patch('registration_browser.birth_age', side_effect=AssertionError('Fixed age must not be recalculated')):
            await self.register_with_session()
        self.assertEqual(self.submissions, [{'name': '李华', 'age': '20'}])

    async def test_age_changed_by_input_handler_never_submits_wrong_value(self):
        self.job.payload['registrationAge'] = 20
        await self.serve('''<form><input name="name"><input name="age" type="number"><button>Continue</button></form>
        <script>document.querySelector('[name=age]').addEventListener('input',event=>{event.target.value='2020';});</script>''')
        with (patch('registration_browser.birth_age', side_effect=AssertionError('Fixed age must not be recalculated')),
              patch('registration_browser.official_identity', AsyncMock(return_value=('fixture', 'identity'))) as identity):
            with self.assertRaises(Stop) as stopped: await self.flow.register()
        self.assertEqual(stopped.exception.report['reason'], 'form_unrecognized')
        self.assertEqual(self.submissions, [])
        self.assertFalse(self.flow.registration_state.get('profile_submitted'))
        identity.assert_not_awaited()

    async def test_same_task_retry_uses_fixed_age_in_original_context(self):
        self.job.payload.update(id='11111111-1111-4111-8111-111111111111', attempt=1, registrationAge=21)
        original = dict(self.job.payload)
        await self.serve('<h1>Verify you are human</h1><form><input name="name"><input name="age"><button>Continue</button></form>')
        with self.assertRaises(Stop): await self.flow.register()
        self.assertEqual(self.submissions, [])
        retry = {**original, 'attempt': 2}
        self.job = SimpleNamespace(payload=retry, check=lambda: None, cancelled=threading.Event(),
            event=lambda name, **data: self.events.append(name), manual=AsyncMock(side_effect=Stop('fixture_paused')),
            awaiting_code=False, registration_state=self.flow.registration_state)
        self.flow = RegistrationBrowser(self.job, self.context); self.flow.page = self.page
        self.flow.settle = AsyncMock(); self.flow.registration_country = AsyncMock(return_value='US')
        await self.serve('<form><input name="name"><input name="age" type="number"><button>Continue</button></form>')
        with patch('registration_browser.birth_age', side_effect=AssertionError('Retry must not recalculate fixed age')):
            await self.register_with_session()
        self.assertEqual(self.job.payload['id'], original['id'])
        self.assertEqual(self.job.payload['registrationAge'], original['registrationAge'])
        self.assertEqual(self.job.payload['birthDate'], original['birthDate'])
        self.assertIs(self.flow.context, self.context)
        self.assertIs(self.flow.page, self.page)
        self.assertEqual(self.submissions, [{'name': '李华', 'age': '21'}])

    async def test_birthdate_variant_keeps_original_birthday(self):
        with (patch('registration_browser.registration_age', side_effect=AssertionError('DOB form must not use fixed age')),
              patch('registration_browser.birth_age', side_effect=AssertionError('DOB form must preserve original date'))):
            for age in [20, 21, 45]:
                with self.subTest(age=age):
                    self.job.payload.update(registrationAge=age, registered=False)
                    self.flow = RegistrationBrowser(self.job, self.context); self.flow.page = self.page
                    self.flow.settle = AsyncMock(); self.flow.registration_country = AsyncMock(return_value='US')
                    await self.serve('<form><input name="fullName"><input type="date" name="birthdate"><button>Continue</button></form>')
                    await self.register_with_session()
        self.assertEqual(self.submissions, [{'fullName': '李华', 'birthdate': '1996-01-01'}] * 3)

    async def test_submit_button_is_checked_after_input_validation(self):
        await self.serve('''<form><input name="name"><input name="age"><button disabled>Continue</button></form>
        <script>document.querySelector('form').oninput=()=>{const form=document.querySelector('form');form.querySelector('button').disabled=!(form.querySelector('[name=name]').value&&form.querySelector('[name=age]').value);};</script>''')
        await self.register_with_session()
        self.assertEqual(self.submissions, [{'name': '李华', 'age': '45'}])

    async def test_labelled_age_variant_and_legacy_payload(self):
        from registration_security import birth_age
        self.job.payload.pop('registrationAge')
        await self.serve('<div role="dialog"><form><input name="name"><label for="years">年龄</label><input id="years" name="years" type="number"><button>继续</button></form></div>')
        await self.register_with_session()
        self.assertEqual(self.submissions, [{'name': '李华', 'years': str(birth_age('1996-01-01'))}])

    async def test_missing_or_conflicting_profile_fields_never_complete_with_session(self):
        for fields in ['<input name="name">', '<input name="name"><input type="date"><input name="age">',
                       '<input name="age">', '<input type="date">']:
            await self.serve('<form>' + fields + '<button>Continue</button></form>')
            with (patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 0),
                  patch('registration_browser.official_identity', AsyncMock(return_value=('fixture', 'identity'))) as identity):
                with self.assertRaises(Stop): await self.flow.register()
            self.assertNotIn('registered', self.events)
            self.assertEqual(self.submissions, [])
            identity.assert_not_awaited()

    async def test_email_code_precedes_pending_profile(self):
        await self.serve('<form><input name="code" autocomplete="one-time-code"><button>Continue</button></form><form><input name="name"><input name="age"><button>Continue</button></form>')
        self.job.wait_code = AsyncMock(return_value='123456')
        self.job.prepare_mail = lambda _step: setattr(self.job, 'awaiting_code', True)
        await self.register_with_session()
        self.assertEqual(self.submissions, [{'code': '123456'}])

    async def test_loading_onboarding_cannot_complete_only_from_session(self):
        await self.serve('<main aria-busy="true">Loading...</main>')
        with (patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 0),
              patch('registration_browser.official_identity', AsyncMock(return_value=('fixture', 'identity'))) as identity):
            with self.assertRaises(Stop): await self.flow.register()
        identity.assert_not_awaited()
        self.assertNotIn('registered', self.events)
        self.assertEqual(self.submissions, [])

    async def test_refresh_readonly_guard_blocks_delayed_spa_write(self):
        writes = []; reads = 0
        async def local(route):
            nonlocal reads
            if route.request.method == 'POST':
                writes.append(True)
                await route.fulfill(body='{}')
                return
            reads += 1
            script = '' if reads == 1 else '''<script>setTimeout(()=>fetch('/signup',{method:'POST',body:'{}'}).catch(()=>document.documentElement.dataset.blocked='true'),50)</script>'''
            await route.fulfill(content_type='text/html', body='<html><body>Loading' + script + '</body></html>')
        await self.context.route('**/*', local)
        await self.page.goto('https://chatgpt.com/onboarding', wait_until='domcontentloaded')
        self.assertTrue(await self.flow.refresh_registration())
        await asyncio.sleep(.2)
        self.assertEqual(writes, [])
        self.assertEqual(await self.page.evaluate('document.documentElement.dataset.blocked'), 'true')
        self.assertIsNotNone(self.flow.recovery_readonly)
        await self.flow.end_recovery()
        self.assertIsNone(self.flow.recovery_readonly)

    async def test_ambiguous_buttons_or_forms_never_submit(self):
        for body in ['<form><input name="name"><input name="age"><button>Continue</button><button>Continue</button></form>',
                     '<form><input name="name"><input name="age"><button>Continue</button></form><form><input name="name"><input name="age"><button>Continue</button></form>']:
            await self.serve(body)
            with self.assertRaises(Stop): await self.flow.register()
            self.assertEqual(self.submissions, [])

    async def test_challenge_and_phone_verification_do_not_refresh_or_fill(self):
        for body in ['<h1>Verify you are human</h1><form><input name="name"><input name="age"><button>Continue</button></form>',
                     '<h1>Verify your phone number</h1><input type="tel">']:
            await self.serve(body)
            navigations = len(self.navigation_methods)
            with self.assertRaises(Stop): await self.flow.register()
            self.job.manual.assert_awaited_with('verification_required', can_resume=self.flow.verification_resolved)
            self.assertEqual(len(self.navigation_methods), navigations)
            self.assertEqual(self.submissions, [])

    async def test_ordinary_phone_word_does_not_block_profile(self):
        await self.serve('<p>Use your account on a phone or computer.</p><form><input name="name"><input name="age"><button>Continue</button></form>')
        await self.register_with_session()
        self.assertEqual(len(self.submissions), 1)

    async def test_submitted_profile_is_never_clicked_again_in_resumed_flow(self):
        await self.serve('<form><input name="name"><input name="age"><button>Continue</button></form>')
        self.job.registration_state = {'profile_submitted': True}
        self.flow = RegistrationBrowser(self.job, self.context); self.flow.page = self.page
        self.flow.settle = AsyncMock()
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 0):
            with self.assertRaises(Stop): await self.flow.register()
        self.assertEqual(self.submissions, [])
        self.assertNotIn('registered', self.events)

    async def test_native_dom_iteration_and_binding_probe(self):
        captured = []
        await self.page.expose_function('syntheticBinding', lambda value: captured.append(value))
        result = await self.page.evaluate('''async () => {
            document.body.innerHTML='<form><input name="synthetic" value="fixture"></form>';
            const nodes=document.querySelectorAll('input');
            const check=(operation)=>{try{return {ok:operation()===true};}catch(error){return {ok:false,error_type:error.name};}};
            const result={
                array_from:check(()=>Array.from(nodes).length===1),
                node_for_each:check(()=>{let count=0;nodes.forEach(()=>count++);return count===1;}),
                node_spread:check(()=>[...nodes].length===1),
                node_for_of:check(()=>{let count=0;for(const node of nodes)count++;return count===1;}),
                form_data_entries:check(()=>Object.fromEntries(new FormData(document.querySelector('form'))).synthetic==='fixture')
            };
            result.binding=await Promise.race([
                window.syntheticBinding({synthetic:true}).then(()=>({ok:true})).catch(error=>({ok:false,error_type:error.name})),
                new Promise(resolve=>setTimeout(()=>resolve({ok:false,error_type:'TimeoutError'}),2000))
            ]);
            return result;
        }''')
        result['binding_callback_invoked'] = bool(captured)
        for key in ['array_from', 'node_for_each', 'node_spread', 'node_for_of', 'form_data_entries']:
            self.assertTrue(result[key]['ok'])


@unittest.skipUnless(os.environ.get('V2_REGISTRATION_BROWSER_TEST') == '1', 'explicit local fixture')
class EmailSubmitBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await ProfileBrowserTests.asyncSetUp(self)
        def prepare_mail(_step, *, new_request=False):
            self.job.awaiting_code = True
        self.job.prepare_mail = MagicMock(side_effect=prepare_mail)

    async def asyncTearDown(self):
        await ProfileBrowserTests.asyncTearDown(self)

    async def email_fixture(self, mode):
        button = '<button id="continue" type="button"' + (' disabled' if mode in {'delay', 'disabled'} else '') + '>Continue</button>'
        if mode == 'ambiguous': button += '<button type="button">继续</button>'
        html = '<!doctype html><html><head><meta charset="utf-8"></head><body><form><input type="email">' + button + '''</form><script>
        const input=document.querySelector('input'),button=document.querySelector('#continue');
        window.enterPresses=0;input.addEventListener('keydown',event=>{if(event.key==='Enter')window.enterPresses++;});
        document.querySelector('form').onsubmit=event=>event.preventDefault();
        __ENABLE__
        button.onclick=async()=>{
          await fetch('/fixture/email',{method:'POST',body:JSON.stringify({email:input.value,enterPresses:window.enterPresses})});
          __AFTER__
        }; </script></body></html>'''
        enable = "input.oninput=()=>setTimeout(()=>button.disabled=false,800);" if mode == 'delay' else ''
        if mode == 'changed':
            enable = '''input.oninput=()=>{document.body.innerHTML=`<form><input name="code" autocomplete="one-time-code"><button type="button" onclick="fetch('/fixture/code',{method:'POST'})">Continue</button></form>`;};'''
        html = html.replace('__ENABLE__', enable)
        html = html.replace('__AFTER__', '' if mode == 'unknown' else "window.location.assign('/welcome');")
        async def local(route):
            self.navigation_methods.append(route.request.method)
            if urlsplit(route.request.url).path == '/fixture/email':
                self.job.prepare_mail.assert_called_once_with('email_code', new_request=True)
                self.assertEqual(self.job.registration_operation, 'email_submit')
                self.submissions.append(json.loads(route.request.post_data))
                await route.fulfill(content_type='application/json', body='{}')
            else:
                body = '<main>Welcome</main>' if urlsplit(route.request.url).path == '/welcome' else html
                await route.fulfill(content_type='text/html', body=body)
        await self.page.route('**/*', local)
        await self.page.goto('https://chatgpt.com/auth/login', wait_until='domcontentloaded')

    async def register_fixture(self):
        async def identity(page, _email, **_kwargs):
            return ('fixture', 'identity') if urlsplit(page.url).path == '/welcome' else None
        with patch('registration_browser.official_identity', identity):
            await asyncio.wait_for(self.flow.register(), timeout=15)

    async def test_email_onclick_only_continue_submits_once_without_enter(self):
        await self.email_fixture('click')
        await self.register_fixture()
        self.assertTrue(self.flow.data['registered'])
        self.assertEqual(self.submissions, [{'email': self.job.payload['email'], 'enterPresses': 0}])
        self.assertEqual(self.navigation_methods.count('POST'), 1)
        self.job.manual.assert_not_awaited()
        self.assertFalse(self.flow.registration_refreshed)
        self.assertEqual(self.page_errors, [])

    async def test_email_continue_waits_for_delayed_validation_enable(self):
        await self.email_fixture('delay')
        await self.register_fixture()
        self.assertEqual(self.submissions, [{'email': self.job.payload['email'], 'enterPresses': 0}])
        self.job.manual.assert_not_awaited()
        self.assertEqual(self.page_errors, [])

    async def test_ambiguous_email_continue_never_prepares_or_submits_mail(self):
        await self.email_fixture('ambiguous')
        with self.assertRaises(Stop): await self.register_fixture()
        self.job.prepare_mail.assert_not_called()
        self.job.manual.assert_awaited_once_with('form_unrecognized')
        self.assertEqual(self.submissions, [])
        self.assertFalse(self.flow.registration_refreshed)

    async def test_disabled_email_continue_exhausts_budget_without_mail_submission(self):
        await self.email_fixture('disabled')
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 1):
            with self.assertRaises(Stop): await self.register_fixture()
        self.job.prepare_mail.assert_not_called()
        self.job.manual.assert_awaited_once_with('form_unrecognized')
        self.assertEqual(self.submissions, [])
        self.assertFalse(self.flow.registration_refreshed)

    async def test_email_page_change_never_clicks_a_code_continue_control(self):
        await self.email_fixture('changed')
        with self.assertRaises(Stop): await self.register_fixture()
        self.job.prepare_mail.assert_not_called()
        self.job.manual.assert_awaited_once_with('form_unrecognized')
        self.assertEqual(self.navigation_methods.count('POST'), 0)
        self.assertFalse(self.flow.data['registered'])

    async def test_unknown_email_submission_after_manual_continue_never_repeats(self):
        await self.email_fixture('unknown')
        self.job.manual.side_effect = [None, Stop('fixture_paused')]
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 1):
            with self.assertRaises(Stop): await self.register_fixture()
        self.job.prepare_mail.assert_called_once_with('email_code', new_request=True)
        self.assertEqual(self.submissions, [{'email': self.job.payload['email'], 'enterPresses': 0}])
        self.assertEqual(self.job.manual.await_count, 2)
        self.assertTrue(self.flow.registration_refreshed)
        self.assertFalse(self.flow.data['registered'])
        self.assertEqual(self.navigation_methods.count('POST'), 1)
        self.assertEqual(self.page_errors, [])

    async def bounded_email_read_fixture(self, missing):
        await self.email_fixture('click')
        self.page.set_default_timeout(10000)
        removed = False
        if missing == 'button':
            button = self.flow.button
            async def disappearing_button(page, pattern, role='button'):
                nonlocal removed
                result = await button(page, pattern, role)
                if result and not removed:
                    await page.locator('#continue').evaluate('(node) => node.remove()')
                    removed = True
                return result
            self.flow.button = disappearing_button
        else:
            from registration_browser import EMAIL_INPUT
            field = self.flow.field
            async def disappearing_email(page, selector):
                nonlocal removed
                result = await field(page, selector)
                if (result and not removed and selector == EMAIL_INPUT
                        and self.job.registration_operation == 'email_submit'):
                    await result.evaluate('(node) => node.remove()')
                    removed = True
                return result
            self.flow.field = disappearing_email
        started = time.monotonic()
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 1):
            with self.assertRaises(Stop):
                await asyncio.wait_for(self.register_fixture(), timeout=4)
        self.assertLess(time.monotonic() - started, 4)
        self.assertTrue(removed)
        self.job.manual.assert_awaited_once_with('form_unrecognized')
        self.assertEqual(self.job.registration_observation_error,
                         {'reason': 'session_load_timeout', 'error_type': 'TimeoutError'})
        self.job.prepare_mail.assert_not_called()
        self.assertEqual(self.navigation_methods.count('POST'), 0)
        self.assertEqual(self.submissions, [])
        self.assertFalse(self.flow.data['registered'])
        self.assertFalse(self.flow.registration_refreshed)

    async def test_disappearing_continue_read_is_bounded_before_mail_request(self):
        await self.bounded_email_read_fixture('button')

    async def test_disappearing_email_value_read_is_bounded_before_mail_request(self):
        await self.bounded_email_read_fixture('email')


@unittest.skipUnless(os.environ.get('V2_REGISTRATION_BROWSER_TEST') == '1', 'explicit local fixture')
class ResumeMailBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await ProfileBrowserTests.asyncSetUp(self)
        from registration_builtin import RegistrationServerJob
        from test_registration_builtin import server_payload
        value = server_payload()
        value['browserProfileId'] = 'reg_' + 'a' * 64
        self.job = RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
        self.flow = RegistrationBrowser(self.job, self.context)
        self.flow.page = self.page
        async def settle(_seconds=2): await asyncio.sleep(.02)
        self.flow.settle = settle
        self.flow.registration_country = AsyncMock(return_value='US')
        self.job.prepare_mail = MagicMock(wraps=self.job.prepare_mail)
        self.job.wait_code = AsyncMock(wraps=self.job.wait_code)
        self.tasks = []
        self.api_state = 'running'
        self.requested_at = None
        self.eligible_mail = False
        self.deliveries = 0
        self.pauses = 0
        self.second_pause = asyncio.Event()

    async def asyncTearDown(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await ProfileBrowserTests.asyncTearDown(self)

    async def resume_mail_fixture(self, arrival, *, gate_navigation=False):
        async def complete_manual():
            await asyncio.sleep(.02)
            if arrival == 'paused':
                self.eligible_mail = True
                deliver()  # MailDelivery cannot deliver while awaiting_user.
                self.assertIsNone(self.job.pending_code)
            if arrival != 'challenge':
                await self.page.locator('#human-challenge').evaluate('(node) => node.remove()')
            self.job.signal_resume()

        async def later_mail():
            await asyncio.sleep(.08)
            self.eligible_mail = True
            deliver()

        def deliver():
            if self.api_state == 'awaiting_email' and self.eligible_mail:
                self.job.signal_code('123456', self.job.attempt, 'email_code', 'fixture-mail')
                self.deliveries += 1

        def event(name, **data):
            self.events.append((name, data))
            self.job.step = data.get('step', self.job.step)
            self.api_state = 'running'
            if name == 'waiting_email':
                self.api_state = 'awaiting_email'
                if data.get('newMailRequest') or self.requested_at is None:
                    self.requested_at = (self.requested_at or 0) + 1
                elif arrival == 'pending':
                    self.assertEqual(self.job.pending_code, ('123456', 'fixture-mail'))
                    self.assertTrue(self.job.code_event.is_set())
                if arrival == 'pending':
                    self.eligible_mail = True
                deliver()  # The existing callback requests delivery, including paused arrivals.
            elif name == 'waiting_user':
                self.api_state = 'awaiting_user'
                self.pauses += 1
                if self.pauses == 1:
                    self.tasks.append(asyncio.create_task(complete_manual()))
                else:
                    self.second_pause.set()
            elif name == 'mail_accepted':
                # The actual API requires awaiting_email for consumption acknowledgment.
                self.assertEqual(self.previous_state, 'awaiting_email')
            elif name == 'progress' and self.pauses and arrival == 'later':
                self.tasks.append(asyncio.create_task(later_mail()))
            self.previous_state = self.api_state

        self.job.event = event
        self.previous_state = self.api_state
        email = '''<form><input type="email"><button>Continue</button></form><script>
        document.querySelector('form').onsubmit=async event=>{
          event.preventDefault();await fetch('/fixture/email',{method:'POST'});
          window.location.assign('/email-verification');
        }; </script>'''
        if gate_navigation:
            email = email.replace("window.location.assign('/email-verification');", '')
        code = '''<h1 id="human-challenge">Verify you are human</h1>
        <form><input name="code" autocomplete="one-time-code"><button>Continue</button></form><script>
        document.querySelector('form').onsubmit=async event=>{
          event.preventDefault();await fetch('/fixture/code',{method:'POST',
            body:JSON.stringify({code:event.target.querySelector('input').value})});
          window.location.assign('/welcome');
        }; </script>'''
        async def local(route):
            self.navigation_methods.append(route.request.method)
            path = urlsplit(route.request.url).path
            if path in {'/fixture/email', '/fixture/code'}:
                self.submissions.append((path, route.request.post_data))
                await route.fulfill(content_type='application/json', body='{}')
            else:
                body = code if path == '/email-verification' else '<main>Welcome</main>' if path == '/welcome' else email
                await route.fulfill(content_type='text/html', body='<!doctype html><html><body>' + body + '</body></html>')
        await self.page.route('**/*', local)
        await self.page.goto('https://chatgpt.com/auth/login', wait_until='domcontentloaded')

    async def finish_resumed_mail(self, arrival):
        await self.resume_mail_fixture(arrival)
        original_page, original_context = self.flow.page, self.flow.context
        async def identity(page, _email, **_kwargs):
            return ('fixture', 'identity') if urlsplit(page.url).path == '/welcome' else None
        with patch('registration_browser.official_identity', identity):
            await asyncio.wait_for(self.flow.register(), timeout=15)
        await asyncio.gather(*self.tasks)
        self.assertTrue(self.flow.data['registered'])
        self.assertIs(self.flow.page, original_page)
        self.assertIs(self.flow.context, original_context)
        self.job.prepare_mail.assert_called_once_with('email_code', new_request=True)
        self.job.wait_code.assert_awaited_once()
        self.assertEqual([data['newMailRequest'] for name, data in self.events if name == 'waiting_email'], [True, False])
        self.assertEqual(self.requested_at, 1)
        self.assertEqual([path for path, _body in self.submissions], ['/fixture/email', '/fixture/code'])
        self.assertEqual(sum(name == 'mail_accepted' for name, _data in self.events), 1)
        self.assertFalse(self.job.awaiting_code)
        self.assertIsNone(self.job.pending_code)
        self.assertFalse(self.flow.registration_refreshed)
        self.assertEqual(self.pauses, 1)
        self.assertEqual(self.page_errors, [])

    async def test_mail_arrived_during_manual_pause_is_consumed_in_original_window(self):
        await self.finish_resumed_mail('paused')
        self.assertEqual(self.deliveries, 1)

    async def test_new_mail_after_manual_resume_is_consumed_once(self):
        await self.finish_resumed_mail('later')
        self.assertEqual(self.deliveries, 1)

    async def test_pending_mail_survives_resume_and_duplicate_delivery(self):
        await self.finish_resumed_mail('pending')
        self.assertEqual(self.deliveries, 2)

    async def test_remaining_human_challenge_never_rearms_or_submits_mail(self):
        await self.resume_mail_fixture('challenge')
        with patch('registration_browser.official_identity', AsyncMock(return_value=None)):
            task = asyncio.create_task(self.flow.register())
            self.tasks.append(task)
            await asyncio.wait_for(self.second_pause.wait(), timeout=15)
            self.assertTrue(self.job.waiting_for_user)
            self.assertEqual(self.api_state, 'awaiting_user')
            self.assertEqual([data['newMailRequest'] for name, data in self.events if name == 'waiting_email'], [True])
            self.assertEqual([path for path, _body in self.submissions], ['/fixture/email'])
            self.job.wait_code.assert_not_awaited()
            self.job.prepare_mail.assert_called_once_with('email_code', new_request=True)
            self.assertEqual(self.page_errors, [])

    async def test_code_navigation_after_old_body_read_pauses_for_stable_human_challenge(self):
        await self.resume_mail_fixture('challenge', gate_navigation=True)
        from registration_browser import CODE_INPUT
        challenge, field = self.flow.challenge, self.flow.field
        ready = crossed = False
        async def observe_old_body():
            nonlocal ready
            result = await challenge()
            if self.submissions and not crossed:
                ready = True
            return result
        async def cross_before_code(page, selector):
            nonlocal crossed
            if ready and not crossed and selector == CODE_INPUT:
                crossed = True
                await page.goto('https://chatgpt.com/email-verification', wait_until='domcontentloaded')
            return await field(page, selector)
        self.flow.challenge = observe_old_body
        self.flow.field = cross_before_code
        with patch('registration_browser.official_identity', AsyncMock(return_value=None)):
            task = asyncio.create_task(self.flow.register())
            self.tasks.append(task)
            await asyncio.wait_for(self.second_pause.wait(), timeout=5)
            self.assertTrue(crossed)
            self.assertTrue(await self.page.locator('#human-challenge').is_visible())
            self.assertTrue(self.job.waiting_for_user)
            self.assertEqual(self.api_state, 'awaiting_user')
            self.assertEqual([data['newMailRequest'] for name, data in self.events if name == 'waiting_email'], [True])
            self.assertEqual([path for path, _body in self.submissions], ['/fixture/email'])
            self.job.prepare_mail.assert_called_once_with('email_code', new_request=True)
            self.job.wait_code.assert_not_awaited()
            self.assertEqual(self.page_errors, [])


@unittest.skipUnless(os.environ.get('V2_REGISTRATION_BROWSER_TEST') == '1', 'explicit local fixture')
class PassiveVerificationBrowserTests(unittest.IsolatedAsyncioTestCase):
    """A disappearing fixture challenge is observed, never clicked or solved."""
    async def asyncSetUp(self):
        await ProfileBrowserTests.asyncSetUp(self)
        from registration_builtin import RegistrationServerJob
        from test_registration_builtin import server_payload
        value = server_payload()
        value['browserProfileId'] = 'reg_' + 'a' * 64
        value['registrationAge'] = 45
        self.job = RegistrationServerJob(value['id'], value,
            'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
        self.job.registration_state = {}
        self.flow = RegistrationBrowser(self.job, self.context)
        self.flow.page = self.page
        self.flow.registration_country = AsyncMock(return_value='US')
        async def settle(_seconds=2):
            self.job.check()
            await asyncio.sleep(.02)
        self.flow.settle = settle
        self.job.prepare_mail = MagicMock(wraps=self.job.prepare_mail)
        self.job.wait_code = AsyncMock(wraps=self.job.wait_code)
        self.job.manual = AsyncMock(wraps=self.job.manual)
        self.job.signal_resume = MagicMock(wraps=self.job.signal_resume)
        self.tasks = []
        self.requests = []
        self.waiting_user = asyncio.Event()
        self.server_registered = False
        self.mail_fence = 1
        self.deliveries = 0

    async def asyncTearDown(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await ProfileBrowserTests.asyncTearDown(self)

    async def passive_fixture(self, resolved='code', *, disappears=True, stop=None, succeeds=False):
        async def change_challenge():
            # Only fixture JavaScript removes its overlay. No CAPTCHA input is operated.
            if stop == 'cancel':
                self.job.signal_cancel()
            elif stop == 'expiry':
                self.job.deadline = time.monotonic() - 1
            await self.page.evaluate("document.dispatchEvent(new Event('fixture-auto-resolve'))")

        def event(name, **data):
            self.events.append((name, data))
            self.job.step = data.get('step', self.job.step)
            if name == 'waiting_user':
                self.assertEqual(data.get('reason'), 'verification_required')
                self.assertTrue(self.job.waiting_for_user)
                self.waiting_user.set()
                self.job.deadline = time.monotonic() + (15 if succeeds else 2)
                if disappears:
                    self.tasks.append(asyncio.create_task(change_challenge()))
            elif name == 'waiting_email':
                self.assertFalse(self.job.waiting_for_user)
                if data.get('newMailRequest'):
                    self.mail_fence += 1
                self.job.signal_code('123456', self.job.attempt, 'email_code', 'fixture-passive-mail')
                self.deliveries += 1

        self.job.event = event
        html = '''<!doctype html><html><head><meta charset="utf-8"></head><body>
        <main><h1>Verify you are human</h1><div class="cf-turnstile">
        <button id="captcha">I am human</button></div></main><script>
        document.documentElement.dataset.captchaClicks='0';
        document.querySelector('#captcha').onclick=()=>{
          document.documentElement.dataset.captchaClicks=String(Number(document.documentElement.dataset.captchaClicks)+1);
        };
        const root=document.querySelector('main');
        window.render=stage=>{
          const code='<form><p>Check your email. Email verification code</p>'
            +'<input name="code" autocomplete="one-time-code"><button>Continue</button></form>';
          const profile='<form><input name="name" autocomplete="name">'
            +'<input name="age" type="number"><button>Continue</button></form>';
          if(stage==='code'||stage==='ambiguous_code')root.innerHTML=code+(stage==='ambiguous_code'?code:'');
          else if(stage==='profile'||stage==='ambiguous_profile')root.innerHTML=profile+(stage==='ambiguous_profile'?profile:'');
          else root.innerHTML='<main>Loading...</main>';
          root.querySelectorAll('form').forEach(form=>form.onsubmit=async event=>{
            event.preventDefault();const kind=form.querySelector('[name=code]')?'code':'profile';
            const values={};form.querySelectorAll('input[name]').forEach(input=>values[input.name]=input.value);
            await fetch('/fixture/'+kind,{method:'POST',body:JSON.stringify(values)});
            if(kind==='code')window.render('profile');else root.innerHTML='<p>Welcome</p>';
          });
        };
        document.addEventListener('fixture-auto-resolve',()=>setTimeout(()=>window.render(__RESOLVED__),80));
        </script></body></html>'''.replace('__RESOLVED__', json.dumps(resolved))

        def session():
            def part(value):
                return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
            token = '.'.join((part({'alg': 'RS256'}), part({
                'exp': int(time.time()) + 3600,
                'https://api.openai.com/auth': {'chatgpt_account_id': 'passive-fixture-account'},
                'https://api.openai.com/profile': {'email': self.job.payload['email']}}),
                'c3ludGhldGljX3NpZ25hdHVyZQ'))
            return {'accessToken': token, 'user': {'id': 'passive-fixture-user',
                    'email': self.job.payload['email']}, 'account': {'id': 'passive-fixture-account'}}

        async def local(route):
            request = route.request
            path = urlsplit(request.url).path
            self.requests.append((request.method, path, request.is_navigation_request()))
            if path == '/api/auth/session':
                self.assertEqual(request.method, 'GET')
                await route.fulfill(content_type='application/json',
                    body=json.dumps(session() if self.server_registered else {}))
            elif path == '/backend-api/accounts/check/v4-2023-04-27':
                self.assertEqual(request.method, 'GET')
                self.assertTrue(self.server_registered)
                await route.fulfill(content_type='application/json', body=json.dumps({
                    'accounts': {'passive-fixture-account': {'account': {'plan_type': 'free'}}}}))
            elif path in {'/fixture/code', '/fixture/profile'}:
                self.assertEqual(request.method, 'POST')
                self.submissions.append((path, json.loads(request.post_data)))
                if path == '/fixture/profile':
                    self.server_registered = True
                await route.fulfill(content_type='application/json', body='{}')
            else:
                self.assertEqual((request.method, path), ('GET', '/email-verification'))
                await route.fulfill(content_type='text/html', body=html)
        await self.context.route('**/*', local)
        await self.page.goto('https://chatgpt.com/email-verification', wait_until='domcontentloaded')
        self.assertEqual(self.page_errors, [])
        self.assertEqual(await self.page.evaluate('document.documentElement.dataset.captchaClicks'), '0')
        self.job.deadline = time.monotonic() + 15

    async def assert_pause_integrity(self):
        self.job.manual.assert_awaited_once_with('verification_required', can_resume=self.flow.verification_resolved)
        self.job.signal_resume.assert_not_called()
        self.assertTrue(self.waiting_user.is_set())
        self.assertFalse(self.job.waiting_for_user)
        self.assertIsNone(self.job.manual_reason)
        await asyncio.gather(*self.tasks)
        self.assertEqual(await self.page.evaluate('document.documentElement.dataset.captchaClicks'), '0')
        self.assertEqual([(method, path) for method, path, navigation in self.requests if navigation],
                         [('GET', '/email-verification')])
        self.assertFalse(self.flow.registration_refreshed)
        self.assertIs(self.flow.page, self.page)
        self.assertIs(self.flow.context, self.context)
        self.assertEqual(self.mail_fence, 1)
        self.assertEqual(self.page_errors, [])

    async def stopped_fixture(self, resolved='code', *, disappears=True, stop=None):
        await self.passive_fixture(resolved, disappears=disappears, stop=stop)
        with self.assertRaises(Stop) as stopped:
            await asyncio.wait_for(self.flow.register(), timeout=12)
        self.assertEqual(stopped.exception.report['reason'],
                         'operation_cancelled' if stop == 'cancel' else 'verification_required')
        await self.assert_pause_integrity()
        self.assertEqual(self.submissions, [])
        self.job.prepare_mail.assert_not_called()
        self.job.wait_code.assert_not_awaited()
        self.assertEqual(self.deliveries, 0)
        self.assertFalse(self.job.payload['registered'])
        self.assertFalse(self.job.payload['passwordVerified'])
        self.assertFalse(self.job.payload['mfaVerified'])
        self.assertNotIn('registered', [name for name, _data in self.events])

    async def test_self_resolving_challenge_delivers_code_once_then_completes_original_profile(self):
        await self.passive_fixture(succeeds=True)
        await asyncio.wait_for(self.flow.register(), timeout=20)
        await self.assert_pause_integrity()
        self.assertEqual(self.submissions, [('/fixture/code', {'code': '123456'}),
            ('/fixture/profile', {'name': self.job.payload['displayName'], 'age': '45'})])
        self.job.wait_code.assert_awaited_once()
        self.job.prepare_mail.assert_called_once_with('email_code')
        self.assertEqual(self.deliveries, 1)
        self.assertEqual([data.get('newMailRequest') for name, data in self.events if name == 'waiting_email'], [False])
        self.assertTrue(self.flow.registration_state['code_submitted'])
        self.assertTrue(self.flow.registration_state['profile_submitted'])
        self.assertTrue(self.job.payload['registered'])
        self.assertFalse(self.job.payload['passwordVerified'])
        self.assertFalse(self.job.payload['mfaVerified'])
        self.assertEqual([name for name, _data in self.events].count('registered'), 1)

    async def test_self_resolving_challenge_can_continue_new_profile_after_previous_code_submission(self):
        self.flow.registration_state['code_submitted'] = True
        await self.passive_fixture('profile', succeeds=True)
        await asyncio.wait_for(self.flow.register(), timeout=20)
        await self.assert_pause_integrity()
        self.assertEqual(self.submissions, [('/fixture/profile',
            {'name': self.job.payload['displayName'], 'age': '45'})])
        self.job.wait_code.assert_not_awaited()
        self.job.prepare_mail.assert_not_called()
        self.assertTrue(self.job.payload['registered'])

    async def test_genuine_challenge_remains_paused_without_mail_or_captcha_actions(self):
        await self.stopped_fixture(disappears=False)
        self.assertTrue(await self.page.locator('.cf-turnstile').is_visible())

    async def test_disappeared_challenge_does_not_replay_previously_submitted_code(self):
        self.flow.registration_state['code_submitted'] = True
        await self.stopped_fixture()
        self.assertTrue(await self.page.locator('input[name="code"]').is_visible())

    async def test_disappeared_challenge_does_not_replay_previously_submitted_profile(self):
        self.flow.registration_state['profile_submitted'] = True
        await self.stopped_fixture('profile')

    async def test_disappeared_challenge_with_ambiguous_code_forms_remains_paused(self):
        await self.stopped_fixture('ambiguous_code')

    async def test_disappeared_challenge_with_ambiguous_profile_forms_remains_paused(self):
        await self.stopped_fixture('ambiguous_profile')

    async def test_cancel_wins_when_fixture_challenge_disappears(self):
        await self.stopped_fixture(stop='cancel')

    async def test_original_deadline_wins_when_fixture_challenge_disappears(self):
        await self.stopped_fixture(stop='expiry')


@unittest.skipUnless(os.environ.get('V2_REGISTRATION_BROWSER_TEST') == '1', 'explicit local fixture')
class OriginalAttemptBrowserTests(unittest.IsolatedAsyncioTestCase):
    """Actual form writes across expired attempts in one retained browser context."""
    async def asyncSetUp(self):
        await ProfileBrowserTests.asyncSetUp(self)
        from test_registration_builtin import server_payload
        self.payload = server_payload()
        self.payload['browserProfileId'] = 'reg_' + 'a' * 64
        self.registration_state = {}
        self.jobs = []
        self.events = []
        self.mail_requests = []
        self.mail_fence = 1
        self.api_step = 'email_code'
        self.last_mail_id = None
        self.auto_delivery = False
        self.expire_on_post = False
        self.post_seen = asyncio.Event()

    async def asyncTearDown(self):
        await ProfileBrowserTests.asyncTearDown(self)

    def new_attempt(self, attempt):
        from registration_builtin import RegistrationServerJob
        from registration_job import STEPS
        body = {**self.payload, 'attempt': attempt, 'step': self.api_step}
        job = RegistrationServerJob(body['id'], body,
            'http://api:3000/api/id-business-v2/auto-registration/local', MagicMock())
        job.registration_state = self.registration_state
        self.jobs.append(job)
        def event(name, **data):
            previous_step = self.api_step
            requested = data.get('step', job.step)
            if STEPS.index(requested) < STEPS.index(job.step):
                requested = job.step
            job.step = self.api_step = requested
            self.events.append((attempt, name, data))
            if name == 'waiting_email':
                # Match the existing callback's same-profile email request fence.
                if data.get('newMailRequest') or previous_step != 'email_code':
                    self.mail_fence += 1
                self.mail_requests.append((attempt, data.get('newMailRequest'), self.mail_fence))
                if self.auto_delivery:
                    job.signal_code('123456', job.attempt, 'email_code', f'fixture-mail-{attempt}')
            elif name == 'mail_accepted':
                self.last_mail_id = data['mailId']
        job.event = event
        job.wait_code = AsyncMock(wraps=job.wait_code)
        job.prepare_mail = MagicMock(wraps=job.prepare_mail)
        job.manual = AsyncMock(side_effect=Stop('fixture_paused'))
        flow = RegistrationBrowser(job, self.context)
        flow.page = self.page
        async def settle(_seconds=2):
            job.check()
            await asyncio.sleep(_seconds if _seconds <= .5 else .02)
        flow.settle = settle
        flow.registration_country = AsyncMock(return_value='US')
        self.job, self.flow = job, flow
        return job, flow

    async def serve_form(self, kind, *, auto_navigation=False, auto_submit=False):
        field = '<input type="email">' if kind == 'email' else '<input name="code" autocomplete="one-time-code">'
        html = '''<!doctype html><html><body><form>__FIELD__<button>Continue</button></form><script>
        window.enterPresses=0;
        document.querySelector('input').addEventListener('keydown',event=>{
          if(event.key==='Enter')window.enterPresses++;
        });
        window.releaseNavigation=()=>window.location.assign('/welcome');
        document.querySelector('form').onsubmit=async event=>{
          event.preventDefault();__BUSY__
          await fetch('/fixture/__KIND__',{method:'POST',body:JSON.stringify({
            value:event.target.querySelector('input').value,enterPresses:window.enterPresses})});
          __NAVIGATE__
        };
        __AUTO_SUBMIT__
        </script></body></html>'''.replace('__FIELD__', field).replace('__KIND__', kind).replace(
            '__BUSY__', "event.target.setAttribute('aria-busy','true');" if kind == 'code' else '').replace(
            '__NAVIGATE__', 'window.releaseNavigation();' if auto_navigation else '').replace('__AUTO_SUBMIT__',
            '''window.autoSent=false;document.querySelector('input').addEventListener('input',event=>{
              if(event.target.value&&!window.autoSent){window.autoSent=true;event.target.form.requestSubmit();}
            });''' if auto_submit else '')
        async def local(route):
            request = route.request
            self.navigation_methods.append(request.method)
            path = urlsplit(request.url).path
            if path == '/api/auth/session':
                self.assertEqual(request.method, 'GET')
                await route.fulfill(content_type='application/json', body='{}')
                return
            if request.method == 'POST':
                self.assertEqual(path, '/fixture/' + kind)
                self.submissions.append((path, json.loads(request.post_data)))
                await route.fulfill(content_type='application/json', body='{}')
                self.post_seen.set()
                if self.expire_on_post and self.job.attempt == 1:
                    self.job.deadline = time.monotonic() - 1
            else:
                self.assertEqual(request.method, 'GET')
                self.assertIn(path, {'/auth/login', '/email-verification', '/welcome'})
                body = '<main>Welcome</main>' if path == '/welcome' else html
                await route.fulfill(content_type='text/html', body=body)
        await self.context.route('**/*', local)
        url = 'https://chatgpt.com/auth/login' if kind == 'email' else 'https://chatgpt.com/email-verification'
        await self.page.goto(url, wait_until='domcontentloaded')

    async def register_attempt(self, flow, *, reason=None):
        async def identity(page, _email, **_kwargs):
            return ('fixture', 'identity') if urlsplit(page.url).path == '/welcome' else None
        with patch('registration_browser.official_identity', identity):
            if reason:
                with self.assertRaises(Stop) as stopped:
                    await asyncio.wait_for(flow.register(), timeout=45)
                self.assertEqual(stopped.exception.report['reason'], reason)
            else:
                await asyncio.wait_for(flow.register(), timeout=45)

    async def test_expired_email_attempt_never_resubmits_unknown_original_result(self):
        self.api_step = 'queued'
        self.expire_on_post = True
        await self.serve_form('email')
        original_page, original_context = self.page, self.context
        first, flow = self.new_attempt(1)
        await self.register_attempt(flow, reason='mailbox_timeout')
        self.assertEqual(len(self.submissions), 1)
        first.wait_code.assert_not_awaited()
        fence = self.mail_fence
        second, flow = self.new_attempt(2)
        self.assertTrue(await self.page.locator('input[type="email"]').is_visible())
        self.assertEqual(await self.page.locator('[aria-busy="true"]').count(), 0)
        self.assertEqual((await flow.registration_view())[0], 'email')
        await self.register_attempt(flow, reason='fixture_paused')
        self.assertEqual(self.submissions, [('/fixture/email', {'value': self.payload['email'], 'enterPresses': 0})])
        self.assertEqual(self.navigation_methods.count('POST'), 1)
        self.assertEqual(self.mail_fence, fence)
        self.assertEqual(self.mail_requests, [(1, True, fence)])
        second.prepare_mail.assert_not_called()
        second.wait_code.assert_not_awaited()
        self.assertIs(flow.page, original_page)
        self.assertIs(flow.context, original_context)
        self.assertFalse(flow.data['registered'])
        self.assertEqual(self.page_errors, [])

    async def test_expired_submitted_code_waits_for_late_navigation_without_new_mail_or_enter(self):
        self.auto_delivery = self.expire_on_post = True
        await self.serve_form('code')
        first, flow = self.new_attempt(1)
        await self.register_attempt(flow, reason='mailbox_timeout')
        self.assertEqual(self.submissions, [('/fixture/code', {'value': '123456', 'enterPresses': 1})])
        first.wait_code.assert_awaited_once()
        self.assertEqual(self.last_mail_id, 'fixture-mail-1')
        fence = self.mail_fence
        second, flow = self.new_attempt(2)
        settles = 0
        async def delayed_navigation(_seconds=2):
            nonlocal settles
            second.check()
            settles += 1
            if settles == 2:
                # Keep the old submitted code DOM until the resumed flow observes it.
                await self.page.goto('https://chatgpt.com/welcome', wait_until='domcontentloaded')
            await asyncio.sleep(.02)
        flow.settle = delayed_navigation
        await self.register_attempt(flow)
        self.assertEqual(self.submissions, [('/fixture/code', {'value': '123456', 'enterPresses': 1})])
        self.assertEqual(self.navigation_methods.count('POST'), 1)
        second.wait_code.assert_not_awaited()
        second.prepare_mail.assert_not_called()
        self.assertEqual(self.mail_fence, fence)
        self.assertEqual(self.last_mail_id, 'fixture-mail-1')
        self.assertTrue(flow.data['registered'])
        self.assertIs(flow.page, self.page)
        self.assertIs(flow.context, self.context)
        self.assertEqual(self.page_errors, [])

    async def test_expired_wait_before_code_submission_still_automatically_delivers_once(self):
        await self.serve_form('code', auto_navigation=True)
        first, flow = self.new_attempt(1)
        wait_entered = asyncio.Event()
        original_wait = first.wait_code
        async def wait_then_mark():
            wait_entered.set()
            return await original_wait()
        first.wait_code = AsyncMock(side_effect=wait_then_mark)
        async def expire_wait():
            await asyncio.wait_for(wait_entered.wait(), timeout=10)
            first.deadline = time.monotonic() - 1
        expiration = asyncio.create_task(expire_wait())
        try:
            await self.register_attempt(flow, reason='mailbox_timeout')
        finally:
            await expiration
        self.assertEqual(self.submissions, [])
        first.wait_code.assert_awaited_once()
        self.assertIsNone(self.last_mail_id)
        self.assertFalse(self.registration_state.get('code_submitted', False))
        fence = self.mail_fence
        self.auto_delivery = True
        second, flow = self.new_attempt(2)
        await self.register_attempt(flow)
        self.assertEqual(self.submissions, [('/fixture/code', {'value': '123456', 'enterPresses': 1})])
        self.assertEqual(self.navigation_methods.count('POST'), 1)
        second.wait_code.assert_awaited_once()
        second.prepare_mail.assert_called_once_with('email_code')
        self.assertEqual(self.last_mail_id, 'fixture-mail-2')
        self.assertEqual(self.mail_fence, fence)
        self.assertTrue(flow.data['registered'])
        self.assertIs(flow.context, self.context)
        self.assertEqual(self.page_errors, [])

    async def test_auto_submitted_code_interrupted_fill_never_replays_on_new_attempt(self):
        from playwright.async_api import Error
        from registration_browser import CODE_INPUT
        self.auto_delivery = True
        await self.serve_form('code', auto_submit=True)
        first, flow = self.new_attempt(1)
        original_field = flow.field
        async def navigation_interrupt(page, selector):
            field = await original_field(page, selector)
            if field and selector == CODE_INPUT:
                async def fill_and_interrupt(value):
                    await field.fill(value)  # Native oninput sends a real fixture POST.
                    await asyncio.wait_for(self.post_seen.wait(), timeout=5)
                    await page.goto('https://chatgpt.com/email-verification', wait_until='domcontentloaded')
                    # Deterministic fault after real submission/navigation, before fill returns.
                    raise Error('Execution context was destroyed during fixture navigation')
                return SimpleNamespace(fill=fill_and_interrupt, press=field.press)
            return field
        flow.field = navigation_interrupt
        with self.assertRaises(Error):
            await self.register_attempt(flow)
        self.assertEqual(self.submissions, [('/fixture/code', {'value': '123456', 'enterPresses': 0})])
        self.assertEqual(self.last_mail_id, 'fixture-mail-1')
        first.deadline = time.monotonic() - 1
        first.wait_code.assert_awaited_once()
        second, flow = self.new_attempt(2)
        settles = 0
        async def delayed_navigation(_seconds=2):
            nonlocal settles
            second.check()
            settles += 1
            if settles == 2:
                await self.page.goto('https://chatgpt.com/welcome', wait_until='domcontentloaded')
            await asyncio.sleep(.02)
        flow.settle = delayed_navigation
        await self.register_attempt(flow)
        self.assertEqual(self.submissions, [('/fixture/code', {'value': '123456', 'enterPresses': 0})])
        self.assertEqual(self.navigation_methods.count('POST'), 1)
        second.wait_code.assert_not_awaited()
        second.prepare_mail.assert_not_called()
        self.assertEqual(self.last_mail_id, 'fixture-mail-1')
        self.assertTrue(flow.data['registered'])
        self.assertIs(flow.context, self.context)
        self.assertEqual(self.page_errors, [])


if __name__ == '__main__':
    unittest.main()
