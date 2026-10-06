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
                     change_on_fill=None, offer_password_choice=False, tel_codes=False, allow_email_identity=False,
                     first_navigation_failure=False):
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
                        if route.request.is_navigation_request():
                            order.append('navigation')
                            if first_navigation_failure and order.count('navigation') == 1:
                                await route.abort('connectionreset')
                                return
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
                cancelled=threading.Event(),
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

    async def test_failed_initial_get_recovers_before_single_email_and_password_submit(self):
        result, submissions, job, order = await self.verify(
            ['email', 'password', 'identity'], first_navigation_failure=True)
        self.assertEqual(result, 'verified')
        self.assertEqual(submissions, ['email', 'password'])
        self.assertEqual(order.count('navigation'), 2)
        self.assertLess(order.index('prepared'), order.index('email'))
        job.prepare_mail.assert_called_once_with('password', new_request=True)
        job.wait_code.assert_not_awaited()

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

    async def test_delayed_email_only_identity_never_proves_password_or_mfa(self):
        result, submissions, job, _ = await self.verify(
            ['email','email_code','identity'], delay_code=True, allow_email_identity=True)
        self.assertEqual(result,'email_identity_only')
        self.assertEqual(submissions,['email','email_code'])
        job.wait_code.assert_awaited_once()
        for allow, mfa in [(False,False),(True,True)]:
            result, submissions, job, _ = await self.verify(
                ['email','email_code','identity'], delay_code=True, allow_email_identity=allow, mfa=mfa)
            self.assertEqual(result,'verification_required')
            self.assertEqual(submissions,['email','email_code'])
            job.wait_code.assert_awaited_once()

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


class RegisteredPasswordRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def flow(self):
        flow = RecoveryTests().flow('https://chatgpt.com')
        flow.data.update(registered=True, passwordVerified=False, mfaVerified=False)
        flow.registration_state.update(email_submitted=True, code_submitted=True, profile_submitted=True)
        flow.context.pages = [flow.page]
        flow.guard_registered_onboarding = AsyncMock()
        flow.register = AsyncMock()
        flow.password = AsyncMock()
        flow.mfa = AsyncMock()
        flow.offer = AsyncMock()
        flow.job.wait_code = AsyncMock()
        return flow

    async def test_registered_resume_recovers_only_same_page_get_then_password(self):
        flow = self.flow()
        flow.identity = AsyncMock(side_effect=[Stop('session_load_timeout'), ('same', 'identity')])
        with patch('registration_browser.clear_visible_secrets', AsyncMock()):
            await flow.run()
        flow.register.assert_not_awaited()
        flow.job.wait_code.assert_not_awaited()
        flow.password.assert_awaited_once()
        flow.mfa.assert_awaited_once()
        flow.page.goto.assert_awaited_once_with('https://chatgpt.com', wait_until='domcontentloaded', timeout=0)
        flow.page.reload.assert_not_awaited()
        self.assertEqual(flow.identity.await_count, 2)
        self.assertTrue(flow.registration_refreshed)
        self.assertIsNone(flow.observation_budget)
        self.assertEqual(flow.registration_state, dict(email_submitted=True, code_submitted=True, profile_submitted=True))

    async def test_network_timeout_and_navigation_race_can_recover(self):
        Error = type('Error', (Exception,), {})
        errors = [Stop('session_network_error'), asyncio.TimeoutError(),
                  Error('net::ERR_CONNECTION_RESET'), Error('Execution context was destroyed')]
        for error in errors:
            with self.subTest(kind=type(error).__name__):
                flow = self.flow()
                flow.identity = AsyncMock(side_effect=[error, ('same', 'identity')])
                self.assertEqual(await flow.registered_identity(), ('same', 'identity'))
                flow.page.goto.assert_awaited_once()
                flow.guard_registered_onboarding.assert_awaited_once()
                self.assertIsNone(flow.recovery_readonly)

    async def test_authority_stable_ambiguity_verification_and_http_do_not_refresh(self):
        errors = [Stop('official_login_email_mismatch'), Stop('official_login_not_verified'),
                  Stop('login_form_ambiguous'), Stop('form_unrecognized'), Stop('verification_required'),
                  Stop('session_network_error', user_action_required=True),
                  Stop('session_network_error', http_status=403)]
        for error in errors:
            with self.subTest(reason=error.report['reason']):
                flow = self.flow(); flow.identity = AsyncMock(side_effect=error)
                with self.assertRaises(Stop) as stopped:
                    await flow.registered_identity()
                self.assertIs(stopped.exception, error)
                flow.page.goto.assert_not_awaited()
                flow.password.assert_not_awaited()

    async def test_unknown_error_is_not_stringified_or_recovered(self):
        class SecretError(Exception):
            def __str__(self):
                raise AssertionError('Exception text must not be needed')
        flow = self.flow(); error = SecretError()
        flow.identity = AsyncMock(side_effect=error)
        with self.assertRaises(SecretError) as stopped:
            await flow.registered_identity()
        self.assertIs(stopped.exception, error)
        flow.page.goto.assert_not_awaited()

    async def test_identity_recovery_keeps_first_closed_failure_when_terminal_identity_fails(self):
        flow = self.flow()
        flow.identity = AsyncMock(side_effect=[asyncio.TimeoutError('https://secret.invalid/?token=private'), None])
        with self.assertRaises(Stop) as stopped:
            await flow.registered_identity()
        self.assertEqual(stopped.exception.report['reason'],'official_login_not_verified')
        self.assertEqual(flow.job.registration_observation_error,
                         {'reason':'session_load_timeout','error_type':'TimeoutError'})
        self.assertNotIn('secret',json.dumps(flow.job.registration_observation_error))
        self.assertNotIn('private',json.dumps(flow.job.registration_observation_error))

    async def test_identity_recovery_preserves_existing_first_reason_without_stringification(self):
        flow = self.flow(); first = {'reason':'registration_page_changing','error_type':'Error'}
        flow.job.registration_observation_error = first
        flow.identity = AsyncMock(side_effect=[Stop('session_network_error'),('same','identity')])
        await flow.registered_identity()
        self.assertIs(flow.job.registration_observation_error,first)

    async def test_identity_recovery_error_fields_are_closed_and_navigation_race_is_explicit(self):
        flow = self.flow()
        flow.identity = AsyncMock(side_effect=[Stop('session_network_error',error_type='password=private',
            browser_error_code='https://secret.invalid/',response_body='private OTP'),('same','identity')])
        await flow.registered_identity()
        self.assertEqual(flow.job.registration_observation_error,{'reason':'session_network_error'})
        Error = type('Error',(Exception,),{})
        flow = self.flow()
        flow.identity = AsyncMock(side_effect=[Error('Execution context was destroyed https://secret.invalid/'),('same','identity')])
        await flow.registered_identity()
        self.assertEqual(flow.job.registration_observation_error,
                         {'reason':'registration_page_changing','error_type':'Error'})

    async def test_anonymous_identity_requires_manual_without_refresh(self):
        flow = self.flow(); flow.identity = AsyncMock(return_value=None)
        flow.job.manual = AsyncMock()
        with patch('registration_browser.clear_visible_secrets', AsyncMock()):
            with self.assertRaises(Stop) as stopped:
                await flow.run()
        self.assertEqual(stopped.exception.report['reason'], 'official_login_not_verified')
        flow.job.manual.assert_awaited_once_with('official_login_not_verified')
        flow.page.goto.assert_not_awaited(); flow.register.assert_not_awaited()
        flow.password.assert_not_awaited()

    async def test_recovery_exhaustion_does_not_replay_or_refresh_again(self):
        flow = self.flow(); flow.identity = AsyncMock(side_effect=Stop('session_network_error'))
        for _ in range(2):
            with self.assertRaises(Stop):
                await flow.registered_identity()
        self.assertEqual(flow.page.goto.await_count, 1)
        self.assertEqual(flow.identity.await_count, 3)
        flow.register.assert_not_awaited(); flow.password.assert_not_awaited()
        self.assertTrue(flow.data['registered'])

    async def test_recovery_without_same_email_identity_keeps_readonly_until_run_cleanup(self):
        flow = self.flow()
        flow.identity = AsyncMock(side_effect=[Stop('session_network_error'), None])
        with self.assertRaises(Stop) as stopped:
            await flow.registered_identity()
        self.assertEqual(stopped.exception.report['reason'], 'official_login_not_verified')
        self.assertIsNotNone(flow.recovery_readonly)
        flow.context.unroute.assert_not_awaited()
        post = SimpleNamespace(request=SimpleNamespace(method='POST'), abort=AsyncMock(), fallback=AsyncMock())
        await flow.recovery_readonly(post)
        post.abort.assert_awaited_once(); post.fallback.assert_not_awaited()
        flow.password.assert_not_awaited()

    async def retained_failure(self):
        flow = self.flow(); flow.job.registration_state = flow.registration_state
        flow.identity = AsyncMock(side_effect=[Stop('session_network_error'), None])
        with patch('registration_browser.clear_visible_secrets', AsyncMock()):
            with self.assertRaises(Stop) as stopped:
                await flow.run()
        self.assertEqual(stopped.exception.report['reason'], 'official_login_not_verified')
        return flow

    async def test_run_failure_retains_one_handler_and_all_submission_facts(self):
        from registration_browser import IDENTITY_RECOVERY
        flow = await self.retained_failure()
        retained = flow.registration_state[IDENTITY_RECOVERY]
        self.assertIs(retained['context'], flow.context)
        self.assertIs(retained['page'], flow.page)
        self.assertIs(retained['handler'], flow.recovery_readonly)
        self.assertTrue(all(flow.registration_state[key] for key in ['email_submitted','code_submitted','profile_submitted']))
        self.assertNotIn(retained['handler'], [call.args[1] for call in flow.context.unroute.await_args_list])
        post = SimpleNamespace(request=SimpleNamespace(method='POST'), abort=AsyncMock(), fallback=AsyncMock())
        await flow.recovery_readonly(post)
        post.abort.assert_awaited_once(); post.fallback.assert_not_awaited()

    async def test_continue_adopts_exact_handler_and_unlocks_only_after_identity(self):
        from registration_browser import IDENTITY_RECOVERY
        old = await self.retained_failure(); handler = old.recovery_readonly
        flow = RegistrationBrowser(old.job, old.context)
        self.assertIs(flow.recovery_readonly, handler)
        self.assertTrue(flow.registration_refreshed)
        flow.guard_registered_onboarding = AsyncMock()
        flow.identity = AsyncMock(return_value=('same','identity'))
        async def password():
            self.assertIsNone(flow.recovery_readonly)
            self.assertNotIn(IDENTITY_RECOVERY, flow.registration_state)
        flow.password = AsyncMock(side_effect=password); flow.mfa = AsyncMock(); flow.offer = AsyncMock()
        with patch('registration_browser.clear_visible_secrets', AsyncMock()):
            await flow.run()
        self.assertIs(flow.page, old.page)
        flow.password.assert_awaited_once()
        self.assertEqual(old.page.goto.await_count, 1)
        old.context.unroute.assert_any_await('**/*', handler)

    async def test_continue_network_failure_keeps_same_handler_without_second_get(self):
        from registration_browser import IDENTITY_RECOVERY
        old = await self.retained_failure()
        flow = RegistrationBrowser(old.job, old.context)
        flow.guard_registered_onboarding = AsyncMock()
        flow.identity = AsyncMock(side_effect=Stop('session_network_error'))
        with patch('registration_browser.clear_visible_secrets', AsyncMock()):
            with self.assertRaises(Stop): await flow.run()
        self.assertIs(flow.registration_state[IDENTITY_RECOVERY]['handler'], old.recovery_readonly)
        self.assertEqual(old.page.goto.await_count, 1)
        self.assertIs(flow.page, old.page)

    async def test_new_guard_cannot_hide_retained_readonly_route(self):
        old = await self.retained_failure()
        flow = RegistrationBrowser(old.job, old.context)
        post = SimpleNamespace(request=SimpleNamespace(method='POST'), abort=AsyncMock(), fallback=AsyncMock(), continue_=AsyncMock())
        await flow.guard(post)
        post.abort.assert_awaited_once(); post.continue_.assert_not_awaited()

    async def test_handler_context_page_and_registered_binding_cannot_change(self):
        old = await self.retained_failure()
        for context, registered in [(SimpleNamespace(),True),(old.context,False)]:
            old.job.payload['registered'] = registered
            with self.assertRaises(Stop) as stopped:
                RegistrationBrowser(old.job, context)
            self.assertEqual(stopped.exception.report['reason'], 'builtin_profile_missing')
        old.job.payload['registered'] = True
        flow = RegistrationBrowser(old.job, old.context)
        old.context.pages = []
        with patch('registration_browser.clear_visible_secrets', AsyncMock()):
            with self.assertRaises(Stop) as stopped: await flow.run()
        self.assertEqual(stopped.exception.report['reason'], 'builtin_profile_missing')
        self.assertEqual(old.page.goto.await_count, 1)

    async def test_failed_unroute_cannot_unlock_or_discard_retained_handler(self):
        from registration_browser import IDENTITY_RECOVERY
        old = await self.retained_failure(); handler = old.recovery_readonly
        flow = RegistrationBrowser(old.job, old.context); flow.page = old.page
        flow.identity = AsyncMock(return_value=('same','identity'))
        old.context.unroute.side_effect = RuntimeError('private cleanup')
        with self.assertRaises(RuntimeError): await flow.registered_identity()
        self.assertIs(flow.recovery_readonly, handler)
        self.assertIs(flow.registration_state[IDENTITY_RECOVERY]['handler'], handler)
        old.context.unroute.side_effect = None
        self.assertEqual(await flow.registered_identity(), ('same','identity'))
        self.assertIsNone(flow.recovery_readonly)
        self.assertNotIn(IDENTITY_RECOVERY, flow.registration_state)

    async def test_registered_human_pause_cannot_unlock_unverified_recovery(self):
        from registration_browser import IDENTITY_RECOVERY
        old = await self.retained_failure()
        flow = RegistrationBrowser(old.job, old.context)
        with self.assertRaises(Stop): await flow.manual_registration('verification_required')
        self.assertIs(flow.recovery_readonly, flow.registration_state[IDENTITY_RECOVERY]['handler'])
        old.job.manual.assert_awaited_once_with('verification_required')

    async def test_cancel_drops_ram_owner_but_blocks_until_exact_browser_close(self):
        from registration_browser import IDENTITY_RECOVERY
        old = await self.retained_failure(); old.job.cancelled.set()
        flow = RegistrationBrowser(old.job, old.context)
        flow.guard_registered_onboarding = AsyncMock()
        with patch('registration_browser.clear_visible_secrets', AsyncMock()):
            with self.assertRaises(Stop) as stopped: await flow.run()
        self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
        self.assertNotIn(IDENTITY_RECOVERY, flow.registration_state)
        post = SimpleNamespace(request=SimpleNamespace(method='POST'), abort=AsyncMock(), fallback=AsyncMock())
        await flow.recovery_readonly(post)
        post.abort.assert_awaited_once(); post.fallback.assert_not_awaited()
        from registration_builtin import BuiltinProfiles
        profiles = BuiltinProfiles(); profile = {'job_id':'fixture','browser':SimpleNamespace(),
                                                'proxy':{},'registration_state':flow.registration_state}
        profiles.profile = profile
        with patch('fingerprint_runtime.close_fingerprint_resource', AsyncMock(return_value=True)):
            await profiles.close('fixture')
        self.assertIsNone(profiles.profile); self.assertEqual(profile,{})

    async def test_unsafe_original_url_cannot_be_replayed(self):
        for url in ['https://auth.openai.com/callback?code=synthetic',
                    'https://chatgpt.com/?token=synthetic', 'https://chatgpt.com/checkout']:
            flow = self.flow(); flow.page.url = url
            flow.identity = AsyncMock(side_effect=Stop('session_load_timeout'))
            with self.assertRaises(Stop):
                await flow.registered_identity()
            flow.page.goto.assert_not_awaited()

    async def test_second_read_uses_same_total_budget_as_get(self):
        flow = self.flow(); budgets = []
        async def identity():
            budgets.append(flow.observation_budget)
            if len(budgets) == 1:
                raise Stop('session_load_timeout')
            return ('same', 'identity')
        flow.identity = identity
        original_refresh = flow.refresh_registration
        async def refresh():
            self.assertIsNot(flow.observation_budget, budgets[0])
            self.assertLessEqual(flow.observation_budget.seconds, 15)
            result = await original_refresh()
            budgets.append(flow.observation_budget)
            return result
        flow.refresh_registration = refresh
        await flow.registered_identity()
        self.assertIs(budgets[1], budgets[2])
        self.assertLessEqual(budgets[0].seconds, 10)

    async def test_deadline_and_cancellation_prevent_recovery_get(self):
        for cancel in [False, True]:
            flow = self.flow(); flow.identity = AsyncMock(side_effect=Stop('session_load_timeout'))
            if cancel:
                flow.job.cancelled.set()
            with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 0 if not cancel else 15):
                with self.assertRaises(Stop) as stopped:
                    await flow.registered_identity()
            self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled' if cancel else 'session_load_timeout')
            flow.page.goto.assert_not_awaited()

    async def test_registered_read_budget_is_capped_by_existing_job_deadline(self):
        flow = self.flow(); flow.job.deadline = time.monotonic() + .2
        flow.identity = AsyncMock(return_value=('same','identity'))
        await flow.registered_identity()
        self.assertLessEqual(flow.recovery_budget().seconds, .2)
        flow.page.goto.assert_not_awaited()
        flow.job.deadline = time.monotonic() - 1
        with self.assertRaises(Stop) as stopped:
            await flow.registered_identity()
        self.assertEqual(stopped.exception.report['reason'], 'session_load_timeout')
        self.assertEqual(flow.identity.await_count, 1)

    async def test_recovered_page_challenge_stops_before_password(self):
        flow = self.flow(); flow.identity = AsyncMock(side_effect=Stop('session_network_error'))
        flow.guard_registered_onboarding = AsyncMock(side_effect=Stop('verification_required'))
        with self.assertRaises(Stop) as stopped:
            await flow.registered_identity()
        self.assertEqual(stopped.exception.report['reason'], 'verification_required')
        self.assertEqual(flow.identity.await_count, 1)
        flow.password.assert_not_awaited()


class VerificationFailureDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    def flow(self):
        page = SimpleNamespace(url='https://chatgpt.com/auth/login',
            goto=AsyncMock(return_value=SimpleNamespace(status=200)),
            title=AsyncMock(return_value='Login'))
        body = SimpleNamespace(inner_text=AsyncMock(return_value='Continue'))
        page.locator = lambda selector: body if selector == 'body' else SimpleNamespace(all=AsyncMock(return_value=[]))
        verification = SimpleNamespace(route=AsyncMock(), unroute=AsyncMock(), new_page=AsyncMock(return_value=page), close=AsyncMock())
        job = SimpleNamespace(payload={'email':'synthetic@example.invalid','password':'synthetic-password'},
            check=lambda:None, cancelled=threading.Event(),
            new_verification_context=AsyncMock(return_value=verification),
            prepare_mail=MagicMock(), wait_code=AsyncMock(return_value='123456'))
        flow = RegistrationBrowser(job, SimpleNamespace())
        flow.settle = AsyncMock()
        flow.field = AsyncMock(return_value=None)
        return flow, verification, page

    async def test_route_and_page_failure_close_clean_context_and_keep_first_error(self):
        for stage in ['context_route', 'page_create']:
            flow, context, _page = self.flow()
            error = ValueError('https://secret.invalid/?token=synthetic-password')
            (context.route if stage == 'context_route' else context.new_page).side_effect = error
            context.close.side_effect = asyncio.TimeoutError('secret cleanup')
            with self.assertLogs('registration', level='WARNING') as logs:
                with self.assertRaises(ValueError) as stopped:
                    await flow.verify_login()
            self.assertIs(stopped.exception, error)
            self.assertEqual(flow.job.registration_operation, 'verification_' + stage)
            self.assertEqual(flow.job.registration_verification_error, {'phase':stage, 'error_type':'UnexpectedError'})
            self.assertEqual(flow.job.registration_verification_cleanup_error,
                             {'phase':'context_cleanup', 'error_type':'TimeoutError'})
            context.close.assert_awaited_once()
            self.assertNotIn('secret', '\n'.join(logs.output))
            self.assertNotIn('synthetic-password', '\n'.join(logs.output))

    async def test_context_creation_failure_is_classified_without_cleanup(self):
        flow, context, _page = self.flow()
        flow.job.new_verification_context.side_effect = asyncio.TimeoutError('private')
        with self.assertRaises(asyncio.TimeoutError):
            await flow.verify_login()
        self.assertEqual(flow.job.registration_operation, 'verification_context_create')
        context.close.assert_not_awaited()

    async def test_unknown_exception_text_is_not_read_by_diagnostics(self):
        class SecretError(Exception):
            def __str__(self):
                raise AssertionError('Do not read exception text')
        flow, context, page = self.flow(); error = SecretError()
        page.goto.side_effect = error
        with self.assertLogs('registration', level='WARNING') as logs:
            with self.assertRaises(SecretError) as stopped:
                await flow.verify_login()
        self.assertIs(stopped.exception, error)
        self.assertEqual(flow.job.registration_operation, 'verification_navigation')
        self.assertIn('UnexpectedError', logs.output[0])
        context.close.assert_awaited_once()

    async def test_initial_read_only_navigation_can_retry_once(self):
        flow, context, page = self.flow()
        page.goto.side_effect = [asyncio.TimeoutError(), SimpleNamespace(status=200)]
        with self.assertRaises(Stop):
            await flow.verify_login()
        self.assertEqual(page.goto.await_count, 2)
        for call in page.goto.await_args_list:
            self.assertEqual(call.args, ('https://chatgpt.com/auth/login',))
            self.assertEqual(call.kwargs, {'wait_until':'domcontentloaded', 'timeout':0})
        flow.job.prepare_mail.assert_not_called()
        context.close.assert_awaited_once()

    async def test_recovery_first_navigation_failure_and_terminal_http_failure_are_distinct(self):
        flow, context, page = self.flow()
        page.goto.side_effect = [asyncio.TimeoutError('private first failure'), SimpleNamespace(status=500)]
        context.close.side_effect = ValueError('private cleanup')
        with self.assertLogs('registration', level='WARNING') as logs:
            with self.assertRaises(Stop) as stopped:
                await flow.verify_login()
        self.assertEqual(stopped.exception.report, {'status':'blocked','reason':'http_error','http_status':500})
        self.assertEqual(flow.job.registration_verification_error, {'phase':'navigation','error_type':'TimeoutError'})
        self.assertEqual(flow.job.registration_verification_last_error, {'phase':'navigation','error_type':'Stop'})
        self.assertEqual(flow.job.registration_verification_cleanup_error,
                         {'phase':'context_cleanup','error_type':'UnexpectedError'})
        self.assertEqual(page.goto.await_count, 2)
        self.assertNotIn('private', '\n'.join(logs.output))
        context.close.assert_awaited_once()

    async def test_navigation_retry_guard_blocks_posts_until_known_email_form(self):
        flow, context, page = self.flow()
        page.goto.side_effect = [asyncio.TimeoutError(), SimpleNamespace(status=200)]
        email = SimpleNamespace(fill=AsyncMock(), press=AsyncMock(side_effect=Stop('fixture_stop')))
        flow.field.return_value = email
        with self.assertRaises(Stop):
            await flow.verify_login()
        self.assertEqual(context.route.await_count, 2)
        readonly = context.route.await_args_list[1].args[1]
        post = SimpleNamespace(request=SimpleNamespace(method='POST'), abort=AsyncMock(), fallback=AsyncMock())
        await readonly(post)
        post.abort.assert_awaited_once_with('blockedbyclient'); post.fallback.assert_not_awaited()
        context.unroute.assert_awaited_once_with('**/*', readonly)
        email.press.assert_awaited_once_with('Enter')
        self.assertEqual(page.goto.await_count, 2)
        context.close.assert_awaited_once()

    async def test_failure_log_correlates_only_valid_job_attempt_and_closed_code(self):
        flow, context, page = self.flow()
        flow.job.id = '11111111-1111-4111-8111-111111111111'
        flow.job.attempt = 2
        Error = type('Error', (Exception,), {})
        page.goto.side_effect = Error('net::ERR_CONNECTION_RESET https://secret.invalid/?token=private password=secret')
        with self.assertLogs('registration', level='WARNING') as logs:
            with self.assertRaises(Error):
                await flow.verify_login()
        output = '\n'.join(logs.output)
        self.assertIn('job=' + flow.job.id, output)
        self.assertIn('attempt=2', output)
        self.assertIn('browser_code=net::ERR_CONNECTION_RESET', output)
        for secret in ['https://', 'secret', 'token=', 'password=', 'private']:
            self.assertNotIn(secret, output)

    async def test_untrusted_job_attempt_values_are_never_stringified(self):
        class Private:
            def __str__(self):
                raise AssertionError('Private metadata must not be printed')
        flow, context, page = self.flow()
        flow.job.id = Private(); flow.job.attempt = Private()
        page.goto.side_effect = ValueError('secret')
        with self.assertLogs('registration', level='WARNING') as logs:
            with self.assertRaises(ValueError):
                await flow.verify_login()
        self.assertIn('job=unknown attempt=0', logs.output[0])
        self.assertNotIn('secret', logs.output[0])

    async def test_http_authority_and_cancellation_do_not_retry(self):
        for error in [Stop('verification_required'), Stop('operation_cancelled'),
                      Stop('official_login_email_mismatch'), Stop('http_error', http_status=500)]:
            flow, context, page = self.flow(); page.goto.side_effect = error
            with self.assertRaises(Stop):
                await flow.verify_login()
            page.goto.assert_awaited_once(); context.close.assert_awaited_once()

    async def test_body_failure_and_cleanup_do_not_mask_original_stage(self):
        flow, context, page = self.flow()
        original = asyncio.TimeoutError('secret body')
        page.locator('body').inner_text.side_effect = original
        context.close.side_effect = RuntimeError('token=private')
        with self.assertRaises(asyncio.TimeoutError) as stopped:
            await flow.verify_login()
        self.assertIs(stopped.exception, original)
        self.assertEqual(flow.job.registration_operation, 'verification_body_read')
        self.assertEqual(flow.job.registration_verification_cleanup_error['error_type'], 'UnexpectedError')

    async def test_failure_after_email_submit_is_never_navigation_or_submit_replay(self):
        flow, context, page = self.flow()
        email = SimpleNamespace(fill=AsyncMock(), press=AsyncMock())
        flow.field.return_value = email
        original = asyncio.TimeoutError('private')
        flow.identity = AsyncMock(side_effect=original)
        with self.assertRaises(asyncio.TimeoutError) as stopped:
            await flow.verify_login()
        self.assertIs(stopped.exception, original)
        page.goto.assert_awaited_once(); email.press.assert_awaited_once_with('Enter')
        email.fill.assert_awaited_once_with('synthetic@example.invalid')
        flow.job.prepare_mail.assert_called_once_with('password', new_request=True)
        self.assertEqual(flow.job.registration_operation, 'verification_identity_read')
        context.close.assert_awaited_once()

    async def test_failure_after_password_submit_cannot_repeat_any_write(self):
        flow, context, page = self.flow()
        field = SimpleNamespace(fill=AsyncMock(), press=AsyncMock())
        flow.field.return_value = field
        original = asyncio.TimeoutError('password=private')
        flow.identity = AsyncMock(side_effect=[None, original])
        with self.assertRaises(asyncio.TimeoutError) as stopped:
            await flow.verify_login()
        self.assertIs(stopped.exception, original)
        page.goto.assert_awaited_once()
        self.assertEqual(field.fill.await_count, 2)
        self.assertEqual(field.press.await_count, 2)
        flow.job.prepare_mail.assert_called_once_with('password', new_request=True)
        context.close.assert_awaited_once()

    async def test_totp_submission_error_cannot_repeat_totp_or_password(self):
        flow, context, page = self.flow()
        email = SimpleNamespace(fill=AsyncMock(), press=AsyncMock())
        password = SimpleNamespace(fill=AsyncMock(), press=AsyncMock())
        code = SimpleNamespace(fill=AsyncMock(), press=AsyncMock(side_effect=asyncio.TimeoutError('private OTP')))
        def field(_page, selector):
            from registration_browser import EMAIL_INPUT, PASSWORD_INPUT, CODE_INPUT
            return {EMAIL_INPUT:email, PASSWORD_INPUT:password, CODE_INPUT:code}.get(selector)
        flow.field = AsyncMock(side_effect=field)
        flow.identity = AsyncMock(return_value=None)
        flow.job.payload['totpSecret'] = 'JBSWY3DPEHPK3PXP'
        with patch('registration_browser.login_code_type', AsyncMock(return_value='totp')):
            with self.assertRaises(asyncio.TimeoutError):
                await flow.verify_login(mfa=True)
        page.goto.assert_awaited_once()
        email.press.assert_awaited_once_with('Enter')
        password.press.assert_awaited_once_with('Enter')
        code.fill.assert_awaited_once(); code.press.assert_awaited_once_with('Enter')
        self.assertEqual(flow.job.registration_operation, 'verification_totp_submit')
        context.close.assert_awaited_once()

    async def test_secret_cleanup_and_close_failure_keep_first_cleanup_reason(self):
        flow, context, page = self.flow()
        primary = Stop('verification_required')
        flow.field.side_effect = primary
        context.close.side_effect = asyncio.TimeoutError('private close')
        with patch('registration_browser.clear_visible_secrets', AsyncMock(side_effect=ValueError('private cleanup'))):
            with self.assertRaises(Stop) as stopped:
                await flow.verify_login()
        self.assertIs(stopped.exception, primary)
        self.assertEqual(flow.job.registration_verification_cleanup_error,
                         {'phase':'secret_cleanup','error_type':'UnexpectedError'})
        self.assertEqual(flow.job.registration_operation, 'verification_field_read')
        context.close.assert_awaited_once()

    async def code_transition(self, identity, *, mfa=False, still_code=False, challenge=False):
        flow, context, page = self.flow()
        email = SimpleNamespace(fill=AsyncMock(),press=AsyncMock())
        password = SimpleNamespace(fill=AsyncMock(),press=AsyncMock())
        code = SimpleNamespace(fill=AsyncMock(),press=AsyncMock())
        from registration_browser import EMAIL_INPUT,PASSWORD_INPUT,CODE_INPUT
        flow.field = AsyncMock(side_effect=lambda _page,selector:{
            EMAIL_INPUT:email,PASSWORD_INPUT:password,CODE_INPUT:code}.get(selector))
        flow.identity = AsyncMock(side_effect=[None,None,None,identity])
        code_type = AsyncMock(side_effect=['email','email','email','unknown'])
        if challenge:
            async def body():
                return 'Verify you are human' if code_type.await_count == 4 else 'Continue'
            page.locator('body').inner_text = body
        with patch('registration_browser.login_code_type',code_type), patch(
                'registration_browser.unique_visible',AsyncMock(return_value=code if still_code else None)):
            try:
                result = await flow.verify_login(mfa=mfa)
            except Stop as stopped:
                result = stopped.report['reason']
        self.assertEqual(page.goto.await_count,1)
        email.press.assert_awaited_once_with('Enter')
        password.press.assert_awaited_once_with('Enter')
        code.press.assert_awaited_once_with('Enter')
        flow.job.wait_code.assert_awaited_once()
        context.close.assert_awaited_once()
        return result,flow

    async def test_submitted_code_disappearing_rechecks_identity_without_write_replay(self):
        result,flow = await self.code_transition(('same','identity'))
        self.assertIs(result,True)
        self.assertEqual(flow.identity.await_count,4)

    async def test_unknown_code_without_identity_remains_paused(self):
        result,flow = await self.code_transition(None)
        self.assertEqual(result,'verification_required')
        self.assertEqual(flow.identity.await_count,4)

    async def test_unknown_code_wrong_email_and_human_challenge_cannot_complete(self):
        result,_flow = await self.code_transition(Stop('official_login_email_mismatch'))
        self.assertEqual(result,'official_login_email_mismatch')
        result,flow = await self.code_transition(('same','identity'),challenge=True)
        self.assertEqual(result,'verification_required')
        self.assertEqual(flow.identity.await_count,3)

    async def test_stable_unknown_code_stays_paused_even_if_identity_arrives(self):
        result,_flow = await self.code_transition(('same','identity'),still_code=True)
        self.assertEqual(result,'verification_required')

    async def test_email_code_identity_cannot_claim_unsubmitted_totp(self):
        result,_flow = await self.code_transition(('same','identity'),mfa=True)
        self.assertEqual(result,'mfa_unverified')

    async def test_unknown_code_without_a_previously_submitted_code_is_not_reobserved(self):
        flow,context,page = self.flow()
        field = SimpleNamespace(fill=AsyncMock(),press=AsyncMock())
        flow.field.return_value = field; flow.identity = AsyncMock(return_value=None)
        with patch('registration_browser.login_code_type',AsyncMock(return_value='unknown')):
            with self.assertRaises(Stop) as stopped: await flow.verify_login()
        self.assertEqual(stopped.exception.report['reason'],'verification_required')
        self.assertEqual(flow.identity.await_count,2)
        self.assertEqual(field.press.await_count,2)
        page.goto.assert_awaited_once(); flow.job.wait_code.assert_not_awaited()

    async def test_success_does_not_hide_cleanup_failure(self):
        flow, context, page = self.flow()
        field = SimpleNamespace(fill=AsyncMock(), press=AsyncMock())
        flow.field.return_value = field
        flow.identity = AsyncMock(side_effect=[None, ('same','identity')])
        context.close.side_effect = asyncio.TimeoutError('private cleanup')
        with self.assertRaises(asyncio.TimeoutError):
            await flow.verify_login()
        self.assertEqual(flow.job.registration_operation, 'verification_cleanup')
        self.assertEqual(field.press.await_count, 2)
        self.assertFalse(hasattr(flow.job, 'registration_verification_error'))


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
        self.assertEqual(self.session_reads, 1)
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
class InitialFormBrowserTests(unittest.IsolatedAsyncioTestCase):
    """Actual DOM and session/account requests, never mocked official identity."""
    async def asyncSetUp(self):
        await ProfileBrowserTests.asyncSetUp(self)

    async def asyncTearDown(self):
        await ProfileBrowserTests.asyncTearDown(self)

    async def fixture(self, body, mode='healthy', *, email_submit=False):
        from browser_session import SessionBudget
        await self.context.unroute('**/*')
        self.session_reads = self.account_reads = self.document_gets = 0
        self.submissions.clear()
        def session():
            def part(value):
                return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
            email = 'other@example.invalid' if mode == 'mismatch' else self.job.payload['email']
            token = '.'.join((part({'alg':'RS256'}), part({
                'exp':int(time.time())+3600,
                'https://api.openai.com/auth':{'chatgpt_account_id':'initial-fixture-account'},
                'https://api.openai.com/profile':{'email':email}}), 'c3ludGhldGlj'))
            return {'accessToken':token,'user':{'id':'initial-fixture-user','email':email},
                    'account':{'id':'initial-fixture-account'}}
        script = '''<script>document.querySelector('form').onsubmit=async event=>{
          event.preventDefault();await fetch('/fixture/email',{method:'POST',body:'{}'});
          document.body.innerHTML='<p>Check your email. Email verification code</p><input name="code" autocomplete="one-time-code"><button>Continue</button>';
        };</script>''' if email_submit else ''
        async def local(route):
            request = route.request
            path = urlsplit(request.url).path
            if request.method not in {'GET','HEAD','OPTIONS'}:
                self.submissions.append(path)
            if path == '/api/auth/session':
                self.session_reads += 1
                if mode == 'network':
                    await route.abort('failed'); return
                if mode == 'timeout':
                    await asyncio.sleep(3)
                try:
                    await route.fulfill(content_type='application/json',body=json.dumps(
                        session() if mode in {'same','mismatch'} else {}))
                except Exception:
                    if mode != 'timeout': raise
            elif path == '/backend-api/accounts/check/v4-2023-04-27':
                self.account_reads += 1
                await route.fulfill(content_type='application/json',body=json.dumps({
                    'accounts':{'initial-fixture-account':{'account':{'plan_type':'free'}}}}))
            elif path == '/fixture/email':
                await route.fulfill(content_type='application/json',body='{}')
            else:
                self.document_gets += 1
                await route.fulfill(content_type='text/html',body='<!doctype html><html><body>'+body+script+'</body></html>')
        await self.context.route('**/*',local)
        await self.page.goto('https://chatgpt.com/auth/login',wait_until='domcontentloaded')
        self.flow.observation_budget = SessionBudget(2,cancelled=self.job.cancelled.is_set)

    async def test_initial_email_signup_do_not_require_anonymous_session_fetch(self):
        for view,body in [('email','<form><input type="email"><button>Continue</button></form>'),
                          ('signup','<button>Sign up</button>')]:
            for mode in ['healthy','network','timeout']:
                with self.subTest(view=view,mode=mode):
                    await self.fixture(body,mode)
                    observed,_field = await self.flow.registration_view()
                    self.assertEqual(observed,view)
                    self.assertEqual(self.session_reads,0)
                    self.assertEqual(self.submissions,[])
                    self.assertFalse(self.job.payload['registered'])
                    self.assertNotIn('registered',self.events)

    async def test_initial_password_form_requires_existing_account_review_without_fetch(self):
        await self.fixture('<input type="password">','network')
        self.assertEqual(await self.flow.registration_view(),('existing',None))
        self.assertEqual(self.session_reads,0)
        self.assertEqual(self.submissions,[])

    async def test_navigation_before_initial_email_read_cannot_use_nonofficial_ui(self):
        import registration_browser
        await self.fixture('<input type="email">','network')
        original = registration_browser.unique_visible
        async def changing(page,selector):
            field = await original(page,selector)
            if selector == registration_browser.PASSWORD_INPUT:
                await page.goto('https://unsupported.example.test/auth/login',wait_until='domcontentloaded')
            return field
        with patch('registration_browser.unique_visible',changing):
            with self.assertRaises(Stop) as stopped:
                await self.flow.registration_view()
        self.assertEqual(stopped.exception.report['reason'],'form_unrecognized')
        self.assertEqual(self.session_reads,0)
        self.assertEqual(self.submissions,[])

    async def test_each_submit_fact_keeps_identity_ahead_of_stale_email_and_signup(self):
        for flag in ['email_submit_started','email_submitted','code_submitted','profile_submitted']:
            for body in ['<input type="email">','<button>Sign up</button>']:
                with self.subTest(flag=flag,body=body):
                    self.flow.registration_state.clear()
                    self.flow.registration_state[flag] = True
                    await self.fixture(body,'same')
                    self.assertEqual(await self.flow.registration_view(),('registered',None))
                    self.assertEqual(self.session_reads,2)
                    self.assertEqual(self.account_reads,1)
                    self.assertTrue(self.flow.registration_state[flag])
                    self.assertEqual(self.submissions,[])

    async def test_submitted_stale_email_cannot_hide_session_failure(self):
        from browser_session import SessionBudget
        self.flow.registration_state['email_submitted'] = True
        for mode,reason in [('network','session_network_error'),('timeout','session_load_timeout')]:
            with self.subTest(mode=mode):
                await self.fixture('<input type="email">',mode)
                self.flow.observation_budget = SessionBudget(.8,cancelled=self.job.cancelled.is_set)
                with self.assertRaises(Stop) as stopped:
                    await self.flow.registration_view()
                self.assertEqual(stopped.exception.report['reason'],reason)
                self.assertEqual(self.session_reads,1)
                self.assertEqual(self.submissions,[])
                self.assertTrue(self.flow.registration_state['email_submitted'])

    async def test_registered_payload_keeps_identity_first_without_submit_flags(self):
        self.job.payload['registered'] = True
        await self.fixture('<input type="email">','same')
        self.assertEqual(await self.flow.registration_view(),('registered',None))
        self.assertEqual(self.session_reads,2)
        self.assertEqual(self.account_reads,1)
        self.assertEqual(self.submissions,[])

    async def test_wrong_identity_is_not_swallowed_or_accepted(self):
        for body,registered,submitted in [('<main>Welcome</main>',False,False),
                                          ('<input type="email">',False,True),
                                          ('<button>Sign up</button>',True,False)]:
            with self.subTest(registered=registered,submitted=submitted):
                self.job.payload['registered'] = registered
                self.flow.registration_state.clear()
                if submitted: self.flow.registration_state['email_submitted'] = True
                await self.fixture(body,'mismatch')
                with self.assertRaises(Stop) as stopped:
                    await self.flow.registration_view()
                self.assertEqual(stopped.exception.report['reason'],'official_login_email_mismatch')
                self.assertEqual(self.session_reads,1)
                self.assertEqual(self.submissions,[])
                self.assertNotIn('registered',self.events)

    async def test_ambiguous_initial_inputs_pause_before_any_session_or_write(self):
        for body in ['<input type="email"><input type="email"><button>Continue</button>',
                     '<input type="password"><input type="password">']:
            with self.subTest(body=body):
                await self.fixture(body,'network')
                self.job.manual.reset_mock()
                with self.assertRaises(Stop) as stopped:
                    await self.flow.register()
                self.assertEqual(stopped.exception.report['reason'],'fixture_paused')
                self.job.manual.assert_awaited_once_with('form_unrecognized')
                self.assertEqual(self.session_reads,0)
                self.assertEqual(self.submissions,[])
                self.assertEqual(self.document_gets,1)

    async def test_challenge_code_profile_and_loading_keep_priority(self):
        for expected,body in [
                ('verification','<h1>Verify you are human</h1><input type="email">'),
                ('code','<p>Check your email. Email verification code</p><input name="code" autocomplete="one-time-code"><input type="email">'),
                ('profile','<form><input name="name"><input name="age"><button>Continue</button></form><input type="email">'),
                ('unknown','<div aria-busy="true">Loading</div><input type="email">')]:
            with self.subTest(view=expected):
                await self.fixture(body,'network')
                view,_field = await self.flow.registration_view()
                self.assertEqual(view,expected)
                self.assertEqual(self.session_reads,0)
                self.assertEqual(self.submissions,[])

    async def test_initial_email_progresses_once_without_fetch_and_keeps_mail_fence(self):
        await self.fixture('<form><input type="email"><button>Continue</button></form>',
                           'network',email_submit=True)
        def prepare_mail(_step,*,new_request=False):
            self.job.awaiting_code = True
        self.job.prepare_mail = MagicMock(side_effect=prepare_mail)
        self.job.wait_code = AsyncMock(side_effect=Stop('fixture_waiting_for_code'))
        with self.assertRaises(Stop) as stopped:
            await self.flow.register()
        self.assertEqual(stopped.exception.report['reason'],'fixture_waiting_for_code')
        self.assertEqual(self.submissions,['/fixture/email'])
        self.assertEqual(self.session_reads,0)
        self.job.prepare_mail.assert_called_once_with('email_code',new_request=True)
        self.job.wait_code.assert_awaited_once()
        self.assertTrue(self.flow.registration_state['email_submit_started'])
        self.assertTrue(self.flow.registration_state['email_submitted'])
        self.assertFalse(self.flow.registration_state.get('code_submitted',False))
        self.assertFalse(self.flow.registration_state.get('profile_submitted',False))
        self.assertFalse(self.flow.registration_refreshed)
        self.job.manual.assert_not_awaited()


@unittest.skipUnless(os.environ.get('V2_REGISTRATION_BROWSER_TEST') == '1', 'explicit local fixture')
class RegisteredIdentityBrowserTests(unittest.IsolatedAsyncioTestCase):
    """Retained-page recovery with real session/account fetches; no identity mocks."""
    async def asyncSetUp(self):
        await ProfileBrowserTests.asyncSetUp(self)
        self.job.payload.update(registered=True, passwordVerified=False, mfaVerified=False)
        self.job.registration_state = self.flow.registration_state
        self.allow_identity = False
        self.flow.registration_state.update(email_submitted=True, code_submitted=True, profile_submitted=True)
        self.requests = []
        self.session_reads = 0
        self.account_reads = 0
        self.navigations = 0

    async def asyncTearDown(self):
        await ProfileBrowserTests.asyncTearDown(self)

    async def fixture(self, mode='recover'):
        def session():
            def part(value):
                return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
            email = 'other@example.invalid' if mode in {'mismatch','mismatch_recover'} else self.job.payload['email']
            token = '.'.join((part({'alg':'RS256'}), part({
                'exp':int(time.time()) + 3600,
                'https://api.openai.com/auth':{'chatgpt_account_id':'registered-fixture-account'},
                'https://api.openai.com/profile':{'email':email}}), 'c3ludGhldGlj'))
            return {'accessToken':token, 'user':{'id':'registered-fixture-user','email':email},
                    'account':{'id':'registered-fixture-account'}}

        async def local(route):
            request = route.request
            path = urlsplit(request.url).path
            self.requests.append((request.method, path))
            if path == '/api/auth/session':
                self.session_reads += 1
                if mode == 'network' or (mode in {'recover','challenge','profile','anonymous','mismatch_recover','delayed_anonymous'} and self.session_reads == 1):
                    await route.abort('failed')
                    return
                read = self.session_reads
                if mode == 'timeout' and read == 1:
                    await asyncio.sleep(.4)
                try:
                    await route.fulfill(content_type='application/json', body=json.dumps({} if mode == 'anonymous' or (mode == 'delayed_anonymous' and not self.allow_identity) else session()))
                except Exception:
                    # Only the timed-out local fixture fetch can already have been cancelled.
                    if mode != 'timeout' or read != 1:
                        raise
            elif path == '/backend-api/accounts/check/v4-2023-04-27':
                self.account_reads += 1
                await route.fulfill(content_type='application/json', body=json.dumps({
                    'accounts':{'registered-fixture-account':{'account':{'plan_type':'free'}}}}))
            elif (request.method,path) == ('POST','/fixture/password-proof') and self.allow_identity:
                await route.fulfill(content_type='application/json',body='{}')
            else:
                self.assertEqual((request.method, path), ('GET','/'))
                self.navigations += 1
                body = '<main>Welcome</main>'
                if self.navigations > 1:
                    if mode == 'challenge':
                        body = '<main>Verify you are human<div class="cf-turnstile">Challenge</div></main>'
                    elif mode == 'profile':
                        body = '<form><input name="name"><input name="age"><button>Continue</button></form>'
                    if mode == 'delayed_anonymous':
                        body += '<script>setTimeout(()=>fetch("/fixture/blocked-write",{method:"POST"}).catch(()=>{}),650)</script>'
                    if mode in {'recover','network','timeout'}:
                        body += '<script>fetch("/fixture/blocked-write",{method:"POST"}).catch(()=>{});</script>'
                await route.fulfill(content_type='text/html', body='<!doctype html><html><body>'+body+'</body></html>')
        # Context-level routing lets the newer recovery guard reject a write before this fixture sees it.
        await self.context.route('**/*', local)
        await self.page.goto('https://chatgpt.com/', wait_until='domcontentloaded')

    async def test_registered_network_failure_get_recovers_same_email_account(self):
        await self.fixture()
        original = self.page
        result = await self.flow.registered_identity()
        self.assertTrue(result[1]['account_matched'])
        self.assertEqual(self.session_reads, 3)
        self.assertEqual(self.account_reads, 1)
        self.assertEqual(self.navigations, 2)
        self.assertIs(self.flow.page, original)
        self.assertEqual(self.context.pages, [original])
        self.assertTrue(all(method == 'GET' for method, _path in self.requests))
        self.assertTrue(self.job.payload['registered'])
        self.assertTrue(all(self.flow.registration_state[key] for key in ['email_submitted','code_submitted','profile_submitted']))
        self.job.manual.assert_not_awaited()
        self.assertIsNone(self.flow.recovery_readonly)

    async def test_registered_healthy_identity_needs_no_refresh(self):
        await self.fixture('healthy')
        self.assertTrue((await self.flow.registered_identity())[1]['account_matched'])
        self.assertEqual(self.navigations, 1)
        self.assertFalse(self.flow.registration_refreshed)

    async def test_registered_real_fetch_timeout_recovers_inside_original_total_budget(self):
        from browser_session import SessionBudget
        await self.fixture('timeout')
        budgets = []
        def budget(seconds, **kwargs):
            # Accelerate the existing initial 10s read, keeping the real shared recovery deadline.
            value = SessionBudget(.15 if len(budgets) == 1 else seconds, **kwargs)
            budgets.append(value)
            return value
        with patch('registration_browser.SessionBudget', side_effect=budget):
            self.assertTrue((await self.flow.registered_identity())[1]['account_matched'])
        self.assertEqual(self.navigations, 2)
        self.assertEqual(len(budgets), 2)
        self.assertLess(budgets[0].elapsed, budgets[0].seconds)
        self.assertTrue(all(method == 'GET' for method, _path in self.requests))

    async def test_registered_remaining_network_failure_stops_without_replay(self):
        await self.fixture('network')
        with self.assertRaises(Stop) as stopped:
            await self.flow.registered_identity()
        self.assertEqual(stopped.exception.report['reason'], 'session_network_error')
        self.assertEqual(self.navigations, 2)
        self.assertEqual(self.session_reads, 2)
        self.assertTrue(all(method == 'GET' for method, _path in self.requests))
        self.assertTrue(self.job.payload['registered'])

    async def test_registered_wrong_email_does_not_refresh_or_claim_password(self):
        await self.fixture('mismatch')
        with self.assertRaises(Stop) as stopped:
            await self.flow.registered_identity()
        self.assertEqual(stopped.exception.report['reason'], 'official_login_email_mismatch')
        self.assertEqual(self.navigations, 1)
        self.assertFalse(self.flow.registration_refreshed)
        self.assertEqual(self.account_reads, 0)

    def transport_guard(self, flow):
        actual_guard = flow.guard
        async def local_guard(route):
            # The network-none fixture's harmless transport uses fallback, while
            # retained writes exercise the actual new-attempt guard delegation.
            if flow.recovery_readonly is not None:
                await actual_guard(route)
            else:
                await route.fallback()
        flow.guard = local_guard

    async def test_failed_run_blocks_delayed_post_and_continue_unlocks_same_page(self):
        from registration_browser import IDENTITY_RECOVERY
        await self.fixture('delayed_anonymous')
        self.transport_guard(self.flow)
        with self.assertRaises(Stop) as stopped:
            await self.flow.run()
        self.assertEqual(stopped.exception.report['reason'],'official_login_not_verified')
        handler = self.flow.recovery_readonly
        self.assertIsNotNone(handler)
        await asyncio.sleep(.9)
        self.assertTrue(all(method == 'GET' for method,_path in self.requests))
        self.assertEqual(self.navigations,2)
        self.job.manual.assert_not_awaited()
        self.allow_identity = True
        flow = RegistrationBrowser(self.job,self.context)
        self.assertIs(flow.recovery_readonly,handler)
        self.transport_guard(flow)
        async def password():
            self.assertNotIn(IDENTITY_RECOVERY,flow.registration_state)
            self.assertIsNone(flow.recovery_readonly)
            await flow.page.evaluate('fetch("/fixture/password-proof",{method:"POST"})')
        flow.password = AsyncMock(side_effect=password); flow.mfa = AsyncMock(); flow.offer = AsyncMock()
        await flow.run()
        self.assertIs(flow.page,self.page)
        self.assertEqual(self.context.pages,[self.page])
        self.assertEqual(self.navigations,2)
        self.assertEqual([path for method,path in self.requests if method=='POST'],['/fixture/password-proof'])
        self.assertTrue(all(flow.registration_state[key] for key in ['email_submitted','code_submitted','profile_submitted']))
        flow.password.assert_awaited_once()

    async def test_recovery_anonymous_identity_does_not_remove_readonly(self):
        await self.fixture('anonymous')
        with self.assertRaises(Stop) as stopped:
            await self.flow.registered_identity()
        self.assertEqual(stopped.exception.report['reason'], 'official_login_not_verified')
        self.assertIsNotNone(self.flow.recovery_readonly)
        self.assertEqual(self.navigations, 2)
        self.assertEqual(self.account_reads, 0)
        self.assertTrue(all(method == 'GET' for method, _path in self.requests))
        self.job.manual.assert_not_awaited()

    async def test_recovery_wrong_email_does_not_remove_readonly(self):
        await self.fixture('mismatch_recover')
        with self.assertRaises(Stop) as stopped:
            await self.flow.registered_identity()
        self.assertEqual(stopped.exception.report['reason'], 'official_login_email_mismatch')
        self.assertIsNotNone(self.flow.recovery_readonly)
        self.assertEqual(self.navigations, 2)
        self.assertEqual(self.account_reads, 0)
        self.assertTrue(all(method == 'GET' for method, _path in self.requests))

    async def test_recovered_challenge_requires_owner_and_no_form_submission(self):
        await self.fixture('challenge')
        with self.assertRaises(Stop) as stopped:
            await self.flow.registered_identity()
        self.assertEqual(stopped.exception.report['reason'], 'fixture_paused')
        self.job.manual.assert_awaited_once_with('verification_required')
        self.assertEqual(self.navigations, 2)
        self.assertEqual(self.session_reads, 1)
        self.assertTrue(all(method == 'GET' for method, _path in self.requests))

    async def test_recovered_profile_is_not_replayed(self):
        await self.fixture('profile')
        with self.assertRaises(Stop) as stopped:
            await self.flow.registered_identity()
        self.assertEqual(stopped.exception.report['reason'], 'fixture_paused')
        self.job.manual.assert_awaited_once_with('form_unrecognized')
        self.assertEqual(self.navigations, 2)
        self.assertEqual(self.session_reads, 1)
        self.assertTrue(all(method == 'GET' for method, _path in self.requests))
        self.assertTrue(self.flow.registration_state['profile_submitted'])


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
            control = self.flow.email_submit_control
            async def disappearing_button(email):
                nonlocal removed
                result = await control(email)
                if result[1] and not removed:
                    await result[1].evaluate('(node) => node.remove()')
                    removed = True
                return result
            self.flow.email_submit_control = disappearing_button
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
                         {'reason': 'registration_page_changing', 'error_type': 'Error'} if missing == 'button'
                         else {'reason': 'session_load_timeout', 'error_type': 'TimeoutError'})
        self.job.prepare_mail.assert_not_called()
        self.assertEqual(self.navigation_methods.count('POST'), 0)
        self.assertEqual(self.submissions, [])
        self.assertFalse(self.flow.data['registered'])
        self.assertFalse(self.flow.registration_refreshed)

    async def test_disappearing_continue_read_is_bounded_before_mail_request(self):
        await self.bounded_email_read_fixture('button')

    async def test_disappearing_email_value_read_is_bounded_before_mail_request(self):
        await self.bounded_email_read_fixture('email')

    async def email_guard_fixture(self, mode):
        """Real native event handlers and anonymous session reads; no identity mock."""
        self.submissions.clear()
        button = '<button>Continue</button>'
        outside = ''
        if mode == 'outside':
            button = ''; outside = '<aside><button type="button">Continue</button></aside>'
        elif mode == 'external_associated':
            button = ''; outside = '<button form="email-form">Continue</button>'
        pattern = ' pattern="allowed-only@example.test"' if mode == 'invalid' else ''
        html = '<!doctype html><html><body><form id="email-form"><input type="email" required' + pattern + '>' + button + '</form>' + outside + '''<script>
        document.querySelector('#email-form').onsubmit=async e=>{
          e.preventDefault();await fetch('/fixture/email',{method:'POST'});
        };
        __EXTRA__
        </script></body></html>'''
        extra = ("document.querySelector('button').onclick=()=>fetch('/fixture/wrong',{method:'POST'});" if mode == 'outside' else
                 '''document.querySelector('input').oninput=()=>setTimeout(()=>{
                   document.body.innerHTML='<form id="code-form"><input name="code" autocomplete="one-time-code"><button>Continue</button></form>';
                   document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch('/fixture/code',{method:'POST'});};
                 },150);''' if mode == 'callback_race' else '')
        html = html.replace('__EXTRA__', extra)
        async def local(route):
            path = urlsplit(route.request.url).path
            self.navigation_methods.append(route.request.method)
            if path == '/api/auth/session':
                await route.fulfill(content_type='application/json', body='{}')
            elif path.startswith('/fixture/'):
                self.submissions.append(path)
                await route.fulfill(content_type='application/json', body='{}')
            else:
                await route.fulfill(content_type='text/html', body=html)
        await self.context.route('**/*', local)
        await self.page.goto('https://chatgpt.com/auth/login', wait_until='domcontentloaded')
        def prepare(_step, *, new_request=False):
            self.job.awaiting_code = True
            if mode == 'callback_race': time.sleep(.4)
            if mode == 'callback_timeout': time.sleep(1.05)
        self.job.prepare_mail = MagicMock(side_effect=prepare)
        self.job.wait_code = AsyncMock(side_effect=Stop('fixture_code_observed'))
        if mode == 'click_error':
            from playwright.async_api import Error
            control = self.flow.email_submit_control
            injected = False
            async def interrupted_control(email):
                nonlocal injected
                result = await control(email)
                if result[1] and not injected:
                    injected = True
                    original_click = result[1].click
                    async def interrupted_click(**kwargs):
                        await original_click(**kwargs)
                        raise Error('Element is not attached to the DOM: synthetic private failure')
                    result[1].click = interrupted_click
                return result
            self.flow.email_submit_control = interrupted_control
        category_mode = mode in {'prepare_context_error', 'callback_context_error'}
        if category_mode:
            from playwright.async_api import Error
            self.context_error_injection_reached = False
            method = 'email_submit_control' if mode == 'prepare_context_error' else 'email_submit_unchanged'
            original = getattr(self.flow, method)
            async def changing_context(*args):
                await original(*args)  # Complete actual native DOM reads before the injected browser error.
                try:
                    await self.page.evaluate('''() => { throw new Error('Execution context was destroyed synthetic-private'); }''')
                except Error as error:
                    self.context_error_injection_reached = (
                        type(error).__name__ == 'Error'
                        and 'Execution context was destroyed synthetic-private' in str(error))
                    if self.context_error_injection_reached:
                        # The category test stops at its next observation after recording the actual injected error.
                        self.flow.registration_view = AsyncMock(side_effect=Stop('form_unrecognized'))
                    raise
            setattr(self.flow, method, changing_context)
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 15 if category_mode else 1):
            with self.assertRaises(Error if mode == 'click_error' else Stop) as stopped:
                await asyncio.wait_for(self.flow.register(), timeout=10 if category_mode else 7)
        return 'fixture_click_interrupted' if mode == 'click_error' else stopped.exception.report['reason']

    async def test_unrelated_global_continue_never_prepares_or_clicks(self):
        self.assertEqual(await self.email_guard_fixture('outside'), 'fixture_paused')
        self.assertEqual(self.submissions, [])
        self.job.prepare_mail.assert_not_called()
        self.assertFalse(self.flow.registration_state.get('email_submit_started'))
        self.assertEqual(self.flow.registration_state['email_form_first_failure']['gate'], 'wrong_scope')

    async def test_html_invalid_email_never_prepares_or_submits(self):
        self.assertEqual(await self.email_guard_fixture('invalid'), 'fixture_paused')
        self.assertEqual(self.submissions, [])
        self.job.prepare_mail.assert_not_called()
        first = self.flow.registration_state['email_form_first_failure']
        self.assertEqual((first['gate'], first['target'], first['validity']), ('invalid', 'matches', 'invalid'))

    async def test_external_button_form_attribute_submits_exact_email_form_once(self):
        self.assertEqual(await self.email_guard_fixture('external_associated'), 'fixture_paused')
        self.assertEqual(self.submissions, ['/fixture/email'])
        self.job.prepare_mail.assert_called_once_with('email_code', new_request=True)
        self.assertTrue(self.flow.registration_state['email_click_returned'])

    async def test_callback_navigation_never_clicks_replaced_code_continue(self):
        self.assertEqual(await self.email_guard_fixture('callback_race'), 'fixture_code_observed')
        self.assertEqual(self.submissions, [])
        self.job.prepare_mail.assert_called_once_with('email_code', new_request=True)
        self.job.wait_code.assert_awaited_once()
        self.assertTrue(self.flow.registration_state['email_submit_prepared'])
        self.assertFalse(self.flow.registration_state.get('email_submit_started'))
        self.assertFalse(self.flow.registration_state.get('code_submitted'))

    async def test_callback_exhausting_original_budget_never_clicks_or_refills(self):
        self.assertEqual(await self.email_guard_fixture('callback_timeout'), 'fixture_paused')
        self.assertEqual(self.submissions, [])
        self.job.prepare_mail.assert_called_once_with('email_code', new_request=True)
        self.assertFalse(self.flow.registration_state.get('email_submit_started'))
        self.assertEqual(self.job.registration_observation_error['reason'], 'session_load_timeout')

    async def test_prepare_context_error_is_closed_before_any_submission(self):
        self.assertEqual(await self.email_guard_fixture('prepare_context_error'), 'fixture_paused')
        self.assertTrue(self.context_error_injection_reached)
        self.assertEqual(self.job.registration_observation_error,
                         {'reason':'registration_page_changing', 'error_type':'Error'})
        self.assertEqual(self.submissions, [])
        self.job.prepare_mail.assert_not_called()
        self.assertFalse(self.flow.registration_state.get('email_submit_started'))

    async def test_callback_context_error_keeps_request_and_never_clicks(self):
        self.assertEqual(await self.email_guard_fixture('callback_context_error'), 'fixture_paused')
        self.assertTrue(self.context_error_injection_reached)
        self.assertEqual(self.job.registration_observation_error,
                         {'reason':'registration_page_changing', 'error_type':'Error'})
        self.assertEqual(self.submissions, [])
        self.job.prepare_mail.assert_called_once_with('email_code', new_request=True)
        self.assertFalse(self.flow.registration_state.get('email_submit_started'))

    async def test_post_click_detach_preserves_possible_write_and_resume_never_repeats(self):
        self.assertEqual(await self.email_guard_fixture('click_error'), 'fixture_click_interrupted')
        self.assertEqual(self.submissions, ['/fixture/email'])
        self.assertTrue(self.flow.registration_state['email_submit_started'])
        self.assertTrue(self.flow.registration_state['email_submitted'])
        self.assertFalse(self.flow.registration_state.get('email_click_returned'))
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 1):
            with self.assertRaises(Stop):
                await asyncio.wait_for(self.flow.register(), timeout=7)
        self.assertEqual(self.submissions, ['/fixture/email'])
        self.job.prepare_mail.assert_called_once_with('email_code', new_request=True)
        self.assertTrue(self.flow.registration_state['email_submit_started'])
        self.assertTrue(self.flow.registration_state['email_submitted'])

    async def test_email_diagnostic_is_closed_and_preserves_first_failure(self):
        from browser_session import SessionBudget
        await self.email_fixture('click')
        await self.page.locator('input').fill('owner@example.test')
        await self.page.evaluate('''() => {
          document.querySelector('input').pattern='allowed-only@example.test';
          document.querySelector('input').setAttribute('data-secret','synthetic-password-OTP-987654-token');
          document.querySelector('form').insertAdjacentHTML('beforeend','<p role="alert">synthetic-password-OTP-987654-token owner@example.test</p>');
        }''')
        await self.flow.email_diagnostic('prepare', SessionBudget(1), 'invalid')
        first = dict(self.flow.registration_state['email_form_first_failure'])
        self.assertEqual((first['alert_count'], first['email_error']), (1, 'unknown'))
        await self.page.locator('input').fill('')
        await self.flow.email_diagnostic('observe', SessionBudget(1))
        self.assertEqual(self.flow.registration_state['email_form_first_failure'], first)
        self.assertEqual(first['target'], 'matches')
        self.assertEqual(self.flow.registration_state['email_form_current']['target'], 'differs')
        with self.assertLogs('registration', level='WARNING') as logs:
            self.flow.log_email_diagnostic('before_safe_get')
            self.flow.log_pause('form_unrecognized')
        text = '\n'.join(logs.output)
        for secret in ['synthetic-password', '987654', 'owner@example.test', 'https://chatgpt.com']:
            self.assertNotIn(secret, text)
        self.assertIn('gate=invalid', text)
        self.assertEqual(self.submissions, [])
        self.assertTrue(all(method == 'GET' for method in self.navigation_methods))

    async def test_email_business_alert_first_snapshot_survives_safe_get(self):
        from browser_session import SessionBudget
        await self.email_fixture('click')
        await self.page.locator('input').fill('owner@example.test')
        await self.page.locator('form').evaluate('''form => form.insertAdjacentHTML('beforeend',
            '<p role="alert">This email address is not supported.</p>')''')
        await self.flow.email_diagnostic('observe', SessionBudget(1))
        first = dict(self.flow.registration_state['email_form_first_failure'])
        self.assertEqual((first['email_error'], first['target']), ('not_supported', 'matches'))
        self.assertTrue(await self.flow.refresh_registration())
        await self.flow.email_diagnostic('observe', SessionBudget(1))
        self.assertEqual(self.flow.registration_state['email_form_first_failure'], first)
        current = self.flow.registration_state['email_form_current']
        self.assertEqual((current['email_error'], current['target']), ('none', 'differs'))
        self.assertEqual(self.submissions, [])

    async def test_diagnostic_timeout_is_not_a_primary_failure_or_new_budget(self):
        from browser_session import SessionBudget
        await self.email_fixture('click')
        budget = SessionBudget(.001)
        await asyncio.sleep(.01)
        self.job.registration_observation_error = {'reason':'session_network_error', 'error_type':'Error'}
        started = time.monotonic()
        await self.flow.email_diagnostic('prepare', budget, 'invalid')
        self.assertLess(time.monotonic() - started, .1)
        self.assertEqual(self.flow.registration_state['email_form_current']['read'], 'not_measured')
        self.assertEqual(self.job.registration_observation_error, {'reason':'session_network_error', 'error_type':'Error'})
        self.assertEqual(self.submissions, [])


@unittest.skipUnless(os.environ.get('V2_REGISTRATION_BROWSER_TEST') == '1', 'explicit local fixture')
class EmailRequestBrowserTests(unittest.IsolatedAsyncioTestCase):
    """Actual Camoufox form/network events; every request is fulfilled or aborted locally."""
    async def asyncSetUp(self):
        await ProfileBrowserTests.asyncSetUp(self)
        self.job.id = '11111111-1111-4111-8111-111111111111'
        self.job.attempt = 1
        self.job.step = 'email_code'
        self.job.prepare_mail = MagicMock(side_effect=lambda *_args, **_kwargs: setattr(self.job, 'awaiting_code', True))
        self.installed, self.removed = [], []
        original_on, original_remove = self.page.on, self.page.remove_listener
        def on(name, handler):
            self.installed.append((name, handler))
            return original_on(name, handler)
        def remove(name, handler):
            self.removed.append((name, handler))
            return original_remove(name, handler)
        self.page.on, self.page.remove_listener = on, remove

    async def asyncTearDown(self):
        await ProfileBrowserTests.asyncTearDown(self)

    async def fixture(self, mode):
        html = '''<!doctype html><html><body><form action="/auth/login" method="get">
        <input type="email" name="email" required><button>Continue</button></form>__SCRIPT__</body></html>'''
        script = '' if mode == 'native_get' else '''<script>
        document.querySelector('form').onsubmit=event=>{
          event.preventDefault();fetch('/fixture/email?token=synthetic-private-token',{
            method:'POST',body:'synthetic-private-password-OTP-123456'}).then(()=>{
              __AFTER__
            }).catch(()=>{document.querySelector('input').value='';});
        };</script>'''
        script = script.replace('__AFTER__', "window.location.assign('/auth/login');" if mode == 'accepted_login'
                                else "document.querySelector('input').value='';")
        html = html.replace('__SCRIPT__', script)
        async def local(route):
            request = route.request
            path = urlsplit(request.url).path
            self.navigation_methods.append(request.method)
            if path == '/api/auth/session':
                await route.fulfill(content_type='application/json', body='{}')
            elif path == '/fixture/email':
                self.submissions.append(request.method)
                if mode == 'transport_failed':
                    await route.abort('connectionreset')
                else:
                    await route.fulfill(status=400 if mode == 'rejected' else 200,
                        content_type='application/json', body='{"private":"synthetic-secret-OTP-123456"}')
            else:
                await route.fulfill(content_type='text/html', body=html)
        await self.context.route('**/*', local)
        await self.page.goto('https://chatgpt.com/auth/login', wait_until='domcontentloaded')
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 1), self.assertLogs('registration', level='WARNING') as logs:
            with self.assertRaises(Stop) as stopped:
                await asyncio.wait_for(self.flow.register(), timeout=12)
        self.assertEqual(stopped.exception.report['reason'], 'fixture_paused')
        self.job.prepare_mail.assert_called_once_with('email_code', new_request=True)
        self.job.manual.assert_awaited_once_with('form_unrecognized')
        self.assertTrue(self.flow.registration_state['email_submit_started'])
        self.assertTrue(self.flow.registration_state['email_click_returned'])
        self.assertFalse(self.flow.registration_state.get('code_submitted', False))
        self.assertFalse(self.flow.registration_state.get('profile_submitted', False))
        self.assertFalse(self.flow.data['registered'])
        self.assertEqual(self.installed, self.removed)
        self.assertEqual([name for name, _handler in self.installed], ['request', 'response', 'requestfailed', 'framenavigated'])
        self.assertEqual(self.flow.email_requests, {})
        self.assertIsNone(self.flow.email_request_page)
        state = self.flow.email_request_observation
        self.assertEqual(state['read'], 'closed')
        frozen = json.dumps(state, sort_keys=True)
        await self.page.goto('https://chatgpt.com/auth/login', wait_until='domcontentloaded')
        self.assertEqual(json.dumps(state, sort_keys=True), frozen)
        text = '\n'.join(logs.output)
        for excluded in ['owner@example.test', 'synthetic-private', 'synthetic-secret', '123456', 'https://']:
            self.assertNotIn(excluded, text)
        self.assertIn('point=before_safe_get', text)
        self.assertIn('point=stop read=closed', text)
        self.assertEqual(self.page_errors, [])
        return state, text

    async def test_native_form_get_is_not_claimed_as_email_code_request(self):
        state, text = await self.fixture('native_get')
        self.assertEqual(self.submissions, [])
        self.assertIsNone(state['last_write'])
        self.assertIsNone(state['first_failure'])
        self.assertIn('method=GET kind=navigation path=login http_status=200 failure=none', text)
        self.assertGreaterEqual(state['navigation_count'], 2)

    async def test_post_rejection_keeps_first_failure_across_safe_get(self):
        state, text = await self.fixture('rejected')
        self.assertEqual(self.submissions, ['POST'])
        self.assertEqual((state['first_failure']['event'], state['first_failure']['method'],
                          state['first_failure']['http_status'], state['first_failure']['failure']),
                         ('response', 'POST', 400, 'http_error'))
        self.assertEqual(state['last_write']['http_status'], 400)
        self.assertEqual(state['current']['method'], 'GET')
        self.assertIn('slot=first_failure', text)

    async def test_transport_failure_is_closed_without_second_submission(self):
        state, _text = await self.fixture('transport_failed')
        self.assertEqual(self.submissions, ['POST'])
        self.assertEqual(state['failed_count'], 1)
        self.assertEqual((state['first_failure']['event'], state['first_failure']['http_status'],
                          state['first_failure']['failure']), ('requestfailed', None, 'network'))

    async def test_post_2xx_then_login_preserves_http_outcome_without_registration_claim(self):
        state, text = await self.fixture('accepted_login')
        self.assertEqual(self.submissions, ['POST'])
        self.assertIsNone(state['first_failure'])
        self.assertEqual((state['last_write']['event'], state['last_write']['method'],
                          state['last_write']['http_status']), ('response', 'POST', 200))
        self.assertEqual(state['main_frame_path'], 'login')
        self.assertIn('slot=last_write', text)
        self.assertNotIn('registered', self.events)

    async def test_code_and_profile_posts_cannot_overwrite_email_transition_snapshot(self):
        html = '''<!doctype html><html><body><main></main><script>
        let stage='email';const root=document.querySelector('main');
        function render(){
          const fields=stage==='email'?'<input type="email" name="email" required>':
            stage==='code'?'<p>Check your email. Email verification code</p><input name="code" autocomplete="one-time-code">':
            '<input name="name"><input type="date" name="birthday">';
          root.innerHTML='<form>'+fields+'<button>Continue</button></form>';
          root.querySelector('form').onsubmit=async event=>{
            event.preventDefault();await fetch('/fixture/'+stage,{method:'POST',body:'synthetic-private-OTP'});
            if(stage==='profile'){root.innerHTML='<main>Welcome</main>';return;}
            stage=stage==='email'?'code':'profile';render();
          };
        }render();</script></body></html>'''
        snapshots = []
        async def local(route):
            path = urlsplit(route.request.url).path
            if path == '/api/auth/session':
                await route.fulfill(content_type='application/json', body='{}')
            elif path.startswith('/fixture/'):
                self.submissions.append(path)
                if path != '/fixture/email':
                    snapshots.append((self.flow.email_request_page is None,
                                      json.dumps(self.flow.email_request_observation, sort_keys=True)))
                await route.fulfill(content_type='application/json', body='{}')
            else:
                await route.fulfill(content_type='text/html', body=html)
        await self.context.route('**/*', local)
        await self.page.goto('https://chatgpt.com/auth/login', wait_until='domcontentloaded')
        async def wait_code():
            self.job.awaiting_code = False
            return '123456'
        self.job.wait_code = AsyncMock(side_effect=wait_code)
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 3), self.assertLogs('registration', level='WARNING') as logs:
            with self.assertRaises(Stop):
                await asyncio.wait_for(self.flow.register(), timeout=15)
        self.assertEqual(self.submissions, ['/fixture/email', '/fixture/code', '/fixture/profile'])
        self.job.prepare_mail.assert_called_once_with('email_code', new_request=True)
        self.job.wait_code.assert_awaited_once()
        self.assertEqual(len(snapshots), 2)
        self.assertTrue(all(inactive for inactive, _snapshot in snapshots))
        frozen = json.dumps(self.flow.email_request_observation, sort_keys=True)
        self.assertTrue(all(snapshot == frozen for _inactive, snapshot in snapshots))
        self.assertEqual(self.flow.email_request_observation['request_count'], 1)
        self.assertEqual(self.flow.email_request_observation['last_write']['http_status'], 200)
        self.assertEqual(self.installed, self.removed)
        summaries = [line for line in logs.output if 'Registration email requests ' in line and 'point=transition' in line]
        self.assertEqual(len(summaries), 1)
        self.assertIn('read=closed', summaries[0])
        self.assertEqual(self.page_errors, [])


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


class PauseDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    def flow(self):
        job=SimpleNamespace(id='11111111-1111-4111-8111-111111111111',attempt=2,step='email_code',
            payload={'email':'private-owner@example.test','password':'private-password','totpSecret':'private-mfa',
                     'birthDate':'1996-01-01','displayName':'private-name'},
            check=lambda:None,cancelled=threading.Event(),awaiting_code=False,
            event=MagicMock(),prepare_mail=MagicMock(),manual=AsyncMock(side_effect=Stop('fixture_paused')))
        context=SimpleNamespace(route=AsyncMock(),unroute=AsyncMock())
        flow=RegistrationBrowser(job,context)
        flow.page=SimpleNamespace(url='https://chatgpt.com/onboarding?token=private-token',goto=AsyncMock(),reload=AsyncMock())
        flow.refresh_registration=AsyncMock(return_value=False)
        flow.email_diagnostic=AsyncMock()  # These unit cases exercise existing pause facts, not native DOM classification.
        async def settle(seconds):
            if seconds==.5:await asyncio.sleep(.05)
        flow.settle=settle
        return flow

    async def email_flow(self, *, fill_error=None, click_error=None):
        flow=self.flow()
        form=SimpleNamespace()
        field=SimpleNamespace(fill=AsyncMock(side_effect=fill_error),input_value=AsyncMock(return_value=flow.data['email']),
            evaluate_handle=AsyncMock(return_value=SimpleNamespace(as_element=lambda:form)))
        submit=SimpleNamespace(is_enabled=AsyncMock(return_value=True),click=AsyncMock())
        flow.field=AsyncMock(return_value=field);flow.button=AsyncMock(return_value=submit)
        flow.email_submit_control=AsyncMock(return_value=(field,submit,None))
        flow.email_submit_unchanged=AsyncMock(return_value=True)
        flow.challenge=AsyncMock(return_value=False)
        async def observed():
            return 'email',field
        flow.registration_view=AsyncMock(side_effect=observed)
        async def click(**_kwargs):
            self.assertTrue(flow.registration_state['email_submit_started'])
            self.assertFalse(flow.registration_state.get('email_click_returned',False))
            if click_error:raise click_error
        submit.click.side_effect=click
        return flow,field,submit

    async def test_pause_logging_excludes_secret_and_untrusted_fields_without_new_reads(self):
        flow=self.flow()
        secret='private-secret\nforged=success'
        flow.job.id=secret;flow.job.attempt=True;flow.job.step=secret
        flow.job.registration_last_observed_view=secret;flow.job.registration_last_write=secret
        flow.job.registration_observation_error={'reason':secret,'error_type':secret,'browser_error_code':secret,'body':secret}
        flow.registration_state.update(email_submitted=secret,code_submitted=True,profile_submitted=False)
        flow.page.locator=MagicMock(side_effect=AssertionError('diagnostics must not read DOM'))
        with self.assertLogs('registration',level='WARNING') as logs:
            flow.log_pause(secret)
        line=logs.output[0]
        for excluded in ['private-secret','private-password','private-mfa','private-owner','private-token','private-name','forged=']:
            self.assertNotIn(excluded,line)
        self.assertIn('job=unknown attempt=0 step=unknown reason=unknown',line)
        self.assertIn('last_observed_view=unknown last_write=none',line)
        self.assertIn('email_submitted=False code_submitted=True profile_submitted=False',line)
        flow.page.locator.assert_not_called();flow.page.goto.assert_not_awaited()

    async def test_read_operations_preserve_last_write_and_existing_operation(self):
        flow=self.flow()
        for write in ['email_submit','code_submit','profile_submit','signup_click']:
            flow.operation(write)
            for read in ['challenge_read','identity_read','profile_read','page_refresh']:
                flow.operation(read)
                self.assertEqual(flow.job.registration_operation,read)
                self.assertEqual(flow.job.registration_last_write,write)
        with self.assertLogs('registration',level='WARNING') as logs:flow.log_pause('form_unrecognized')
        self.assertIn('last_write=signup_click',logs.output[0])

    async def test_unknown_and_ambiguous_observation_pause_before_manual_without_submission(self):
        for ambiguous in [False,True]:
            flow=self.flow()
            if ambiguous:
                flow.job.registration_last_observed_view='email'
                flow.registration_view=AsyncMock(side_effect=Stop('login_form_ambiguous'))
            else:flow.registration_view=AsyncMock(return_value=('unknown',None))
            with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS',0),self.assertLogs('registration',level='WARNING') as logs:
                with self.assertRaises(Stop):await flow.register()
            self.assertEqual(len(logs.output),1)
            self.assertIn('last_observed_view='+('email' if ambiguous else 'unknown'),logs.output[0])
            self.assertIn('email_submit_started=False email_click_returned=False',logs.output[0])
            flow.job.manual.assert_awaited_once_with('form_unrecognized')
            flow.job.prepare_mail.assert_not_called();flow.page.goto.assert_not_awaited()

    async def test_email_click_phase_facts_are_observed_without_repeat_submission(self):
        flow,field,submit=await self.email_flow()
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS',.25),self.assertLogs('registration',level='WARNING') as logs:
            with self.assertRaises(Stop):await flow.register()
        pause = next(line for line in logs.output if 'Registration paused ' in line)
        self.assertIn('last_observed_view=email last_write=email_submit',pause)
        self.assertIn('email_submit_started=True email_click_returned=True email_submitted=True',pause)
        field.fill.assert_awaited_once_with(flow.data['email']);submit.click.assert_awaited_once()
        flow.job.prepare_mail.assert_called_once_with('email_code',new_request=True)
        flow.job.manual.assert_awaited_once_with('form_unrecognized')

    async def test_failed_click_never_reports_click_returned_or_replays_submission(self):
        flow,field,submit=await self.email_flow(click_error=Stop('session_network_error'))
        with self.assertRaises(Stop) as stopped:await flow.register()
        self.assertEqual(stopped.exception.report['reason'],'session_network_error')
        with self.assertLogs('registration',level='WARNING') as logs:flow.log_pause('form_unrecognized')
        self.assertIn('last_observed_view=email last_write=email_submit',logs.output[0])
        self.assertIn('email_submit_started=True email_click_returned=False email_submitted=True',logs.output[0])
        submit.click.assert_awaited_once();flow.job.manual.assert_not_awaited()

    async def test_first_network_failure_survives_later_page_change(self):
        flow=self.flow()
        first={'reason':'session_network_error','error_type':'Error','browser_error_code':'net::ERR_CONNECTION_RESET'}
        class Error(Exception):pass
        flow.registration_view=AsyncMock(side_effect=[Stop(first['reason'],error_type=first['error_type'],browser_error_code=first['browser_error_code']),Error('Execution context was destroyed private-token')])
        flow.refresh_registration=AsyncMock(side_effect=[True,False])
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS',0),self.assertLogs('registration',level='WARNING') as logs:
            with self.assertRaises(Stop):await flow.register()
        self.assertEqual(flow.job.registration_observation_error,first)
        self.assertIn('observation_reason=session_network_error observation_error_type=Error observation_browser_code=net::ERR_CONNECTION_RESET',logs.output[0])
        self.assertNotIn('private-token',logs.output[0])

    async def test_email_prepare_timeout_preserves_first_failure_without_mail_request(self):
        flow,field,submit=await self.email_flow(fill_error=Stop('session_load_timeout',error_type='TimeoutError'))
        first={'reason':'session_network_error','error_type':'Error','browser_error_code':'NS_ERROR_NET_RESET'}
        flow.job.registration_observation_error=first
        with self.assertLogs('registration',level='WARNING') as logs:
            with self.assertRaises(Stop):await flow.register()
        self.assertIs(flow.job.registration_observation_error,first)
        self.assertIn('observation_browser_code=NS_ERROR_NET_RESET',logs.output[0])
        self.assertIn('email_submit_started=False email_click_returned=False',logs.output[0])
        flow.job.prepare_mail.assert_not_called();submit.click.assert_not_awaited()

    async def test_cancel_still_wins_without_pause_log_or_submission(self):
        flow=self.flow();flow.job.check=MagicMock(side_effect=Stop('operation_cancelled'))
        with patch('registration_browser.logging.getLogger') as logger:
            with self.assertRaises(Stop) as stopped:await flow.register()
        self.assertEqual(stopped.exception.report['reason'],'operation_cancelled')
        logger.return_value.warning.assert_not_called();flow.job.manual.assert_not_awaited()
        flow.job.prepare_mail.assert_not_called();flow.page.goto.assert_not_awaited()

    async def test_prepare_and_callback_context_failures_are_closed_and_keep_first_reason(self):
        class Error(Exception):
            pass
        for method in ['email_submit_control', 'email_submit_unchanged']:
            for marker in ['Execution context was destroyed', 'Cannot find context with specified id']:
                for retained in [False, True]:
                    with self.subTest(method=method, marker=marker, retained=retained):
                        flow, field, submit = await self.email_flow()
                        expected = {'reason':'registration_page_changing', 'error_type':'Error'}
                        if retained:
                            expected = {'reason':'session_network_error', 'error_type':'Error'}
                            flow.job.registration_observation_error = expected
                        getattr(flow, method).side_effect = Error(marker + ' private-token')
                        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', .1), self.assertLogs('registration', level='WARNING') as logs:
                            with self.assertRaises(Stop):
                                await flow.register()
                        self.assertEqual(flow.job.registration_observation_error, expected)
                        submit.click.assert_not_awaited()
                        field.fill.assert_awaited_once_with(flow.data['email'])
                        self.assertFalse(flow.registration_state.get('email_submit_started'))
                        self.assertNotIn('private-token', '\n'.join(logs.output))


class EmailRequestDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self):
        flow = PauseDiagnosticsTests().flow()
        handlers = {}
        page = SimpleNamespace(url='https://chatgpt.com/auth/login?token=private-token',
                               on=lambda name, handler: handlers.setdefault(name, handler),
                               remove_listener=lambda name, handler: handlers.pop(name), main_frame=None)
        page.main_frame = SimpleNamespace(page=page, url=page.url)
        flow.page = page
        flow.begin_email_requests()
        return flow, page, handlers

    def request(self, page, *, method='POST', navigation=False, code='net::ERR_CONNECTION_RESET'):
        class Request:
            frame = page.main_frame
            resource_type = 'fetch'
            url = 'https://auth.openai.com/email-verification?token=private-token-OTP-123456'
            failure = code
            def is_navigation_request(self):
                return navigation
            def __getattr__(self, name):
                raise AssertionError('forbidden request read')
        request = Request()
        request.method = method
        return request

    async def test_request_association_and_all_counts_are_bounded(self):
        flow, page, handlers = self.fixture()
        requests = [self.request(page) for _ in range(40)]
        for request in requests:
            handlers['request'](request)
        self.assertEqual(len(flow.email_requests), 16)
        for request in requests[:16]:
            for _ in range(2):
                handlers['response'](SimpleNamespace(request=request, status=200))
                handlers['requestfailed'](request)
                handlers['framenavigated'](page.main_frame)
        state = flow.email_request_observation
        self.assertTrue(state['overflow'])
        for key in ('request_count', 'response_count', 'failed_count', 'navigation_count'):
            self.assertEqual(state[key], 16)
        flow.end_email_requests()
        self.assertEqual(flow.email_requests, {})
        self.assertEqual(handlers, {})

    async def test_first_failure_and_post_outcome_survive_later_read_navigation(self):
        flow, page, handlers = self.fixture()
        first = self.request(page)
        handlers['request'](first)
        handlers['response'](SimpleNamespace(request=first, status=409))
        saved = dict(flow.email_request_observation['first_failure'])
        later = self.request(page)
        handlers['request'](later)
        handlers['response'](SimpleNamespace(request=later, status=200))
        read = self.request(page, method='GET', navigation=True)
        handlers['request'](read)
        handlers['response'](SimpleNamespace(request=read, status=200))
        page.main_frame.url = 'https://chatgpt.com/auth/login?code=private-token'
        handlers['framenavigated'](page.main_frame)
        self.assertEqual(flow.email_request_observation['first_failure'], saved)
        self.assertEqual(flow.email_request_observation['last_write']['http_status'], 200)
        self.assertEqual(flow.email_request_observation['current']['method'], 'GET')
        self.assertEqual(flow.email_request_observation['main_frame_path'], 'login')
        flow.end_email_requests()

    async def test_closed_failure_logging_never_reads_or_emits_private_fields(self):
        flow, page, handlers = self.fixture()
        request = self.request(page, method='private-method', code='private-secret-OTP-123456')
        handlers['request'](request)
        handlers['requestfailed'](request)
        with self.assertLogs('registration', level='WARNING') as logs:
            flow.log_email_requests('pause')
        text = '\n'.join(logs.output)
        self.assertIn('method=other', text)
        self.assertIn('failure=unknown', text)
        for excluded in ['private-', '123456', 'https://', 'owner@']:
            self.assertNotIn(excluded, text)
        self.assertEqual(flow.email_request_observation['read'], 'observing')
        flow.end_email_requests()

    async def test_other_page_host_resource_and_subframe_do_not_pollute_observation(self):
        flow, page, handlers = self.fixture()
        other_page = SimpleNamespace(main_frame=SimpleNamespace(page=SimpleNamespace()))
        other = self.request(other_page)
        handlers['request'](other)
        other = self.request(page)
        other.url = 'https://untrusted.example/email-verification?token=private-token'
        handlers['request'](other)
        other = self.request(page)
        other.resource_type = 'image'
        handlers['request'](other)
        handlers['framenavigated'](SimpleNamespace(page=page, url=page.url))
        self.assertEqual(flow.email_request_observation['request_count'], 0)
        self.assertEqual(flow.email_request_observation['navigation_count'], 0)
        self.assertIsNone(flow.email_request_observation['current'])
        flow.end_email_requests()

    async def test_listener_cleanup_on_stop_is_inert_even_if_removal_fails(self):
        flow, page, handlers = self.fixture()
        request = self.request(page)
        flow.observe_registration = AsyncMock(side_effect=Stop('operation_cancelled'))
        page.remove_listener = MagicMock(side_effect=RuntimeError('private-secret'))
        with self.assertRaises(Stop) as stopped:
            await flow.register()
        self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
        self.assertEqual(page.remove_listener.call_count, 4)
        self.assertIsNone(flow.email_request_page)
        handlers['request'](request)
        self.assertEqual(flow.email_request_observation['request_count'], 0)
        self.assertEqual(flow.email_requests, {})
        self.assertEqual(flow.email_request_observation['read'], 'unavailable')

    async def test_invalid_state_and_records_are_not_logged(self):
        flow, page, handlers = self.fixture()
        request = self.request(page)
        handlers['request'](request)
        handlers['response'](SimpleNamespace(request=request, status=True))
        self.assertIsNone(flow.email_request_observation['current']['http_status'])
        flow.email_request_observation['current']['failure'] = {'secret': 'private-token'}
        flow.email_request_observation['last_write'] = None
        with self.assertLogs('registration', level='WARNING') as logs:
            flow.log_email_requests('pause')
        self.assertEqual(len(logs.output), 1)
        flow.email_request_observation['main_frame_path'] = ['private-token']
        with patch('registration_browser.logging.getLogger') as logger:
            flow.log_email_requests('pause')
        logger.assert_not_called()
        flow.end_email_requests()
