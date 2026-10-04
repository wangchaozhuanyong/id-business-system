"""Real browser DOM fixture; all requests are fulfilled locally in memory."""
import asyncio
import os
import json
from urllib.parse import urlsplit
import unittest
import threading
from types import SimpleNamespace
from pathlib import Path
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
        async def identity(page, email):
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
            async def identity(page, email):
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
        async def manual(_reason):
            self.assertEqual(flow.context.unroute.await_count, 1)
        flow.job.manual = AsyncMock(side_effect=manual)
        self.assertTrue(await flow.refresh_registration())
        flow.job.manual.assert_awaited_once_with('verification_required')

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
            self.job.manual.assert_awaited_with('verification_required')
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
        path = Path(__file__).resolve().parents[6] / '.runtime/registration-profile-repair-20261003/dom-compat-result.json'
        path.write_text(json.dumps(result, sort_keys=True) + '\n', encoding='utf-8')
        for key in ['array_from', 'node_for_each', 'node_spread', 'node_for_of', 'form_data_entries']:
            self.assertTrue(result[key]['ok'])


if __name__ == '__main__':
    unittest.main()
